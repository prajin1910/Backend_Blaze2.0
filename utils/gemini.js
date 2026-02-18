const OpenAI = require('openai');

// OpenRouter API — compatible with OpenAI SDK, uses DeepSeek model
const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://tnsmp.gov.in',
    'X-Title': 'Tamil Nadu Service Management Portal'
  }
});

// ============================================================
// MODEL CONFIG — OpenRouter DeepSeek
// ============================================================
const MODEL = 'deepseek/deepseek-chat-v3-0324';
const FALLBACK_MODEL = 'deepseek/deepseek-chat';
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 2000;

// Track if API is permanently down (quota exceeded) to avoid wasting time
let cloudDisabledUntil = 0;
const CLOUD_COOLDOWN_MS = 5 * 60 * 1000; // 5 min cooldown after quota error

/**
 * Utility: call OpenAI ChatGPT with retry logic + fast-fail for quota errors
 */
async function callAI(prompt, maxTokens = 200) {
  // Skip cloud call entirely if we recently hit a quota/billing error
  if (Date.now() < cloudDisabledUntil) {
    console.log(`[OpenRouter SKIP] Cloud API disabled until ${new Date(cloudDisabledUntil).toLocaleTimeString()} (cooldown)`);
    return null;
  }

  const modelsToTry = [MODEL, FALLBACK_MODEL];

  for (const currentModel of modelsToTry) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await openai.chat.completions.create({
          model: currentModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.3
        });
        const text = response.choices[0]?.message?.content?.trim();
        console.log(`[OpenRouter OK] model=${currentModel}, attempt=${attempt + 1}, response_len=${text?.length || 0}`);
        cloudDisabledUntil = 0; // Reset on success
        return text || null;
      } catch (error) {
        const status = error.status || error.code || 0;
        console.warn(`[OpenRouter FAIL] model=${currentModel}, attempt=${attempt + 1}, status=${status}, msg=${error.message?.substring(0, 120)}`);

        // 401 (bad key) or 403 (forbidden) → fast-fail completely
        if (status === 401 || status === 403) {
          cloudDisabledUntil = Date.now() + CLOUD_COOLDOWN_MS;
          console.warn(`[OpenRouter] Auth error — disabling cloud AI for 5 minutes.`);
          return null;
        }
        // 429 (rate limit) → skip to fallback model
        if (status === 429) {
          console.warn(`[OpenRouter] Rate limited on ${currentModel}, trying next model...`);
          break; // break retry loop, try next model
        }
        // 500/502/503 = server error → retry once after delay
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
      }
    }
  }
  return null;
}

// ============================================================
// LOCAL FALLBACK: Keyword-based Priority Analysis
// ============================================================
const PRIORITY_KEYWORDS = {
  Critical: [
    'flood', 'fire', 'collapse', 'collapsed', 'accident', 'danger', 'dangerous',
    'emergency', 'fallen', 'burst', 'explosion', 'electrocution', 'death', 'dead',
    'drowning', 'sinkhole', 'gas leak', 'building crack', 'bridge damage',
    'short circuit', 'live wire', 'exposed wire', 'water contamination',
    'epidemic', 'outbreak', 'major damage', 'life threatening', 'critical',
    'fallen tree', 'road cave', 'wall collapse', 'roof collapse', 'sewage overflow'
  ],
  High: [
    'broken', 'pothole', 'leak', 'leaking', 'sewage', 'blocked', 'damaged',
    'contaminated', 'overflow', 'overflowing', 'no water', 'no electricity',
    'power cut', 'power outage', 'blackout', 'road damage', 'crack', 'cracked',
    'waterlogging', 'stagnant water', 'mosquito', 'garbage pile', 'dump',
    'illegal dumping', 'unsafe', 'hazard', 'risk', 'urgent',
    'no supply', 'pipeline break', 'main road', 'highway', 'bus breakdown',
    'traffic signal', 'drainage block', 'manhole open', 'missing cover'
  ],
  Medium: [
    'not working', 'malfunction', 'delayed', 'dirty', 'slow', 'complaint',
    'issue', 'problem', 'repair', 'maintenance', 'streetlight', 'lamp',
    'footpath', 'pavement', 'speed breaker', 'signal', 'noise', 'dust',
    'irregular', 'faulty', 'poor condition', 'needs attention', 'overdue',
    'pending', 'unresolved', 'partially', 'intermittent', 'sometimes'
  ],
  Low: [
    'request', 'suggestion', 'new', 'improvement', 'inquiry', 'information',
    'feedback', 'install', 'installation', 'propose', 'plan', 'future',
    'beautification', 'painting', 'garden', 'park', 'bench', 'sign board',
    'name board', 'bus stop', 'shelter', 'upgrade', 'enhance', 'minor'
  ]
};

