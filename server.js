const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const complaintRoutes = require('./routes/complaints');
const managementRoutes = require('./routes/management');
const providerRoutes = require('./routes/provider');
const chatbotRoutes = require('./routes/chatbot');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/complaints', complaintRoutes);
app.use('/api/management', managementRoutes);
app.use('/api/provider', providerRoutes);
app.use('/api/chatbot', chatbotRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'TNSMP Backend Running', timestamp: new Date() });
});

// AI Health check — test OpenRouter/DeepSeek connectivity
app.get('/api/ai-status', async (req, res) => {
  try {
    const OpenAI = require('openai');
    const client = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
      defaultHeaders: {
        'HTTP-Referer': 'https://tnsmp.gov.in',
        'X-Title': 'Tamil Nadu Service Management Portal'
      }
    });
    const result = await client.chat.completions.create({
      model: 'deepseek/deepseek-chat-v3-0324',
      messages: [{ role: 'user', content: 'Reply with only the word OK' }],
      max_tokens: 5
    });
    const text = result.choices[0]?.message?.content?.trim();
    res.json({ 
      aiStatus: 'online', 
      model: 'DeepSeek via OpenRouter', 
      response: text,
      fallback: 'Local NLP analysis active as backup'
    });
  } catch (err) {
    res.json({ 
      aiStatus: 'fallback', 
      model: 'local-nlp',
      error: err.message?.substring(0, 100),
      fallback: 'Local keyword + similarity AI analysis is fully operational'
    });
  }
});

// Connect to MongoDB and start server
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB Atlas');
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => {
      console.log(`TNSMP Backend running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });
