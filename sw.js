/**
 * sw.js — Service Worker for BLR-CommuteOptimizer
 *
 * Strategy:
 *  - Static assets (HTML, JS, CSS, fonts): Cache-first with network fallback.
 *  - /api/commute requests: Network-first with offline fallback to last cached result.
 *  - On install: pre-caches all static shell assets.
 *  - On activate: purges stale caches from previous versions.
 *
 * Offline behaviour:
 *  When /api/commute fails due to network unavailability, returns the last
 *  successful API response from cache with an X-SW-Offline: true header so
 *  app.js can display a "showing last result" banner.
 *
 * Author: Hemanth Aragonda — github.com/haragonda
 */

'use strict';

const CACHE_VERSION   = 'blr-commute-v2';
const API_CACHE_NAME  = 'blr-commute-api-v2';

// Static assets to pre-cache on install
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/holidays.js',
  '/history.js',
  '/analytics.js',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;700&family=JetBrains+Mono:wght@400;600&display=swap'
];

// ── Install: pre-cache static shell ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Pre-cache failed:', err))
  );
});

// ── Activate: delete stale caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_VERSION && k !== API_CACHE_NAME)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: route requests ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls: network-first, offline fallback to last cached result
  if (url.pathname.startsWith('/api/commute')) {
    event.respondWith(networkFirstWithOfflineFallback(event.request));
    return;
  }

  // Analytics beacon: attempt only, never cache, never fallback
  if (url.pathname.startsWith('/api/analytics')) {
    event.respondWith(fetch(event.request).catch(() => new Response('', { status: 204 })));
    return;
  }

  // Static assets: cache-first with network fallback
  event.respondWith(cacheFirstWithNetworkFallback(event.request));
});

// ─────────────────────────────────────
// STRATEGIES
// ─────────────────────────────────────

/**
 * Network-first strategy for API calls.
 * On success: clones response into API cache keyed by URL (without timestamp).
 * On failure: returns the most recent cached API response with offline header.
 */
async function networkFirstWithOfflineFallback(request) {
  const cache    = await caches.open(API_CACHE_NAME);
  const cacheKey = stripTimestamp(request.url);

  try {
    const networkResponse = await fetch(request);

    if (networkResponse.ok) {
      // Cache a clone of the successful response
      await cache.put(cacheKey, networkResponse.clone());
    }

    return networkResponse;

  } catch (networkError) {
    // Network failed — check for any cached API result
    const cached = await cache.match(cacheKey)
      || await findAnyApiCache(cache);

    if (cached) {
      // Return cached result with offline signal header
      const body    = await cached.json();
      const headers = new Headers(cached.headers);
      headers.set('X-SW-Offline', 'true');
      headers.set('X-SW-Cached-At', cached.headers.get('date') || 'unknown');

      return new Response(JSON.stringify(body), {
        status:  200,
        headers
      });
    }

    // No cache at all — return structured error
    return new Response(
      JSON.stringify({ error: 'You are offline and no cached result is available. Connect to the internet and try again.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Cache-first strategy for static assets.
 * Serves from cache if available; fetches and caches on miss.
 */
async function cacheFirstWithNetworkFallback(request) {
  const cache  = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);

  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok && request.method === 'GET') {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    // For HTML navigation requests, return the cached shell
    if (request.mode === 'navigate') {
      const shell = await cache.match('/index.html');
      if (shell) return shell;
    }
    return new Response('Offline', { status: 503 });
  }
}

/**
 * Finds any cached API response (most recent) when the exact URL key misses.
 * @param {Cache} cache
 */
async function findAnyApiCache(cache) {
  const keys = await cache.keys();
  if (keys.length === 0) return null;
  // Return the most recently cached entry (last in insertion order)
  return cache.match(keys[keys.length - 1]);
}

/**
 * Strips dynamic parameters (departure timestamp) from the cache key
 * so that results for the same route are reusable across sessions.
 * Keeps: origin, destination. Removes: departure (changes every call).
 * @param {string} url
 * @returns {string}
 */
function stripTimestamp(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('departure');
    return u.toString();
  } catch {
    return url;
  }
}
