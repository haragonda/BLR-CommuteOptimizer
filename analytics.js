/**
 * analytics.js — Anonymous Usage Telemetry
 *
 * Fires a single navigator.sendBeacon() per calculation.
 * Captures zero PII — no addresses, no names, no IDs.
 * Data: departure slot bucket, day, duration range, demo flag, slot count.
 *
 * Endpoint: /api/analytics (Vercel serverless — logs to Vercel's built-in log drain)
 * Fallback: if sendBeacon unavailable, silently skips.
 *
 * Author: Hemanth Aragonda — github.com/haragonda
 */

'use strict';

const ANALYTICS_ENDPOINT = '/api/analytics';

/**
 * Records a commute calculation event.
 * All values are bucketed/anonymised — no raw addresses or times.
 *
 * @param {{
 *   day:          string,   // 'Monday' … 'Friday'
 *   depMinutes:   number,   // departure time (bucketed server-side)
 *   slotCount:    number,   // how many departure slots were calculated
 *   bestGuessSec: number,   // best-guess duration in seconds
 *   hasWaypoints: boolean,  // whether school stops were included
 *   demoMode:     boolean,
 *   onTime:       boolean   // whether recommended departure is on time
 * }} params
 */
export function trackCalculation(params) {
  if (typeof navigator === 'undefined' || !navigator.sendBeacon) return;

  // Bucket the departure time to nearest 30-min slot — prevents fingerprinting
  const depBucket = Math.floor(params.depMinutes / 30) * 30;

  // Bucket duration to nearest 5-min range
  const durationBucket = Math.round((params.bestGuessSec || 0) / 300) * 5;

  const payload = JSON.stringify({
    event:        'calculation',
    day:           params.day,
    depBucket,
    durationBucket,
    slotCount:     params.slotCount,
    hasWaypoints:  params.hasWaypoints,
    demoMode:      params.demoMode,
    onTime:        params.onTime,
    ts:            Date.now()
  });

  try {
    navigator.sendBeacon(ANALYTICS_ENDPOINT, new Blob([payload], { type: 'application/json' }));
  } catch (e) {
    // sendBeacon failing is non-critical — swallow silently
    console.debug('BLR-CommuteOptimizer: analytics beacon failed', e);
  }
}

/**
 * Records a PWA install prompt event.
 */
export function trackInstallPrompt(outcome) {
  if (typeof navigator === 'undefined' || !navigator.sendBeacon) return;
  try {
    navigator.sendBeacon(
      ANALYTICS_ENDPOINT,
      new Blob([JSON.stringify({ event: 'install_prompt', outcome, ts: Date.now() })],
      { type: 'application/json' })
    );
  } catch { /* silent */ }
}
