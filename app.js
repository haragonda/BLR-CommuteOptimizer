/**
 * BLR-CommuteOptimizer — app.js (v2)
 *
 * Complete client engine. Responsibilities:
 *  - Google Places Autocomplete on origin + destination + waypoint fields
 *  - 2-school-stop waypoint UI (add/remove)
 *  - 4-slot departure curve: chosen time + −15, −30, −45 minutes
 *  - IST timezone + next-weekday epoch resolution
 *  - Indian public holiday guard (warns, doesn't block)
 *  - 15-minute localStorage cache keyed on route + day + time
 *  - Structured API error handling with user-facing messages
 *  - Service Worker offline detection (X-SW-Offline header)
 *  - Calculation history (30 entries, reuse flow)
 *  - PWA install prompt capture
 *  - Anonymous analytics via sendBeacon
 *  - WCAG 2.1 AA: aria-live, aria-busy, focus management
 *
 * Author: Hemanth Aragonda — github.com/haragonda
 */

'use strict';

import { getHolidayWarning, formatEpochDate } from './holidays.js';
import { saveToHistory, loadHistory, renderHistoryTable } from './history.js';
import { trackCalculation, trackInstallPrompt } from './analytics.js';

// ═══════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════

const IST_OFFSET_MIN   = 330;                 // UTC+5:30
const CACHE_KEY_PREFIX = 'blr_v2_';
const CACHE_TTL_MS     = 15 * 60 * 1000;     // 15 minutes
const DEBOUNCE_MS      = 500;
const PROXY_ENDPOINT   = '/api/commute';
const WEEKDAYS         = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const WEEKDAY_JS       = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5 };

// Departure curve: selected time + these offsets in minutes
const CURVE_OFFSETS    = [0, -15, -30, -45];

// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════

const state = {
  demoMode:        false,
  selectedDay:     'Tuesday',
  debounceTimer:   null,
  isCalculating:   false,
  waypoints:       [],          // array of { id, value, placeId }
  originPlaceId:   null,
  destPlaceId:     null,
  deferredInstall: null         // PWA install prompt event
};

// ═══════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  registerServiceWorker();
  renderDayButtons();
  updateSliderDisplay(document.getElementById('departure-slider'));
  initPlacesAutocomplete();
  bindInputDebounce();
  loadHistoryPanel();
  capturePWAInstallPrompt();
  handleURLParams();
});

// ═══════════════════════════════════════════════════════════
// SERVICE WORKER
// ═══════════════════════════════════════════════════════════

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js')
    .then(reg => console.log('[SW] Registered, scope:', reg.scope))
    .catch(err => console.warn('[SW] Registration failed:', err));
}

// ═══════════════════════════════════════════════════════════
// PLACES AUTOCOMPLETE
// ═══════════════════════════════════════════════════════════

/**
 * Attaches Google Places Autocomplete to the origin and destination inputs.
 * Restricts results to India. Stores place_id for precision routing.
 *
 * Requires the Places library to be loaded in index.html:
 *   <script src="https://maps.googleapis.com/maps/api/js?key=PUBLIC_KEY&libraries=places&callback=initMap" async defer></script>
 *
 * Note: A separate RESTRICTED PUBLIC key (HTTP referrer restricted, Places API only)
 * is used here. The private Distance Matrix / Directions key stays server-side.
 */
function initPlacesAutocomplete() {
  if (typeof google === 'undefined' || !google.maps?.places) {
    console.warn('[BLR] Google Places not loaded — autocomplete unavailable.');
    return;
  }

  const bounds = new google.maps.LatLngBounds(
    new google.maps.LatLng(12.7343, 77.3791),   // SW corner of Bengaluru metro
    new google.maps.LatLng(13.1731, 77.7825)    // NE corner of Bengaluru metro
  );

  const options = {
    bounds,
    strictBounds: false,
    componentRestrictions: { country: 'in' },
    fields: ['formatted_address', 'place_id', 'name']
  };

  attachAutocomplete('origin-input', options, (place) => {
    state.originPlaceId = place.place_id || null;
    clearResults();
  });

  attachAutocomplete('destination-input', options, (place) => {
    state.destPlaceId = place.place_id || null;
    clearResults();
  });
}

