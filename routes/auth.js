const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { sendOTP } = require('../utils/mailer');

const router = express.Router();

// Generate 4-digit OTP
const generateOTP = () => Math.floor(1000 + Math.random() * 9000).toString();

// SIGNUP - Step 1: Register user and send OTP
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser && existingUser.isVerified) {
      return res.status(400).json({ message: 'User already exists with this email' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Generate OTP
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    if (existingUser && !existingUser.isVerified) {
      // Update existing unverified user
      existingUser.name = name;
      existingUser.password = hashedPassword;
      existingUser.phone = phone;
      existingUser.otp = otp;
      existingUser.otpExpiry = otpExpiry;
      await existingUser.save();
    } else {
      // Create new user
      const user = new User({
        name,
        email,
        password: hashedPassword,
        phone,
        otp,
        otpExpiry,
        role: 'user'
      });
      await user.save();
    }

    // Send OTP email
    await sendOTP(email, otp);

    res.status(200).json({ message: 'OTP sent to your email', email });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ message: 'Server error during signup' });
  }
});

// VERIFY OTP - Step 2
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.otp !== otp) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    if (new Date() > user.otpExpiry) {
      return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
    }

    await User.updateOne(
      { _id: user._id },
      { $set: { isVerified: true }, $unset: { otp: '', otpExpiry: '' } }
    );

    res.status(200).json({ message: 'Email verified successfully. You can now log in.' });
  } catch (error) {
    console.error('OTP verification error:', error);
    res.status(500).json({ message: 'Server error during verification' });
  }
});

// RESEND OTP
router.post('/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const otp = generateOTP();
    await User.updateOne(
      { _id: user._id },
      { $set: { otp: otp, otpExpiry: new Date(Date.now() + 5 * 60 * 1000) } }
    );

    await sendOTP(email, otp);

    res.status(200).json({ message: 'New OTP sent to your email' });
  } catch (error) {
    console.error('Resend OTP error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// LOGIN
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const userRole = user.role.toLowerCase();
    if (!user.isVerified && userRole === 'user') {
      return res.status(400).json({ message: 'Please verify your email first', needsVerification: true, email });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Update login stats using updateOne to avoid full validation on legacy docs
    await User.updateOne(
      { _id: user._id },
      { $set: { lastLogin: new Date(), role: user.role.toLowerCase() }, $inc: { loginCount: 1 } }
    );

    const role = user.role.toLowerCase();
    const token = jwt.sign(
      { id: user._id, email: user.email, role: role, name: user.name, department: user.department },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: role,
        department: user.department
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error during login' });
  }
});

// GET current user
router.get('/me', require('../middleware/auth')(), async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password -otp -otpExpiry');
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
