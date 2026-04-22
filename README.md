# Balance Sheet Builder

An Electron-based desktop tool for Indian Chartered Accountants to convert a Tally Trial Balance into a complete Schedule III financial statements package — Balance Sheet, P&L, Cash Flow Statement (AS 3 Indirect Method), Notes 1-29, Tax Computation, and Audit Report.

## Features

- Trial balance import (Excel / CSV / Tally XML), with separate Current Year and Previous Year slots
- Schedule III Division I balance sheet and P&L with comparative columns
- Cash Flow Statement — Indirect Method, with auto classification of operating / investing / financing flows from BS+PL movement
- Notes to Accounts (N1-N7), Tax Computation with 234A/B/C interest, CARO 2020, Director's Report, Audit Report
- Multi-client workspace (each client's data isolated in its own vault)
- Year-end carry forward, audit log, draft saving
- Print-ready output for the full FS package

## Tech stack

- Electron desktop shell (Mac + Windows)
- Vanilla JavaScript / HTML / CSS — no build step for the app code
- All accounting logic in `engine.js` (single object, ~3000+ lines)
- Per-page UI in dedicated HTML files (`balance.html`, `pl.html`, `cf.html`, `n1`-`n7`, `tx.html`, `audit-report.html`, `fs-package.html`, etc.)

## Run locally

```bash
npm install
npm start
```

## Build installers

```bash
npm run build:mac     # .dmg
npm run build:win     # .exe (NSIS)
npm run build:all
```

## Author

Krimish Rathod
