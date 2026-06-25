/**
 * history.js — Calculation History Log
 *
 * Stores up to 30 commute calculations in localStorage.
 * Each entry captures: timestamp, route, day, departure, result slots, recommendation.
 * Exposes render functions for the history panel in the UI.
 *
 * Author: Hemanth Aragonda — github.com/haragonda
 */

'use strict';

const HISTORY_KEY      = 'blr_commute_history';
const MAX_HISTORY      = 30;

/**
 * @typedef {Object} HistoryEntry
 * @property {string} id           - UUID v4
 * @property {number} timestamp    - Unix epoch ms (when calculated)
 * @property {string} origin       - Origin address
 * @property {string} destination  - Destination address
 * @property {string[]} waypoints  - School stop addresses (may be empty)
 * @property {string} day          - e.g. 'Tuesday'
 * @property {number} depMinutes   - Departure minutes since midnight
 * @property {string} arrivalTime  - 'HH:MM' required arrival
 * @property {Object[]} slots      - Array of departure slot results
 * @property {string} recommendation - Recommended departure time string
 * @property {boolean} demoMode
 */

/**
 * Saves a new calculation to history.
 * Prepends to the array, trims to MAX_HISTORY.
 * @param {Omit<HistoryEntry, 'id' | 'timestamp'>} entry
 */
export function saveToHistory(entry) {
  const history = loadHistory();
  const newEntry = {
    ...entry,
    id:        crypto.randomUUID(),
    timestamp: Date.now()
  };
  history.unshift(newEntry);
  const trimmed = history.slice(0, MAX_HISTORY);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  } catch (e) {
    console.warn('BLR-CommuteOptimizer: history write failed (storage quota?)', e);
  }
  return newEntry;
}

/**
 * Loads all history entries from localStorage.
 * Returns empty array if none exist or parse fails.
 * @returns {HistoryEntry[]}
 */
export function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Clears all history.
 */
export function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
}

/**
 * Renders the history table into a given container element.
 * @param {HTMLElement} container
 * @param {function} onReuse - called with an entry when user clicks "Reuse"
 */
export function renderHistoryTable(container, onReuse) {
  const history = loadHistory();

  if (history.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding: 32px 0; color: var(--slate-500); font-size: 13px;">
        No calculations yet. Run your first commute check above.
      </div>
    `;
    return;
  }

  const rows = history.map(entry => {
    const date   = new Date(entry.timestamp);
    const dateStr= date.toLocaleDateString('en-IN', { day:'numeric', month:'short' });
    const timeStr= date.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });
    const bestSlot = entry.slots?.find(s => s.model === 'bestGuess');
    const duration = bestSlot ? bestSlot.durationText : '—';
    const depTime  = minsToTime(entry.depMinutes);
    const rec      = entry.recommendation || '—';
    const stops    = entry.waypoints?.length > 0 ? `+${entry.waypoints.length} stop${entry.waypoints.length > 1 ? 's' : ''}` : 'Direct';
    const demo     = entry.demoMode ? '<span style="color:var(--saffron-l);font-size:10px;"> demo</span>' : '';

    return `
      <tr data-id="${entry.id}" style="border-bottom: 1px solid var(--navy-800);">
        <td style="padding: 10px 8px; font-size: 11px; color: var(--slate-400); font-family: 'JetBrains Mono', monospace; white-space: nowrap;">${dateStr}<br><span style="color:var(--slate-600)">${timeStr}</span></td>
        <td style="padding: 10px 8px; font-size: 11px; color: var(--slate-300);">${entry.day}${demo}<br><span style="color:var(--slate-500)">${stops}</span></td>
        <td style="padding: 10px 8px; font-size: 12px; font-family: 'JetBrains Mono', monospace; color: var(--slate-200);">${depTime}</td>
        <td style="padding: 10px 8px; font-size: 12px; font-family: 'JetBrains Mono', monospace; color: var(--saffron-l);">${duration}</td>
        <td style="padding: 10px 8px; font-size: 11px; color: var(--jade-l);">${rec}</td>
        <td style="padding: 10px 8px;">
          <button
            onclick="window._reuseHistory('${entry.id}')"
            style="font-size: 10px; font-family: 'JetBrains Mono', monospace; color: var(--slate-400); background: var(--navy-800); border: 1px solid var(--navy-700); border-radius: 6px; padding: 4px 10px; cursor: pointer;"
          >Reuse</button>
        </td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <div style="overflow-x: auto;">
      <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
        <thead>
          <tr style="border-bottom: 1px solid var(--navy-700);">
            <th style="padding: 8px; text-align: left; font-size: 10px; color: var(--slate-500); font-weight: 500;">WHEN</th>
            <th style="padding: 8px; text-align: left; font-size: 10px; color: var(--slate-500); font-weight: 500;">DAY</th>
            <th style="padding: 8px; text-align: left; font-size: 10px; color: var(--slate-500); font-weight: 500;">DEPART</th>
            <th style="padding: 8px; text-align: left; font-size: 10px; color: var(--slate-500); font-weight: 500;">TYPICAL</th>
            <th style="padding: 8px; text-align: left; font-size: 10px; color: var(--slate-500); font-weight: 500;">RECOMMENDATION</th>
            <th style="padding: 8px;"></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="display: flex; justify-content: flex-end; margin-top: 12px;">
      <button
        onclick="window._clearHistory()"
        style="font-size: 11px; color: var(--slate-500); background: none; border: none; cursor: pointer; text-decoration: underline; text-underline-offset: 2px;"
      >Clear history</button>
    </div>
  `;

  // Expose callback to global scope for inline onclick handlers
  window._reuseHistory = (id) => {
    const entry = history.find(e => e.id === id);
    if (entry && onReuse) onReuse(entry);
  };
  window._clearHistory = () => {
    clearHistory();
    renderHistoryTable(container, onReuse);
  };
}

// ── Utility ──
function minsToTime(total) {
  const t   = Math.max(0, total || 0);
  const h24 = Math.floor(t / 60);
  const m   = t % 60;
  const p   = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${p}`;
}
