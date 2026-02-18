const express = require('express');
const Complaint = require('../models/Complaint');
const User = require('../models/User');
const auth = require('../middleware/auth');
const { prioritizeComplaint, detectDuplicateOrFake } = require('../utils/gemini');
const { detectDepartmentFromImage } = require('../utils/vision');
const { sendComplaintAssignment, sendStatusUpdate } = require('../utils/mailer');

const router = express.Router();

// ---------- HELPERS ----------

// Reverse geocode lat/lng to address using Google Maps Geocoding API
async function reverseGeocode(latitude, longitude) {
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return { address: '', area: '' };

    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== 'OK' || !data.results?.length) return { address: '', area: '' };

    const fullAddress = data.results[0].formatted_address || '';

    // Extract district/area from address components
    let detectedArea = '';
    const tamilNaduAreas = [
      'Chennai', 'Coimbatore', 'Madurai', 'Tiruchirappalli', 'Salem',
      'Tirunelveli', 'Erode', 'Vellore', 'Thoothukudi', 'Dindigul',
      'Thanjavur', 'Ranipet', 'Sivaganga', 'Karur', 'Namakkal',
      'Tiruppur', 'Cuddalore', 'Kanchipuram', 'Tiruvannamalai', 'Villupuram',
      'Nagapattinam', 'Ramanathapuram', 'Virudhunagar', 'Krishnagiri', 'Dharmapuri',
      'Perambalur', 'Ariyalur', 'Nilgiris', 'Pudukkottai', 'Theni',
      'Kanyakumari', 'Kallakurichi', 'Chengalpattu', 'Tiruvallur', 'Tenkasi',
      'Tirupattur', 'Mayiladuthurai'
    ];

    // Search address components for district match
    for (const component of data.results[0].address_components || []) {
      const name = component.long_name;
      const match = tamilNaduAreas.find(a => name.toLowerCase().includes(a.toLowerCase()));
      if (match) {
        detectedArea = match;
        break;
      }
    }

    // Fallback: search full address string
    if (!detectedArea) {
      for (const area of tamilNaduAreas) {
        if (fullAddress.toLowerCase().includes(area.toLowerCase())) {
          detectedArea = area;
          break;
        }
      }
    }

    console.log(`[Geocode] Address: ${fullAddress}, Detected area: ${detectedArea || 'unknown'}`);
    return { address: fullAddress, area: detectedArea };
  } catch (err) {
    console.error('[Geocode] Error:', err.message);
    return { address: '', area: '' };
  }
}

// Load-balanced provider assignment: find the least-loaded free provider in a department
async function assignProviderForDepartment(department) {
  try {
    const providers = await User.find({ role: 'provider', department }).select('_id name email').lean();
    if (!providers.length) {
      console.log(`[LoadBalance] No providers found for department: ${department}`);
      return null;
    }

    // Single aggregation to get active counts per provider in this department
    const loadAgg = await Complaint.aggregate([
      { $match: { assignedTo: { $in: providers.map(p => p._id) }, status: { $in: ['Registered', 'Accepted', 'Working On'] } } },
      { $group: { _id: '$assignedTo', activeCount: { $sum: 1 } } }
    ]);

    const loadMap = {};
    for (const item of loadAgg) loadMap[item._id.toString()] = item.activeCount;

    const providerLoads = providers.map(p => ({ ...p, activeCount: loadMap[p._id.toString()] || 0 }));
    providerLoads.sort((a, b) => a.activeCount - b.activeCount);

    const freeProvider = providerLoads.find(p => p.activeCount === 0);
    const chosen = freeProvider || providerLoads[0];

    console.log(`[LoadBalance] ${department}: ${providerLoads.map(p => `${p.name}(${p.activeCount})`).join(', ')} → ${chosen.name}`);
    return chosen;
  } catch (err) {
    console.error('[LoadBalance] Error:', err.message);
    return null;
  }
}

