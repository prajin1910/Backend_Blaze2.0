// Quick test script for complaint creation
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);
require('dotenv').config();

const http = require('http');
const jwt = require('jsonwebtoken');

// Generate token
const token = jwt.sign(
  { id: '67b300db4af3b43e4e5ae81b', email: 'test@test.com', role: 'user', name: 'Test User' },
  process.env.JWT_SECRET,
  { expiresIn: '1h' }
);

const data = JSON.stringify({
  area: 'Chennai',
  department: 'Water Resources',
  description: 'Test complaint - water leakage on road',
  photo: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD'
});

const options = {
  hostname: 'localhost',
  port: 5000,
  path: '/api/complaints',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'Content-Length': Buffer.byteLength(data)
  }
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Response:', body);
  });
});

req.on('error', (e) => console.error('Request error:', e.message));
req.write(data);
req.end();
