// FILE: C:\WeTow\server\server.js
// WeTow Backend Server - Google Maps API Proxy + PayFast Payment Callbacks
// Deploy to Render as a Web Service

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

// Firebase Admin SDK for updating job payment status
let db = null;
try {
  const admin = require('firebase-admin');
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(
      Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8')
    );
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp();
  } else {
    admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'wetow-unified' });
  }
  db = admin.firestore();
  console.log('✅ Firebase Admin initialized');
} catch (e) {
  console.warn('⚠️ Firebase Admin not initialized:', e.message);
  console.warn('   PayFast webhooks will log but not update Firestore');
}

const app = express();
const PORT = process.env.PORT || 3001;

// PayFast config
const PAYFAST_MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID || '33800919';
const PAYFAST_PASSPHRASE = process.env.PAYFAST_PASSPHRASE || 'WeTow2026_Secure';

// Rate limiting configuration
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const MAX_REQUESTS_PER_WINDOW = 500;

// CORS configuration
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting middleware
const rateLimit = (req, res, next) => {
  // Skip rate limiting for PayFast webhooks
  if (req.path.startsWith('/payfast/')) return next();
  
  const clientIP = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!rateLimitMap.has(clientIP)) {
    rateLimitMap.set(clientIP, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }
  
  const clientData = rateLimitMap.get(clientIP);
  
  if (now > clientData.resetTime) {
    rateLimitMap.set(clientIP, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }
  
  if (clientData.count >= MAX_REQUESTS_PER_WINDOW) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: `Maximum ${MAX_REQUESTS_PER_WINDOW} requests per hour allowed`,
      resetTime: new Date(clientData.resetTime).toISOString()
    });
  }
  
  clientData.count++;
  next();
};

app.use(rateLimit);

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'WeTow Backend Server',
    firebase: db ? 'connected' : 'not connected'
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'WeTow Backend Server',
    firebase: db ? 'connected' : 'not connected',
    uptime: process.uptime()
  });
});

// ==================== PAYFAST SIGNATURE VERIFICATION ====================

