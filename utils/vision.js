const vision = require('@google-cloud/vision');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');

// Initialize Vision client — prefer env var, fallback to key file
let visionClientOptions = {};
if (process.env.GOOGLE_CREDENTIALS) {
  try {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    visionClientOptions = { credentials: creds };
    console.log('[Vision] Using GOOGLE_CREDENTIALS from environment');
  } catch (e) {
    console.warn('[Vision] Failed to parse GOOGLE_CREDENTIALS env var:', e.message);
  }
}
if (!visionClientOptions.credentials) {
  const keyPath = path.join(__dirname, '..', 'config', 'vision-key.json');
  if (fs.existsSync(keyPath)) {
    visionClientOptions = { keyFilename: keyPath };
    console.log('[Vision] Using key file:', keyPath);
  } else {
    console.warn('[Vision] No credentials found — Vision API calls will use fallback');
  }
}
const client = new vision.ImageAnnotatorClient(visionClientOptions);

// Initialize OpenRouter client for vision fallback
const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://tnsmp.gov.in',
    'X-Title': 'Tamil Nadu Service Management Portal'
  }
});

// ============================================================
// DEPARTMENT MAPPING — keywords from Vision API labels → department
// ============================================================
const DEPARTMENT_KEYWORDS = {
  'Water Resources': {
    keywords: [
      'water', 'pipe', 'pipeline', 'flood', 'flooding', 'drain', 'drainage',
      'sewage', 'sewer', 'leak', 'leaking', 'plumbing', 'tap', 'faucet',
      'water supply', 'borewell', 'well', 'tank', 'overhead tank', 'pump',
      'waterlogging', 'stagnant water', 'canal', 'river', 'pond', 'reservoir',
      'water contamination', 'dirty water', 'water body', 'puddle', 'swimming pool',
      'moisture', 'wet', 'liquid', 'fluid', 'sprinkler', 'hydrant', 'valve',
      'water pipe', 'water tank', 'water damage', 'water overflow'
    ],
    weight: 1.0
  },
  'Electricity': {
    keywords: [
      'electric', 'electricity', 'wire', 'wiring', 'cable', 'power line',
      'transformer', 'pole', 'power pole', 'utility pole', 'streetlight',
      'street light', 'lamp', 'lamp post', 'bulb', 'light', 'lighting',
      'electric pole', 'power outage', 'blackout', 'short circuit',
      'electrical', 'voltage', 'current', 'generator', 'inverter',
      'circuit breaker', 'meter', 'electric meter', 'fuse', 'switch',
      'overhead line', 'high tension', 'conductor', 'insulator',
      'power grid', 'substation', 'energy', 'neon', 'fluorescent',
      'led', 'electrical equipment', 'power supply', 'electric line'
    ],
    weight: 1.0
  },
  'Roads & Highways': {
    keywords: [
      'road', 'highway', 'pothole', 'crack', 'asphalt', 'pavement',
      'footpath', 'sidewalk', 'bridge', 'flyover', 'overpass', 'underpass',
      'speed breaker', 'speed bump', 'divider', 'median', 'curb',
      'road damage', 'road construction', 'tar', 'concrete', 'gravel',
      'lane', 'intersection', 'junction', 'roundabout', 'road sign',
      'traffic sign', 'barricade', 'guardrail', 'railing', 'manhole',
      'road surface', 'street', 'avenue', 'boulevard', 'path', 'trail',
      'cobblestone', 'bitumen', 'roadwork', 'paving', 'road marking',
      'zebra crossing', 'crosswalk', 'pedestrian', 'roadway', 'infrastructure'
    ],
    weight: 1.0
  },
  'Sanitation': {
    keywords: [
      'garbage', 'trash', 'waste', 'dump', 'litter', 'debris', 'rubbish',
      'dustbin', 'bin', 'dumpster', 'compost', 'recycling', 'junk',
      'pollution', 'dirty', 'filth', 'mess', 'unhygienic', 'unsanitary',
      'toilet', 'restroom', 'latrine', 'sewage', 'sanitation',
      'cleaning', 'sweeping', 'disposal', 'waste management',
      'plastic', 'plastic waste', 'polythene', 'bottle', 'cans',
      'food waste', 'organic waste', 'landfill', 'decomposition',
      'stench', 'smell', 'odor', 'foul smell', 'rot', 'rotten',
      'contamination', 'hazardous waste', 'biomedical waste'
    ],
    weight: 1.0
  },
  'Public Health': {
    keywords: [
      'hospital', 'clinic', 'medical', 'health', 'disease', 'infection',
      'mosquito', 'pest', 'insect', 'rat', 'rodent', 'cockroach',
      'dengue', 'malaria', 'epidemic', 'pandemic', 'vaccination',
      'medicine', 'pharmacy', 'doctor', 'nurse', 'patient',
      'ambulance', 'emergency', 'first aid', 'health hazard',
      'contamination', 'polluted', 'toxic', 'chemical', 'smoke',
      'air pollution', 'respiratory', 'safety', 'biohazard',
      'stagnant', 'breeding ground', 'larvae', 'fly', 'flies',
      'public health', 'hygiene', 'disinfection', 'sanitizer'
    ],
    weight: 1.0
  },
  'Education': {
    keywords: [
      'school', 'college', 'university', 'classroom', 'education',
      'student', 'teacher', 'blackboard', 'whiteboard', 'desk',
      'chair', 'bench', 'library', 'book', 'notebook', 'stationery',
      'playground', 'campus', 'laboratory', 'computer lab',
      'hostel', 'canteen', 'auditorium', 'sports', 'academic',
      'tuition', 'exam', 'scholarship', 'learning'
    ],
    weight: 0.8
  },
  'Transport': {
    keywords: [
      'bus', 'bus stop', 'bus stand', 'bus station', 'bus shelter',
      'traffic', 'traffic light', 'traffic signal', 'traffic jam',
      'vehicle', 'car', 'truck', 'auto', 'rickshaw', 'train',
      'railway', 'metro', 'station', 'platform', 'parking',
      'accident', 'collision', 'transport', 'transportation',
      'commute', 'transit', 'route', 'highway', 'signal',
      'pedestrian crossing', 'overloaded', 'public transport'
    ],
    weight: 0.9
  },
  'Revenue': {
    keywords: [
      'land', 'property', 'boundary', 'survey', 'deed', 'title',
      'encroachment', 'illegal construction', 'demolition',
      'tax', 'revenue', 'registration', 'document', 'certificate',
      'patta', 'chitta', 'adangal', 'land record', 'measurement'
    ],
    weight: 0.7
  },
  'Agriculture': {
    keywords: [
      'farm', 'crop', 'field', 'agriculture', 'farming', 'harvest',
      'irrigation', 'fertilizer', 'pesticide', 'soil', 'seed',
      'tractor', 'plowing', 'cattle', 'livestock', 'poultry',
      'paddy', 'rice', 'wheat', 'vegetable', 'fruit', 'garden',
      'horticulture', 'plantation', 'orchard', 'greenhouse',
      'drought', 'pest attack', 'crop damage', 'agricultural land'
    ],
    weight: 0.8
  }
};

