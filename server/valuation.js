// Valuation rules:
//   melt value  = quantity × weight (ozt) × purity × spot price
//   bullion     = melt × (1 + premium_pct / 100)
//   collectible = latest recorded market value per unit × quantity,
//                 or melt value if no market value has been recorded yet.
// Collectible values older than STALE_DAYS (or missing) are flagged stale.

import { latestSpot } from './prices.js';

export function today() {
  // Local calendar day in YYYY-MM-DD.
  return new Date().toLocaleDateString('en-CA');
}

function daysBetween(fromDay, toDay) {
  return Math.round((Date.parse(toDay) - Date.parse(fromDay)) / 86400000);
}

export function fineOunces(item) {
  return item.quantity * item.weight_ozt * item.purity;
}

export function latestMarketValues(db) {
  const rows = db
    .prepare(
      `SELECT mv.* FROM market_values mv
        JOIN (SELECT item_id, MAX(recorded_on || printf('%010d', id)) AS k
                FROM market_values GROUP BY item_id) l
          ON l.item_id = mv.item_id AND (mv.recorded_on || printf('%010d', mv.id)) = l.k`,
    )
    .all();
  return new Map(rows.map((r) => [r.item_id, r]));
}

export function valueItem(item, spot, latestMv, { staleDays, asOf = today() } = {}) {
  const fine = fineOunces(item);
  const spotPrice = item.metal !== 'none' ? spot[item.metal]?.price ?? null : null;
  const melt = spotPrice != null ? fine * spotPrice : null;

  let value = null;
  let basis;
  let stale = false;
  let staleReason = null;

  if (item.category === 'bullion') {
    if (melt != null) {
      value = melt * (1 + (item.premium_pct || 0) / 100);
      basis = 'spot';
    } else {
      basis = item.metal === 'none' ? 'none' : 'no-spot';
    }
  } else if (latestMv) {
    value = latestMv.value_per_unit * item.quantity;
    basis = 'market';
    const age = daysBetween(latestMv.recorded_on, asOf);
    if (staleDays != null && age > staleDays) {
      stale = true;
      staleReason = `Last market value is ${age} days old`;
    }
  } else {
    value = melt;
    basis = melt != null ? 'melt-fallback' : 'none';
    stale = true;
    staleReason = 'No market value recorded yet';
  }

  const cost = item.purchase_price;
  const gain = value != null ? value - cost : null;
  return {
    fine_ozt: fine,
    spot_price: spotPrice,
    melt_value: melt,
    value,
    basis,
    cost,
    gain,
    gain_pct: gain != null && cost > 0 ? (gain / cost) * 100 : null,
    stale,
    stale_reason: staleReason,
    last_market_value: latestMv || null,
  };
}

export function valueCollection(db, config) {
  const items = db.prepare('SELECT * FROM items ORDER BY name COLLATE NOCASE, id').all();
  const spot = latestSpot(db);
  const mvs = latestMarketValues(db);
  const valued = items.map((item) => ({
    ...item,
    valuation: valueItem(item, spot, mvs.get(item.id), { staleDays: config.staleDays }),
  }));

  const totals = { value: 0, cost: 0, valued_cost: 0, unvalued: 0, stale: 0, by_metal: {}, by_category: {} };
  for (const it of valued) {
    const v = it.valuation;
    totals.cost += v.cost;
    if (v.value != null) {
      totals.value += v.value;
      totals.valued_cost += v.cost;
    } else {
      totals.unvalued += 1;
    }
    if (v.stale) totals.stale += 1;
    const m = (totals.by_metal[it.metal] ??= { value: 0, cost: 0, fine_ozt: 0 });
    m.value += v.value ?? 0;
    m.cost += v.cost;
    m.fine_ozt += v.fine_ozt;
    const c = (totals.by_category[it.category] ??= { value: 0, cost: 0, count: 0 });
    c.value += v.value ?? 0;
    c.cost += v.cost;
    c.count += it.quantity;
  }
  // Gain only counts items we can value, so an unvalued coin doesn't show
  // up as a 100% loss.
  totals.gain = totals.value - totals.valued_cost;
  totals.gain_pct = totals.valued_cost > 0 ? (totals.gain / totals.valued_cost) * 100 : null;
  return { items: valued, totals, spot };
}

/**
 * Record today's value for every item and for the portfolio as a whole.
 * Called after spot refreshes and whenever the collection changes, so each
 * day keeps the latest value seen that day.
 */
export function snapshot(db, config, day = today()) {
  const { items, totals } = valueCollection(db, config);
  const upsertItem = db.prepare(
    `INSERT INTO item_value_history (item_id, day, value, cost) VALUES (?, ?, ?, ?)
     ON CONFLICT(item_id, day) DO UPDATE SET value = excluded.value, cost = excluded.cost`,
  );
  for (const it of items) {
    if (it.valuation.value != null) upsertItem.run(it.id, day, it.valuation.value, it.valuation.cost);
  }
  db.prepare(
    `INSERT INTO portfolio_history (day, total_value, total_cost) VALUES (?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET total_value = excluded.total_value, total_cost = excluded.total_cost`,
  ).run(day, totals.value, totals.cost);
  return totals;
}