function attachAutocomplete(inputId, options, onSelect) {
  const input = document.getElementById(inputId);
  if (!input) return;

  const ac = new google.maps.places.Autocomplete(input, options);

  ac.addListener('place_changed', () => {
    const place = ac.getPlace();
    if (place.formatted_address) {
      input.value = place.formatted_address;
    }
    onSelect(place);
  });

  // Prevent form submission on Enter in autocomplete
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') e.preventDefault();
  });
}

/**
 * Attaches autocomplete to a dynamically added waypoint input.
 * @param {HTMLInputElement} input
 * @param {string} waypointId - state.waypoints entry id
 */
function attachWaypointAutocomplete(input, waypointId) {
  if (typeof google === 'undefined' || !google.maps?.places) return;

  const bounds = new google.maps.LatLngBounds(
    new google.maps.LatLng(12.7343, 77.3791),
    new google.maps.LatLng(13.1731, 77.7825)
  );

  const ac = new google.maps.places.Autocomplete(input, {
    bounds,
    strictBounds: false,
    componentRestrictions: { country: 'in' },
    fields: ['formatted_address', 'place_id']
  });

  ac.addListener('place_changed', () => {
    const place  = ac.getPlace();
    const entry  = state.waypoints.find(w => w.id === waypointId);
    if (entry) {
      entry.value   = place.formatted_address || input.value;
      entry.placeId = place.place_id || null;
    }
    clearResults();
  });
}

// ═══════════════════════════════════════════════════════════
// WAYPOINT UI
// ═══════════════════════════════════════════════════════════

/**
 * Adds a school-stop waypoint field (max 2).
 */
window.addWaypoint = function () {
  if (state.waypoints.length >= 2) return;

  const id  = `wp_${Date.now()}`;
  const num = state.waypoints.length + 1;
  state.waypoints.push({ id, value: '', placeId: null });

  const container = document.getElementById('waypoints-container');
  const div       = document.createElement('div');
  div.id          = `waypoint-row-${id}`;
  div.className   = 'waypoint-row';
  div.setAttribute('role', 'group');
  div.setAttribute('aria-label', `School stop ${num}`);

  div.innerHTML = `
    <label for="wp-input-${id}" class="field-label">
      School Stop ${num}
      <span class="field-hint">Drop-off point</span>
    </label>
    <div class="input-row">
      <input
        type="text"
        id="wp-input-${id}"
        class="text-input"
        placeholder="e.g. DPS School, Whitefield, Bengaluru"
        aria-label="School stop ${num} address"
        oninput="onWaypointInput('${id}', this.value)"
        style="flex:1"
      />
      <button
        type="button"
        class="remove-btn touch-target"
        aria-label="Remove school stop ${num}"
        onclick="removeWaypoint('${id}')"
      >✕</button>
    </div>
  `;

  container.appendChild(div);

  const input = document.getElementById(`wp-input-${id}`);
  attachWaypointAutocomplete(input, id);
  updateAddWaypointButton();
  input.focus();
  clearResults();
};

window.removeWaypoint = function (id) {
  state.waypoints = state.waypoints.filter(w => w.id !== id);
  const row = document.getElementById(`waypoint-row-${id}`);
  if (row) row.remove();
  // Re-number remaining labels
  const remaining = document.querySelectorAll('.waypoint-row label');
  remaining.forEach((lbl, i) => {
    const num = i + 1;
    lbl.firstChild.textContent = `School Stop ${num} `;
  });
  updateAddWaypointButton();
  clearResults();
};

window.onWaypointInput = function (id, value) {
  const entry = state.waypoints.find(w => w.id === id);
  if (entry) entry.value = value;
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(clearResults, DEBOUNCE_MS);
};

function updateAddWaypointButton() {
  const btn = document.getElementById('add-waypoint-btn');
  if (!btn) return;
  btn.disabled         = state.waypoints.length >= 2;
  btn.setAttribute('aria-disabled', String(state.waypoints.length >= 2));
  btn.textContent      = state.waypoints.length >= 2
    ? '+ Max 2 school stops reached'
    : '+ Add School Stop';
}

// ═══════════════════════════════════════════════════════════
// DAY BUTTONS
// ═══════════════════════════════════════════════════════════