// ANALYZE IMAGE — Google Cloud Vision API auto-detects department
router.post('/analyze-image', auth(['user']), async (req, res) => {
  try {
    const { photo } = req.body;
    if (!photo) {
      return res.status(400).json({ message: 'Photo is required for analysis' });
    }

    console.log('[Analyze] Starting image analysis via Google Cloud Vision...');
    const result = await detectDepartmentFromImage(photo);

    res.json({
      department: result.department,
      confidence: result.confidence,
      detectedLabels: result.detectedLabels,
      reason: result.reason,
      error: result.error || false
    });
  } catch (error) {
    console.error('[Analyze] Image analysis error:', error.message);
    res.status(500).json({ 
      department: 'General',
      confidence: 0,
      detectedLabels: [],
      reason: 'Vision API error: ' + error.message,
      error: true
    });
  }
});

// CREATE complaint (User only) — department is auto-detected from image if not provided
router.post('/', auth(['user']), async (req, res) => {
  try {
    let { area, department, description, photo, latitude, longitude, address } = req.body;

    console.log('Creating complaint - user:', req.user);
    console.log('Creating complaint - fields:', { area, department, descLen: description?.length, photoLen: photo?.length, latitude, longitude });

    if (!photo) {
      return res.status(400).json({ message: 'Photo is required. Please take a live photo.' });
    }

    if (!description) {
      return res.status(400).json({ message: 'Description is required.' });
    }

    // Reverse geocode if lat/lng provided and area/address not set
    if (latitude && longitude) {
      const geoResult = await reverseGeocode(latitude, longitude);
      if (!address && geoResult.address) address = geoResult.address;
      if (!area && geoResult.area) area = geoResult.area;
    }

    // Fallback area
    if (!area) area = 'Unknown';

    // Auto-detect department from image if not provided
    if (!department) {
      try {
        console.log('[Auto-Detect] No department provided, analyzing image...');
        const visionResult = await detectDepartmentFromImage(photo);
        department = visionResult.department;
        console.log(`[Auto-Detect] Detected department: ${department} (${visionResult.confidence}%)`);
      } catch (visionErr) {
        console.error('[Auto-Detect] Vision API failed, defaulting to General:', visionErr.message);
        department = 'General';
      }
    }

    // AI Duplicate & Fake Detection
    let duplicateCheck = { isDuplicate: false, duplicateOf: null, isFake: false, remarks: '' };
    try {
      const existingComplaints = await Complaint.find({ 
        department, 
        status: { $ne: 'Rejected' } 
      }).select('ticketId description area status').limit(20).lean();

      duplicateCheck = await detectDuplicateOrFake(description, department, area, existingComplaints);
      console.log('AI Duplicate/Fake check:', duplicateCheck);
    } catch (aiErr) {
      console.error('AI duplicate detection failed:', aiErr.message);
    }

    // Reject fake complaints
    if (duplicateCheck.isFake) {
      return res.status(400).json({ 
        message: 'This complaint appears to be invalid or fake. AI Remarks: ' + duplicateCheck.remarks,
        isFake: true,
        aiRemarks: duplicateCheck.remarks
      });
    }

    // AI Priority assignment (with fallback)
    let priority = 'Medium';
    try {
      priority = await prioritizeComplaint(description, department);
    } catch (aiErr) {
      console.error('AI prioritization failed, using Medium:', aiErr.message);
    }

    // Generate ticket ID
    const prefix = 'TNSMP';
    const timestamp = Date.now().toString().slice(-6);
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const ticketId = `${prefix}-${timestamp}-${random}`;

    // Load-balanced provider assignment
    let assignedProvider = null;
    const isRejected = duplicateCheck.isDuplicate;
    if (!isRejected) {
      assignedProvider = await assignProviderForDepartment(department);
    }

    const complaintData = {
      ticketId,
      userId: req.user.id,
      userName: req.user.name || 'Unknown',
      userEmail: req.user.email || 'unknown@email.com',
      area,
      address: address || '',
      department,
      description,
      photo,
      priority,
      status: isRejected ? 'Rejected' : 'Registered',
      isDuplicate: duplicateCheck.isDuplicate,
      duplicateOf: duplicateCheck.duplicateOf,
      isFake: false,
      aiRemarks: duplicateCheck.remarks,
      // Status history — initial entry
      statusHistory: [{
        status: isRejected ? 'Rejected' : 'Registered',
        timestamp: new Date(),
        updatedByName: 'System',
        note: isRejected
          ? `Flagged as duplicate of ${duplicateCheck.duplicateOf}`
          : 'Complaint registered successfully'
      }]
    };

    // Add location if provided
    if (latitude && longitude) {
      complaintData.location = { latitude: parseFloat(latitude), longitude: parseFloat(longitude) };
    }

    // Assign provider
    if (assignedProvider) {
      complaintData.assignedTo = assignedProvider._id;
      complaintData.assignedToName = assignedProvider.name;
    }

    const complaint = new Complaint(complaintData);

    console.log('Saving complaint with ticketId:', ticketId);
    await complaint.save();
    console.log('Complaint saved successfully');

    // Send email notification to assigned provider
    if (assignedProvider) {
      try {
        await sendComplaintAssignment(assignedProvider.email, assignedProvider.name, complaint);
        console.log(`[Email] Assignment notification sent to ${assignedProvider.email}`);
      } catch (emailErr) {
        console.error('[Email] Failed to send assignment notification:', emailErr.message);
      }
    }

    // Build response
    const responseData = {
      message: duplicateCheck.isDuplicate 
        ? 'Complaint flagged as potential duplicate of ' + duplicateCheck.duplicateOf
        : 'Complaint registered successfully',
      ticketId: complaint.ticketId,
      priority: complaint.priority,
      isDuplicate: complaint.isDuplicate,
      aiRemarks: complaint.aiRemarks,
      assignedTo: assignedProvider ? assignedProvider.name : null,
      department: complaint.department,
      address: complaint.address,
      area: complaint.area
    };

    res.status(201).json(responseData);
  } catch (error) {
    console.error('Create complaint error:', error.message);
    console.error('Error details:', error);
    res.status(500).json({ message: 'Server error creating complaint: ' + error.message });
  }
});

