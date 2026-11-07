import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { METALS, getMeta, tx } from './db.js';
import { latestSpot, previousSpot, recordSpot, refreshSpot } from './prices.js';
import { latestMarketValues, snapshot, today, valueCollection, valueItem } from './valuation.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function str(v, max = 500) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function number(v, field, { min = 0, required = false, integer = false } = {}) {
  if (v === '' || v == null) {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
    throw new HttpError(400, `${field} must be ${integer ? 'a whole number' : 'a number'} ≥ ${min}`);
  }
  return n;
}

function day(v, field, { required = true } = {}) {
  const s = str(v, 10);
  if (!s) {
    if (required) throw new HttpError(400, `${field} is required`);
    return null;
  }
  if (!DAY_RE.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, `${field} must be YYYY-MM-DD`);
  return s;
}

function parseItem(body) {
  const category = body.category;
  if (!['bullion', 'collectible'].includes(category)) {
    throw new HttpError(400, 'category must be "bullion" or "collectible"');
  }
  const metal = body.metal || 'none';
  if (![...METALS, 'none'].includes(metal)) throw new HttpError(400, 'metal is not valid');
  const name = str(body.name, 200);
  if (!name) throw new HttpError(400, 'name is required');

  const weight = number(body.weight_ozt, 'Weight') ?? 0;
  const purity = number(body.purity, 'Purity') ?? 0;
  if (purity > 1) throw new HttpError(400, 'Purity must be between 0 and 1 (e.g. 0.999)');
  if (category === 'bullion' && metal === 'none') throw new HttpError(400, 'Bullion needs a metal');
  if (category === 'bullion' && (weight <= 0 || purity <= 0)) {
    throw new HttpError(400, 'Bullion needs a weight and purity to calculate melt value');
  }

  return {
    name,
    category,
    metal,
    weight_ozt: weight,
    purity,
    quantity: number(body.quantity, 'Quantity', { min: 1, integer: true }) ?? 1,
    year: str(body.year, 20),
    mint_mark: str(body.mint_mark, 20),
    grade: str(body.grade, 40),
    grading_service: str(body.grading_service, 40),
    cert_number: str(body.cert_number, 60),
    purchase_price: number(body.purchase_price, 'Purchase price', { required: true }),
    purchase_date: day(body.purchase_date, 'Purchase date'),
    premium_pct: number(body.premium_pct, 'Premium', { min: -100 }) ?? 0,
    notes: str(body.notes, 4000),
  };
}

function parseMarketValue(body) {
  return {
    value_per_unit: number(body.value_per_unit, 'Value', { required: true }),
    recorded_on: day(body.recorded_on, 'Date', { required: false }) ?? today(),
    source: str(body.source, 200),
    note: str(body.note, 1000),
  };
}

