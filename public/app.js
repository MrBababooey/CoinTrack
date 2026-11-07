// CoinTrack front end: a small hash-routed single-page app (no build step).

const GRAMS_PER_OZT = 31.1034768;
const METALS = ['gold', 'silver', 'platinum', 'palladium'];
const view = document.getElementById('view');
let charts = [];
let currency = 'USD';

// Common coins and bars. Weight is gross weight in grams; purity is fineness.
const PRESETS = [
  { group: 'Gold bullion', name: 'American Gold Eagle (1 oz)', metal: 'gold', g: 33.931, purity: 0.9167 },
  { group: 'Gold bullion', name: 'American Gold Buffalo (1 oz)', metal: 'gold', g: 31.108, purity: 0.9999 },
  { group: 'Gold bullion', name: 'Canadian Gold Maple Leaf (1 oz)', metal: 'gold', g: 31.11, purity: 0.9999 },
  { group: 'Gold bullion', name: 'South African Krugerrand (1 oz)', metal: 'gold', g: 33.93, purity: 0.9167 },
  { group: 'Gold bullion', name: 'Gold bar (1 oz)', metal: 'gold', g: GRAMS_PER_OZT, purity: 0.9999 },
  { group: 'Silver bullion', name: 'American Silver Eagle (1 oz)', metal: 'silver', g: 31.103, purity: 0.999 },
  { group: 'Silver bullion', name: 'Canadian Silver Maple Leaf (1 oz)', metal: 'silver', g: 31.11, purity: 0.9999 },
  { group: 'Silver bullion', name: 'Silver round (1 oz)', metal: 'silver', g: GRAMS_PER_OZT, purity: 0.999 },
  { group: 'Silver bullion', name: 'Silver bar (10 oz)', metal: 'silver', g: GRAMS_PER_OZT * 10, purity: 0.999 },
  { group: 'Silver bullion', name: 'Silver bar (1 kg)', metal: 'silver', g: 1000, purity: 0.999 },
  { group: 'Platinum / palladium', name: 'American Platinum Eagle (1 oz)', metal: 'platinum', g: 31.12, purity: 0.9995 },
  { group: 'Platinum / palladium', name: 'Canadian Palladium Maple Leaf (1 oz)', metal: 'palladium', g: 31.12, purity: 0.9995 },
  { group: 'US silver coins', name: 'Morgan Dollar', metal: 'silver', g: 26.73, purity: 0.9 },
  { group: 'US silver coins', name: 'Peace Dollar', metal: 'silver', g: 26.73, purity: 0.9 },
  { group: 'US silver coins', name: 'Walking Liberty / Franklin / 1964 Kennedy Half', metal: 'silver', g: 12.5, purity: 0.9 },
  { group: 'US silver coins', name: 'Washington Quarter (pre-1965)', metal: 'silver', g: 6.25, purity: 0.9 },
  { group: 'US silver coins', name: 'Mercury / Roosevelt Dime (pre-1965)', metal: 'silver', g: 2.5, purity: 0.9 },
  { group: 'US silver coins', name: 'Kennedy Half (1965–1970, 40%)', metal: 'silver', g: 11.5, purity: 0.4 },
  { group: 'US silver coins', name: 'Jefferson War Nickel (1942–1945)', metal: 'silver', g: 5.0, purity: 0.35 },
  { group: 'US gold coins', name: '$20 Saint-Gaudens / Liberty Double Eagle', metal: 'gold', g: 33.436, purity: 0.9 },
  { group: 'US gold coins', name: '$10 Indian / Liberty Eagle', metal: 'gold', g: 16.718, purity: 0.9 },
  { group: 'US gold coins', name: '$5 Indian / Liberty Half Eagle', metal: 'gold', g: 8.359, purity: 0.9 },
];