function renderDayButtons() {
  const container = document.getElementById('day-buttons');
  container.innerHTML = '';
  WEEKDAYS.forEach(day => {
    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.textContent = day.slice(0, 3);
    btn.dataset.day = day;
    btn.className   = `day-btn touch-target ${day === state.selectedDay ? 'active' : ''}`;
    btn.setAttribute('aria-pressed', day === state.selectedDay ? 'true' : 'false');
    btn.setAttribute('aria-label',   `Select ${day}`);
    btn.addEventListener('click', () => {
      state.selectedDay = day;
      renderDayButtons();
      clearResults();
    });
    container.appendChild(btn);
  });
}

// ═══════════════════════════════════════════════════════════
// DEMO MODE
// ═══════════════════════════════════════════════════════════

window.toggleDemoMode = function () {
  state.demoMode = !state.demoMode;
  const btn    = document.getElementById('demo-toggle');
  const knob   = document.getElementById('demo-toggle-knob');
  const banner = document.getElementById('demo-banner');

  btn.setAttribute('aria-checked', String(state.demoMode));
  btn.classList.toggle('on', state.demoMode);
  knob.classList.toggle('shifted', state.demoMode);
  banner.classList.toggle('visible', state.demoMode);
  clearResults();
};

// ═══════════════════════════════════════════════════════════
// SLIDER
// ═══════════════════════════════════════════════════════════

window.onSliderInput = function (el) {
  updateSliderDisplay(el);
  clearResults();
};

function updateSliderDisplay(el) {
  const mins = parseInt(el.value, 10);
  const str  = minsToTime(mins);
  document.getElementById('departure-display').textContent = str;
  el.setAttribute('aria-valuenow', str);
  el.setAttribute('aria-label', `Departure time — currently ${str}`);
}

// ═══════════════════════════════════════════════════════════
// IST EPOCH — 4-SLOT DEPARTURE CURVE
// ═══════════════════════════════════════════════════════════

/**
 * Builds the next-weekday IST epoch for a given minutes-since-midnight value.
 * @param {number} depMins
 * @param {string} dayName
 * @returns {number} Unix seconds
 */
function buildEpoch(depMins, dayName) {
  const nowUTC     = new Date();
  const nowIST     = new Date(nowUTC.getTime() + IST_OFFSET_MIN * 60 * 1000);
  const todayJS    = nowIST.getUTCDay();
  const targetJS   = WEEKDAY_JS[dayName];

  let daysAhead = (targetJS - todayJS + 7) % 7;
  if (daysAhead === 0) {
    const nowMinIST = nowIST.getUTCHours() * 60 + nowIST.getUTCMinutes();
    if (depMins <= nowMinIST) daysAhead = 7;
  }

  const targetDate = new Date(nowIST);
  targetDate.setUTCDate(nowIST.getUTCDate() + daysAhead);
  targetDate.setUTCHours(0, 0, 0, 0);

  const h   = Math.floor(depMins / 60);
  const m   = depMins % 60;
  const utc = new Date(
    targetDate.getTime()
    + (h * 3600 + m * 60) * 1000
    - IST_OFFSET_MIN * 60 * 1000
  );
  return Math.floor(utc.getTime() / 1000);
}

/**
 * Builds 4 departure epochs for the curve (chosen time + −15, −30, −45 min).
 * Filters out slots that would be before 5:00 AM IST (330 min).
 * @param {number} baseMins
 * @param {string} dayName
 * @returns {Array<{ mins: number, epoch: number }>}
 */
function buildDepartureCurve(baseMins, dayName) {
  return CURVE_OFFSETS
    .map(offset => ({ mins: baseMins + offset, epoch: buildEpoch(baseMins + offset, dayName) }))
    .filter(slot => slot.mins >= 300);  // 5:00 AM minimum
}

// ═══════════════════════════════════════════════════════════
// CACHE
// ═══════════════════════════════════════════════════════════

function cacheKey(origin, destination, waypoints, baseMins, day) {
  const o  = norm(origin);
  const d  = norm(destination);
  const wp = waypoints.map(w => norm(w.value)).join('|');
  return `${CACHE_KEY_PREFIX}${o}__${d}__${wp}__${baseMins}__${day}`;
}