const ITEM_COLS = [
  'name', 'category', 'metal', 'weight_ozt', 'purity', 'quantity', 'year', 'mint_mark', 'grade',
  'grading_service', 'cert_number', 'purchase_price', 'purchase_date', 'premium_pct', 'notes',
];

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function createApp(db, config) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  const getItem = (id) => {
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(id));
    if (!item) throw new HttpError(404, 'Item not found');
    return item;
  };

  const status = () => ({
    currency: config.currency,
    provider: config.priceProvider,
    has_api_key: Boolean(config.priceApiKey),
    refresh_hours: config.refreshHours,
    stale_days: config.staleDays,
    last_refresh_attempt: getMeta(db, 'last_refresh_attempt'),
    last_refresh_error: getMeta(db, 'last_refresh_error'),
  });

  // ---- Summary / dashboard ------------------------------------------------
  app.get('/api/summary', (req, res) => {
    const { items, totals, spot } = valueCollection(db, config);
    const prev = previousSpot(db);
    const stale = items
      .filter((i) => i.valuation.stale)
      .map((i) => ({ id: i.id, name: i.name, reason: i.valuation.stale_reason }));
    res.json({ totals, spot, previous_spot: prev, stale, status: status() });
  });

  app.get('/api/history', (req, res) => {
    const days = Math.min(Number(req.query.days) || 3650, 36500);
    const rows = db
      .prepare(
        `SELECT day, total_value, total_cost FROM portfolio_history
          WHERE day >= date('now', ?) ORDER BY day`,
      )
      .all(`-${days} days`);
    res.json(rows);
  });

  // ---- Spot prices --------------------------------------------------------
  app.get('/api/spot', (req, res) => {
    res.json({ latest: latestSpot(db), previous: previousSpot(db), status: status() });
  });

  app.get('/api/spot/history', (req, res) => {
    const days = Math.min(Number(req.query.days) || 365, 36500);
    const rows = db
      .prepare(
        `SELECT metal, price, fetched_at FROM spot_prices
          WHERE fetched_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
          ORDER BY fetched_at`,
      )
      .all(`-${days} days`);
    res.json(rows);
  });

  app.post('/api/spot/refresh', async (req, res) => {
    const result = await refreshSpot(db, config, { force: false });
    if (result.ok) snapshot(db, config);
    res.status(result.ok || result.skipped ? 200 : 502).json(result);
  });

  // Manual spot entry, e.g. { "gold": 2650.10, "silver": 31.2 }
  app.post('/api/spot', (req, res) => {
    const prices = {};
    for (const metal of METALS) {
      const v = number(req.body?.[metal], metal);
      if (v) prices[metal] = v;
    }
    if (!Object.keys(prices).length) throw new HttpError(400, 'Enter at least one spot price');
    const saved = recordSpot(db, prices, { currency: config.currency, source: 'manual' });
    snapshot(db, config);
    res.status(201).json({ ok: true, prices: saved });
  });

  // ---- Items --------------------------------------------------------------
  app.get('/api/items', (req, res) => {
    res.json(valueCollection(db, config).items);
  });

  app.get('/api/items/:id', (req, res) => {
    const item = getItem(req.params.id);
    const mvs = latestMarketValues(db);
    const valuation = valueItem(item, latestSpot(db), mvs.get(item.id), { staleDays: config.staleDays });
    const market_values = db
      .prepare('SELECT * FROM market_values WHERE item_id = ? ORDER BY recorded_on DESC, id DESC')
      .all(item.id);
    const history = db
      .prepare('SELECT day, value, cost FROM item_value_history WHERE item_id = ? ORDER BY day')
      .all(item.id);
    res.json({ ...item, valuation, market_values, history });
  });

  app.post('/api/items', (req, res) => {
    const data = parseItem(req.body || {});
    const initialValue = req.body?.initial_market_value;
    const id = tx(db, () => {
      const r = db
        .prepare(`INSERT INTO items (${ITEM_COLS.join(', ')}) VALUES (${ITEM_COLS.map(() => '?').join(', ')})`)
        .run(...ITEM_COLS.map((c) => data[c]));
      if (initialValue != null && initialValue !== '') {
        const mv = parseMarketValue({
          value_per_unit: initialValue,
          recorded_on: req.body.initial_market_value_date,
          source: req.body.initial_market_value_source,
        });
        db.prepare('INSERT INTO market_values (item_id, value_per_unit, recorded_on, source, note) VALUES (?, ?, ?, ?, ?)')
          .run(r.lastInsertRowid, mv.value_per_unit, mv.recorded_on, mv.source, mv.note);
      }
      return Number(r.lastInsertRowid);
    });
    snapshot(db, config);
    res.status(201).json(getItem(id));
  });

  app.put('/api/items/:id', (req, res) => {
    const item = getItem(req.params.id);
    const data = parseItem(req.body || {});
    db.prepare(
      `UPDATE items SET ${ITEM_COLS.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    ).run(...ITEM_COLS.map((c) => data[c]), item.id);
    snapshot(db, config);
    res.json(getItem(item.id));
  });

  app.delete('/api/items/:id', (req, res) => {
    const item = getItem(req.params.id);
    db.prepare('DELETE FROM items WHERE id = ?').run(item.id);
    snapshot(db, config);
    res.status(204).end();
  });

  // ---- Market values (collectibles) --------------------------------------
  app.post('/api/items/:id/values', (req, res) => {
    const item = getItem(req.params.id);
    const mv = parseMarketValue(req.body || {});
    const r = db
      .prepare('INSERT INTO market_values (item_id, value_per_unit, recorded_on, source, note) VALUES (?, ?, ?, ?, ?)')
      .run(item.id, mv.value_per_unit, mv.recorded_on, mv.source, mv.note);
    snapshot(db, config);
    res.status(201).json(db.prepare('SELECT * FROM market_values WHERE id = ?').get(r.lastInsertRowid));
  });

  app.delete('/api/items/:id/values/:valueId', (req, res) => {
    const item = getItem(req.params.id);
    const r = db.prepare('DELETE FROM market_values WHERE id = ? AND item_id = ?').run(Number(req.params.valueId), item.id);
    if (!r.changes) throw new HttpError(404, 'Value not found');
    snapshot(db, config);
    res.status(204).end();
  });

  // ---- Export -------------------------------------------------------------
  app.get('/api/export.csv', (req, res) => {
    const { items } = valueCollection(db, config);
    const header = [...ITEM_COLS, 'fine_ozt', 'melt_value', 'current_value', 'value_basis', 'gain'];
    const lines = [header.join(',')];
    for (const it of items) {
      const v = it.valuation;
      lines.push(
        [...ITEM_COLS.map((c) => it[c]), v.fine_ozt, v.melt_value?.toFixed(2), v.value?.toFixed(2), v.basis, v.gain?.toFixed(2)]
          .map(csvCell)
          .join(','),
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="cointrack-${today()}.csv"`);
    res.send(lines.join('\n') + '\n');
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ---- Static front end ---------------------------------------------------
  app.get('/vendor/chart.umd.js', (req, res) => {
    res.sendFile(join(ROOT, 'node_modules/chart.js/dist/chart.umd.js'));
  });
  app.use(express.static(join(ROOT, 'public')));

  // Express 5 forwards thrown/rejected errors here.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  return app;
}
