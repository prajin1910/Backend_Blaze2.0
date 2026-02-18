const express = require('express');
const Complaint = require('../models/Complaint');
const auth = require('../middleware/auth');
const { callAI } = require('../utils/gemini');

const router = express.Router();

// In-memory conversation history per user (cleared on server restart)
const conversationHistory = new Map();
const MAX_HISTORY = 10; // Keep last 10 exchanges per user

// Strip markdown formatting from AI responses
function stripMarkdown(text) {
  if (!text) return text;
  return text
    .replace(/\*\*\*(.*?)\*\*\*/g, '$1')  // ***bold italic***
    .replace(/\*\*(.*?)\*\*/g, '$1')       // **bold**
    .replace(/\*(.*?)\*/g, '$1')           // *italic*
    .replace(/__(.*?)__/g, '$1')           // __bold__
    .replace(/_(.*?)_/g, '$1')             // _italic_
    .replace(/^#{1,6}\s+/gm, '')          // # headings
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [links](url)
    .replace(/`([^`]+)`/g, '$1')           // `inline code`
    .trim();
}

/**
 * POST /api/chatbot
 * Body: { message: string }
 * Auth: user role only
 *
 * AI chatbot that answers queries about the user's complaints,
 * statuses, departments, timelines, etc.
 */
router.post('/', auth(['user']), async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ message: 'Message is required' });
    }

    const userId = req.user.id;
    const userName = req.user.name || 'User';

    // Fetch user's complaints
    const complaints = await Complaint.find({ userId })
      .sort({ createdAt: -1 })
      .select('ticketId department description status priority area address assignedToName createdAt updatedAt statusHistory rating feedback resolution isDuplicate aiRemarks')
      .lean();

    // Build complaint summary for the AI context
    let complaintContext = '';
    if (complaints.length === 0) {
      complaintContext = 'This user has no complaints registered yet.';
    } else {
      complaintContext = `This user has ${complaints.length} complaint(s):\n\n`;
      complaints.forEach((c, i) => {
        const latestHistory = c.statusHistory && c.statusHistory.length > 0
          ? c.statusHistory[c.statusHistory.length - 1]
          : null;

        complaintContext += `${i + 1}. Ticket: ${c.ticketId}\n`;
        complaintContext += `   Department: ${c.department}\n`;
        complaintContext += `   Description: ${c.description.substring(0, 150)}\n`;
        complaintContext += `   Status: ${c.status}\n`;
        complaintContext += `   Priority: ${c.priority}\n`;
        complaintContext += `   Area: ${c.area}${c.address ? ' (' + c.address.substring(0, 80) + ')' : ''}\n`;
        if (c.assignedToName) complaintContext += `   Assigned To: ${c.assignedToName}\n`;
        complaintContext += `   Filed On: ${new Date(c.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}\n`;
        if (latestHistory && latestHistory.note) {
          complaintContext += `   Latest Update: ${latestHistory.note} (${new Date(latestHistory.timestamp).toLocaleDateString('en-IN')})\n`;
        }
        if (c.resolution) complaintContext += `   Resolution: ${c.resolution}\n`;
        if (c.rating) complaintContext += `   User Rating: ${c.rating}/5\n`;
        if (c.isDuplicate) complaintContext += `   Note: Flagged as duplicate\n`;
        if (c.aiRemarks) complaintContext += `   AI Remarks: ${c.aiRemarks}\n`;
        complaintContext += '\n';
      });
    }

    // Get or initialize conversation history
    if (!conversationHistory.has(userId)) {
      conversationHistory.set(userId, []);
    }
    const history = conversationHistory.get(userId);

    // Build history context string
    let historyContext = '';
    if (history.length > 0) {
      historyContext = '\n\nRecent conversation:\n';
      history.forEach(h => {
        historyContext += `User: ${h.user}\nAssistant: ${h.assistant}\n`;
      });
    }

    // Build the prompt
    const systemPrompt = `You are a helpful and friendly AI assistant for the Tamil Nadu Service Management Portal (TNSMP). Your name is TNSMP Assistant.

Your role is to help citizens with queries about their registered complaints — statuses, timelines, departments, next steps, and general guidance.

RULES:
- Be concise, clear, and helpful. Keep responses under 150 words unless the user asks for details.
- Only share information about THIS user's complaints. Never fabricate complaint data.
- If asked about something unrelated to complaints or the portal, politely redirect.
- Use a friendly, professional tone. You may use simple emojis for warmth.
- If the user has no complaints, suggest they file one via the "Raise Complaint" page.
- When referencing complaints, always mention the Ticket ID.
- NEVER use markdown formatting. No ** or * for bold/italic. No # headings. Just plain text.
- Use numbered lists (1. 2. 3.) and bullet points (•) for structure.
- Use CAPS or quotes for emphasis instead of markdown stars.
- Format complaint lists cleanly like:
  1. TNSMP-XXXXXX-XXX | Department | Status | Priority
     Assigned to: Name | Filed: Date
- For status queries, explain what each status means:
  • Registered = Complaint received, pending review
  • Accepted = Reviewed and accepted by service provider
  • Working On = Service provider is actively resolving it
  • Completed = Issue has been resolved
  • Rejected = Complaint was rejected (duplicate/invalid)

USER: ${userName}
${complaintContext}${historyContext}

User's question: ${message}`;

    // Call AI
    let aiResponse = await callAI(systemPrompt, 400);

    // Fallback if AI is unavailable
    if (!aiResponse) {
      aiResponse = generateLocalResponse(message, complaints, userName);
    }

    // Strip any markdown formatting
    aiResponse = stripMarkdown(aiResponse);

    // Save to conversation history
    history.push({ user: message, assistant: aiResponse });
    if (history.length > MAX_HISTORY) {
      history.shift(); // Remove oldest
    }

    res.json({ reply: aiResponse });
  } catch (error) {
    console.error('[Chatbot] Error:', error.message);
    res.status(500).json({ 
      reply: "I'm sorry, I encountered an error processing your request. Please try again in a moment." 
    });
  }
});