/**
 * Analyze an image using Google Cloud Vision API.
 * Returns labels, objects and text detected in the image.
 */
async function analyzeImage(base64Image) {
  try {
    // Strip data URI prefix if present (e.g., "data:image/jpeg;base64,...")
    let imageData = base64Image;
    if (imageData.includes(',')) {
      imageData = imageData.split(',')[1];
    }

    const request = {
      image: { content: imageData },
      features: [
        { type: 'LABEL_DETECTION', maxResults: 20 },
        { type: 'OBJECT_LOCALIZATION', maxResults: 15 },
        { type: 'TEXT_DETECTION', maxResults: 5 },
        { type: 'WEB_DETECTION', maxResults: 10 }
      ]
    };

    console.log('[Vision API] Sending image for analysis...');
    const [result] = await client.annotateImage(request);

    // Collect all detected terms
    const labels = (result.labelAnnotations || []).map(l => ({
      description: l.description.toLowerCase(),
      score: l.score
    }));

    const objects = (result.localizedObjectAnnotations || []).map(o => ({
      name: o.name.toLowerCase(),
      score: o.score
    }));

    const textAnnotations = result.textAnnotations || [];
    const detectedText = textAnnotations.length > 0
      ? textAnnotations[0].description.toLowerCase()
      : '';

    const webEntities = (result.webDetection?.webEntities || [])
      .filter(e => e.description)
      .map(e => ({
        description: e.description.toLowerCase(),
        score: e.score || 0
      }));

    console.log('[Vision API] Labels:', labels.map(l => `${l.description}(${(l.score * 100).toFixed(0)}%)`).join(', '));
    console.log('[Vision API] Objects:', objects.map(o => `${o.name}(${(o.score * 100).toFixed(0)}%)`).join(', '));
    if (detectedText) console.log('[Vision API] Text detected:', detectedText.substring(0, 100));
    console.log('[Vision API] Web entities:', webEntities.map(w => w.description).join(', '));

    return { labels, objects, detectedText, webEntities, source: 'google-vision' };
  } catch (error) {
    console.error('[Vision API] Google Cloud Vision failed:', error.message);
    // Fall back to OpenRouter vision model
    return await analyzeImageViaOpenRouter(base64Image);
  }
}