// ---------------------------------------------------------------- helpers
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function money(n, { sign = false, cents = true } = {}) {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  }).format(n);
  return sign && n > 0 ? `+${s}` : s;
}
const pct = (n) => (n == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`);
const tone = (n) => (n > 0 ? 'gain' : n < 0 ? 'loss' : '');
const ozt = (n) => (n ? `${Number(n.toFixed(4))} ozt` : '—');
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const metalColor = (m) => cssVar(`--${m}`) || cssVar('--muted');
const todayStr = () => new Date().toLocaleDateString('en-CA');
const fmtDate = (d) => (d ? new Date(d.length === 10 ? `${d}T00:00:00` : d).toLocaleDateString() : '—');
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString() : '—');

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !(data && 'skipped' in data)) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 3000);
}

function destroyCharts() {
  charts.forEach((c) => c.destroy());
  charts = [];
}

function lineChart(canvas, datasets, { money: isMoney = true } = {}) {
  const grid = cssVar('--border');
  const text = cssVar('--muted');
  const chart = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      parsing: { xAxisKey: 'x', yAxisKey: 'y' },
      scales: {
        x: {
          type: 'linear',
          grid: { color: grid },
          ticks: { color: text, maxTicksLimit: 7, callback: (v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' }) },
        },
        y: { grid: { color: grid }, ticks: { color: text, callback: (v) => (isMoney ? money(v, { cents: false }) : v) } },
      },
      plugins: {
        legend: { labels: { color: text, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            title: (items) => (items[0] ? new Date(items[0].parsed.x).toLocaleDateString() : ''),
            label: (ctx) => `${ctx.dataset.label}: ${isMoney ? money(ctx.parsed.y) : ctx.parsed.y}`,
          },
        },
      },
      elements: { point: { radius: (ctx) => (ctx.dataset.data.length < 15 ? 3 : 0), hoverRadius: 4 }, line: { tension: 0.2, borderWidth: 2 } },
    },
  });
  charts.push(chart);
  return chart;
}
const dayToX = (d) => new Date(`${d}T12:00:00`).getTime();

function rangeButtons(active, values = [[30, '1M'], [90, '3M'], [365, '1Y'], [3650, 'All']]) {
  return `<div class="range" role="group" aria-label="Date range">${values
    .map(([d, l]) => `<button type="button" data-days="${d}" class="${d === active ? 'active' : ''}">${l}</button>`)
    .join('')}</div>`;
}

function basisBadge(v) {
  const labels = {
    spot: 'Spot',
    market: 'Market',
    'melt-fallback': 'Melt only',
    'no-spot': 'No spot price',
    none: 'Unvalued',
  };
  return `<span class="badge ${v.stale ? 'warn' : ''}" title="${esc(v.stale_reason || '')}">${labels[v.basis] || v.basis}${v.stale ? ' · update' : ''}</span>`;
}

// ---------------------------------------------------------------- views
async function dashboard() {
  const [summary, history] = await Promise.all([api('/summary'), api('/history?days=3650')]);
  currency = summary.status.currency;
  const t = summary.totals;
  const st = summary.status;
  const hasItems = t.cost > 0 || Object.keys(t.by_category).length > 0;

  const spotTiles = METALS.map((m) => {
    const cur = summary.spot[m];
    const prev = summary.previous_spot[m];
    const change = cur && prev ? ((cur.price - prev.price) / prev.price) * 100 : null;
    return `<div class="spot" style="--c:${metalColor(m)}">
      <div class="metal">${m}</div>
      <div class="price">${cur ? money(cur.price) : '—'}</div>
      <div class="small ${tone(change)}">${change != null ? `${pct(change)} 24h` : '<span class="muted">per troy oz</span>'}</div>
    </div>`;
  }).join('');

  const lastPull = Object.values(summary.spot).map((s) => s.fetched_at).sort().pop();
  const needsSetup = st.provider === 'manual' || !st.has_api_key;

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><div class="muted small">Values in ${esc(currency)} · spot updated ${fmtDateTime(lastPull)}</div></div>
      <div class="actions">
        <button class="btn" id="refresh" ${st.provider === 'manual' ? 'disabled title="No price API configured"' : ''}>↻ Refresh prices</button>
      </div>
    </div>
    ${needsSetup ? `<div class="alert" style="margin-bottom:16px">No price API configured, so spot prices must be <a href="#/spot">entered by hand</a>. Set <code>PRICE_PROVIDER</code> and <code>PRICE_API_KEY</code> in <code>.env</code> for automatic updates.</div>` : ''}
    ${st.last_refresh_error ? `<div class="alert" style="margin-bottom:16px">Last price refresh failed: ${esc(st.last_refresh_error)}</div>` : ''}
    <div class="grid grid-kpi">
      <div class="card kpi"><div class="label">Current value</div><div class="value">${money(t.value)}</div>
        <div class="sub muted">${t.unvalued ? `${t.unvalued} item(s) unvalued` : 'All items valued'}</div></div>
      <div class="card kpi"><div class="label">Total paid</div><div class="value">${money(t.cost)}</div>
        <div class="sub muted">cost basis</div></div>
      <div class="card kpi"><div class="label">Gain / loss</div><div class="value ${tone(t.gain)}">${money(t.gain, { sign: true })}</div>
        <div class="sub ${tone(t.gain)}">${pct(t.gain_pct)}${t.unvalued ? ' <span class="muted">· valued items only</span>' : ''}</div></div>
      <div class="card kpi"><div class="label">Metal content</div><div class="value">${
        METALS.filter((m) => t.by_metal[m]?.fine_ozt).map((m) => `<span class="small" style="display:block;font-size:.95rem"><span class="dot" style="--c:${metalColor(m)}"></span>${ozt(t.by_metal[m].fine_ozt)} ${m}</span>`).join('') || '—'
      }</div></div>
    </div>
    <div class="card" style="margin-bottom:16px"><h2>Spot prices</h2><div class="spot-row">${spotTiles}</div></div>
    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><h2>Collection value over time</h2>${rangeButtons(365)}</div>
        ${history.length ? '<div class="chart-box"><canvas id="pf-chart"></canvas></div>' : '<p class="muted">History builds up as prices update — one point per day.</p>'}
      </div>
      <div class="card">
        <h2>Needs a value update</h2>
        ${summary.stale.length
          ? `<p class="small muted" style="margin-top:-6px">Collectibles with no market value, or one older than ${st.stale_days} days.</p>
             <ul class="list">${summary.stale.map((s) => `<li><a href="#/item/${s.id}">${esc(s.name)}</a><span class="small muted">${esc(s.reason)}</span></li>`).join('')}</ul>`
          : '<p class="muted">All collectible values are up to date.</p>'}
      </div>
    </div>
    ${!hasItems ? `<div class="card empty" style="margin-top:16px"><h2>Your collection is empty</h2><p>Add your first coin or bar to start tracking.</p><a class="btn btn-primary" href="#/add">+ Add item</a></div>` : ''}
  `;

  document.getElementById('refresh')?.addEventListener('click', refreshPrices);

  if (history.length) {
    const draw = (days) => {
      destroyCharts();
      const cutoff = Date.now() - days * 86400000;
      const rows = history.filter((r) => dayToX(r.day) >= cutoff);
      lineChart(document.getElementById('pf-chart'), [
        { label: 'Value', data: rows.map((r) => ({ x: dayToX(r.day), y: r.total_value })), borderColor: cssVar('--accent'), backgroundColor: cssVar('--accent') },
        { label: 'Cost', data: rows.map((r) => ({ x: dayToX(r.day), y: r.total_cost })), borderColor: cssVar('--muted'), backgroundColor: cssVar('--muted'), borderDash: [5, 4] },
      ]);
    };
    wireRange(draw);
    draw(365);
  }
}

