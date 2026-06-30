/**
 * BLR-CommuteOptimizer — api/commute.js (v2)
 *
 * Upgraded from Distance Matrix API to Directions API to support
 * school-stop waypoints. Runs 4 departure slot queries × 2 traffic
 * models = up to 8 parallel fetch calls, returning a complete
 * departure curve to the client in one round trip.
 *
 * Endpoints handled:
 *   GET  /api/commute   — Main commute calculation
 *   POST /api/analytics — Anonymous telemetry log drain
 *
 * Rate limiting: 10 requests / minute per IP (in-memory, resets on cold start).
 * Vercel serverless functions are stateless — for persistent rate limiting
 * across instances, upgrade to Vercel KV or Upstash Redis.
 *
 * Author: Hemanth Aragonda — github.com/haragonda
 */

'use strict';

// ── Google API Endpoints ──
const DIRECTIONS_BASE = 'https://maps.googleapis.com/maps/api/directions/json';

// ── In-memory rate limiter (per-IP, resets on cold start) ──
const rateLimitMap = new Map();
const RATE_LIMIT   = 10;    // max requests
const RATE_WINDOW  = 60000; // per 60 seconds

// ── Structured error codes ──
const ERROR_CODES = {
  OVER_DAILY_LIMIT:   { status: 429, message: 'Google Maps daily quota reached. Try again tomorrow or check your billing settings in Google Cloud Console.' },
  OVER_QUERY_LIMIT:   { status: 429, message: 'Google Maps rate limit hit. Wait 60 seconds and try again.' },
  REQUEST_DENIED:     { status: 403, message: 'API key rejected. Verify your Google Maps API key is active and the Directions API is enabled in Google Cloud Console.' },
  INVALID_REQUEST:    { status: 400, message: 'The address provided could not be resolved. Try a more specific location (include neighbourhood and city).' },
  NOT_FOUND:          { status: 404, message: 'Google Maps could not find a route between these locations. Check both addresses.' },
  ZERO_RESULTS:       { status: 404, message: 'No driving route found. Bengaluru routing requires both addresses to be drivable locations.' },
  MAX_WAYPOINTS_EXCEEDED: { status: 400, message: 'Too many stops. Maximum 2 school waypoints are supported.' },
  UNKNOWN_ERROR:      { status: 502, message: 'Google Maps returned an unexpected error. Try again in a moment.' }
};

// Allowed CORS origins
const ALLOWED_ORIGINS = [
  'https://blr-commuteoptimizer.vercel.app',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];

// ═══════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════

export default async function handler(req, res) {
  // ── CORS ──
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();

  // ── Route to sub-handlers ──
  const path = req.url?.split('?')[0];

  if (path === '/api/analytics' && req.method === 'POST') {
    return handleAnalytics(req, res);
  }

  if (path === '/api/commute' && req.method === 'GET') {
    return handleCommute(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}

// ═══════════════════════════════════════════════════════════
// COMMUTE HANDLER
// ═══════════════════════════════════════════════════════════

async function handleCommute(req, res) {
  // ── Rate limiting ──
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: 'Too many requests. Maximum 10 calculations per minute.',
      code:  'RATE_LIMITED'
    });
  }

  // ── Environment check ──
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.error('[BLR-Commute] GOOGLE_MAPS_API_KEY not configured.');
    return res.status(500).json({ error: 'Server configuration error — API key missing.' });
  }

  // ── Parse query parameters ──
  const { origin, destination, departures, waypoints } = req.query;

  if (!origin || origin.trim().length < 5) {
    return res.status(400).json({ error: ERROR_CODES.INVALID_REQUEST.message, code: 'INVALID_REQUEST' });
  }
  if (!destination || destination.trim().length < 5) {
    return res.status(400).json({ error: ERROR_CODES.INVALID_REQUEST.message, code: 'INVALID_REQUEST' });
  }

  // departures: comma-separated Unix epoch seconds (up to 4 slots)
  if (!departures) {
    return res.status(400).json({ error: 'Parameter "departures" is required (comma-separated Unix epochs).' });
  }
  const departureList = departures.split(',').map(d => parseInt(d.trim(), 10)).filter(d => !isNaN(d));
  if (departureList.length === 0 || departureList.length > 4) {
    return res.status(400).json({ error: 'Parameter "departures" must contain 1–4 valid Unix epoch timestamps.' });
  }
  const now = Math.floor(Date.now() / 1000);
  if (departureList.some(d => d < now)) {
    return res.status(400).json({ error: 'All departure timestamps must be in the future.' });
  }

  // waypoints: pipe-separated school stop addresses (optional, max 2)
  let waypointList = [];
  if (waypoints) {
    waypointList = waypoints.split('|').map(w => w.trim()).filter(Boolean).slice(0, 2);
  }

  // ── Build all requests: 4 slots × 2 traffic models = up to 8 calls ──
  const requests = [];
  for (const epoch of departureList) {
    for (const model of ['optimistic', 'best_guess']) {
      requests.push(
        fetchDirections({
          origin:     origin.trim().slice(0, 300),
          destination: destination.trim().slice(0, 300),
          waypoints:  waypointList,
          departure:  epoch,
          model,
          apiKey
        }).then(data => ({ epoch, model, data }))
          .catch(err => ({ epoch, model, error: err.message }))
      );
    }
  }

  const results = await Promise.allSettled(requests);

  // ── Shape response: group by departure slot ──
  const slots = {};
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { epoch, model, data, error } = result.value;
    if (!slots[epoch]) slots[epoch] = { epoch };
    const key = model === 'best_guess' ? 'bestGuess' : model; // normalise to camelCase for client
    if (error) {
      slots[epoch][key] = { error };
    } else {
      slots[epoch][key] = extractDirectionsData(data);
    }
  }

  const slotArray = Object.values(slots);

  if (slotArray.length === 0) {
    return res.status(502).json({ error: 'All Google Maps requests failed. Check your API key and billing status.' });
  }

  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.status(200).json({ slots: slotArray, waypointCount: waypointList.length });
}