function verifyPayFastSignature(data) {
  const receivedSignature = data.signature;
  if (!receivedSignature) return false;

  // Build param string from received data (excluding signature), in received order
  const params = { ...data };
  delete params.signature;

  const paramString = Object.entries(params)
    .filter(([_, value]) => value !== '' && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value)).replace(/%20/g, '+')}`)
    .join('&');

  const signatureString = PAYFAST_PASSPHRASE
    ? `${paramString}&passphrase=${encodeURIComponent(PAYFAST_PASSPHRASE).replace(/%20/g, '+')}`
    : paramString;

  const calculatedSignature = crypto.createHash('md5').update(signatureString).digest('hex');
  return calculatedSignature === receivedSignature;
}

// ==================== PAYFAST PAYMENT ENDPOINTS ====================

// PayFast ITN (Instant Transaction Notification) Webhook — THE CRITICAL ENDPOINT
app.post('/payfast/webhook', async (req, res) => {
  console.log('[PayFast ITN] Received:', JSON.stringify(req.body));

  try {
    const data = req.body;

    // Step 1: Verify signature
    if (!verifyPayFastSignature(data)) {
      console.error('[PayFast ITN] Invalid signature — possible fraud attempt');
      return res.status(400).send('Invalid signature');
    }

    // Step 2: Verify merchant ID
    if (data.merchant_id !== PAYFAST_MERCHANT_ID) {
      console.error('[PayFast ITN] Merchant ID mismatch:', data.merchant_id);
      return res.status(400).send('Merchant ID mismatch');
    }

    // Step 3: Extract payment details
    const jobId = data.m_payment_id;
    const paymentStatus = data.payment_status;
    const amountGross = parseFloat(data.amount_gross || '0');
    const amountFee = parseFloat(data.amount_fee || '0');
    const amountNet = parseFloat(data.amount_net || '0');

    console.log(`[PayFast ITN] Job: ${jobId}, Status: ${paymentStatus}, Amount: R${amountGross}`);

    if (!jobId) {
      console.error('[PayFast ITN] No job ID (m_payment_id) in payment');
      return res.status(400).send('Missing job ID');
    }

    // Step 4: Update Firestore
    if (db) {
      const admin = require('firebase-admin');
      const jobRef = db.collection('jobs').doc(jobId);
      const jobDoc = await jobRef.get();

      if (!jobDoc.exists) {
        console.error(`[PayFast ITN] Job ${jobId} not found in Firestore`);
        // Still return 200 — don't make PayFast retry for a missing job
        return res.status(200).send('OK');
      }

      if (paymentStatus === 'COMPLETE') {
        await jobRef.update({
          paymentStatus: 'completed',
          paymentConfirmedAt: admin.firestore.FieldValue.serverTimestamp(),
          paymentConfirmedByWebhook: true,
          payfastPaymentId: data.pf_payment_id || null,
          payfastAmountGross: amountGross,
          payfastAmountFee: amountFee,
          payfastAmountNet: amountNet,
        });
        console.log(`[PayFast ITN] Job ${jobId} payment CONFIRMED: R${amountGross}`);
      } else if (paymentStatus === 'CANCELLED') {
        await jobRef.update({
          paymentStatus: 'cancelled',
          paymentCancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`[PayFast ITN] Job ${jobId} payment CANCELLED`);
      } else {
        await jobRef.update({
          paymentStatus: paymentStatus.toLowerCase(),
        });
        console.log(`[PayFast ITN] Job ${jobId} payment status: ${paymentStatus}`);
      }

      // Audit log
      await db.collection('paymentLogs').add({
        jobId,
        paymentStatus,
        amountGross,
        amountFee,
        amountNet,
        payfastPaymentId: data.pf_payment_id || null,
        rawData: data,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      console.log('[PayFast ITN] Firestore not available — logged only');
    }

    // PayFast requires 200 OK to confirm receipt
    res.status(200).send('OK');
  } catch (error) {
    console.error('[PayFast ITN] Error:', error);
    res.status(500).send('Internal error');
  }
});

// Also support the old endpoint name for backward compat
app.post('/payfast/payment-notify', async (req, res) => {
  // Forward to the main webhook handler
  req.url = '/payfast/webhook';
  app.handle(req, res);
});

// PayFast Payment Return (customer redirected here after success)
app.get('/payfast/return', (req, res) => {
  const jobId = req.query.jobId || req.query.job_id || '';
  console.log(`[PayFast Return] Job: ${jobId}`);

  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Payment Successful</title>
    <style>body{font-family:-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#000;color:#fff;text-align:center;padding:20px}
    .icon{font-size:64px;margin-bottom:16px;color:#059669}h1{color:#059669;margin-bottom:8px}p{color:#888;margin-bottom:8px}
    a{display:inline-block;margin-top:20px;background:#059669;color:#fff;text-decoration:none;padding:16px 32px;border-radius:12px;font-weight:bold;font-size:16px}</style></head>
    <body>
    <div class="icon">&#x2714;</div>
    <h1>Payment Successful</h1>
    <p>Your payment has been processed.</p>
    <p style="font-size:12px;color:#555">Ref: ${jobId.substring(0, 12)}</p>
    <a href="wetow://payment/success?jobId=${jobId}">Return to WeTow</a>
    <script>setTimeout(function(){window.location.href="wetow://payment/success?jobId=${jobId}"},2500);</script>
    </body></html>
  `);
});

// Keep old endpoint working too
app.get('/payfast/payment-success', (req, res) => {
  req.query.jobId = req.query.jobId || req.query.job_id || '';
  res.redirect(`/payfast/return?jobId=${req.query.jobId}`);
});