function wireRange(draw) {
  view.querySelectorAll('.range button').forEach((b) =>
    b.addEventListener('click', () => {
      b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      draw(Number(b.dataset.days));
    }),
  );
}

async function refreshPrices(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const r = await api('/spot/refresh', { method: 'POST' });
    if (r.ok) toast('Spot prices updated');
    else toast(r.error, true);
    route();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

const collectionState = { sort: 'name', dir: 1, filter: 'all', q: '' };

async function collection() {
  const [items, summary] = await Promise.all([api('/items'), api('/summary')]);
  currency = summary.status.currency;

  if (!items.length) {
    view.innerHTML = `<div class="page-head"><h1>Collection</h1></div>
      <div class="card empty"><h2>No items yet</h2><p>Add coins and bullion with what you paid, and CoinTrack tracks their value.</p><a class="btn btn-primary" href="#/add">+ Add item</a></div>`;
    return;
  }

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Collection</h1><div class="muted small">${items.length} entries · ${items.reduce((a, i) => a + i.quantity, 0)} pieces</div></div>
      <div class="actions">
        <input type="search" id="q" placeholder="Search…" value="${esc(collectionState.q)}" style="width:180px">
        <select id="filter" style="width:auto">
          ${[['all', 'All items'], ['bullion', 'Bullion'], ['collectible', 'Collectibles'], ['stale', 'Needs update'], ...METALS.map((m) => [m, m[0].toUpperCase() + m.slice(1)])]
            .map(([v, l]) => `<option value="${v}" ${collectionState.filter === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <a class="btn" href="/api/export.csv">Export CSV</a>
      </div>
    </div>
    <div class="card table-wrap" style="padding:6px 8px"><table>
      <thead><tr>
        <th class="sortable" data-sort="name">Item</th>
        <th class="hide-sm">Type</th>
        <th class="sortable num hide-sm" data-sort="quantity">Qty</th>
        <th class="sortable num hide-sm" data-sort="fine">Metal</th>
        <th class="sortable num hide-sm" data-sort="cost">Paid</th>
        <th class="sortable num" data-sort="value">Value</th>
        <th class="sortable num" data-sort="gain">Gain</th>
        <th class="hide-sm">Basis</th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table></div>`;

  const key = {
    name: (i) => i.name.toLowerCase(),
    quantity: (i) => i.quantity,
    fine: (i) => i.valuation.fine_ozt,
    cost: (i) => i.valuation.cost,
    value: (i) => i.valuation.value ?? -Infinity,
    gain: (i) => i.valuation.gain_pct ?? -Infinity,
  };

  const render = () => {
    const s = collectionState;
    const q = s.q.toLowerCase();
    const rows = items
      .filter((i) => {
        if (s.filter === 'stale') return i.valuation.stale;
        if (['bullion', 'collectible'].includes(s.filter)) return i.category === s.filter;
        if (METALS.includes(s.filter)) return i.metal === s.filter;
        return true;
      })
      .filter((i) => !q || [i.name, i.year, i.mint_mark, i.grade, i.grading_service, i.cert_number, i.notes].some((f) => f && String(f).toLowerCase().includes(q)))
      .sort((a, b) => (key[s.sort](a) > key[s.sort](b) ? 1 : key[s.sort](a) < key[s.sort](b) ? -1 : 0) * s.dir);

    document.getElementById('rows').innerHTML = rows.map((i) => {
      const v = i.valuation;
      const sub = [i.year, i.mint_mark, i.grading_service && i.grade ? `${i.grading_service} ${i.grade}` : i.grade].filter(Boolean).join(' · ');
      return `<tr class="clickable" data-id="${i.id}">
        <td><span class="dot" style="--c:${metalColor(i.metal)}"></span><strong>${esc(i.name)}</strong>${sub ? `<div class="small muted">${esc(sub)}</div>` : ''}</td>
        <td class="hide-sm small">${i.category === 'bullion' ? 'Bullion' : 'Collectible'}</td>
        <td class="num hide-sm">${i.quantity}</td>
        <td class="num hide-sm small">${ozt(v.fine_ozt)}</td>
        <td class="num hide-sm">${money(v.cost)}</td>
        <td class="num">${money(v.value)}</td>
        <td class="num ${tone(v.gain)}">${money(v.gain, { sign: true })}<div class="small">${pct(v.gain_pct)}</div></td>
        <td class="hide-sm">${basisBadge(v)}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">No matching items</td></tr>';

    view.querySelectorAll('th.sortable').forEach((th) => {
      th.textContent = th.textContent.replace(/ [▲▼]$/, '') + (th.dataset.sort === s.sort ? (s.dir > 0 ? ' ▲' : ' ▼') : '');
    });
  };

  view.querySelectorAll('th.sortable').forEach((th) =>
    th.addEventListener('click', () => {
      const s = collectionState;
      s.dir = s.sort === th.dataset.sort ? -s.dir : th.dataset.sort === 'name' ? 1 : -1;
      s.sort = th.dataset.sort;
      render();
    }),
  );
  document.getElementById('filter').addEventListener('change', (e) => { collectionState.filter = e.target.value; render(); });
  document.getElementById('q').addEventListener('input', (e) => { collectionState.q = e.target.value; render(); });
  document.getElementById('rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) location.hash = `#/item/${tr.dataset.id}`;
  });
  render();
}

async function itemDetail(id) {
  const [item, summary] = await Promise.all([api(`/items/${id}`), api('/summary')]);
  currency = summary.status.currency;
  const v = item.valuation;
  const isCollectible = item.category === 'collectible';
  const facts = [
    ['Type', isCollectible ? 'Collectible' : 'Bullion'],
    ['Metal', item.metal === 'none' ? 'None / base metal' : item.metal[0].toUpperCase() + item.metal.slice(1)],
    ['Year / mint', [item.year, item.mint_mark].filter(Boolean).join(' ') || null],
    ['Grade', [item.grading_service, item.grade].filter(Boolean).join(' ') || null],
    ['Cert #', item.cert_number],
    ['Quantity', item.quantity],
    ['Weight (each)', item.weight_ozt ? `${Number(item.weight_ozt.toFixed(4))} ozt (${(item.weight_ozt * GRAMS_PER_OZT).toFixed(2)} g)` : null],
    ['Purity', item.purity ? item.purity : null],
    ['Fine metal (total)', v.fine_ozt ? ozt(v.fine_ozt) : null],
    ['Purchased', `${fmtDate(item.purchase_date)} for ${money(item.purchase_price)}${item.quantity > 1 ? ` (${money(item.purchase_price / item.quantity)} each)` : ''}`],
    !isCollectible && item.premium_pct ? ['Valuation premium', `${item.premium_pct}% over melt`] : null,
    ['Notes', item.notes],
  ].filter((f) => f && f[1] != null && f[1] !== '');

  view.innerHTML = `
    <div class="page-head">
      <div><a href="#/collection" class="small">← Collection</a><h1>${esc(item.name)}</h1>
        <div>${basisBadge(v)} ${v.stale_reason ? `<span class="small muted">${esc(v.stale_reason)}</span>` : ''}</div></div>
      <div class="actions">
        <a class="btn" href="#/item/${item.id}/edit">Edit</a>
        <button class="btn btn-danger" id="delete">Delete</button>
      </div>
    </div>
    <div class="grid grid-kpi">
      <div class="card kpi"><div class="label">Current value</div><div class="value">${money(v.value)}</div>
        <div class="sub muted">${v.basis === 'market' ? `market value from ${fmtDate(v.last_market_value.recorded_on)}` : v.basis === 'spot' ? 'from live spot' : v.basis === 'melt-fallback' ? 'melt value (no market value yet)' : 'not enough data'}</div></div>
      <div class="card kpi"><div class="label">Paid</div><div class="value">${money(v.cost)}</div></div>
      <div class="card kpi"><div class="label">Gain / loss</div><div class="value ${tone(v.gain)}">${money(v.gain, { sign: true })}</div><div class="sub ${tone(v.gain)}">${pct(v.gain_pct)}</div></div>
      <div class="card kpi"><div class="label">Melt value</div><div class="value">${money(v.melt_value)}</div>
        <div class="sub muted">${v.spot_price ? `${money(v.spot_price)}/ozt spot` : '—'}</div></div>
    </div>
    <div class="grid grid-2">
      <div class="stack">
        <div class="card">
          <div class="card-head"><h2>Value over time</h2>${item.history.length ? rangeButtons(3650) : ''}</div>
          ${item.history.length ? '<div class="chart-box"><canvas id="item-chart"></canvas></div>' : '<p class="muted">No history yet.</p>'}
        </div>
        ${isCollectible ? marketValuesCard(item) : ''}
      </div>
      <div class="card"><h2>Details</h2><dl class="facts">${facts.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('')}</dl></div>
    </div>`;

  document.getElementById('delete').addEventListener('click', async () => {
    if (!confirm(`Delete "${item.name}"? This removes its value history too.`)) return;
    await api(`/items/${item.id}`, { method: 'DELETE' });
    toast('Item deleted');
    location.hash = '#/collection';
  });

  if (isCollectible) wireMarketValues(item);

  if (item.history.length) {
    const draw = (days) => {
      destroyCharts();
      const cutoff = Date.now() - days * 86400000;
      const rows = [{ day: item.purchase_date, value: item.purchase_price, cost: item.purchase_price }, ...item.history]
        .filter((r) => dayToX(r.day) >= cutoff);
      const sets = [
        { label: 'Value', data: rows.map((r) => ({ x: dayToX(r.day), y: r.value })), borderColor: cssVar('--accent'), backgroundColor: cssVar('--accent') },
        { label: 'Paid', data: rows.map((r) => ({ x: dayToX(r.day), y: r.cost })), borderColor: cssVar('--muted'), backgroundColor: cssVar('--muted'), borderDash: [5, 4] },
      ];
      if (isCollectible && item.market_values.length) {
        sets.push({
          label: 'Recorded sales',
          data: item.market_values.filter((m) => dayToX(m.recorded_on) >= cutoff).map((m) => ({ x: dayToX(m.recorded_on), y: m.value_per_unit * item.quantity })),
          showLine: false, pointRadius: 4, borderColor: metalColor(item.metal), backgroundColor: metalColor(item.metal),
        });
      }
      lineChart(document.getElementById('item-chart'), sets);
    };
    wireRange(draw);
    draw(3650);
  }
}

function marketValuesCard(item) {
  return `<div class="card">
    <h2>Market values</h2>
    <p class="small muted" style="margin-top:-6px">Record recent sold prices for <strong>one</strong> coin, e.g. from eBay sold listings, Heritage or PCGS/NGC price guides. The latest one sets the value.</p>
    <form id="mv-form"><div class="row" style="align-items:end">
      <label><span>Sold / value per coin</span><input name="value_per_unit" type="number" step="0.01" min="0" required></label>
      <label><span>Date</span><input name="recorded_on" type="date" value="${todayStr()}" max="${todayStr()}"></label>
      <label><span>Source</span><input name="source" placeholder="eBay sold, Heritage, PCGS…" list="sources"></label>
      <div><button class="btn btn-primary" type="submit">Add value</button></div>
    </div></form>
    <datalist id="sources"><option>eBay sold listing</option><option>Heritage Auctions</option><option>PCGS Price Guide</option><option>NGC Price Guide</option><option>Greysheet</option><option>Dealer quote</option></datalist>
    ${item.market_values.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th class="num">Per coin</th><th class="num">Total</th><th>Source</th><th></th></tr></thead>
      <tbody>${item.market_values.map((m) => `<tr>
        <td>${fmtDate(m.recorded_on)}</td><td class="num">${money(m.value_per_unit)}</td><td class="num">${money(m.value_per_unit * item.quantity)}</td>
        <td class="small">${esc(m.source || '')}${m.note ? `<div class="muted">${esc(m.note)}</div>` : ''}</td>
        <td class="num"><button class="btn btn-sm btn-danger" data-del="${m.id}" aria-label="Delete value">✕</button></td></tr>`).join('')}</tbody>
    </table></div>` : ''}
  </div>`;
}

function wireMarketValues(item) {
  document.getElementById('mv-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/items/${item.id}/values`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast('Market value recorded');
      route();
    } catch (err) {
      toast(err.message, true);
    }
  });
  view.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Delete this market value?')) return;
      await api(`/items/${item.id}/values/${b.dataset.del}`, { method: 'DELETE' });
      route();
    }),
  );
}

