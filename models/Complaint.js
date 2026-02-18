const mongoose = require('mongoose');

const complaintSchema = new mongoose.Schema({
  ticketId: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userName: { type: String, required: true },
  userEmail: { type: String, required: true },
  area: { type: String, required: true },
  address: { type: String }, // Full reverse-geocoded address from GPS
  department: { 
    type: String, 
    required: true,
    enum: [
      'Water Resources',
      'Electricity',
      'Roads & Highways',
      'Sanitation',
      'Public Health',
      'Education',
      'Transport',
      'Revenue',
      'Agriculture',
      'General'
    ]
  },
  description: { type: String, required: true },
  photo: { type: String, required: true }, // base64 image data
  status: { 
    type: String, 
    default: 'Registered',
    enum: ['Registered', 'Accepted', 'Working On', 'Completed', 'Rejected']
  },
  // Status timeline history (like Amazon order tracking)
  statusHistory: [{
    status: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedByName: { type: String },
    note: { type: String }
  }],
  priority: {
    type: String,
    default: 'Medium',
    enum: ['Critical', 'High', 'Medium', 'Low']
  },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  assignedToName: { type: String }, // Provider name for quick display
  resolution: { type: String },

  // Location - captured when photo is taken
  location: {
    latitude: { type: Number },
    longitude: { type: Number }
  },

  // Rating & Feedback from user after completion
  rating: { type: Number, min: 1, max: 5 },
  feedback: { type: String },

  // Duplicate/Fake detection flags
  isDuplicate: { type: Boolean, default: false },
  duplicateOf: { type: String }, // ticketId of original complaint
  isFake: { type: Boolean, default: false },
  aiRemarks: { type: String }, // AI analysis remarks

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Indexes for fast queries
complaintSchema.index({ status: 1 });
complaintSchema.index({ department: 1 });
complaintSchema.index({ assignedTo: 1 });
complaintSchema.index({ userId: 1 });
complaintSchema.index({ priority: 1 });
complaintSchema.index({ department: 1, status: 1 });
complaintSchema.index({ assignedTo: 1, status: 1 });
complaintSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Complaint', complaintSchema);
