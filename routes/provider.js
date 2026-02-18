const express = require('express');
const Complaint = require('../models/Complaint');
const auth = require('../middleware/auth');
const { sendStatusUpdate } = require('../utils/mailer');

const router = express.Router();

// GET complaints assigned to this specific provider (not all department complaints)
router.get('/complaints', auth(['provider']), async (req, res) => {
  try {
    // Show complaints assigned to this provider, plus any unassigned ones in their department
    const complaints = await Complaint.find({
      department: req.user.department,
      $or: [
        { assignedTo: req.user.id },
        { assignedTo: null },
        { assignedTo: { $exists: false } }
      ]
    })
      .sort({ 
        priority: 1,
        createdAt: -1 
      })
      .populate('userId', 'name email phone')
      .populate('assignedTo', 'name email')
      .lean();

    // Custom sort by priority
    const priorityOrder = { 'Critical': 0, 'High': 1, 'Medium': 2, 'Low': 3 };
    complaints.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    res.json(complaints);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// UPDATE complaint status (Provider) — tracks status history + load balancing
router.put('/complaints/:id', auth(['provider']), async (req, res) => {
  try {
    const { status, resolution } = req.body;
    const complaint = await Complaint.findById(req.params.id);

    if (!complaint) {
      return res.status(404).json({ message: 'Complaint not found' });
    }

    if (complaint.department !== req.user.department) {
      return res.status(403).json({ message: 'Not authorized for this department' });
    }

    // Validate status transitions
    const validTransitions = {
      'Registered': ['Accepted', 'Rejected'],
      'Accepted': ['Working On', 'Rejected'],
      'Working On': ['Completed'],
      'Completed': [],
      'Rejected': []
    };

    const allowed = validTransitions[complaint.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({ 
        message: `Cannot change status from "${complaint.status}" to "${status}". Allowed: ${allowed.join(', ') || 'none'}` 
      });
    }

    // If accepting a complaint, check if this provider already has an active one
    if (status === 'Accepted') {
      const activeCount = await Complaint.countDocuments({
        assignedTo: req.user.id,
        status: { $in: ['Accepted', 'Working On'] },
        _id: { $ne: complaint._id }
      });
      if (activeCount > 0) {
        return res.status(400).json({ 
          message: 'You already have an active complaint. Please complete it before accepting a new one.' 
        });
      }
    }

    // Update complaint
    complaint.status = status;
    complaint.assignedTo = req.user.id;
    complaint.assignedToName = req.user.name;
    if (resolution) complaint.resolution = resolution;
    complaint.updatedAt = new Date();

    // Add to status history timeline
    complaint.statusHistory.push({
      status,
      timestamp: new Date(),
      updatedBy: req.user.id,
      updatedByName: req.user.name,
      note: resolution || `Status updated to ${status}`
    });

    await complaint.save();

    // Send email notification to user about status change
    try {
      await sendStatusUpdate(complaint.userEmail, complaint.userName, complaint, status, resolution);
      console.log(`[Email] Status update sent to ${complaint.userEmail} for ${complaint.ticketId}`);
    } catch (emailErr) {
      console.error('[Email] Failed to send status update:', emailErr.message);
    }

    res.json({ message: 'Complaint updated', complaint });
  } catch (error) {
    console.error('Provider update error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET provider stats (includes average rating + active workload) — OPTIMIZED
router.get('/stats', auth(['provider']), async (req, res) => {
  try {
    const department = req.user.department;

    // Single aggregation for status counts instead of 5 separate queries
    const [statusAgg, ratingAgg, myActive] = await Promise.all([
      Complaint.aggregate([
        { $match: { department } },
        { $group: { _id: '$status', count: { $sum: 1 }, criticalCount: { $sum: { $cond: [{ $eq: ['$priority', 'Critical'] }, 1, 0] } } } }
      ]),
      Complaint.aggregate([
        { $match: { department, rating: { $exists: true, $ne: null } } },
        { $group: { _id: null, avgRating: { $avg: '$rating' }, totalRated: { $sum: 1 } } }
      ]),
      Complaint.countDocuments({ assignedTo: req.user.id, status: { $in: ['Registered', 'Accepted', 'Working On'] } })
    ]);

    let total = 0, registered = 0, accepted = 0, workingOn = 0, completed = 0, critical = 0;
    for (const s of statusAgg) {
      total += s.count;
      critical += s.criticalCount;
      if (s._id === 'Registered') registered = s.count;
      else if (s._id === 'Accepted') accepted = s.count;
      else if (s._id === 'Working On') workingOn = s.count;
      else if (s._id === 'Completed') completed = s.count;
    }

    const avgRating = ratingAgg.length > 0 ? Math.round(ratingAgg[0].avgRating * 10) / 10 : 0;
    const totalRated = ratingAgg.length > 0 ? ratingAgg[0].totalRated : 0;

    res.json({ total, registered, accepted, workingOn, completed, critical, avgRating, totalRated, myActive });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