async function itemForm(id) {
  const [item, summary] = await Promise.all([id ? api(`/items/${id}`) : null, api('/summary')]);
  currency = summary.status.currency;
  const it = item || { category: 'bullion', metal: 'silver', quantity: 1, purchase_date: todayStr(), premium_pct: 0 };
  const groups = [...new Set(PRESETS.map((p) => p.group))];

  view.innerHTML = `
    <div class="page-head"><div>
      <a href="${id ? `#/item/${id}` : '#/collection'}" class="small">← Back</a>
      <h1>${id ? 'Edit item' : 'Add item'}</h1>
    </div></div>
    <form id="item-form" class="card" novalidate>
      <div class="segmented" role="radiogroup" aria-label="Type">
        <label><input type="radio" name="category" value="bullion" ${it.category === 'bullion' ? 'checked' : ''}><span>Bullion</span></label>
        <label><input type="radio" name="category" value="collectible" ${it.category === 'collectible' ? 'checked' : ''}><span>Collectible</span></label>
      </div>
      <p class="hint" id="cat-hint" style="margin:-8px 0 16px"></p>

      <fieldset><legend>What is it?</legend>
        <div class="row">
          <label><span>Start from a common coin (optional)</span>
            <select id="preset"><option value="">Choose…</option>${groups.map((g) => `<optgroup label="${esc(g)}">${PRESETS.map((p, i) => (p.group === g ? `<option value="${i}">${esc(p.name)}</option>` : '')).join('')}</optgroup>`).join('')}</select>
          </label>
        </div>
        <div class="row">
          <label style="grid-column:span 2"><span>Name *</span><input name="name" required value="${esc(it.name)}" placeholder="e.g. 1921 Morgan Dollar"></label>
          <label><span>Quantity *</span><input name="quantity" type="number" min="1" step="1" required value="${esc(it.quantity)}"></label>
        </div>
        <div class="row">
          <label><span>Year</span><input name="year" value="${esc(it.year)}"></label>
          <label><span>Mint mark</span><input name="mint_mark" value="${esc(it.mint_mark)}" placeholder="P, D, S, CC…"></label>
          <label class="coll-only"><span>Grading service</span><input name="grading_service" value="${esc(it.grading_service)}" list="graders" placeholder="PCGS, NGC, raw…"></label>
          <label class="coll-only"><span>Grade</span><input name="grade" value="${esc(it.grade)}" placeholder="MS-65, VF-30…"></label>
          <label class="coll-only"><span>Cert #</span><input name="cert_number" value="${esc(it.cert_number)}"></label>
        </div>
        <datalist id="graders"><option>PCGS</option><option>NGC</option><option>ANACS</option><option>ICG</option><option>CAC</option><option>Raw</option></datalist>
      </fieldset>

      <fieldset><legend>Metal content</legend>
        <div class="row">
          <label><span>Metal</span><select name="metal">
            ${[...METALS, 'none'].map((m) => `<option value="${m}" ${it.metal === m ? 'selected' : ''}>${m === 'none' ? 'None / base metal' : m[0].toUpperCase() + m.slice(1)}</option>`).join('')}
          </select></label>
          <label><span>Weight of one piece</span><div class="input-group">
            <input id="weight" type="number" min="0" step="any" value="${it.weight_ozt ? Number(it.weight_ozt.toFixed(6)) : ''}">
            <select id="weight-unit"><option value="ozt">ozt</option><option value="g">g</option><option value="kg">kg</option></select>
          </div></label>
          <label><span>Purity (fineness)</span><input name="purity" type="number" min="0" max="1" step="any" value="${esc(it.purity ?? '')}" placeholder="0.999" list="purities"></label>
          <datalist id="purities"><option value="0.9999"><option value="0.999"><option value="0.9167">22k</option><option value="0.9">90%</option><option value="0.4">40%</option><option value="0.35">35%</option></datalist>
        </div>
        <p class="hint" id="fine-preview"></p>
      </fieldset>

      <fieldset><legend>Purchase</legend>
        <div class="row">
          <label><span>Total price paid * <span class="muted">(all pieces)</span></span><input name="purchase_price" type="number" min="0" step="0.01" required value="${esc(it.purchase_price ?? '')}"></label>
          <label><span>Purchase date *</span><input name="purchase_date" type="date" required value="${esc(it.purchase_date)}" max="${todayStr()}"></label>
          <label class="bull-only"><span>Valuation premium over melt (%)</span><input name="premium_pct" type="number" step="0.1" value="${esc(it.premium_pct ?? 0)}"><div class="hint">0 = value at melt. Use e.g. 5 for coins that sell above spot.</div></label>
        </div>
        <p class="hint" id="cost-preview"></p>
      </fieldset>

      ${!id ? `<fieldset class="coll-only"><legend>Current market value</legend>
        <p class="hint" style="margin-top:0">The most recent sale price for one of these coins. You can add more later from the item page.</p>
        <div class="row">
          <label><span>Last sold / value per coin</span><input name="initial_market_value" type="number" min="0" step="0.01"></label>
          <label><span>Sale date</span><input name="initial_market_value_date" type="date" value="${todayStr()}" max="${todayStr()}"></label>
          <label><span>Source</span><input name="initial_market_value_source" list="sources2" placeholder="eBay sold, Heritage…"></label>
        </div>
        <datalist id="sources2"><option>eBay sold listing</option><option>Heritage Auctions</option><option>PCGS Price Guide</option><option>NGC Price Guide</option><option>Greysheet</option></datalist>
      </fieldset>` : ''}

      <fieldset><legend>Notes</legend>
        <label><span class="sr-only" hidden>Notes</span><textarea name="notes" rows="3" placeholder="Where you bought it, storage location, toning…">${esc(it.notes)}</textarea></label>
        <div style="height:14px"></div>
      </fieldset>

      <div class="actions"><button class="btn btn-primary" type="submit">${id ? 'Save changes' : 'Add to collection'}</button>
        <a class="btn" href="${id ? `#/item/${id}` : '#/collection'}">Cancel</a></div>
    </form>`;

  const form = document.getElementById('item-form');
  const weight = document.getElementById('weight');
  const unit = document.getElementById('weight-unit');
  let lastUnit = 'ozt';
  const toOzt = (val, u) => (u === 'g' ? val / GRAMS_PER_OZT : u === 'kg' ? (val * 1000) / GRAMS_PER_OZT : val);
  const fromOzt = (val, u) => (u === 'g' ? val * GRAMS_PER_OZT : u === 'kg' ? (val * GRAMS_PER_OZT) / 1000 : val);
  const weightOzt = () => toOzt(Number(weight.value) || 0, unit.value);

  unit.addEventListener('change', () => {
    if (weight.value) weight.value = Number(fromOzt(toOzt(Number(weight.value), lastUnit), unit.value).toFixed(6));
    lastUnit = unit.value;
  });

  const update = () => {
    const cat = form.category.value;
    form.querySelectorAll('.coll-only').forEach((el) => (el.style.display = cat === 'collectible' ? '' : 'none'));
    form.querySelectorAll('.bull-only').forEach((el) => (el.style.display = cat === 'bullion' ? '' : 'none'));
    document.getElementById('cat-hint').textContent = cat === 'bullion'
      ? 'Bullion is valued by its metal content at live spot price.'
      : 'Collectibles are valued at the latest sale price you record. Metal content gives a melt-value floor.';
    const qty = Math.max(1, Number(form.quantity.value) || 1);
    const fine = weightOzt() * (Number(form.purity.value) || 0) * qty;
    const metal = form.metal.value;
    const spot = summary.spot[metal]?.price;
    document.getElementById('fine-preview').textContent = fine > 0 && metal !== 'none'
      ? `${Number(fine.toFixed(4))} ozt fine ${metal} total${spot ? ` · melt value ≈ ${money(fine * spot)} at ${money(spot)}/ozt` : ''}`
      : '';
    const paid = Number(form.purchase_price.value);
    document.getElementById('cost-preview').textContent = paid > 0 && qty > 1 ? `${money(paid / qty)} per piece` : '';
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);

  document.getElementById('preset').addEventListener('change', (e) => {
    const p = PRESETS[e.target.value];
    if (!p) return;
    if (!form.name.value) form.name.value = p.name;
    form.metal.value = p.metal;
    unit.value = 'g';
    lastUnit = 'g';
    weight.value = Number(p.g.toFixed(3));
    form.purity.value = p.purity;
    if (p.group.startsWith('US ') && !id) form.category.value = 'collectible';
    update();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    body.weight_ozt = weightOzt();
    if (body.metal === 'none' && !body.purity) body.purity = 0;
    try {
      const saved = await api(id ? `/items/${id}` : '/items', { method: id ? 'PUT' : 'POST', body });
      toast(id ? 'Changes saved' : 'Added to collection');
      location.hash = `#/item/${saved.id}`;
    } catch (err) {
      toast(err.message, true);
    }
  });
  update();
}

