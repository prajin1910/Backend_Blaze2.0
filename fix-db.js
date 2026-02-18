const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);
require('dotenv').config();
const mongoose = require('mongoose');

async function fix() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  
  const r1 = await db.collection('users').updateMany({ role: 'USER' }, { $set: { role: 'user' } });
  const r2 = await db.collection('users').updateMany({ role: 'MANAGEMENT' }, { $set: { role: 'management' } });
  const r3 = await db.collection('users').updateMany({ role: 'PROVIDER' }, { $set: { role: 'provider' } });
  const r4 = await db.collection('users').updateMany({ phone: { $exists: false } }, { $set: { phone: '' } });
  
  console.log('Fixed roles:', r1.modifiedCount + r2.modifiedCount + r3.modifiedCount);
  console.log('Fixed phones:', r4.modifiedCount);
  
  await mongoose.disconnect();
  console.log('Done!');
}

fix().catch(console.error);
