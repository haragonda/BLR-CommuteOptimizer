/**
 * holidays.js — Indian Public Holidays 2025–2026 (Karnataka / Bengaluru)
 *
 * Covers national holidays + Karnataka state holidays relevant to
 * office commuters. Update the HOLIDAYS array annually.
 *
 * Usage:
 *   import { getHolidayWarning } from './holidays.js';
 *   const warning = getHolidayWarning(epochSeconds); // null or { name, note }
 *
 * Author: Hemanth Aragonda — github.com/haragonda
 */

'use strict';

/**
 * Each entry: { date: 'YYYY-MM-DD', name: string, officeClose: boolean }
 * officeClose: true = Okta office likely closed (national/state holiday)
 *              false = roads affected but office may be open (regional observance)
 */
const HOLIDAYS = [
  // ── 2025 ──
  { date: '2025-01-01', name: "New Year's Day",           officeClose: false },
  { date: '2025-01-14', name: 'Sankranti / Pongal',       officeClose: false },
  { date: '2025-01-26', name: 'Republic Day',              officeClose: true  },
  { date: '2025-02-26', name: 'Maha Shivaratri',           officeClose: false },
  { date: '2025-03-14', name: 'Holi',                      officeClose: false },
  { date: '2025-03-31', name: 'Eid ul-Fitr',               officeClose: true  },
  { date: '2025-04-14', name: 'Dr. Ambedkar Jayanti / Ugadi', officeClose: true },
  { date: '2025-04-18', name: 'Good Friday',               officeClose: true  },
  { date: '2025-05-01', name: 'Karnataka Rajyotsava (May Day)', officeClose: true },
  { date: '2025-06-07', name: 'Eid ul-Adha',               officeClose: true  },
  { date: '2025-08-15', name: 'Independence Day',           officeClose: true  },
  { date: '2025-08-16', name: 'Janmashtami',                officeClose: false },
  { date: '2025-08-27', name: 'Ganesh Chaturthi',           officeClose: false },
  { date: '2025-10-02', name: 'Gandhi Jayanti',             officeClose: true  },
  { date: '2025-10-02', name: 'Dasara / Vijayadashami',     officeClose: false },
  { date: '2025-10-20', name: 'Diwali (Naraka Chaturdashi)', officeClose: true },
  { date: '2025-10-21', name: 'Diwali (Lakshmi Puja)',      officeClose: true  },
  { date: '2025-11-01', name: 'Kannada Rajyotsava',         officeClose: true  },
  { date: '2025-11-05', name: 'Guru Nanak Jayanti',         officeClose: false },
  { date: '2025-12-25', name: 'Christmas Day',              officeClose: true  },

  // ── 2026 ──
  { date: '2026-01-01', name: "New Year's Day",             officeClose: false },
  { date: '2026-01-14', name: 'Sankranti / Pongal',         officeClose: false },
  { date: '2026-01-26', name: 'Republic Day',               officeClose: true  },
  { date: '2026-03-20', name: 'Holi',                       officeClose: false },
  { date: '2026-03-21', name: 'Ugadi',                      officeClose: true  },
  { date: '2026-03-20', name: 'Eid ul-Fitr (approx)',       officeClose: true  },
  { date: '2026-04-03', name: 'Good Friday',                officeClose: true  },
  { date: '2026-04-14', name: 'Dr. Ambedkar Jayanti',       officeClose: true  },
  { date: '2026-05-01', name: 'Karnataka Rajyotsava (May Day)', officeClose: true },
  { date: '2026-05-27', name: 'Eid ul-Adha (approx)',       officeClose: true  },
  { date: '2026-08-15', name: 'Independence Day',           officeClose: true  },
  { date: '2026-09-16', name: 'Ganesh Chaturthi',           officeClose: false },
  { date: '2026-10-02', name: 'Gandhi Jayanti',             officeClose: true  },
  { date: '2026-10-08', name: 'Dasara / Vijayadashami',     officeClose: false },
  { date: '2026-10-09', name: 'Diwali (Naraka Chaturdashi)', officeClose: true },
  { date: '2026-10-10', name: 'Diwali (Lakshmi Puja)',      officeClose: true  },
  { date: '2026-11-01', name: 'Kannada Rajyotsava',         officeClose: true  },
  { date: '2026-12-25', name: 'Christmas Day',              officeClose: true  },
];

/**
 * Checks whether a given Unix epoch (seconds, IST-resolved) falls on a
 * known public holiday in Bengaluru.
 *
 * @param {number} epochSeconds — future Unix timestamp in seconds
 * @returns {{ name: string, officeClose: boolean, note: string } | null}
 */
export function getHolidayWarning(epochSeconds) {
  // Convert epoch to IST date string (YYYY-MM-DD)
  const IST_OFFSET_MS = 330 * 60 * 1000;
  const dateIST = new Date(epochSeconds * 1000 + IST_OFFSET_MS);
  const yyyy    = dateIST.getUTCFullYear();
  const mm      = String(dateIST.getUTCMonth() + 1).padStart(2, '0');
  const dd      = String(dateIST.getUTCDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;

  const match = HOLIDAYS.find(h => h.date === dateStr);
  if (!match) return null;

  return {
    name:         match.name,
    officeClose:  match.officeClose,
    note: match.officeClose
      ? `${match.name} — office likely closed. Traffic will be light but verify with your team.`
      : `${match.name} — office open but road patterns will differ from a normal ${new Date(epochSeconds * 1000).toLocaleDateString('en-IN', { weekday: 'long' })}. Results may be less accurate.`
  };
}

/**
 * Returns the display date string (e.g. "Tuesday, 15 Aug 2026") for a given epoch.
 * @param {number} epochSeconds
 * @returns {string}
 */
export function formatEpochDate(epochSeconds) {
  const IST_OFFSET_MS = 330 * 60 * 1000;
  const d = new Date(epochSeconds * 1000 + IST_OFFSET_MS);
  return d.toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'short', year: 'numeric',
    timeZone: 'UTC'   // we've already adjusted for IST manually
  });
}