// REVERSE GEOCODE — frontend calls this to auto-fill address from GPS
router.post('/reverse-geocode', auth(['user']), async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    if (!latitude || !longitude) {
      return res.status(400).json({ message: 'Latitude and longitude required' });
    }
    const result = await reverseGeocode(latitude, longitude);
    res.json(result);
  } catch (error) {
    res.status(500).json({ address: '', area: '' });
  }
});

// RATE a completed complaint (User only)
router.put('/:id/rate', auth(['user']), async (req, res) => {
  try {
    const { rating, feedback } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'Rating must be between 1 and 5' });
    }

    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) {
      return res.status(404).json({ message: 'Complaint not found' });
    }

    if (complaint.userId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'You can only rate your own complaints' });
    }

    if (complaint.status !== 'Completed') {
      return res.status(400).json({ message: 'Can only rate completed complaints' });
    }

    if (complaint.rating) {
      return res.status(400).json({ message: 'You have already rated this complaint' });
    }

    complaint.rating = rating;
    complaint.feedback = feedback || '';
    complaint.updatedAt = new Date();
    await complaint.save();

    res.json({ message: 'Thank you for your feedback!', rating, feedback });
  } catch (error) {
    console.error('Rating error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET user's complaints (My Complaints)
router.get('/my', auth(['user']), async (req, res) => {
  try {
    const complaints = await Complaint.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .populate('assignedTo', 'name email')
      .lean();
    res.json(complaints);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET single complaint
router.get('/:id', auth(), async (req, res) => {
  try {
    const complaint = await Complaint.findById(req.params.id)
      .populate('userId', 'name email')
      .populate('assignedTo', 'name email');
    if (!complaint) {
      return res.status(404).json({ message: 'Complaint not found' });
    }
    res.json(complaint);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
