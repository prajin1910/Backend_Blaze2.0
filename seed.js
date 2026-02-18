// Seed script to create the default Management account
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('./models/User');

async function seed() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Check if management account exists
    const existing = await User.findOne({ role: 'management' });
    if (existing) {
      console.log('Management account already exists:', existing.email);
    } else {
      const hashedPassword = await bcrypt.hash('admin@tnsmp2026', 10);
      const admin = new User({
        name: 'TNSMP Admin',
        email: 'admin@tnsmp.gov.in',
        password: hashedPassword,
        phone: '0000000000',
        role: 'management',
        isVerified: true
      });
      await admin.save();
      console.log('Management account created!');
      console.log('Email: admin@tnsmp.gov.in');
      console.log('Password: admin@tnsmp2026');
    }

    await mongoose.disconnect();
    console.log('Done!');
  } catch (err) {
    console.error('Seed error:', err);
    process.exit(1);
  }
}

seed();
