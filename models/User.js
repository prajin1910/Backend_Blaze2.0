const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  phone: { type: String, default: '' },
  isVerified: { type: Boolean, default: false },
  otp: { type: String },
  otpExpiry: { type: Date },
  role: { type: String, default: 'user', enum: ['user', 'provider', 'management', 'USER', 'PROVIDER', 'MANAGEMENT'] },
  department: { type: String }, // For service providers
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date },
  loginCount: { type: Number, default: 0 }
});

module.exports = mongoose.model('User', userSchema);
