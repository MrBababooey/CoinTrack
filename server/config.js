// Runtime configuration, read from environment variables (or a .env file
// loaded by `npm start`). See .env.example for documentation of each value.

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && value !== '' && value != null ? n : fallback;
}

export function loadConfig(env = process.env) {
  return {
    host: env.HOST || '127.0.0.1',
    port: num(env.PORT, 3000),
    dbPath: env.DB_PATH || 'data/cointrack.db',
    currency: (env.CURRENCY || 'USD').toUpperCase(),
    priceProvider: (env.PRICE_PROVIDER || 'manual').toLowerCase(),
    priceApiKey: env.PRICE_API_KEY || '',
    // How often to pull spot prices automatically. 12h ≈ 60 calls/month,
    // which fits inside the free tiers of the supported providers.
    refreshHours: num(env.REFRESH_HOURS, 12),
    // Minimum gap between manual "Refresh now" clicks, to protect API quota.
    minRefreshMinutes: num(env.MIN_REFRESH_MINUTES, 10),
    // Collectible values older than this are flagged as needing an update.
    staleDays: num(env.STALE_DAYS, 90),
  };
}
