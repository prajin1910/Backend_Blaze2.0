const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const sendOTP = async (email, otp) => {
  const mailOptions = {
    from: `"TNSMP Portal" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'TNSMP - Email Verification OTP',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 2px solid #1a237e; border-radius: 10px;">
        <h2 style="color: #1a237e; text-align: center;">Tamil Nadu Service Management Portal</h2>
        <hr style="border: 1px solid #e0e0e0;">
        <p style="font-size: 16px; color: #333;">Your verification OTP is:</p>
        <div style="text-align: center; margin: 20px 0;">
          <span style="font-size: 36px; font-weight: bold; color: #1a237e; letter-spacing: 8px; background: #e8eaf6; padding: 10px 30px; border-radius: 8px;">${otp}</span>
        </div>
        <p style="font-size: 14px; color: #666;">This OTP is valid for 5 minutes. Do not share it with anyone.</p>
        <hr style="border: 1px solid #e0e0e0;">
        <p style="font-size: 12px; color: #999; text-align: center;">© 2026 TNSMP - Government of Tamil Nadu</p>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
};

const sendProviderCredentials = async (email, name, password, department) => {
  const mailOptions = {
    from: `"TNSMP Portal" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'TNSMP - Service Provider Account Created',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 2px solid #1a237e; border-radius: 10px;">
        <h2 style="color: #1a237e; text-align: center;">Tamil Nadu Service Management Portal</h2>
        <hr style="border: 1px solid #e0e0e0;">
        <p style="font-size: 16px; color: #333;">Hello <strong>${name}</strong>,</p>
        <p>Your Service Provider account has been created for the <strong>${department}</strong> department.</p>
        <div style="background: #e8eaf6; padding: 15px; border-radius: 8px; margin: 15px 0;">
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Password:</strong> ${password}</p>
          <p><strong>Department:</strong> ${department}</p>
        </div>
        <p style="font-size: 14px; color: #666;">Please log in at the TNSMP portal to start resolving complaints.</p>
        <hr style="border: 1px solid #e0e0e0;">
        <p style="font-size: 12px; color: #999; text-align: center;">© 2026 TNSMP - Government of Tamil Nadu</p>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
};

// Notify provider of new complaint assignment
const sendComplaintAssignment = async (providerEmail, providerName, complaint) => {
  const mailOptions = {
    from: `"TNSMP Portal" <${process.env.EMAIL_USER}>`,
    to: providerEmail,
    subject: `TNSMP - New Complaint Assigned: ${complaint.ticketId}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 2px solid #1a237e; border-radius: 10px;">
        <h2 style="color: #1a237e; text-align: center;">Tamil Nadu Service Management Portal</h2>
        <hr style="border: 1px solid #e0e0e0;">
        <p style="font-size: 16px; color: #333;">Hello <strong>${providerName}</strong>,</p>
        <p>A new complaint has been assigned to you.</p>
        <div style="background: #e8eaf6; padding: 15px; border-radius: 8px; margin: 15px 0;">
          <p><strong>Ticket ID:</strong> ${complaint.ticketId}</p>
          <p><strong>Department:</strong> ${complaint.department}</p>
          <p><strong>Area:</strong> ${complaint.area}</p>
          <p><strong>Priority:</strong> <span style="color: ${complaint.priority === 'Critical' ? '#c62828' : complaint.priority === 'High' ? '#e65100' : '#1565c0'}; font-weight: bold;">${complaint.priority}</span></p>
          <p><strong>Description:</strong> ${complaint.description.substring(0, 200)}${complaint.description.length > 200 ? '...' : ''}</p>
          ${complaint.address ? `<p><strong>Location:</strong> ${complaint.address}</p>` : ''}
        </div>
        <p style="font-size: 14px; color: #666;">Please log in to the TNSMP portal to accept and resolve this complaint.</p>
        <hr style="border: 1px solid #e0e0e0;">
        <p style="font-size: 12px; color: #999; text-align: center;">© 2026 TNSMP - Government of Tamil Nadu</p>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
};

// Notify user about complaint status update
const sendStatusUpdate = async (userEmail, userName, complaint, newStatus, note) => {
  const statusEmoji = {
    'Registered': '📋',
    'Accepted': '✅',
    'Working On': '🔧',
    'Completed': '🎉',
    'Rejected': '❌'
  };

  const mailOptions = {
    from: `"TNSMP Portal" <${process.env.EMAIL_USER}>`,
    to: userEmail,
    subject: `TNSMP - Complaint ${complaint.ticketId} Status Update: ${newStatus}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 2px solid #1a237e; border-radius: 10px;">
        <h2 style="color: #1a237e; text-align: center;">Tamil Nadu Service Management Portal</h2>
        <hr style="border: 1px solid #e0e0e0;">
        <p style="font-size: 16px; color: #333;">Hello <strong>${userName}</strong>,</p>
        <p>Your complaint status has been updated:</p>
        <div style="background: #e8eaf6; padding: 15px; border-radius: 8px; margin: 15px 0;">
          <p><strong>Ticket ID:</strong> ${complaint.ticketId}</p>
          <p><strong>New Status:</strong> ${statusEmoji[newStatus] || ''} <strong>${newStatus}</strong></p>
          ${note ? `<p><strong>Note:</strong> ${note}</p>` : ''}
          ${complaint.assignedToName ? `<p><strong>Handled by:</strong> ${complaint.assignedToName}</p>` : ''}
        </div>
        <p style="font-size: 14px; color: #666;">Log in to the TNSMP portal to view full details.</p>
        <hr style="border: 1px solid #e0e0e0;">
        <p style="font-size: 12px; color: #999; text-align: center;">© 2026 TNSMP - Government of Tamil Nadu</p>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
};

module.exports = { sendOTP, sendProviderCredentials, sendComplaintAssignment, sendStatusUpdate };