function norm(str) {
  return str.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 80);
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL_MS) { localStorage.removeItem(key); return null; }
    return data;
  } catch { return null; }
}

function writeCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ data, ts: Date.now() }));
  } catch (e) {
    console.warn('[BLR] Cache write failed:', e);
  }
}

// ═══════════════════════════════════════════════════════════
// MAIN CALCULATION
// ═══════════════════════════════════════════════════════════

window.calculateCommute = async function () {
  if (state.isCalculating) return;

  const origin      = document.getElementById('origin-input').value.trim();
  const destination = document.getElementById('destination-input').value.trim();
  const baseMins    = parseInt(document.getElementById('departure-slider').value, 10);
  const arrivalStr  = document.getElementById('required-arrival').value;

  clearError();

  if (!origin)      { showError('Enter your departure address.'); document.getElementById('origin-input').focus(); return; }
  if (!destination) { showError('Enter a destination address.');  document.getElementById('destination-input').focus(); return; }
  if (!arrivalStr)  { showError('Enter your required arrival time.'); return; }

  // Holiday check on the primary departure slot
  const primaryEpoch   = buildEpoch(baseMins, state.selectedDay);
  const holidayWarning = getHolidayWarning(primaryEpoch);
  if (holidayWarning) {
    showHolidayWarning(holidayWarning);
  } else {
    hideHolidayWarning();
  }

  setCalculating(true);
  showSkeleton();

  try {
    let slots;
    let fromCache  = false;
    let fromOffline = false;

    if (state.demoMode) {
      await sleep(1000);
      slots = buildMockSlots(baseMins, state.selectedDay, state.waypoints.length);
    } else {
      const key    = cacheKey(origin, destination, state.waypoints, baseMins, state.selectedDay);
      const cached = readCache(key);

      if (cached) {
        slots     = cached;
        fromCache = true;
      } else {
        const curve    = buildDepartureCurve(baseMins, state.selectedDay);
        const epochs   = curve.map(s => s.epoch).join(',');
        const wpStr    = state.waypoints.map(w => w.value).filter(Boolean).join('|');
        const response = await fetchProxy({ origin, destination, departures: epochs, waypoints: wpStr });

        fromOffline = response.offline;
        slots       = response.slots;
        if (!fromOffline) writeCache(key, slots);
      }
    }

    if (!slots || slots.length === 0) {
      throw new Error('No routing data returned. Try a more specific address.');
    }

    const curve = buildDepartureCurve(baseMins, state.selectedDay);
    renderResults({ slots, curve, baseMins, arrivalStr, fromCache, fromOffline, day: state.selectedDay });

    // Save to history
    const bestSlot      = slots[0]; // first slot = chosen time
    const bestGuessData = bestSlot?.bestGuess;
    const recommendation = buildRecommendationText(slots, curve, arrivalStr);

    saveToHistory({
      origin,
      destination,
      waypoints:      state.waypoints,
      day:            state.selectedDay,
      depMinutes:     baseMins,
      arrivalTime:    arrivalStr,
      slots,
      recommendation,
      demoMode:       state.demoMode
    });

    // Analytics beacon
    trackCalculation({
      day:          state.selectedDay,
      depMinutes:   baseMins,
      slotCount:    slots.length,
      bestGuessSec: bestGuessData?.durationSec || 0,
      hasWaypoints: state.waypoints.length > 0,
      demoMode:     state.demoMode,
      onTime:       calcArrival(baseMins, bestGuessData?.durationSec || 0, arrivalStr).onTime
    });

    loadHistoryPanel();

  } catch (err) {
    console.error('[BLR] Calculation error:', err);
    showError(err.message || 'Calculation failed. Check your network and try again.');
    showEmptyState();
  } finally {
    setCalculating(false);
  }
};

// ═══════════════════════════════════════════════════════════
// PROXY FETCH
// ═══════════════════════════════════════════════════════════

async function fetchProxy({ origin, destination, departures, waypoints }) {
  const url = new URL(PROXY_ENDPOINT, window.location.origin);
  url.searchParams.set('origin',      origin);
  url.searchParams.set('destination', destination);
  url.searchParams.set('departures',  departures);
  if (waypoints) url.searchParams.set('waypoints', waypoints);

  const res = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });

  const offline = res.headers.get('X-SW-Offline') === 'true';

  if (!res.ok) {
    let msg = `API error ${res.status}`;
    try { const b = await res.json(); msg = b.error || msg; } catch { /* use default */ }
    throw new Error(msg);
  }

  const data = await res.json();
  if (data.error) throw new Error(data.error);

  return { slots: data.slots, offline };
}