// ═══════════════════════════════════════════════════════════
// ANALYTICS HANDLER
// ═══════════════════════════════════════════════════════════

async function handleAnalytics(req, res) {
  // Simply log to Vercel's log drain — no storage, no PII processing
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    // Vercel captures console.log in its log drain
    console.log('[analytics]', JSON.stringify({ ...payload, ip_hash: hashIP(req.headers['x-forwarded-for'] || '') }));
  } catch { /* swallow parse errors */ }

  return res.status(204).end();
}

// ═══════════════════════════════════════════════════════════
// DIRECTIONS API FETCH
// ═══════════════════════════════════════════════════════════

/**
 * Calls Google Directions API for a single departure slot + traffic model.
 * Uses waypoints (via: addresses) for school stops.
 *
 * @param {{ origin, destination, waypoints, departure, model, apiKey }} params
 * @returns {Promise<object>} Google Directions JSON response
 */
async function fetchDirections({ origin, destination, waypoints, departure, model, apiKey }) {
  const params = new URLSearchParams({
    origin:           encodeRouteParam(origin),
    destination:      encodeRouteParam(destination),
    mode:             'driving',
    language:         'en',
    units:            'metric',
    region:           'in',
    departure_time:   String(departure),
    traffic_model:    model,
    key:              apiKey
  });

  if (waypoints.length > 0) {
    // Directions API waypoint syntax: "via:addr1|via:addr2"
    // Using 'via:' prefix avoids adding extra legs (pass-through waypoints)
    params.set('waypoints', waypoints.map(w => `via:${encodeRouteParam(w)}`).join('|'));
  }

  const url      = `${DIRECTIONS_BASE}?${params.toString()}`;
  const response = await fetch(url, { headers: { 'Accept': 'application/json' } });

  if (!response.ok) {
    throw new Error(`Google Maps HTTP ${response.status}`);
  }

  const data = await response.json();

  // Map Google status codes to structured errors
  if (data.status && data.status !== 'OK') {
    const mapped = ERROR_CODES[data.status] || ERROR_CODES.UNKNOWN_ERROR;
    const err    = new Error(mapped.message);
    err.code     = data.status;
    err.httpStatus = mapped.status;
    throw err;
  }

  return data;
}

// ═══════════════════════════════════════════════════════════
// RESPONSE EXTRACTION
// ═══════════════════════════════════════════════════════════

/**
 * Extracts duration, distance, and step summary from a Directions API response.
 * Sums across all legs (origin → stop1 → stop2 → destination).
 *
 * @param {object} directionsData
 * @returns {{ durationSec, durationText, distanceM, distanceText, legs }} | null
 */
function extractDirectionsData(directionsData) {
  if (!directionsData || directionsData.status !== 'OK') return null;
  const route = directionsData.routes?.[0];
  if (!route) return null;

  const legs = route.legs || [];
  if (legs.length === 0) return null;

  // Sum all legs for total journey time (includes all school stops)
  let totalDurationSec   = 0;
  let totalDurationInTrafficSec = 0;
  let totalDistanceM     = 0;

  for (const leg of legs) {
    totalDurationSec          += leg.duration?.value || 0;
    totalDurationInTrafficSec += leg.duration_in_traffic?.value || leg.duration?.value || 0;
    totalDistanceM            += leg.distance?.value || 0;
  }

  return {
    durationSec:  totalDurationInTrafficSec,
    durationText: formatDuration(totalDurationInTrafficSec),
    distanceM:    totalDistanceM,
    distanceText: `${(totalDistanceM / 1000).toFixed(1)} km`,
    legs: legs.map(leg => ({
      start:       leg.start_address,
      end:         leg.end_address,
      durationSec: leg.duration_in_traffic?.value || leg.duration?.value || 0,
      distanceM:   leg.distance?.value || 0
    }))
  };
}

// ═══════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h} hr ${m} min` : `${m} min`;
}

function encodeRouteParam(str) {
  return str.replace(/&/g, '%26').replace(/=/g, '%3D');
}

/**
 * Simple in-memory rate limiter. NOT persistent across Vercel function instances.
 * Sufficient for personal use; upgrade to Vercel KV for multi-instance deployments.
 */
function checkRateLimit(ip) {
  const now   = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_WINDOW) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= RATE_LIMIT) return false;

  entry.count++;
  return true;
}

/**
 * One-way hash of IP for analytics logging — never store raw IPs.
 */
function hashIP(ip) {
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    hash = ((hash << 5) - hash) + ip.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
