const state = { view: 'overview', overview: null, rows: [] };
const app = document.querySelector('#app');
const health = document.querySelector('#health');

document.querySelectorAll('button[data-view]').forEach((button) => {
  button.addEventListener('click', () => {
    state.view = button.dataset.view;
    load();
  });
});

async function api(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) }
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function load() {
  try {
    const healthPayload = await api('/api/v1/health');
    health.textContent = `${healthPayload.tenantId} online`;
    if (state.view === 'overview') {
      state.overview = await api('/api/v1/stats/overview');
      renderOverview();
    }
    if (state.view === 'sniper1') {
      state.rows = await api('/api/v1/sniper1/items');
      renderRows('Sniper1 Auctions', ['itemId', 'siteId', 'state', 'budgetCents']);
    }
    if (state.view === 'sniper2') {
      state.rows = await api('/api/v1/sniper2/tasks');
      renderRows('Sniper2 Orders', ['taskId', 'state']);
    }
    if (state.view === 'sniper3') {
      state.rows = await api('/api/v1/sniper3/watches');
      renderRows('Sniper3 Restocks', ['watchId', 'state', 'totalChecks']);
    }
  } catch (error) {
    health.textContent = error.message;
    app.innerHTML = `<div class="card"><strong>Unable to load data</strong><p class="muted">${error.message}</p></div>`;
  }
}

function renderOverview() {
  const overview = state.overview;
  app.innerHTML = `
    <div class="toolbar">
      <button class="primary" id="seedAuction">Add Fixture Auction</button>
      <button id="refresh">Refresh</button>
    </div>
    <div class="grid">
      ${metric('Adapters', overview.adapters.length)}
      ${metric('Sniper1 Items', overview.sniper1Items)}
      ${metric('Sniper2 Tasks', overview.sniper2Tasks)}
      ${metric('Sniper3 Watches', overview.sniper3Watches)}
    </div>
    <table>
      <thead><tr><th>Adapter</th><th>Kind</th><th>Strategies</th></tr></thead>
      <tbody>
        ${overview.adapters.map((row) => `<tr><td>${row.siteId}</td><td>${row.kind}</td><td>${strategies(row.capabilities)}</td></tr>`).join('')}
      </tbody>
    </table>
  `;
  document.querySelector('#refresh').addEventListener('click', load);
  document.querySelector('#seedAuction').addEventListener('click', async () => {
    await api('/api/v1/sniper1/items', {
      method: 'POST',
      body: JSON.stringify({ siteId: 'ebay', urlOrId: 'https://www.ebay.test/item/1', options: { budget: 2500 } })
    });
    load();
  });
}

function renderRows(title, columns) {
  app.innerHTML = `
    <div class="toolbar">
      <h2 style="font-size:18px;margin:0">${title}</h2>
      <button id="refresh">Refresh</button>
    </div>
    <table>
      <thead><tr>${columns.map((column) => `<th>${column}</th>`).join('')}</tr></thead>
      <tbody>
        ${state.rows.map((row) => `<tr>${columns.map((column) => `<td>${format(row[column])}</td>`).join('')}</tr>`).join('')}
      </tbody>
    </table>
  `;
  document.querySelector('#refresh').addEventListener('click', load);
}

function metric(label, value) {
  return `<div class="card"><div class="metric">${value}</div><div class="muted">${label}</div></div>`;
}

function strategies(capabilities) {
  return [
    capabilities.supportsHttpStrategy ? 'HTTP' : null,
    capabilities.supportsBrowserStrategy ? 'Browser' : null,
    capabilities.supportsMobileStrategy ? 'Android' : null
  ].filter(Boolean).join(', ');
}

function format(value) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

load();
