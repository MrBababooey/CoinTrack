import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { providers, refreshSpot, recordSpot } from '../server/prices.js';
import { valueItem } from '../server/valuation.js';

const close = (a, b, eps = 0.005) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

describe('valueItem', () => {
  const spot = { silver: { price: 30 }, gold: { price: 2500 } };
  const base = { quantity: 1, weight_ozt: 1, purity: 0.999, premium_pct: 0, purchase_price: 25 };

  test('bullion is valued at melt × premium', () => {
    const v = valueItem({ ...base, category: 'bullion', metal: 'silver', quantity: 10, premium_pct: 10, purchase_price: 300 }, spot, null, { staleDays: 90 });
    close(v.melt_value, 299.7);
    close(v.value, 329.67);
    close(v.gain, 29.67);
    assert.equal(v.basis, 'spot');
    assert.equal(v.stale, false);
  });

  test('bullion without a spot price is unvalued', () => {
    const v = valueItem({ ...base, category: 'bullion', metal: 'platinum' }, spot, null, { staleDays: 90 });
    assert.equal(v.value, null);
    assert.equal(v.basis, 'no-spot');
  });

  test('collectible uses latest market value × quantity', () => {
    const mv = { value_per_unit: 120, recorded_on: '2026-10-01' };
    const v = valueItem({ ...base, category: 'collectible', metal: 'silver', quantity: 2, purity: 0.9, weight_ozt: 0.8594, purchase_price: 200 }, spot, mv, { staleDays: 90, asOf: '2026-11-01' });
    assert.equal(v.value, 240);
    assert.equal(v.basis, 'market');
    assert.equal(v.stale, false);
    close(v.gain_pct, 20);
  });

  test('old market value is flagged stale', () => {
    const mv = { value_per_unit: 120, recorded_on: '2026-01-01' };
    const v = valueItem({ ...base, category: 'collectible', metal: 'silver' }, spot, mv, { staleDays: 90, asOf: '2026-11-01' });
    assert.equal(v.stale, true);
    assert.match(v.stale_reason, /days old/);
  });

  test('collectible without market value falls back to melt and is stale', () => {
    const v = valueItem({ ...base, category: 'collectible', metal: 'gold', weight_ozt: 1.0750, purity: 0.9 }, spot, null, { staleDays: 90 });
    close(v.value, 2418.75);
    assert.equal(v.basis, 'melt-fallback');
    assert.equal(v.stale, true);
  });
});

describe('price providers', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => (globalThis.fetch = realFetch));
  const mockFetch = (body, status = 200) => {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), opts });
      return new Response(JSON.stringify(typeof body === 'function' ? body(String(url)) : body), { status });
    };
    return calls;
  };

  test('metals.dev response', async () => {
    const calls = mockFetch({ status: 'success', metals: { gold: 2650.5, silver: 31.2, platinum: 980, palladium: 1010, copper: 0.3 } });
    const p = await providers.metalsdev({ apiKey: 'k', currency: 'USD' });
    assert.deepEqual(p, { gold: 2650.5, silver: 31.2, platinum: 980, palladium: 1010 });
    assert.match(calls[0].url, /api_key=k/);
  });

  test('metalpriceapi inverts rates and prefers direct keys', async () => {
    mockFetch({ success: true, rates: { XAU: 1 / 2600, USDXAU: 2601, XAG: 1 / 30 } });
    const p = await providers.metalpriceapi({ apiKey: 'k', currency: 'USD' });
    assert.equal(p.gold, 2601);
    close(p.silver, 30);
    assert.equal(p.platinum, undefined);
  });

  test('goldapi calls once per metal with token header', async () => {
    const calls = mockFetch((url) => ({ price: url.includes('XAU') ? 2600 : 30 }));
    const p = await providers.goldapi({ apiKey: 'tok', currency: 'USD' });
    assert.equal(calls.length, 4);
    assert.equal(calls[0].opts.headers['x-access-token'], 'tok');
    assert.equal(p.gold, 2600);
  });

  test('HTTP errors surface the API message', async () => {
    mockFetch({ error_message: 'Invalid API key' }, 401);
    await assert.rejects(providers.metalsdev({ apiKey: 'bad', currency: 'USD' }), /Invalid API key/);
  });

  test('refreshSpot records prices and rate-limits non-forced refreshes', async () => {
    const db = openDb(':memory:');
    const config = loadConfig({ PRICE_PROVIDER: 'metalsdev', PRICE_API_KEY: 'x' });
    const fake = async () => ({ gold: 2000, silver: 25 });
    const r1 = await refreshSpot(db, config, { fetchImpl: fake });
    assert.equal(r1.ok, true);
    const r2 = await refreshSpot(db, config, { fetchImpl: fake });
    assert.equal(r2.skipped, true);
    const r3 = await refreshSpot(db, config, { fetchImpl: fake, force: true });
    assert.equal(r3.ok, true);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM spot_prices').get().n, 4);
  });
});