// Clear conversation history
router.delete('/history', auth(['user']), (req, res) => {
  conversationHistory.delete(req.user.id);
  res.json({ message: 'Conversation history cleared' });
});

/**
 * Local fallback response generator when AI is unavailable
 */
function generateLocalResponse(message, complaints, userName) {
  const msg = message.toLowerCase();

  // Greeting
  if (msg.match(/^(hi|hello|hey|good morning|good evening|namaste)/)) {
    return `Hello ${userName}! 👋 I'm your TNSMP Assistant. You have ${complaints.length} complaint(s) on record. How can I help you today? You can ask me about your complaint status, timelines, or any other queries.`;
  }

  // Complaint count
  if (msg.includes('how many') && (msg.includes('complaint') || msg.includes('ticket'))) {
    const active = complaints.filter(c => ['Registered', 'Accepted', 'Working On'].includes(c.status)).length;
    const completed = complaints.filter(c => c.status === 'Completed').length;
    return `You have ${complaints.length} total complaint(s): ${active} active and ${completed} completed.`;
  }

  // Status query
  if (msg.includes('status') || msg.includes('update') || msg.includes('track') || msg.includes('where') || msg.includes('progress')) {
    if (complaints.length === 0) {
      return "You don't have any complaints registered yet. You can file one from the 'Raise Complaint' page.";
    }

    // Check if asking about specific ticket
    const ticketMatch = msg.match(/tnsmp-\d+-\d+/i);
    if (ticketMatch) {
      const ticket = complaints.find(c => c.ticketId.toLowerCase() === ticketMatch[0].toLowerCase());
      if (ticket) {
        return `📋 ${ticket.ticketId}\nStatus: ${ticket.status}\nDepartment: ${ticket.department}\nPriority: ${ticket.priority}\n${ticket.assignedToName ? `Assigned to: ${ticket.assignedToName}` : 'Awaiting assignment'}\nFiled: ${new Date(ticket.createdAt).toLocaleDateString('en-IN')}`;
      }
      return "I couldn't find that ticket ID in your complaints. Please check and try again.";
    }

    // General status overview
    const latest = complaints[0];
    let response = `Here's your latest complaint:\n\n📋 ${latest.ticketId} — ${latest.status}\n${latest.department} | ${latest.priority} priority\n${latest.description.substring(0, 80)}...\n`;
    if (complaints.length > 1) {
      response += `\nYou have ${complaints.length - 1} other complaint(s). Ask me about a specific ticket ID for details!`;
    }
    return response;
  }

  // List all complaints
  if (msg.includes('list') || msg.includes('all') || msg.includes('show')) {
    if (complaints.length === 0) {
      return "You don't have any complaints yet. Head to 'Raise Complaint' to file one!";
    }
    let response = `Here are your complaints:\n\n`;
    complaints.slice(0, 5).forEach((c, i) => {
      response += `${i + 1}. ${c.ticketId} | ${c.department} | ${c.status} | ${c.priority}\n   ${c.area}\n`;
    });
    if (complaints.length > 5) {
      response += `\n...and ${complaints.length - 5} more. Visit 'My Complaints' for the full list.`;
    }
    return response;
  }

  // Help / what can you do
  if (msg.includes('help') || msg.includes('what can you') || msg.includes('what do you')) {
    return `I can help you with:\n\n• 📊 Check complaint status\n• 📋 List all your complaints\n• 🔍 Get details on a specific ticket\n• 📈 Track complaint progress\n• ❓ Answer questions about the portal\n\nJust ask me anything!`;
  }

  // Default
  return `I have access to your ${complaints.length} complaint(s). You can ask me about:\n• Your complaint status or progress\n• Details about a specific ticket ID\n• How many complaints you have\n• What different statuses mean\n\nHow can I help you?`;
}

module.exports = router;