/**
 * Fallback: Analyze image using OpenRouter with vision-capable model.
 * Uses GPT-4o-mini or Gemini Flash which support image input.
 */
async function analyzeImageViaOpenRouter(base64Image) {
  console.log('[Vision Fallback] Trying OpenRouter vision model...');

  // Ensure proper data URI format
  let imageUrl = base64Image;
  if (!imageUrl.startsWith('data:')) {
    imageUrl = `data:image/jpeg;base64,${imageUrl}`;
  }

  const VISION_MODELS = ['openai/gpt-4o-mini', 'google/gemini-2.0-flash-001'];
  const deptList = Object.keys(DEPARTMENT_KEYWORDS).join(', ');

  for (const model of VISION_MODELS) {
    try {
      const response = await openrouter.chat.completions.create({
        model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `You are an image analysis AI for the Tamil Nadu Service Management Portal.
Analyze this image of a civic issue/complaint and determine:
1. What objects, issues, or problems are visible in the image
2. Which government department should handle this complaint

Available departments: ${deptList}, General

Respond in this EXACT JSON format only (no markdown, no code blocks):
{"labels": ["label1", "label2", "label3", "label4", "label5"], "department": "Department Name", "reason": "Brief explanation of why this department"}`
              },
              {
                type: 'image_url',
                image_url: { url: imageUrl }
              }
            ]
          }
        ],
        max_tokens: 200,
        temperature: 0.2
      });

      const text = response.choices[0]?.message?.content?.trim();
      console.log(`[Vision Fallback] ${model} response:`, text?.substring(0, 200));

      if (text) {
        let cleaned = text;
        if (cleaned.startsWith('```')) {
          cleaned = cleaned.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        }
        const parsed = JSON.parse(cleaned);
        const labels = (parsed.labels || []).map(l => ({
          description: l.toLowerCase(),
          score: 0.8
        }));

        return {
          labels,
          objects: [],
          detectedText: '',
          webEntities: [],
          source: 'openrouter-vision',
          directDepartment: parsed.department,
          directReason: parsed.reason
        };
      }
    } catch (err) {
      console.warn(`[Vision Fallback] ${model} failed:`, err.message?.substring(0, 100));
    }
  }

  console.error('[Vision Fallback] All vision models failed');
  return { labels: [], objects: [], detectedText: '', webEntities: [], source: 'none' };
}

/**
 * Map Vision API results to the most appropriate department.
 * Returns { department, confidence, detectedLabels, reason }
 */