// ═══════════════════════════════════════════════════════════
// MOCK DATA — realistic Bengaluru patterns, 4-slot curve
// ═══════════════════════════════════════════════════════════

function buildMockSlots(baseMins, day, waypointCount) {
  const curve = buildDepartureCurve(baseMins, day);
  const wpFactor = 1 + waypointCount * 0.18; // each stop adds ~18% journey time
  const heavy    = day === 'Monday' || day === 'Friday';

  return curve.map(({ mins, epoch }) => {
    const inPeak   = mins >= 420 && mins <= 540;
    const nearPeak = mins >= 390 && mins < 420;
    let base;
    if (inPeak)         base = heavy ? 68 : 54;
    else if (nearPeak)  base = heavy ? 48 : 38;
    else                base = 32;

    const bgSec  = Math.round(base * 60 * wpFactor);
    const optSec = Math.round(bgSec * 0.75);

    return {
      epoch,
      optimistic: {
        durationSec:  optSec,
        durationText: formatDur(optSec),
        distanceM:    14800 + waypointCount * 3200,
        distanceText: `${((14800 + waypointCount * 3200) / 1000).toFixed(1)} km`
      },
      bestGuess: {
        durationSec:  bgSec,
        durationText: formatDur(bgSec),
        distanceM:    14800 + waypointCount * 3200,
        distanceText: `${((14800 + waypointCount * 3200) / 1000).toFixed(1)} km`
      }
    };
  });
}

// ═══════════════════════════════════════════════════════════
// RESULT RENDERING
// ═══════════════════════════════════════════════════════════

function renderResults({ slots, curve, baseMins, arrivalStr, fromCache, fromOffline, day }) {
  clearEmptyState();
  const panel = document.getElementById('results-panel');
  panel.classList.remove('hidden');

  // Cache / offline badges
  document.getElementById('cache-badge').classList.toggle('hidden', !fromCache && !fromOffline);
  if (fromCache)   document.getElementById('cache-badge').textContent = '⚡ cached';
  if (fromOffline) document.getElementById('cache-badge').textContent = '📴 offline — last result';

  // ── Departure curve table ──
  renderCurveTable(slots, curve, arrivalStr);

  // ── Primary result cards (chosen departure slot) ──
  const primarySlot = slots[0];
  renderPrimaryCards(primarySlot, baseMins, arrivalStr);

  // ── Recommendation ──
  const recText = buildRecommendationText(slots, curve, arrivalStr);
  renderRecommendation(recText, slots, curve, arrivalStr);

  // ── Details panel ──
  renderDetails(primarySlot, baseMins, day);

  // ── Meta ──
  const dateStr = formatEpochDate(buildEpoch(baseMins, day));
  const mode    = state.demoMode ? 'demo/mock' : fromOffline ? 'offline cache' : 'Google Directions API';
  document.getElementById('results-meta').textContent =
    `${dateStr} · ${mode} · ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} IST`;
}

/**
 * Renders the departure curve table showing all 4 slots side by side.
 */