function localPrioritize(description, department) {
  const text = (description + ' ' + department).toLowerCase();
  let scores = { Critical: 0, High: 0, Medium: 0, Low: 0 };

  for (const [level, keywords] of Object.entries(PRIORITY_KEYWORDS)) {
    for (const kw of keywords) {
      if (text.includes(kw)) {
        scores[level] += (level === 'Critical' ? 3 : level === 'High' ? 2 : 1);
      }
    }
  }

  const deptBoosts = {
    'Electricity': 1,
    'Water Resources': 1,
    'Public Health': 1,
    'Roads & Highways': 0.5
  };
  if (deptBoosts[department]) {
    scores.Critical += deptBoosts[department];
    scores.High += deptBoosts[department] * 0.5;
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (sorted[0][1] > 0) return sorted[0][0];
  return 'Medium';
}

// ============================================================
// LOCAL FALLBACK: Text-similarity Duplicate & Fake Detection
// ============================================================
function getWords(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
}

function jaccardSimilarity(wordsA, wordsB) {
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// Common English words + complaint-related words that indicate real content
const KNOWN_WORDS = new Set([
  // Common English
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one',
  'our', 'out', 'has', 'his', 'how', 'its', 'may', 'who', 'did', 'get', 'new', 'now', 'old',
  'see', 'way', 'day', 'too', 'any', 'been', 'from', 'have', 'here', 'just', 'like', 'long',
  'make', 'many', 'more', 'only', 'over', 'such', 'take', 'than', 'them', 'then', 'very',
  'when', 'come', 'could', 'into', 'made', 'after', 'back', 'also', 'with', 'this', 'that',
  'they', 'what', 'will', 'about', 'there', 'their', 'which', 'would', 'other', 'these',
  'some', 'time', 'being', 'does', 'where', 'before', 'between', 'each', 'even', 'much',
  'most', 'same', 'still', 'should', 'through', 'while', 'under', 'never', 'every', 'since',
  'need', 'help', 'please', 'because', 'near', 'facing', 'causing', 'people', 'daily',
  // Complaint-specific
  'road', 'water', 'street', 'light', 'area', 'working', 'broken', 'damage', 'damaged',
  'pipe', 'pipeline', 'drain', 'drainage', 'block', 'blocked', 'garbage', 'bus', 'power',
  'electricity', 'supply', 'issue', 'problem', 'repair', 'fix', 'fixed', 'days', 'weeks',
  'months', 'public', 'health', 'safety', 'danger', 'dangerous', 'flood', 'flooded',
  'sewage', 'pothole', 'pavement', 'footpath', 'bridge', 'building', 'house', 'school',
  'hospital', 'temple', 'church', 'mosque', 'park', 'garden', 'traffic', 'signal',
  'lamp', 'pole', 'wire', 'cable', 'tank', 'well', 'bore', 'motor', 'pump', 'valve',
  'meter', 'bill', 'connection', 'complaint', 'department', 'office', 'officer',
  'collector', 'corporation', 'municipality', 'panchayat', 'ward', 'zone', 'district',
  'village', 'town', 'city', 'nagar', 'colony', 'layout', 'main', 'cross', 'junction',
  'corner', 'side', 'front', 'behind', 'opposite', 'next', 'above', 'below',
  'morning', 'evening', 'night', 'today', 'yesterday', 'week', 'month', 'year',
  'leaking', 'overflowing', 'stagnant', 'contaminated', 'polluted', 'dirty', 'clean',
  'mosquito', 'insects', 'smell', 'stench', 'noise', 'dust', 'smoke', 'illegal',
  'construction', 'encroachment', 'parking', 'speed', 'accident', 'fallen', 'tree',
  'branch', 'fence', 'wall', 'gate', 'roof', 'floor', 'ceiling', 'window', 'door',
  'transformer', 'generator', 'inverter', 'streetlight', 'manhole', 'cover',
  'cracked', 'collapse', 'collapsed', 'sinking', 'eroded', 'erosion', 'landslide',
  'request', 'suggestion', 'improvement', 'install', 'installation', 'upgrade'
]);

function isKnownWord(word) {
  return KNOWN_WORDS.has(word) || word.length >= 6; // Long words are likely real
}

function localDetectDuplicateOrFake(description, department, area, existingComplaints) {
  const text = description.trim();

  // === FAKE DETECTION ===
  if (text.length < 10) {
    return { isDuplicate: false, duplicateOf: null, isFake: true, remarks: 'Description too short to be a valid complaint' };
  }

  const words = getWords(text);
  if (words.length === 0) {
    return { isDuplicate: false, duplicateOf: null, isFake: true, remarks: 'No meaningful words found in description' };
  }

  // Repeated characters detection (e.g., "aaaaaaa bbbbb ccccc")
  const repeatPattern = /(.)\1{4,}/;
  if (repeatPattern.test(text)) {
    return { isDuplicate: false, duplicateOf: null, isFake: true, remarks: 'Description contains repeated character patterns (spam)' };
  }

  // Check if words are recognizable English/complaint terms
  const knownCount = words.filter(w => isKnownWord(w)).length;
  const knownRatio = knownCount / words.length;

  if (knownRatio < 0.3 && words.length >= 3) {
    return { isDuplicate: false, duplicateOf: null, isFake: true, 
      remarks: `Description appears to be gibberish (only ${Math.round(knownRatio * 100)}% recognizable words)` };
  }

  // Check for keyboard-mashing patterns (consecutive keyboard letters)
  const keyboardPatterns = /asdf|qwert|zxcv|hjkl|uiop|bnm|wasd|jkl|fgh/gi;
  const lowerText = text.toLowerCase();
  const patternMatches = (lowerText.match(keyboardPatterns) || []).length;
  if (patternMatches >= 2) {
    return { isDuplicate: false, duplicateOf: null, isFake: true, remarks: 'Description appears to be keyboard-mashing / random input' };
  }

  // All same word repeated
  const uniqueWords = new Set(words);
  if (uniqueWords.size === 1 && words.length > 2) {
    return { isDuplicate: false, duplicateOf: null, isFake: true, remarks: 'Description is just the same word repeated' };
  }

  // === DUPLICATE DETECTION ===
  const newWords = getWords(description);
  let bestMatch = null;
  let bestScore = 0;

  for (const existing of existingComplaints) {
    if (existing.area !== area) continue;
    const existingWords = getWords(existing.description);
    const similarity = jaccardSimilarity(newWords, existingWords);
    if (similarity > bestScore) {
      bestScore = similarity;
      bestMatch = existing;
    }
  }

  if (bestScore >= 0.6 && bestMatch) {
    return {
      isDuplicate: true,
      duplicateOf: bestMatch.ticketId,
      isFake: false,
      remarks: `${Math.round(bestScore * 100)}% similar to existing complaint ${bestMatch.ticketId}`
    };
  }

  return { isDuplicate: false, duplicateOf: null, isFake: false, remarks: 'Complaint appears valid and unique' };
}

// ============================================================
// MAIN EXPORTS: OpenAI ChatGPT with local fallback
// ============================================================
const prioritizeComplaint = async (description, department) => {
  console.log('[AI Priority] Attempting OpenRouter/DeepSeek analysis...');

  const prompt = `You are an AI assistant for the Tamil Nadu Service Management Portal.
Analyze the following complaint and assign a priority level.

Department: ${department}
Complaint: ${description}

Consider these factors:
- Safety risk to public (Critical if immediate danger)
- Number of people affected
- Urgency of the issue
- Essential service disruption

Respond with ONLY one word - the priority level: Critical, High, Medium, or Low.

Examples:
- "Water pipeline burst flooding entire street" = Critical
- "Electricity pole fallen on road" = Critical
- "Streetlight not working for a week" = Medium
- "Pothole on main road" = High
- "Request for new bus stop" = Low`;

  const response = await callAI(prompt, 10);

  if (response) {
    const validPriorities = ['Critical', 'High', 'Medium', 'Low'];
    const priority = validPriorities.find(p => response.includes(p));
    if (priority) {
      console.log(`[AI Priority] Cloud AI result: ${priority}`);
      return priority;
    }
  }

  // Fallback to local keyword analysis
  const localResult = localPrioritize(description, department);
  console.log(`[AI Priority] Using local fallback: ${localResult}`);
  return localResult;
};

const detectDuplicateOrFake = async (description, department, area, existingComplaints) => {
  console.log('[AI DupCheck] Attempting OpenRouter/DeepSeek analysis...');

  // Always run local check first (fast, no API cost)
  const localResult = localDetectDuplicateOrFake(description, department, area, existingComplaints);

  // If local check already found fake/duplicate, return immediately
  if (localResult.isFake || localResult.isDuplicate) {
    console.log(`[AI DupCheck] Local detection caught it:`, localResult);
    return localResult;
  }

  // Try ChatGPT for more nuanced analysis
  if (existingComplaints.length > 0) {
    const existingSummaries = existingComplaints.slice(0, 15).map(c =>
      `[${c.ticketId}] "${c.description}" (Area: ${c.area}, Status: ${c.status})`
    ).join('\n');

    const prompt = `You are an AI assistant for the Tamil Nadu Service Management Portal.
Analyze this NEW complaint and determine if it is:
1. A DUPLICATE of an existing complaint (same issue, same area, same problem)
2. FAKE or nonsensical (gibberish text, impossible scenario, spam, test data)

NEW COMPLAINT:
Department: ${department}
Area: ${area}
Description: "${description}"

EXISTING COMPLAINTS IN SAME DEPARTMENT:
${existingSummaries}

Respond in this EXACT JSON format only (no markdown, no code blocks, no extra text):
{"isDuplicate": false, "duplicateOf": null, "isFake": false, "remarks": "Brief analysis"}

Rules:
- isDuplicate: true ONLY if description closely matches an existing complaint in same area
- duplicateOf: the ticketId of the matching complaint, or null
- isFake: true if the description is gibberish, nonsensical, clearly fabricated, or spam
- remarks: brief 1-line explanation of your analysis`;

    const response = await callAI(prompt, 150);

    if (response) {
      try {
        let cleaned = response;
        if (cleaned.startsWith('```')) {
          cleaned = cleaned.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        }
        const parsed = JSON.parse(cleaned);
        const cloudResult = {
          isDuplicate: !!parsed.isDuplicate,
          duplicateOf: parsed.duplicateOf || null,
          isFake: !!parsed.isFake,
          remarks: parsed.remarks || ''
        };
        console.log(`[AI DupCheck] Cloud AI result:`, cloudResult);
        return cloudResult;
      } catch (parseErr) {
        console.warn('[AI DupCheck] Failed to parse cloud AI response:', response?.substring(0, 100));
      }
    }
  }

  // Return local result as fallback
  console.log(`[AI DupCheck] Using local fallback:`, localResult);
  return localResult;
};

module.exports = { prioritizeComplaint, detectDuplicateOrFake, callAI };