async function spotPage() {
  const [spot, hist] = await Promise.all([api('/spot'), api('/spot/history?days=3650')]);
  currency = spot.status.currency;
  const st = spot.status;
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Spot prices</h1><div class="muted small">Per troy ounce in ${esc(currency)} · source: ${esc(st.provider)}${st.provider !== 'manual' ? ` · auto-refresh every ${st.refresh_hours}h` : ''}</div></div>
      <div class="actions"><button class="btn" id="refresh" ${st.provider === 'manual' ? 'disabled' : ''}>↻ Refresh now</button></div>
    </div>
    ${st.last_refresh_error ? `<div class="alert" style="margin-bottom:16px">Last refresh failed: ${esc(st.last_refresh_error)}</div>` : ''}
    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><h2>History</h2>${rangeButtons(365)}</div>
        <div class="row" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px" id="metal-pick">
          ${METALS.map((m) => `<button type="button" class="btn btn-sm" data-metal="${m}" aria-pressed="false"><span class="dot" style="--c:${metalColor(m)}"></span>${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}
        </div>
        ${hist.length ? '<div class="chart-box"><canvas id="spot-chart"></canvas></div>' : '<p class="muted">No spot prices recorded yet.</p>'}
      </div>
      <div class="card">
        <h2>Enter spot prices by hand</h2>
        <p class="small muted" style="margin-top:-6px">Useful without an API key, or to correct a bad reading. Leave a metal blank to skip it.</p>
        <form id="spot-form">
          ${METALS.map((m) => `<label style="margin-bottom:10px"><span>${m[0].toUpperCase() + m.slice(1)} ${spot.latest[m] ? `<span class="muted">(now ${money(spot.latest[m].price)})</span>` : ''}</span><input name="${m}" type="number" min="0" step="0.01"></label>`).join('')}
          <button class="btn btn-primary" type="submit">Save prices</button>
        </form>
      </div>
    </div>`;

  document.getElementById('refresh').addEventListener('click', refreshPrices);
  document.getElementById('spot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/spot', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      toast('Spot prices saved');
      route();
    } catch (err) {
      toast(err.message, true);
    }
  });

  if (!hist.length) return;
  let metal = METALS.find((m) => spot.latest[m]) || 'gold';
  let days = 365;
  const draw = () => {
    destroyCharts();
    view.querySelectorAll('#metal-pick button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.metal === metal));
      b.classList.toggle('btn-primary', b.dataset.metal === metal);
    });
    const cutoff = Date.now() - days * 86400000;
    const rows = hist.filter((r) => r.metal === metal && Date.parse(r.fetched_at) >= cutoff);
    lineChart(document.getElementById('spot-chart'), [
      { label: `${metal[0].toUpperCase() + metal.slice(1)} spot`, data: rows.map((r) => ({ x: Date.parse(r.fetched_at), y: r.price })), borderColor: metalColor(metal), backgroundColor: metalColor(metal) },
    ]);
  };
  view.querySelectorAll('#metal-pick button').forEach((b) => b.addEventListener('click', () => { metal = b.dataset.metal; draw(); }));
  wireRange((d) => { days = d; draw(); });
  draw();
}

// ---------------------------------------------------------------- router
async function route() {
  destroyCharts();
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean);
  const section = parts[0] || 'dashboard';
  document.querySelectorAll('[data-nav]').forEach((a) =>
    a.classList.toggle('active', a.dataset.nav === (section === 'item' ? 'collection' : section)),
  );
  try {
    if (section === 'dashboard') await dashboard();
    else if (section === 'collection') await collection();
    else if (section === 'spot') await spotPage();
    else if (section === 'add') await itemForm(null);
    else if (section === 'item' && parts[2] === 'edit') await itemForm(parts[1]);
    else if (section === 'item') await itemDetail(parts[1]);
    else view.innerHTML = '<div class="card empty"><h2>Page not found</h2><a href="#/">Go to dashboard</a></div>';
  } catch (err) {
    view.innerHTML = `<div class="card empty"><h2>Something went wrong</h2><p>${esc(err.message)}</p><a href="#/">Go to dashboard</a></div>`;
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();
