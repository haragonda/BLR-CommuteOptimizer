# 🚗 BLR-CommuteOptimizer
### Predictive Departure Windows for Bengaluru Commuters

[![Deploy Status](https://img.shields.io/github/actions/workflow/status/haragonda/BLR-CommuteOptimizer/deploy.yml?branch=main&label=deploy&style=flat-square)](https://github.com/haragonda/BLR-CommuteOptimizer/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![WCAG 2.1 AA](https://img.shields.io/badge/accessibility-WCAG%202.1%20AA-green?style=flat-square)](https://www.w3.org/TR/WCAG21/)
[![Vercel](https://img.shields.io/badge/deployed%20on-Vercel-black?style=flat-square&logo=vercel)](https://blr-commute-optimizer.vercel.app)

**Live app:** https://blr-commute-optimizer.vercel.app

---

## The Problem

Two school drop-offs. One volatile Bengaluru commute. A hard office start time.

Generic navigation apps tell you how long the drive takes *right now*. They do not tell you what happens if you leave 15 minutes later — or whether Rapido would beat driving on a Monday morning.

BLR-CommuteOptimizer answers the question working parents actually ask: **given my school drop-offs and required arrival time, when exactly should I leave and how?**

---

## What It Does

- **4-slot departure curve** — shows travel time at your chosen time and −15, −30, −45 minutes so you see the non-linearity of Bengaluru traffic
- **School stop waypoints** — add up to 2 school drop-off addresses included in the total journey time
- **Historical traffic modelling** — uses Google's `optimistic` and `best_guess` traffic models, not just live traffic
- **IST timezone precision** — departure times resolve to the correct next-weekday UTC epoch for accurate historical data
- **Karnataka holiday guard** — warns when your selected date is a public holiday and traffic patterns will differ
- **Offline fallback** — Service Worker caches the last successful result so the app works without network at 7 AM
- **PWA** — installable to your phone home screen, works like a native app
- **Demo Mode** — full UI preview with realistic mock data, no API key required

---

## Project Structure

```
BLR-CommuteOptimizer/
├── index.html          # Mobile-first dashboard — WCAG 2.1 AA
├── app.js              # Client engine — IST conversion, cache, UI
├── sw.js               # Service Worker — offline fallback
├── manifest.json       # PWA manifest
├── holidays.js         # Karnataka holiday guard 2025–2026
├── history.js          # 30-entry calculation history
├── analytics.js        # Anonymous sendBeacon telemetry
├── api/
│   └── commute.js      # Vercel serverless proxy — keeps API key server-side
├── .github/
│   └── workflows/
│       └── deploy.yml  # GitHub Actions CI/CD
├── vercel.json         # Routing + security headers
├── package.json
├── .gitignore
└── .env.example        # Environment variable template
```

---

## Two API Keys Required

This project uses **two separate Google Maps API keys** for security:

| Key | Purpose | Restriction |
|-----|---------|-------------|
| `GOOGLE_MAPS_API_KEY` | Server-side — Directions API routing | Directions API only |
| `PUBLIC_MAPS_KEY` | Client-side — Places Autocomplete | HTTP referrer + Places API + Maps JS API only |

The private key never appears in client code. It lives in Vercel's encrypted environment variables and is only used inside `api/commute.js`.

---

## Local Setup

### Prerequisites
- Node.js 18+
- Git
- Vercel CLI: `npm install -g vercel`
- Two Google Maps API keys (see above)

### 1. Clone

```bash
git clone https://github.com/haragonda/BLR-CommuteOptimizer.git
cd BLR-CommuteOptimizer
```

### 2. Configure Google Cloud

**Enable these APIs** in [Google Cloud Console](https://console.cloud.google.com):
- Directions API (for private key)
- Maps JavaScript API + Places API (for public key)

**Create two API keys:**
- Key 1 `GOOGLE_MAPS_API_KEY`: restrict to Directions API only
- Key 2 `PUBLIC_MAPS_KEY`: restrict to HTTP referrers (your domain + localhost) + Maps JS + Places APIs

**Set budget alert:** Billing → Budgets & Alerts → ₹100 cap

### 3. Environment Variables

```bash
cp .env.example .env.local
```

Edit `.env.local`:
```
GOOGLE_MAPS_API_KEY=your_private_directions_key
PUBLIC_MAPS_KEY=your_public_places_key
```

### 4. Run Locally

```bash
npm install
vercel dev
```

Open `http://localhost:3000` — toggle Demo Mode to test without API calls.

---

## Deployment

### Vercel

```bash
vercel login
vercel link
vercel env add GOOGLE_MAPS_API_KEY    # select Production, mark as sensitive
vercel env add PUBLIC_MAPS_KEY        # select Production, mark as sensitive
vercel --prod
```

### GitHub Actions (Auto-Deploy)

Add these 4 secrets to GitHub → Settings → Secrets and variables → Actions:

| Secret | Where to find it |
|--------|-----------------|
| `VERCEL_TOKEN` | vercel.com → Account Settings → Tokens |
| `VERCEL_ORG_ID` | `.vercel/project.json` → orgId |
| `VERCEL_PROJECT_ID` | `.vercel/project.json` → projectId |
| `PUBLIC_MAPS_KEY` | Your Google Cloud public key |

Every push to `main` triggers: lint → structure check → secrets scan → deploy.

---

## API Cost

Google gives $200 free credit per month. At personal use (4 calculations/day, 2 days/week):

| API | Monthly calls | Free tier | Cost |
|-----|--------------|-----------|------|
| Directions API | ~256 | 40,000/mo | ₹0 |
| Places API | ~48 | 10,000/mo | ₹0 |

**Total: ₹0/month** at this usage level.

---

## Phase 1 Roadmap (October 2026)

- Multi-modal comparison — Uber, Rapido, auto, bus, Metro, walk in one view
- Fare estimates with accuracy contract
- Saved route profiles (up to 3)
- URL-encoded share link for cross-device access
- 6-slot departure curve + bar chart
- Monsoon season warning + algorithm adjustment
- In-app on-time feedback prompt

See [PRD v2.1](docs/) for full specification.

---

## Documents

| Document | Description |
|----------|-------------|
| `PRD_v2.1` | Full Product Requirements Document |
| `GAP_ANALYSIS` | Code vs PRD gap analysis |
| `Deployment_Status_BuildPlan` | Current deployment status + Phase 1 build steps |

---

## Author

**Hemanth Aragonda** — Staff Technical Program Manager
[github.com/haragonda](https://github.com/haragonda)
