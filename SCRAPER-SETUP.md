# Partner Comparison Scraper — How It's Set Up

This documents how partner price data gets scraped, stored, and served across
the two running instances of this app. Written after a session spent fixing a
recurring "Price missing" bug — read the **Why** notes, they explain decisions
that aren't obvious from the code alone.

## The core problem this setup works around

Kapruka geo-detects the connecting IP and serves **USD pricing instead of LKR**
to hosts outside Sri Lanka. The scraper (`src/compare/sources.js`) only trusts
LKR-tagged prices (from JSON-LD, or a visible price that literally contains
"Rs./LKR/₨") — anything else is left `null` rather than stored as if it were
rupees. A product with no usable LKR price anywhere ends up with the
`price_missing` verdict.

**This means: which host does the scraping from determines data quality.** A
host with bad Kapruka geo-pricing will produce incomplete data no matter how
good the rest of the code is.

## Two running instances, one shared backend

| | This local machine | VPS (`23.111.183.110`, service `KaprukaPriceTools`) |
|---|---|---|
| Confirmed Kapruka geo-pricing | ✅ Yes — tested directly, gets correct LKR | ❌ Confirmed bad — gets USD, not LKR |
| Runs the scheduled scraper | ✅ Yes (see below) | No — would produce incomplete data |
| Code | Same GitHub repo | Same GitHub repo |
| Data | Same Supabase project | Same Supabase project |

Both instances read `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` from their own local
`.env` and talk to the **same Supabase tables** (`comparison_runs`,
`price_checks`, `partners` — see "Adding / removing partners" below). Code
lives in each instance's own local git checkout — **pushing a commit here
does not deploy it there**; each side needs its own `git pull` (or
`git fetch` + `git rebase` if it has local commits of its own) and a restart.

**Why scraping only runs from this local machine:** it's the only host
confirmed to get correct LKR pricing. Tested directly on the VPS too (fetch a
Kapruka catalogue page, check `"priceCurrency"` in the JSON-LD) — it comes
back `USD`, confirming it has the bad-geo-pricing problem. So the VPS should
never run the scheduled scraper itself; it only ever reads what this machine
(or another confirmed-good host) has already written to Supabase.

## The scheduled refresh job

- **Script:** `src/tools/refresh-all-partners.js`
- **Wrapper:** `scripts/refresh-all-partners.bat` (resolves the full path to
  `node.exe` and sets the working directory explicitly — a bare `node` on PATH
  isn't reliably resolved inside a non-interactive Task Scheduler session)
- **Windows Scheduled Task:** `Kapruka Price Refresh`, daily at 3:00 AM, on
  this local machine
- **Log:** `logs/refresh-all-partners.log`

Check/manage the task:
```powershell
Get-ScheduledTaskInfo -TaskName "Kapruka Price Refresh"
Start-ScheduledTask -TaskName "Kapruka Price Refresh"   # run it now
```

Run it manually without the scheduler:
```
node src/tools/refresh-all-partners.js
```

### Gap-filling, not a full re-scrape every time

The script loops over every partner in the shared `partners` table, but **skips any
partner whose latest stored Supabase run already has zero `price_missing`
entries** — it only rescrapes partners with gaps (or no stored run yet). This
matters for two reasons: it avoids wasted requests against Kapruka/partner
sites, and it directly reduces how often the next issue gets triggered:

### 429 rate-limiting

Partners with larger, multi-page catalogues (more `&p=N` requests in quick
succession) can trip Kapruka's per-IP rate limit mid-fetch. `fetchText()` in
`src/compare/sources.js` retries a `429` with backoff (honouring `Retry-After`
if Kapruka sends one, else 1s/2s/4s/8s), and `fetchKaprukaCatalog()` adds a
350ms delay between page requests to reduce how often the limit gets tripped
in the first place. Even so, a partner with a large catalogue may need two
runs of the scheduled job to fully complete — this is expected, not a bug; the
gap-fill logic will pick it up again next time since it won't show as
"complete" until `price_missing` is actually zero.

## How the web app serves data (no live scraping on page view)

`/api/compare` (used by `compare.html`) and `/api/overpriced` (the dashboard)
**only ever read the latest stored Supabase run** — neither triggers a live
scrape on a normal page view. There used to be a "Refresh" button that forced
a live re-scrape from whichever server was handling the request; it was
**removed** because it let anyone browsing either instance silently overwrite
good stored data with bad data, if that instance happened to be on a host with
poor Kapruka geo-pricing (or just from load/rate-limiting mid-scrape).

The only exception: a partner with **no stored run at all yet** (brand new,
just added) gets one live fetch so it has something to show, and that result
is saved as its first row.

**Net effect:** the only way partner data ever gets refreshed is the scheduled
job described above. Nothing else writes to `comparison_runs`.

## The VPS's own disk-cache + MCP fallback (optional, separate mechanism)

The VPS had independent, locally-committed work (never pushed until this was
reconciled) that adds a *different* caching/backfill layer on top of the
above, in `src/compare/run.js` and `src/compare/mcpPrices.js`:

- A **disk-backed cache** (`data/compare-cache/<partnerId>.json`) with
  stale-while-revalidate: an on-demand `runComparison()` call returns cached
  data instantly and refreshes in the background rather than blocking.
- An **MCP-based price hydration fallback**, gated behind `USE_KAPRUKA_MCP=1`
  in `.env`. For any product still missing a price after the normal catalogue
  scrape, it tries (in order):
  1. Loading the product's own Kapruka page via the `/lk/buyonline/...` URL
     variant (vs. plain `/buyonline/...`) — this appears to force LKR pricing
     **regardless of the visitor's geo-IP**, unlike the bulk catalogue pages.
  2. Falling back to a company-run MCP server (`mcp.kapruka.com`, tool
     `kapruka_search_products`), matching by extracted model code as a safety
     check against wrong matches.

This is **separate from and complementary to** the scheduled-job approach
above. It only reaches Supabase on a partner's very first-ever load (the
synchronous path, which always saves regardless of data quality); a
*background* refresh (stale cache being revalidated) only rewrites the local
disk cache file and never touches Supabase. So it can meaningfully help a
brand-new partner's first save, but has no effect on data the scheduled job
already owns and keeps fixing.

