// WeTow Cars - Backend Server for Google Maps API
// UPDATED: Using environment variables with dotenv and rate limiting

// Load environment variables first
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;

// CRITICAL: Load API key from environment variable
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Validate API key is present
if (!GOOGLE_MAPS_API_KEY) {
  console.error('❌ CRITICAL ERROR: GOOGLE_MAPS_API_KEY not found in environment variables');
  console.error('Please create a .env file with GOOGLE_MAPS_API_KEY=your_key_here');
  process.exit(1);
}

// Parse allowed origins from environment (comma-separated)
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:19006', 'http://localhost:8081', 'exp://localhost:8081'];

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.warn('⚠️ CORS blocked request from:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());

// Rate limiting configuration
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per 15 minutes
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 500, // Limit each IP to 500 API requests per hour
  message: 'Too many API requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to specific endpoints
app.use('/autocomplete', apiLimiter);
app.use('/place-details', apiLimiter);
app.use('/distance', apiLimiter);
app.use('/geocode', apiLimiter);

// Health check endpoint
app.get('/', generalLimiter, (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'WeTow Cars Server Running',
    timestamp: new Date().toISOString(),
    apiKeyConfigured: !!GOOGLE_MAPS_API_KEY,
  });
});

// Google Places Autocomplete endpoint
app.get('/autocomplete', async (req, res) => {
  const { input } = req.query;

  if (!input) {
    return res.status(400).json({ error: 'Input parameter is required' });
  }

  try {
    console.log('📍 Autocomplete request for:', input);
    
    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/place/autocomplete/json',
      {
        params: {
          input: input,
          key: GOOGLE_MAPS_API_KEY,
          components: 'country:za',
          types: 'address',
        },
      }
    );

    console.log('✅ Autocomplete results:', response.data.predictions.length);
    res.json(response.data);
  } catch (error) {
    console.error('❌ Autocomplete error:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch autocomplete suggestions',
      details: error.message 
    });
  }
});

// Google Place Details endpoint
app.get('/place-details', async (req, res) => {
  const { place_id } = req.query;

  if (!place_id) {
    return res.status(400).json({ error: 'place_id parameter is required' });
  }

  try {
    console.log('🔍 Place details request for place_id:', place_id);
    
    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/place/details/json',
      {
        params: {
          place_id: place_id,
          key: GOOGLE_MAPS_API_KEY,
          fields: 'geometry,formatted_address,name',
        },
      }
    );

    if (response.data.result && response.data.result.geometry) {
      const result = response.data.result;
      const location = result.geometry.location;
      
      console.log('✅ Place details found:');
      console.log('   Name:', result.name || 'N/A');
      console.log('   Address:', result.formatted_address);
      console.log('   Coordinates: lat:', location.lat, 'lng:', location.lng);
      
      res.json(response.data);
    } else {
      console.error('❌ Place details not found for place_id:', place_id);
      res.status(404).json({ 
        error: 'Place details not found',
        place_id: place_id
      });
    }
  } catch (error) {
    console.error('❌ Place details error:', error.message);
    
    if (error.response) {
      console.error('   API Response Status:', error.response.status);
      console.error('   API Response Data:', error.response.data);
    }
    
    res.status(500).json({ 
      error: 'Failed to fetch place details',
      details: error.message,
      place_id: place_id
    });
  }
});

// Distance Matrix endpoint
app.post('/distance', async (req, res) => {
  const { origin, destination } = req.body;

  if (!origin || !destination) {
    return res.status(400).json({ 
      error: 'Origin and destination are required' 
    });
  }

  try {
    console.log('📏 Distance request from:', origin, 'to:', destination);
    
    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/distancematrix/json',
      {
        params: {
          origins: origin,
          destinations: destination,
          key: GOOGLE_MAPS_API_KEY,
          units: 'metric',
        },
      }
    );

    if (response.data.rows[0]?.elements[0]?.status === 'OK') {
      const distance = response.data.rows[0].elements[0].distance.value;
      const duration = response.data.rows[0].elements[0].duration.value;
      
      console.log('✅ Distance:', distance, 'meters (', (distance/1000).toFixed(2), 'km )');
      console.log('✅ Duration:', duration, 'seconds (', (duration/60).toFixed(1), 'min )');
      
      res.json({
        distance: distance,
        duration: duration,
        distanceText: response.data.rows[0].elements[0].distance.text,
        durationText: response.data.rows[0].elements[0].duration.text,
      });
    } else {
      console.error('❌ Distance calculation failed');
      console.error('   Status:', response.data.rows[0]?.elements[0]?.status);
      res.status(400).json({ 
        error: 'Could not calculate distance between locations',
        status: response.data.rows[0]?.elements[0]?.status
      });
    }
  } catch (error) {
    console.error('❌ Distance error:', error.message);
    res.status(500).json({ 
      error: 'Failed to calculate distance',
      details: error.message 
    });
  }
});

// Geocoding endpoint
app.get('/geocode', async (req, res) => {
  const { address } = req.query;

  if (!address) {
    return res.status(400).json({ error: 'Address parameter is required' });
  }

  try {
    console.log('🌍 Geocoding address:', address);
    
    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/geocode/json',
      {
        params: {
          address: address,
          key: GOOGLE_MAPS_API_KEY,
        },
      }
    );

    if (response.data.results.length > 0) {
      const location = response.data.results[0].geometry.location;
      console.log('✅ Coordinates:', location);
      
      res.json({
        latitude: location.lat,
        longitude: location.lng,
        formattedAddress: response.data.results[0].formatted_address,
      });
    } else {
      console.error('❌ Address not found:', address);
      res.status(404).json({ error: 'Address not found' });
    }
  } catch (error) {
    console.error('❌ Geocoding error:', error.message);
    res.status(500).json({ 
      error: 'Failed to geocode address',
      details: error.message 
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║   🚗 WeTow Cars Backend Server                    ║');
  console.log(`║   Server running on http://localhost:${PORT}         ║`);
  console.log('╚════════════════════════════════════════════════════╝');
  console.log('');
  console.log('📍 Available API Endpoints:');
  console.log('   GET  /                  - Health check');
  console.log('   GET  /autocomplete      - Address autocomplete suggestions');
  console.log('   GET  /place-details     - Get coordinates from place_id');
  console.log('   POST /distance          - Calculate distance between locations');
  console.log('   GET  /geocode           - Convert address to coordinates');
  console.log('');
  console.log('🔐 Security Status:');
  console.log('   API Key: ✅ Loaded from environment');
  console.log('   CORS: ✅ Configured for:', ALLOWED_ORIGINS.join(', '));
  console.log('   Rate Limiting: ✅ 100 req/15min general, 500 req/hour API');
  console.log('');
  console.log('✅ Server is ready to handle requests!');
  console.log('💡 Press Ctrl+C to stop the server');
  console.log('');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n');
  console.log('👋 Shutting down WeTow Cars server...');
  console.log('✅ Server stopped successfully');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n');
  console.log('👋 Shutting down WeTow Cars server...');
  console.log('✅ Server stopped successfully');
  process.exit(0);
});