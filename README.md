# CoinTrack

A self-hosted web app for tracking a coin and bullion collection: what you paid,
what it's worth now, and how that value changes over time.

- **Bullion** is valued from its metal content at live spot price
  (`quantity × weight × purity × spot`, with an optional premium over melt).
- **Collectibles** are valued at the most recent sold price you record
  (eBay sold listings, Heritage, PCGS/NGC price guides, dealer quotes…). Each
  value is kept, so you can see the history. Items with no value, or one older
  than 90 days, are flagged on the dashboard as needing an update. Until you
  add one, a collectible's melt value is used as a floor.
- **Spot prices** for gold, silver, platinum and palladium update automatically
  from a free price API, or you can enter them by hand.
- **History**: the app records the value of every item and of the whole
  collection once a day, and charts value against cost.
- Presets for common coins and bars (Eagles, Maples, Krugerrands, Morgan/Peace
  dollars, pre-1965 90% silver, 40% halves, war nickels, US gold…).
- CSV export for insurance or spreadsheets.

Your data stays in one SQLite file on your machine (`data/cointrack.db`).
Back up that file to back up your collection.

## Requirements

Node.js **22.13 or newer** (it uses Node's built-in SQLite, so there's nothing
to compile).

## Setup

```bash
npm install
cp .env.example .env     # then edit .env
npm start
```

Open <http://127.0.0.1:3000>.

### Getting a spot price API key

Pick one provider, sign up for its free tier, and put the key in `.env`:

| `PRICE_PROVIDER` | Sign up | Notes |
|---|---|---|
| `metalsdev` | <https://metals.dev> | One request per refresh. Recommended. |
| `metalpriceapi` | <https://metalpriceapi.com> | One request per refresh. |
| `goldapi` | <https://www.goldapi.io> | Four requests per refresh; set `REFRESH_HOURS=24` or more. |
| `manual` | — | No API; enter prices on the **Spot prices** page. |

The free tiers allow about 100 requests a month. The default refresh interval
(12 hours) uses about 60. Restarting the server doesn't trigger an extra pull
unless the last one is older than the interval.

### Using it from your phone

By default the server only listens on `127.0.0.1`. To open it from other devices
on your home network, set `HOST=0.0.0.0` and browse to
`http://<computer-ip>:3000`. There is no login, so don't expose it to the
internet without putting authentication (e.g. a reverse proxy) in front.

## Entering items

1. Click **+ Add item** and choose **Bullion** or **Collectible**.
2. Optionally pick a common coin to fill in the metal, weight and purity.
3. Enter the **total price paid** for all pieces and the purchase date.
4. For collectibles, enter the latest sold price for one coin, if you have one.

On an item's page you can add more market values over time. The newest one
sets the current value, and every value appears on the chart.

## Development

```bash
npm run dev   # restarts on file changes
npm test      # node:test suite
```

Project layout:

```
server/
  index.js       startup, scheduled price refresh, daily snapshots
  app.js         Express app and REST API
  db.js          SQLite schema
  prices.js      spot price providers (metals.dev, metalpriceapi, goldapi)
  valuation.js   valuation rules and daily history snapshots
public/          front end (plain HTML/CSS/JS + Chart.js, no build step)
test/            tests
```

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/summary` | Totals, latest spot, stale items |
| GET | `/api/history?days=N` | Daily collection value and cost |
| GET/POST/PUT/DELETE | `/api/items[/:id]` | Collection items |
| POST/DELETE | `/api/items/:id/values[/:valueId]` | Collectible market values |
| GET/POST | `/api/spot` | Latest spot / manual spot entry |
| GET | `/api/spot/history?days=N` | Spot price history |
| POST | `/api/spot/refresh` | Pull spot prices now (rate-limited) |
| GET | `/api/export.csv` | CSV export |