## Adding / removing partners

Partners live in the `partners` table in Supabase — **shared** across every
instance, unlike the scraped data's-adjacent-but-separate concerns above.
This used to be a per-machine `config/partners.json` file, which meant one
instance adding a partner was invisible to any other instance until someone
manually git-synced the file — a recurring source of confusion once this app
started running from more than one server. Add a partner either through the
UI ("➕ Add a store" on the Comparison page, from *either* instance — it
writes straight to Supabase) or directly:

```js
// one-off, e.g. via `node -e "import('./src/db.js').then(db => db.insertPartnerRow({...}))"`
await db.insertPartnerRow({
  id: 'partner-id',        // becomes the URL param: ?partner=partner-id
  name: 'Display Name',
  kaprukaUrl: 'https://www.kapruka.com/partner/<slug>',
  partnerSite: 'https://partner-site.com/',
  partnerLabel: 'partner-site.com',
  platform: 'woocommerce | shopify | auto',
});
```

A newly-added partner gets one live fetch on its first page view (see above),
then the scheduled job takes over — automatically, on *any* instance, since
the registry itself is shared.

## Accessing the VPS

The VPS runs Windows, reachable only via **Remote Desktop (RDP)** — there's no
SSH access set up. Connect with:

```
mstsc /v:23.111.183.110
```

(or open "Remote Desktop Connection" from the Start menu and enter that
address). It prompts for a Windows account username/password on *that
server* — not your normal work login, unless that box happens to be joined to
the same company domain (worth trying once, but don't assume it).

**Watch out for account lockout.** Several wrong-password attempts in a row
locks the account ("too many logon attempts") for a period that isn't
short — in practice it stayed locked well past 30 minutes. If you're not sure
of the password, stop after one or two tries rather than hammering it; if it
does lock, the only way back in is either waiting it out, or an admin/hosting
console unlocking it out-of-band (see below).

**If you don't have login credentials and don't know where to find them:**
check the hosting provider's account (DigitalOcean/Azure/AWS/etc. — look for
billing records or setup emails to identify who it's with) for a browser-based
console/VNC session, which bypasses the Windows login entirely and can also
reset the Administrator password from outside.

**Once connected**, open PowerShell (not Command Prompt — a lot of the
diagnostic commands below only work there) and `cd` to the app folder:
```powershell
cd C:\apps\kapruka-price-tools
```

Useful commands once there:
```powershell
Get-Service KaprukaPriceTools              # is it running?
Restart-Service KaprukaPriceTools          # apply code changes
Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" |
  Select-Object CommandLine, ParentProcessId   # what's actually running, and how it's supervised
```

The app is registered as a real Windows Service via **NSSM** (a tool that
wraps an arbitrary command as a proper service) under the name
`KaprukaPriceTools` — that's why `Restart-Service` works instead of needing to
find and kill/relaunch a bare console process.

## Keeping both instances in sync

Since both instances are independent git checkouts of the same GitHub repo
(`KaprukaDM/kapruka-price-tools`):

```powershell
git fetch origin
git pull origin main          # if no local commits of your own
# — or, if this instance has its own uncommitted/local work —
git rebase origin/main        # replays local commits on top, resolve conflicts if any
git push origin main          # share it back
```

After pulling code changes on the VPS, restart the service so they take
effect — `git pull` alone does **not** restart the running node process:
```powershell
Restart-Service KaprukaPriceTools
```

Locally, restart with `npm start` (or however you're running it). Note this
sync is only for **code** changes now — the partner registry itself lives in
Supabase, so a new partner added on one instance is already visible on the
other immediately, with no git sync or restart needed.
