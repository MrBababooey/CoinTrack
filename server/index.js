import { loadConfig } from './config.js';
import { openDb, getMeta } from './db.js';
import { createApp } from './app.js';
import { refreshSpot, PROVIDER_NAMES } from './prices.js';
import { snapshot } from './valuation.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const app = createApp(db, config);

if (!PROVIDER_NAMES.includes(config.priceProvider)) {
  console.warn(`Unknown PRICE_PROVIDER "${config.priceProvider}". Valid: ${PROVIDER_NAMES.join(', ')}`);
}

async function scheduledRefresh() {
  if (config.priceProvider !== 'manual') {
    const result = await refreshSpot(db, config, { force: true });
    if (result.ok) console.log(`Spot prices updated: ${JSON.stringify(result.prices)}`);
    else console.warn(`Spot price refresh failed: ${result.error}`);
  }
  // Always record a daily snapshot so the history chart has a point per day,
  // even when prices are entered manually.
  snapshot(db, config);
}

// Refresh at startup only if the last pull is older than the interval, so
// restarting the server doesn't burn API quota.
const last = getMeta(db, 'last_refresh_attempt');
const intervalMs = Math.max(config.refreshHours, 0.25) * 3600 * 1000;
if (!last || Date.now() - Date.parse(last) >= intervalMs) {
  scheduledRefresh();
} else {
  snapshot(db, config);
}
setInterval(scheduledRefresh, intervalMs).unref();
// Keep a daily snapshot even if the refresh interval is long.
setInterval(() => snapshot(db, config), 3600 * 1000).unref();

const server = app.listen(config.port, config.host, () => {
  console.log(`CoinTrack running at http://${config.host}:${config.port}`);
  console.log(`Price provider: ${config.priceProvider}${config.priceProvider !== 'manual' && !config.priceApiKey ? ' (PRICE_API_KEY missing!)' : ''}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
