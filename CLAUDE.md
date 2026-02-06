# CLAUDE.md

## Project Overview

Nawabi Chai House — dual-purpose project with a **marketing website** (static HTML) and an **operations management suite** (dashboards for live sales monitoring, runner settlement, and analytics). Brand of HN Hotels Pvt Ltd, Shivajinagar, Bangalore.

## Tech Stack

- **Frontend**: Pure HTML5/CSS3/Vanilla JavaScript — no frameworks, no build tools
- **Backend**: Cloudflare Workers (serverless functions in `/functions/api/`)
- **Database**: Cloudflare D1 (SQLite) for settlement records
- **Hosting**: Cloudflare Pages (auto-deploys on push to `main`)
- **External APIs**: Odoo ERP (JSON-RPC for POS data), Razorpay (UPI payments)

## Project Structure

```
├── index.html                  # Marketing website (self-contained HTML/CSS/JS)
├── privacy-policy.html         # Legal page
├── terms.html                  # Terms of service
├── schema.sql                  # D1 database schema
├── assets/                     # Brand logos (SVG/PNG)
├── functions/api/              # Cloudflare Worker endpoints
│   ├── nch-data.js            # Main dashboard API
│   ├── sales-insights.js      # Sales analytics API
│   └── settlement.js          # Runner settlement API
└── ops/                        # Operations dashboards
    ├── index.html             # Dashboard hub
    ├── live/index.html        # Real-time monitoring
    ├── sales/index.html       # Sales insights
    └── settlement/index.html  # Runner cash settlement
```

## Commands

```bash
# Local dev server
npx serve .

# Deploy (auto via Cloudflare Pages)
git push origin main

# Initialize D1 database
wrangler d1 execute <DATABASE_NAME> --file=schema.sql
```

## Code Conventions

- **No npm dependencies** — pure vanilla web standards
- **Single-file components** — each HTML page is self-contained with inline `<style>` and `<script>`
- **File names**: kebab-case (`nch-data.js`, `sales-insights.js`)
- **Functions**: camelCase (`fetchOdooOrders`, `processDashboardData`)
- **Constants**: SCREAMING_SNAKE_CASE (`ODOO_URL`, `RAZORPAY_KEY`)
- **CSS variables** for brand colors: `--chamoisee-brown: #AC7E54`, `--wheat: #E9D1A9`, `--golden-amber: #D4A44C`
- **ES6+**: Arrow functions, async/await, template literals
- **Mobile-first responsive** design with CSS Grid (`.grid-4`, `.grid-2`)
- **No formal tests** — manual browser-based testing

## Environment Variables (Cloudflare Workers Secrets)

```
ODOO_API_KEY       # Odoo authentication token
RAZORPAY_KEY       # Razorpay API key ID
RAZORPAY_SECRET    # Razorpay API secret
DB                 # Cloudflare D1 database binding
```

## API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/nch-data?from=&to=` | GET | Real-time sales data with runner breakdown |
| `/api/sales-insights?from=&to=` | GET | Product performance & hourly analytics |
| `/api/settlement?action=` | GET/POST | Runner cash settlement (verify-pin, settle, history) |

## Key Business Logic

### Runner IDs & QR Codes
- Runner IDs: 64 (FAROOQ/RUN001), 65 (AMIN/RUN002), 66–68 (RUN003–RUN005)
- Each runner has a Razorpay QR code for UPI collection

### Odoo Payment Method IDs
- 37: Cash, 38: UPI (Counter), 39: Card, 40: Runner Ledger, 48: Token Issue, 49: Complimentary

### POS Configs
- 27: Cash Counter (main register), 28: Runner Counter (delivery orders)

### Settlement Formula
```
cashToCollect = (tokens + sales) - upiAmount
```

## Architecture

```
User → HTML Dashboard → Cloudflare Worker → Odoo/Razorpay → Response → DOM Update
```

- Cloudflare Workers use `onRequest` export pattern with CORS headers
- Odoo integration via JSON-RPC to `ops.hamzahotel.com/jsonrpc`
- Razorpay via REST API with Basic auth
- All datetime handling uses IST (UTC+5:30) conversion