function renderCurveTable(slots, curve, arrivalStr) {
  const container = document.getElementById('curve-table');
  if (!container) return;

  const rows = slots.map((slot, i) => {
    const mins     = curve[i]?.mins ?? 0;
    const bgData   = slot.bestGuess;
    const optData  = slot.optimistic;
    if (!bgData) return '';

    const arr      = calcArrival(mins, bgData.durationSec, arrivalStr);
    const isChosen = i === 0;
    const rowClass = isChosen ? 'curve-row chosen' : 'curve-row';

    return `
      <tr class="${rowClass}" role="row">
        <td class="curve-cell depart-cell">
          <span class="mono-val ${isChosen ? 'chosen-val' : ''}">${minsToTime(mins)}</span>
          ${isChosen ? '<span class="chosen-tag">selected</span>' : ''}
        </td>
        <td class="curve-cell"><span class="mono-val">${optData?.durationText || '—'}</span></td>
        <td class="curve-cell"><span class="mono-val">${bgData.durationText}</span></td>
        <td class="curve-cell"><span class="mono-val">${minsToTime(arr.arrivalMins)}</span></td>
        <td class="curve-cell">
          <span class="buffer-val ${arr.onTime ? 'buffer-ok' : 'buffer-late'}">
            ${arr.onTime ? '+' : ''}${arr.bufferMins} min
          </span>
        </td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <table class="curve-table-el" role="table" aria-label="Departure curve — 4 slots compared">
      <thead>
        <tr role="row">
          <th class="curve-th">Depart</th>
          <th class="curve-th">Optimistic</th>
          <th class="curve-th">Typical</th>
          <th class="curve-th">Arrive ~</th>
          <th class="curve-th">Buffer</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="curve-note">Each row = same journey, different departure. Move 15 min earlier to see how traffic changes.</p>
  `;
}

/**
 * Renders the two primary result cards for the chosen departure time.
 */
function renderPrimaryCards(slot, baseMins, arrivalStr) {
  const grid = document.getElementById('results-grid');
  grid.innerHTML = '';
  if (!slot) return;

  const cards = [
    { model: 'optimistic', label: 'Optimistic Route', icon: '🟢', badge: 'optimistic', badgeClass: 'badge-opt', data: slot.optimistic },
    { model: 'bestGuess',  label: 'Typical Route',    icon: '🟠', badge: 'best_guess', badgeClass: 'badge-bg',  data: slot.bestGuess  }
  ];

  cards.forEach(card => {
    if (!card.data) return;
    const arr = calcArrival(baseMins, card.data.durationSec, arrivalStr);
    const el  = document.createElement('div');
    el.className   = 'result-card fade-in';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', card.label);

    el.innerHTML = `
      <div class="rc-head">
        <h3>${card.icon} ${card.label}</h3>
        <span class="badge ${card.badgeClass}">${card.badge}</span>
      </div>
      <div class="duration">${card.data.durationText}</div>
      <div class="dist-text">${card.data.distanceText}</div>
      <div class="meta-grid">
        <span class="mk">Depart</span>  <span class="mv">${minsToTime(baseMins)}</span>
        <span class="mk">Arrive ~</span><span class="mv">${minsToTime(arr.arrivalMins)}</span>
        <span class="mk">Buffer</span>  <span class="mv ${arr.onTime ? 'mv-ok' : 'mv-late'}">${arr.onTime ? '+' : ''}${arr.bufferMins} min</span>
      </div>
      <div class="progress-bar" aria-hidden="true">
        <div class="progress-fill ${arr.onTime ? 'fill-ok' : 'fill-late'}" style="width:${arr.onTime ? 100 : 55}%"></div>
      </div>
      <p class="status-line ${arr.onTime ? 'sl-ok' : 'sl-late'}">
        ${arr.onTime ? `On time · ${arr.bufferMins} min buffer` : `${Math.abs(arr.bufferMins)} min late — depart earlier`}
      </p>
    `;

    grid.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('visible')));
  });
}

/**
 * Generates the recommendation text from the 4-slot curve.
 * Works backwards from required arrival to find the latest safe departure.
 */
function buildRecommendationText(slots, curve, arrivalStr) {
  // Find the latest slot where typical traffic still gets you there on time with ≥10 min buffer
  let bestSlot = null;
  let bestMins = null;

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const mins = curve[i]?.mins;
    if (!slot?.bestGuess || mins == null) continue;
    const arr = calcArrival(mins, slot.bestGuess.durationSec, arrivalStr);
    if (arr.bufferMins >= 10) {
      bestSlot = slot;
      bestMins = mins;
    }
  }

  if (bestMins !== null) {
    const arr = calcArrival(bestMins, bestSlot.bestGuess.durationSec, arrivalStr);
    return `${minsToTime(bestMins)} — arrives with ${arr.bufferMins} min buffer on typical traffic`;
  }

  // No slot works — recommend the earliest slot in the curve
  const earliest = curve[curve.length - 1];
  return `Depart by ${minsToTime(earliest.mins)} — all calculated windows are tight`;
}

