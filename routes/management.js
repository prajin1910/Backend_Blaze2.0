const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Complaint = require('../models/Complaint');
const auth = require('../middleware/auth');
const { sendProviderCredentials } = require('../utils/mailer');

const router = express.Router();

// CREATE service provider (Management only)
router.post('/providers', auth(['management']), async (req, res) => {
  try {
    const { name, email, department, password } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const provider = new User({
      name,
      email,
      password: hashedPassword,
      phone: 'N/A',
      role: 'provider',
      department,
      isVerified: true
    });

    await provider.save();

    // Send credentials via email
    let emailSent = false;
    let emailError = null;
    try {
      await sendProviderCredentials(email, name, password, department);
      emailSent = true;
      console.log(`[Management] Provider credentials email sent to ${email}`);
    } catch (emailErr) {
      emailError = emailErr.message;
      console.error(`[Management] Failed to send credentials email to ${email}:`, emailErr.message);
    }

    res.status(201).json({
      message: emailSent
        ? 'Service provider created successfully. Login credentials sent to their email.'
        : 'Service provider created successfully, but failed to send credentials email. Please share the credentials manually.',
      emailSent,
      emailError: emailError || undefined,
      provider: { id: provider._id, name, email, department }
    });
  } catch (error) {
    console.error('Create provider error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET all service providers
router.get('/providers', auth(['management']), async (req, res) => {
  try {
    const providers = await User.find({ role: 'provider' })
      .select('-password -otp -otpExpiry')
      .sort({ department: 1 });
    res.json(providers);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// DELETE service provider
router.delete('/providers/:id', auth(['management']), async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ message: 'Provider removed' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET dashboard stats (Management) — OPTIMIZED with aggregation pipelines
router.get('/dashboard', auth(['management']), async (req, res) => {
  try {
    // Single aggregation for all status + department + priority counts
    const [statusDeptAgg, priorityAgg, providerWorkloadAgg, userCounts, recentComplaints] = await Promise.all([
      // 1. Status counts by department (single aggregation replaces 50+ queries)
      Complaint.aggregate([
        {
          $group: {
            _id: { department: '$department', status: '$status' },
            count: { $sum: 1 }
          }
        }
      ]),

      // 2. Priority breakdown (single aggregation replaces 4 queries)
      Complaint.aggregate([
        { $group: { _id: '$priority', count: { $sum: 1 } } }
      ]),

      // 3. Provider workload (single aggregation replaces N*2 queries per provider)
      Complaint.aggregate([
        { $match: { assignedTo: { $exists: true, $ne: null } } },
        {
          $group: {
            _id: { assignedTo: '$assignedTo', status: '$status' },
            count: { $sum: 1 }
          }
        }
      ]),

      // 4. User/provider counts (2 queries in parallel)
      Promise.all([
        User.countDocuments({ role: 'user' }),
        User.countDocuments({ role: 'provider' })
      ]),

      // 5. Recent complaints — EXCLUDE photo field for speed
      Complaint.find()
        .sort({ createdAt: -1 })
        .limit(10)
        .populate('userId', 'name email')
        .populate('assignedTo', 'name email')
        .lean()
    ]);

    // Process status/dept aggregation into overview + department stats
    const overview = { totalComplaints: 0, registered: 0, accepted: 0, workingOn: 0, completed: 0, totalUsers: userCounts[0], totalProviders: userCounts[1] };
    const deptMap = {};

    for (const item of statusDeptAgg) {
      const dept = item._id.department;
      const status = item._id.status;
      const count = item.count;

      overview.totalComplaints += count;
      if (status === 'Registered') overview.registered += count;
      else if (status === 'Accepted') overview.accepted += count;
      else if (status === 'Working On') overview.workingOn += count;
      else if (status === 'Completed') overview.completed += count;

      if (!deptMap[dept]) deptMap[dept] = { department: dept, total: 0, registered: 0, accepted: 0, workingOn: 0, completed: 0, providers: 0, providerDetails: [] };
      deptMap[dept].total += count;
      if (status === 'Registered') deptMap[dept].registered += count;
      else if (status === 'Accepted') deptMap[dept].accepted += count;
      else if (status === 'Working On') deptMap[dept].workingOn += count;
      else if (status === 'Completed') deptMap[dept].completed += count;
    }

    // Process priority aggregation
    const priorityBreakdown = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const item of priorityAgg) {
      if (item._id === 'Critical') priorityBreakdown.critical = item.count;
      else if (item._id === 'High') priorityBreakdown.high = item.count;
      else if (item._id === 'Medium') priorityBreakdown.medium = item.count;
      else if (item._id === 'Low') priorityBreakdown.low = item.count;
    }

    // Process provider workload aggregation
    const providerLoadMap = {};
    for (const item of providerWorkloadAgg) {
      const pid = item._id.assignedTo.toString();
      if (!providerLoadMap[pid]) providerLoadMap[pid] = { active: 0, completed: 0 };
      if (['Registered', 'Accepted', 'Working On'].includes(item._id.status)) {
        providerLoadMap[pid].active += item.count;
      } else if (item._id.status === 'Completed') {
        providerLoadMap[pid].completed += item.count;
      }
    }

    // Get all providers and attach workload data
    const allProviders = await User.find({ role: 'provider' })
      .select('name email department loginCount lastLogin').lean();

    for (const p of allProviders) {
      const dept = p.department;
      if (!deptMap[dept]) deptMap[dept] = { department: dept, total: 0, registered: 0, accepted: 0, workingOn: 0, completed: 0, providers: 0, providerDetails: [] };
      deptMap[dept].providers++;
      const load = providerLoadMap[p._id.toString()] || { active: 0, completed: 0 };
      deptMap[dept].providerDetails.push({
        _id: p._id,
        name: p.name,
        email: p.email,
        activeComplaints: load.active,
        completedComplaints: load.completed,
        isBusy: load.active > 0
      });
    }

    const departmentStats = Object.values(deptMap).filter(d => d.total > 0 || d.providers > 0);

    res.json({ overview, departmentStats, priorityBreakdown, recentComplaints });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET all complaints (Management)
router.get('/complaints', auth(['management']), async (req, res) => {
  try {
    const { department, status, priority } = req.query;
    const filter = {};
    if (department) filter.department = department;
    if (status) filter.status = status;
    if (priority) filter.priority = priority;

    const complaints = await Complaint.find(filter)
      .sort({ createdAt: -1 })
      .populate('userId', 'name email')
      .populate('assignedTo', 'name email department')
      .lean();
    res.json(complaints);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