// PayFast Payment Cancel
app.get('/payfast/cancel', (req, res) => {
  const jobId = req.query.jobId || req.query.job_id || '';
  console.log(`[PayFast Cancel] Job: ${jobId}`);

  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Payment Cancelled</title>
    <style>body{font-family:-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#000;color:#fff;text-align:center;padding:20px}
    .icon{font-size:64px;margin-bottom:16px;color:#EF4444}h1{color:#EF4444;margin-bottom:8px}p{color:#888}
    a{display:inline-block;margin-top:20px;background:#333;color:#fff;text-decoration:none;padding:16px 32px;border-radius:12px;font-weight:bold;font-size:16px}</style></head>
    <body>
    <div class="icon">&#x2718;</div>
    <h1>Payment Cancelled</h1>
    <p>No charges were made. You can try again from the app.</p>
    <a href="wetow://payment/cancel?jobId=${jobId}">Return to WeTow</a>
    <script>setTimeout(function(){window.location.href="wetow://payment/cancel?jobId=${jobId}"},3000);</script>
    </body></html>
  `);
});

// Keep old endpoint working too
app.get('/payfast/payment-cancel', (req, res) => {
  req.query.jobId = req.query.jobId || req.query.job_id || '';
  res.redirect(`/payfast/cancel?jobId=${req.query.jobId}`);
});

// Tokenization endpoints (kept for saved cards feature)
app.get('/payfast/tokenization-success', (req, res) => {
  const { user_id } = req.query;
  console.log('[PayFast Token] Success for user:', user_id);
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Card Saved</title>
  <style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#000;color:#fff;text-align:center}
  h1{color:#059669}</style></head><body><h1>Card Saved</h1><p style="color:#888">Returning to app...</p>
  <script>setTimeout(function(){window.location.href="wetow://card/saved"},2000);</script></body></html>`);
});

app.get('/payfast/tokenization-cancel', (req, res) => {
  console.log('[PayFast Token] Cancelled');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cancelled</title>
  <style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#000;color:#fff;text-align:center}
  h1{color:#EF4444}</style></head><body><h1>Cancelled</h1><p style="color:#888">Card was not saved.</p>
  <script>setTimeout(function(){window.location.href="wetow://card/cancelled"},2000);</script></body></html>`);
});

app.post('/payfast/tokenization-notify', (req, res) => {
  console.log('[PayFast Token ITN]:', JSON.stringify(req.body));
  res.status(200).send('OK');
});

// ==================== GOOGLE MAPS API ENDPOINTS ====================

// Google Places Autocomplete endpoint
app.get('/autocomplete', async (req, res) => {
  try {
    const { input } = req.query;
    if (!input) return res.status(400).json({ error: 'Input parameter is required' });

    const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (!API_KEY) return res.status(500).json({ error: 'Server configuration error' });

    const response = await axios.get('https://maps.googleapis.com/maps/api/place/autocomplete/json', {
      params: { input, key: API_KEY, components: 'country:za', types: 'geocode' },
    });

    res.json(response.data);
  } catch (error) {
    console.error('Autocomplete error:', error.message);
    res.status(500).json({ error: 'Failed to fetch autocomplete suggestions', message: error.message });
  }
});

// Google Place Details endpoint
app.get('/place-details', async (req, res) => {
  try {
    const { place_id } = req.query;
    if (!place_id) return res.status(400).json({ error: 'place_id parameter is required' });

    const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (!API_KEY) return res.status(500).json({ error: 'Server configuration error' });

    const response = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
      params: { place_id, key: API_KEY, fields: 'geometry,formatted_address,name' },
    });

    res.json(response.data);
  } catch (error) {
    console.error('Place details error:', error.message);
    res.status(500).json({ error: 'Failed to fetch place details', message: error.message });
  }
});

// Geocoding endpoint
app.get('/geocode', async (req, res) => {
  try {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'address parameter is required' });

    const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (!API_KEY) return res.status(500).json({ error: 'Server configuration error' });

    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address, key: API_KEY },
    });

    res.json(response.data);
  } catch (error) {
    console.error('Geocode error:', error.message);
    res.status(500).json({ error: 'Failed to geocode address', message: error.message });
  }
});

// Reverse geocoding endpoint
app.get('/reverse-geocode', async (req, res) => {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng parameters are required' });

    const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (!API_KEY) return res.status(500).json({ error: 'Server configuration error' });

    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { latlng: `${lat},${lng}`, key: API_KEY },
    });

    res.json(response.data);
  } catch (error) {
    console.error('Reverse geocode error:', error.message);
    res.status(500).json({ error: 'Failed to reverse geocode', message: error.message });
  }
});

// Distance Matrix endpoint
app.get('/distance-matrix', async (req, res) => {
  try {
    const { origins, destinations } = req.query;
    if (!origins || !destinations) return res.status(400).json({ error: 'origins and destinations required' });

    const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (!API_KEY) return res.status(500).json({ error: 'Server configuration error' });

    const response = await axios.get('https://maps.googleapis.com/maps/api/distancematrix/json', {
      params: { origins, destinations, key: API_KEY },
    });

    res.json(response.data);
  } catch (error) {
    console.error('Distance matrix error:', error.message);
    res.status(500).json({ error: 'Failed to calculate distance', message: error.message });
  }
});

// Directions endpoint (for route polylines)
app.get('/directions', async (req, res) => {
  try {
    const { origin, destination } = req.query;
    if (!origin || !destination) return res.status(400).json({ error: 'origin and destination required' });

    const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (!API_KEY) return res.status(500).json({ error: 'Server configuration error' });

    const response = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
      params: { origin, destination, key: API_KEY },
    });

    res.json(response.data);
  } catch (error) {
    console.error('Directions error:', error.message);
    res.status(500).json({ error: 'Failed to get directions', message: error.message });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Start server
app.listen(PORT, () => {
  console.log(`WeTow Server running on port ${PORT}`);
  console.log(`Firebase: ${db ? 'Connected' : 'Not connected'}`);
  console.log('Endpoints: /health, /autocomplete, /place-details, /geocode, /reverse-geocode, /distance-matrix, /directions');
  console.log('PayFast: /payfast/webhook, /payfast/return, /payfast/cancel');
});

// Graceful shutdown
process.on('SIGTERM', () => { console.log('SIGTERM received'); process.exit(0); });
process.on('SIGINT', () => { console.log('SIGINT received'); process.exit(0); });