function renderRecommendation(text, slots, curve, arrivalStr) {
  const card = document.getElementById('recommendation-card');
  const content = document.getElementById('recommendation-content');
  card.classList.remove('entering');
  card.classList.add('visible');

  // Also find the travel time non-linearity insight
  const firstSlot = slots[0];
  const lastSlot  = slots[slots.length - 1];
  let insight = '';
  if (firstSlot?.bestGuess && lastSlot?.bestGuess) {
    const diff = Math.round((firstSlot.bestGuess.durationSec - lastSlot.bestGuess.durationSec) / 60);
    if (diff > 5) {
      const timeDiff = (curve[0]?.mins ?? 0) - (curve[curve.length - 1]?.mins ?? 0);
      insight = `Leaving ${timeDiff} min earlier saves ${diff} min of driving — traffic is non-linear on this corridor.`;
    }
  }

  content.innerHTML = `
    <p class="rec-main">${text}</p>
    ${insight ? `<p class="rec-sub">${insight}</p>` : ''}
    ${state.waypoints.length > 0 ? `<p class="rec-sub">Includes ${state.waypoints.length} school stop${state.waypoints.length > 1 ? 's' : ''} in the total journey time.</p>` : ''}
  `;
}

function renderDetails(slot, baseMins, day) {
  const panel = document.getElementById('details-panel');
  if (!panel || !slot) return;

  const optSec = slot.optimistic?.durationSec || 0;
  const bgSec  = slot.bestGuess?.durationSec  || 0;
  const diff   = Math.round((bgSec - optSec) / 60);

  const rows = [
    ['Traffic variance',    diff > 0 ? `+${diff} min typical vs optimistic` : 'Minimal'],
    ['Day selected',        day],
    ['Departure (IST)',     minsToTime(baseMins)],
    ['School stops',        state.waypoints.length > 0 ? `${state.waypoints.length} waypoint(s)` : 'None (direct route)'],
    ['API used',            'Google Directions API (Directions v2)'],
    ['Traffic model',       'optimistic + best_guess'],
    ['Epoch calculation',   'Next ' + day + ' IST → UTC conversion'],
    ['Cache TTL',           '15 min (localStorage)'],
    ['IST offset',          'UTC+5:30 (330 min)'],
  ];

  // Leg breakdown if available
  if (slot.bestGuess?.legs?.length > 1) {
    slot.bestGuess.legs.forEach((leg, i) => {
      rows.push([`Leg ${i + 1}`, `${leg.start?.split(',')[0]} → ${leg.end?.split(',')[0]} · ${formatDur(leg.durationSec)}`]);
    });
  }

  panel.innerHTML = rows.map(([k, v]) => `
    <div class="detail-row">
      <span class="dk">${k}</span>
      <span class="dv">${v}</span>
    </div>
  `).join('');
}

// ═══════════════════════════════════════════════════════════
// HISTORY PANEL
// ═══════════════════════════════════════════════════════════

function loadHistoryPanel() {
  const container = document.getElementById('history-container');
  if (!container) return;

  renderHistoryTable(container, (entry) => {
    // Reuse: populate form fields from history entry
    document.getElementById('origin-input').value      = entry.origin || '';
    document.getElementById('destination-input').value = entry.destination || '';
    if (entry.depMinutes) {
      const slider = document.getElementById('departure-slider');
      slider.value = entry.depMinutes;
      updateSliderDisplay(slider);
    }
    if (entry.day) {
      state.selectedDay = entry.day;
      renderDayButtons();
    }
    // Scroll to form
    document.getElementById('main-content').scrollIntoView({ behavior: 'smooth' });
  });
}

// ═══════════════════════════════════════════════════════════
// PWA INSTALL PROMPT
// ═══════════════════════════════════════════════════════════

function capturePWAInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstall = e;
    const banner = document.getElementById('install-banner');
    if (banner) banner.classList.remove('hidden');
  });
}

window.triggerInstall = async function () {
  if (!state.deferredInstall) return;
  state.deferredInstall.prompt();
  const { outcome } = await state.deferredInstall.userChoice;
  trackInstallPrompt(outcome);
  state.deferredInstall = null;
  const banner = document.getElementById('install-banner');
  if (banner) banner.classList.add('hidden');
};