describe('HTTP API', () => {
  let server, base, db;
  before(async () => {
    db = openDb(':memory:');
    const app = createApp(db, loadConfig({ PRICE_PROVIDER: 'manual' }));
    await new Promise((r) => (server = app.listen(0, '127.0.0.1', r)));
    base = `http://127.0.0.1:${server.address().port}/api`;
  });
  after(() => server.close());

  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
  };

  test('full flow: spot, bullion, collectible, values, summary', async () => {
    assert.equal((await call('POST', '/spot', { gold: 2500, silver: 30 })).status, 201);

    const eagle = await call('POST', '/items', {
      name: 'American Silver Eagle', category: 'bullion', metal: 'silver',
      weight_ozt: 1, purity: 0.999, quantity: 20, purchase_price: 600, purchase_date: '2025-03-01',
    });
    assert.equal(eagle.status, 201);

    const morgan = await call('POST', '/items', {
      name: '1893-S Morgan Dollar', category: 'collectible', metal: 'silver',
      weight_ozt: 0.8594, purity: 0.9, quantity: 1, purchase_price: 4000, purchase_date: '2024-06-15',
      grade: 'VF-20', grading_service: 'PCGS', initial_market_value: 4500, initial_market_value_date: '2026-10-20',
    });
    assert.equal(morgan.status, 201);

    const detail = await call('GET', `/items/${morgan.body.id}`);
    assert.equal(detail.body.valuation.value, 4500);
    assert.equal(detail.body.market_values.length, 1);
    assert.equal(detail.body.history.length, 1);

    assert.equal((await call('POST', `/items/${morgan.body.id}/values`, { value_per_unit: 4800, recorded_on: '2026-11-01', source: 'eBay sold listing' })).status, 201);
    const after = await call('GET', `/items/${morgan.body.id}`);
    assert.equal(after.body.valuation.value, 4800);

    const summary = await call('GET', '/summary');
    close(summary.body.totals.value, 20 * 0.999 * 30 + 4800);
    assert.equal(summary.body.totals.cost, 4600);

    const hist = await call('GET', '/history');
    assert.equal(hist.body.length, 1);
    close(hist.body[0].total_value, summary.body.totals.value);

    const csv = await fetch(`${base}/export.csv`).then((r) => r.text());
    assert.match(csv, /1893-S Morgan Dollar/);
  });

  test('validation errors', async () => {
    const r1 = await call('POST', '/items', { name: 'x', category: 'bullion', metal: 'gold', purchase_price: 10, purchase_date: '2025-01-01' });
    assert.equal(r1.status, 400);
    assert.match(r1.body.error, /weight and purity/);
    const r2 = await call('POST', '/items', { name: 'x', category: 'collectible', purity: 5, purchase_price: 1, purchase_date: '2025-01-01' });
    assert.equal(r2.status, 400);
    const r3 = await call('POST', '/items', { name: 'x', category: 'collectible', purchase_price: 1, purchase_date: 'yesterday' });
    assert.equal(r3.status, 400);
    assert.equal((await call('GET', '/items/9999')).status, 404);
  });

  test('update and delete', async () => {
    const created = await call('POST', '/items', { name: 'Buffalo nickel', category: 'collectible', purchase_price: 5, purchase_date: '2025-01-01' });
    const upd = await call('PUT', `/items/${created.body.id}`, { ...created.body, quantity: 3 });
    assert.equal(upd.body.quantity, 3);
    assert.equal((await call('DELETE', `/items/${created.body.id}`)).status, 204);
    assert.equal((await call('GET', `/items/${created.body.id}`)).status, 404);
  });

  test('manual provider refresh is skipped, not an error', async () => {
    const r = await call('POST', '/spot/refresh');
    assert.equal(r.status, 200);
    assert.equal(r.body.skipped, true);
  });
});

test('recordSpot ignores invalid prices', () => {
  const db = openDb(':memory:');
  const saved = recordSpot(db, { gold: 'abc', silver: -1, platinum: 900 }, { currency: 'USD', source: 't' });
  assert.deepEqual(saved, { platinum: 900 });
});
