# Kapruka Price Tools

Two pricing tools for the Kapruka marketplace, served as one web app:

1. **Price Checker** — enter a product, match its live price across curated Sri
   Lankan stores and top web shops, with a confidence rate.
2. **Partner Price Comparison** — reconcile a partner's Kapruka listing against
   their own website: which products match, where Kapruka is overpriced, and
   what's listed on one site but not the other.

Every run of both tools is saved to a SQLite database (`data/price-tools.db`).

## Run locally

```bash
npm install
npm start            # serves http://localhost:3000 (or PORT from .env)
```

Other commands:

```bash
npm run compare      # CLI: writes a report to ./out (matched.csv, report.html, …)
```

The Partner Comparison needs no API keys. The Price Checker uses `OPENAI_API_KEY`
and `SERP_API_KEY` (see `.env.example`).

## Adding a partner to compare

On the Comparison page click **➕ Add a store** and paste:
- the partner's **own website** (WooCommerce or Shopify), and
- their **Kapruka link** — either a partner storefront
  (`kapruka.com/partner/<slug>`) or a brand/category page
  (`kapruka.com/online/<category>/price/<brand>`).

It validates both, detects the store platform, saves the partner to
`config/partners.json`, and runs the comparison. No code changes needed.

## Deploy to Render

This repo includes `render.yaml`, so Render can configure everything.

1. Push this repo to GitHub.
2. In Render: **New + → Blueprint**, pick this repo, click **Apply**.
3. Render builds and deploys; you get a public URL.

### Database persistence on Render
Render's **free** plan has an ephemeral filesystem — the SQLite database is
**wiped on every redeploy and when the service sleeps**. To keep run history,
use the paid **Starter** plan and a persistent disk: in `render.yaml`, set
`plan: starter`, add `DATA_DIR=/var/data`, and uncomment the `disk:` block (it's
already there with instructions).

### Environment variables on Render
- `NODE_VERSION` = `22.16.0` (required — the app uses `node:sqlite`)
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` = `1` (faster builds; the comparison tool
  needs no browser)
- `OPENAI_API_KEY`, `SERP_API_KEY` — optional, only for the Price Checker
- `DATA_DIR` — optional, path to a persistent disk for the database