function mapToDepartment(visionResults) {
  const { labels, objects, detectedText, webEntities, source, directDepartment, directReason } = visionResults;

  // If OpenRouter vision model directly returned a department, validate and use it
  if (directDepartment && source === 'openrouter-vision') {
    const validDepts = [...Object.keys(DEPARTMENT_KEYWORDS), 'General'];
    const matched = validDepts.find(d => d.toLowerCase() === directDepartment.toLowerCase());
    if (matched) {
      return {
        department: matched,
        confidence: 85,
        detectedLabels: labels.slice(0, 8).map(l => l.description),
        matchedKeywords: [],
        reason: directReason || `AI vision detected: ${matched}`,
        source
      };
    }
  }

  // Combine all detected terms into a single searchable text
  const allTerms = [
    ...labels.map(l => ({ term: l.description, score: l.score, source: 'label' })),
    ...objects.map(o => ({ term: o.name, score: o.score, source: 'object' })),
    ...webEntities.map(w => ({ term: w.description, score: w.score || 0.5, source: 'web' }))
  ];

  // Score each department
  const scores = {};
  const matchedKeywords = {};

  for (const [department, config] of Object.entries(DEPARTMENT_KEYWORDS)) {
    scores[department] = 0;
    matchedKeywords[department] = [];

    for (const item of allTerms) {
      for (const keyword of config.keywords) {
        if (item.term.includes(keyword) || keyword.includes(item.term)) {
          const contribution = item.score * config.weight *
            (item.source === 'label' ? 1.2 : item.source === 'object' ? 1.0 : 0.8);
          scores[department] += contribution;
          if (!matchedKeywords[department].includes(keyword)) {
            matchedKeywords[department].push(keyword);
          }
        }
      }
    }

    // Also check detected text
    if (detectedText) {
      for (const keyword of config.keywords) {
        if (detectedText.includes(keyword)) {
          scores[department] += 0.5 * config.weight;
          if (!matchedKeywords[department].includes(keyword)) {
            matchedKeywords[department].push(`text:${keyword}`);
          }
        }
      }
    }
  }

  // Sort departments by score
  const sorted = Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .filter(([, score]) => score > 0);

  if (sorted.length === 0) {
    return {
      department: 'General',
      confidence: 0,
      detectedLabels: labels.slice(0, 8).map(l => l.description),
      reason: 'Could not match image to a specific department',
      allScores: scores,
      source: source || 'keyword-mapping'
    };
  }

  const [topDept, topScore] = sorted[0];
  const totalScore = sorted.reduce((sum, [, s]) => sum + s, 0);
  const confidence = totalScore > 0 ? Math.min(Math.round((topScore / totalScore) * 100), 99) : 0;

  return {
    department: topDept,
    confidence,
    detectedLabels: labels.slice(0, 8).map(l => l.description),
    matchedKeywords: matchedKeywords[topDept],
    reason: `Detected: ${matchedKeywords[topDept].slice(0, 5).join(', ')}`,
    allScores: Object.fromEntries(sorted.slice(0, 3)),
    source: source || 'keyword-mapping'
  };
}

/**
 * Full pipeline: Analyze image and return auto-detected department.
 */
async function detectDepartmentFromImage(base64Image) {
  try {
    const visionResults = await analyzeImage(base64Image);
    const departmentResult = mapToDepartment(visionResults);

    console.log(`[Vision API] Auto-detected department: ${departmentResult.department} (${departmentResult.confidence}% confidence)`);
    console.log(`[Vision API] Matched keywords:`, departmentResult.matchedKeywords);
    console.log(`[Vision API] Labels:`, departmentResult.detectedLabels);

    return departmentResult;
  } catch (error) {
    console.error('[Vision API] Department detection failed:', error.message);
    // Return a fallback
    return {
      department: 'General',
      confidence: 0,
      detectedLabels: [],
      reason: 'Vision API analysis failed: ' + error.message,
      error: true
    };
  }
}

module.exports = { analyzeImage, mapToDepartment, detectDepartmentFromImage };
