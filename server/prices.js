// Spot price providers. Each provider returns { gold, silver, platinum,
// palladium } in the configured currency per troy ounce. Metals a provider
// doesn't return are simply omitted.

import { METALS, getMeta, setMeta } from './db.js';

const SYMBOLS = { gold: 'XAU', silver: 'XAG', platinum: 'XPT', palladium: 'XPD' };

async function getJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Price API returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = body?.error_message || body?.error?.message || body?.error || body?.message || text;
    throw new Error(`Price API error (HTTP ${res.status}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return body;
}

function positive(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export const providers = {
  // https://metals.dev — one call returns all metals.
  async metalsdev({ apiKey, currency }) {
    const url = new URL('https://api.metals.dev/v1/latest');
    url.search = new URLSearchParams({ api_key: apiKey, currency, unit: 'toz' });
    const body = await getJson(url);
    if (body.status && body.status !== 'success') {
      throw new Error(`metals.dev: ${body.error_message || body.status}`);
    }
    const out = {};
    for (const metal of METALS) {
      const p = positive(body.metals?.[metal]);
      if (p) out[metal] = p;
    }
    return out;
  },

  // https://metalpriceapi.com — rates are "units of metal per 1 currency",
  // so the per-ounce price is the inverse (newer responses also include
  // a pre-inverted "<CUR><SYM>" key, which we prefer when present).
  async metalpriceapi({ apiKey, currency }) {
    const url = new URL('https://api.metalpriceapi.com/v1/latest');
    url.search = new URLSearchParams({
      api_key: apiKey,
      base: currency,
      currencies: Object.values(SYMBOLS).join(','),
    });
    const body = await getJson(url);
    if (body.success === false) {
      throw new Error(`metalpriceapi: ${body.error?.info || body.error?.message || 'request failed'}`);
    }
    const out = {};
    for (const [metal, sym] of Object.entries(SYMBOLS)) {
      const direct = positive(body.rates?.[`${currency}${sym}`]);
      const inverse = positive(body.rates?.[sym]);
      const p = direct ?? (inverse ? 1 / inverse : null);
      if (p) out[metal] = p;
    }
    return out;
  },

  // https://www.goldapi.io — one call per metal.
  async goldapi({ apiKey, currency }) {
    const out = {};
    const errors = [];
    for (const [metal, sym] of Object.entries(SYMBOLS)) {
      try {
        const body = await getJson(`https://www.goldapi.io/api/${sym}/${currency}`, {
          headers: { 'x-access-token': apiKey, 'Content-Type': 'application/json' },
        });
        const p = positive(body.price);
        if (p) out[metal] = p;
      } catch (err) {
        errors.push(`${metal}: ${err.message}`);
      }
    }
    if (!Object.keys(out).length && errors.length) throw new Error(errors.join('; '));
    return out;
  },
};

export const PROVIDER_NAMES = ['manual', ...Object.keys(providers)];

export function latestSpot(db) {
  const rows = db
    .prepare(
      `SELECT s.metal, s.price, s.currency, s.source, s.fetched_at
         FROM spot_prices s
         JOIN (SELECT metal, MAX(id) AS id FROM spot_prices GROUP BY metal) m ON m.id = s.id`,
    )
    .all();
  const spot = {};
  for (const r of rows) spot[r.metal] = { ...r };
  return spot;
}

/** Spot price for each metal as of ~24h before its latest observation. */
export function previousSpot(db) {
  const out = {};
  const latest = latestSpot(db);
  for (const [metal, cur] of Object.entries(latest)) {
    const row = db
      .prepare(
        `SELECT price, fetched_at FROM spot_prices
          WHERE metal = ? AND fetched_at <= strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-20 hours')
          ORDER BY fetched_at DESC, id DESC LIMIT 1`,
      )
      .get(metal, cur.fetched_at);
    if (row) out[metal] = { ...row };
  }
  return out;
}

export function recordSpot(db, prices, { currency, source }) {
  const insert = db.prepare(
    'INSERT INTO spot_prices (metal, price, currency, source) VALUES (?, ?, ?, ?)',
  );
  const saved = {};
  for (const metal of METALS) {
    const p = positive(prices[metal]);
    if (p) {
      insert.run(metal, p, currency, source);
      saved[metal] = p;
    }
  }
  return saved;
}

/**
 * Pull fresh spot prices from the configured provider and store them.
 * Returns { ok, prices?, error?, skipped? }. Never throws.
 */
export async function refreshSpot(db, config, { force = false, fetchImpl } = {}) {
  const name = config.priceProvider;
  if (name === 'manual') {
    return { ok: false, skipped: true, error: 'Price provider is "manual"; enter spot prices by hand or configure an API.' };
  }
  const provider = fetchImpl || providers[name];
  if (!provider) return { ok: false, error: `Unknown PRICE_PROVIDER "${name}". Use one of: ${PROVIDER_NAMES.join(', ')}` };
  if (!config.priceApiKey && !fetchImpl) return { ok: false, error: 'PRICE_API_KEY is not set.' };

  const last = getMeta(db, 'last_refresh_attempt');
  if (!force && last) {
    const ageMin = (Date.now() - Date.parse(last)) / 60000;
    if (ageMin < config.minRefreshMinutes) {
      return { ok: false, skipped: true, error: `Prices were refreshed ${Math.floor(ageMin)} min ago; try again in ${Math.ceil(config.minRefreshMinutes - ageMin)} min.` };
    }
  }
  setMeta(db, 'last_refresh_attempt', new Date().toISOString());

  try {
    const prices = await provider({ apiKey: config.priceApiKey, currency: config.currency });
    const saved = recordSpot(db, prices, { currency: config.currency, source: name });
    if (!Object.keys(saved).length) throw new Error('Provider returned no usable prices.');
    setMeta(db, 'last_refresh_error', null);
    return { ok: true, prices: saved };
  } catch (err) {
    setMeta(db, 'last_refresh_error', `${new Date().toISOString()} ${err.message}`);
    return { ok: false, error: err.message };
  }
}