window.dismissInstall = function () {
  const banner = document.getElementById('install-banner');
  if (banner) banner.classList.add('hidden');
  trackInstallPrompt('dismissed');
};

// ═══════════════════════════════════════════════════════════
// URL PARAM HANDLING (for PWA shortcuts)
// ═══════════════════════════════════════════════════════════

function handleURLParams() {
  const params = new URLSearchParams(window.location.search);
  const day    = params.get('day');
  if (day && WEEKDAYS.includes(day)) {
    state.selectedDay = day;
    renderDayButtons();
  }
}

// ═══════════════════════════════════════════════════════════
// UI STATE
// ═══════════════════════════════════════════════════════════

function setCalculating(v) {
  state.isCalculating = v;
  const btn   = document.getElementById('calculate-btn');
  const label = document.getElementById('btn-label');
  btn.disabled = v;
  btn.setAttribute('aria-busy', String(v));
  label.textContent = v ? 'Calculating…' : 'Calculate Departure Window';
}

function showSkeleton() {
  clearEmptyState();
  document.getElementById('results-panel').classList.remove('hidden');
  document.getElementById('results-grid').innerHTML = `
    <div class="result-card" aria-hidden="true"><div class="skel" style="height:14px;width:60%;margin-bottom:14px"></div><div class="skel" style="height:36px;width:45%;margin-bottom:10px"></div><div class="skel" style="height:10px;width:100%;margin-bottom:6px"></div><div class="skel" style="height:10px;width:70%"></div></div>
    <div class="result-card" aria-hidden="true"><div class="skel" style="height:14px;width:60%;margin-bottom:14px"></div><div class="skel" style="height:36px;width:45%;margin-bottom:10px"></div><div class="skel" style="height:10px;width:100%;margin-bottom:6px"></div><div class="skel" style="height:10px;width:70%"></div></div>
  `;
  const curveTable = document.getElementById('curve-table');
  if (curveTable) curveTable.innerHTML = `<div class="skel" style="height:120px;width:100%" aria-hidden="true"></div>`;
  document.getElementById('recommendation-content').innerHTML = `<div class="skel" style="height:14px;width:75%;margin-bottom:8px"></div><div class="skel" style="height:11px;width:55%" aria-hidden="true"></div>`;
}

function clearResults() {
  document.getElementById('results-panel').classList.add('hidden');
  document.getElementById('results-grid').innerHTML = '';
  const curveTable = document.getElementById('curve-table');
  if (curveTable) curveTable.innerHTML = '';
  document.getElementById('recommendation-content').innerHTML = '';
  document.getElementById('details-panel').innerHTML = '';
  document.getElementById('results-meta').textContent = '';
  showEmptyState();
  clearError();
}

function showEmptyState() {
  document.getElementById('empty-state').classList.remove('hidden');
}
function clearEmptyState() {
  document.getElementById('empty-state').classList.add('hidden');
}

function showError(msg) {
  const r = document.getElementById('error-region');
  r.textContent = msg;
  r.classList.remove('hidden');
}
function clearError() {
  const r = document.getElementById('error-region');
  r.textContent = '';
  r.classList.add('hidden');
}

function showHolidayWarning({ note }) {
  const w = document.getElementById('holiday-warning');
  if (!w) return;
  w.textContent = `⚠️ ${note}`;
  w.classList.remove('hidden');
}
function hideHolidayWarning() {
  const w = document.getElementById('holiday-warning');
  if (w) w.classList.add('hidden');
}

function bindInputDebounce() {
  ['origin-input', 'destination-input'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(clearResults, DEBOUNCE_MS);
    });
  });
}

// ═══════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════

function calcArrival(depMins, durSec, arrStr) {
  const arrivalMins  = depMins + Math.ceil(durSec / 60);
  const [h, m]       = arrStr.split(':').map(Number);
  const requiredMins = h * 60 + m;
  return { arrivalMins, bufferMins: requiredMins - arrivalMins, onTime: requiredMins >= arrivalMins };
}

function minsToTime(total) {
  const t   = Math.max(0, total);
  const h24 = Math.floor(t / 60);
  const m   = t % 60;
  const p   = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${p}`;
}

function formatDur(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h} hr ${m} min` : `${m} min`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
