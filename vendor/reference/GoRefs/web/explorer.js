import * as duckdb from 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.28.0/+esm';

let db = null;
let conn = null;

let allData = { 
  species: [], 
  forms: [], 
  moves: [], 
  progression: [], 
  type_effectiveness: [], 
  weather_boosts: [], 
  community_days: [] 
};
let discrepanciesData = [];

async function initDuckDB() {
  try {
    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
    const worker = await duckdb.createWorker(bundle.mainWorker);
    const logger = new duckdb.ConsoleLogger();
    db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

    // Fetch output/GoRefs_Master.duckdb binary dataset
    const candidateUrls = [
      'output/GoRefs_Master.duckdb',
      '../output/GoRefs_Master.duckdb',
      '/output/GoRefs_Master.duckdb'
    ];

    let buffer = null;
    for (const url of candidateUrls) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          buffer = await res.arrayBuffer();
          break;
        }
      } catch (e) {}
    }

    if (!buffer) {
      throw new Error("Could not fetch output/GoRefs_Master.duckdb from web server.");
    }

    await db.registerFileBuffer('GoRefs_Master.duckdb', new Uint8Array(buffer));
    conn = await db.connect();
    await conn.query("ATTACH 'GoRefs_Master.duckdb' AS master; USE master;");
    return true;
  } catch (err) {
    console.error("Error initializing DuckDB WASM:", err);
    return false;
  }
}

async function queryTable(tableName) {
  if (!conn) return [];
  try {
    const result = await conn.query(`SELECT * FROM ${tableName}`);
    return result.toArray().map(row => row.toJSON());
  } catch (e) {
    console.warn(`Query failed for table '${tableName}':`, e);
    return [];
  }
}

async function initExplorer() {
  setupTabs();
  setupSearch();

  const resultsContainer = document.getElementById('sql-results');
  if (resultsContainer) {
    resultsContainer.innerHTML = '<p style="color: var(--accent-gold);">Initializing DuckDB WASM engine & loading master database (output/GoRefs_Master.duckdb)...</p>';
  }

  const success = await initDuckDB();

  if (success) {
    if (resultsContainer) {
      resultsContainer.innerHTML = '<p style="color: var(--text-muted);">DuckDB WASM initialized successfully! Execute live SQL queries above against <code>output/GoRefs_Master.duckdb</code>.</p>';
    }

    const speciesRaw = await queryTable('species');
    allData.species = speciesRaw.map(s => {
      let typesParsed = s.types;
      if (typeof s.types === 'string') {
        try { typesParsed = JSON.parse(s.types); } catch (e) {}
      }
      return { ...s, types: Array.isArray(typesParsed) ? typesParsed : [] };
    });

    const movesRaw = await queryTable('moves');
    allData.moves = movesRaw;

    const progRaw = await queryTable('progression');
    allData.progression = progRaw;

    const typeRaw = await queryTable('type_effectiveness');
    allData.type_effectiveness = typeRaw;

    const cdRaw = await queryTable('community_days');
    allData.community_days = cdRaw;

    const discRaw = await queryTable('discrepancies');
    discrepanciesData = discRaw.map(d => {
      let claimsParsed = d.claims;
      if (typeof d.claims === 'string') {
        try { claimsParsed = JSON.parse(d.claims); } catch (e) {}
      }
      let resValParsed = d.resolved_value;
      if (typeof d.resolved_value === 'string') {
        try { resValParsed = JSON.parse(d.resolved_value); } catch (e) {}
      }
      return { ...d, claims: claimsParsed, resolved_value: resValParsed };
    });

    renderSpecies(allData.species);
    renderMoves(allData.moves);
    renderProgression(allData.progression);
    renderTypeEffectiveness(allData.type_effectiveness);
    renderCommunityDays(allData.community_days);
    renderDiscrepancies(discrepanciesData);
  } else {
    if (resultsContainer) {
      resultsContainer.innerHTML = '<p style="color: #f87171;">Failed to initialize DuckDB WASM engine. Please ensure output/GoRefs_Master.duckdb exists by running <code>uv run go_refs.py --build</code>.</p>';
    }
  }

  setupSQLConsole();
}

function renderSpecies(speciesList) {
  const container = document.getElementById('species-grid');
  if (!container) return;

  container.innerHTML = speciesList.map(s => `
    <div class="card">
      <div class="card-header">
        <h3>${s.name}</h3>
        <span class="dex-badge">#${String(s.dex_number).padStart(3, '0')}</span>
      </div>
      <div class="tag-list">
        ${(s.types || []).map(t => `<span class="tag tag-type">${t}</span>`).join('')}
        ${s.can_mega_evolve ? '<span class="tag tag-mega">Mega</span>' : ''}
        ${s.can_gigantamax ? '<span class="tag tag-gmax">G-Max</span>' : ''}
      </div>
      <p style="color: var(--text-muted); font-size: 0.9rem;">Gen ${s.gen} • ${s.slug} • Buddy: ${s.buddy_distance_km ? s.buddy_distance_km + 'km' : 'N/A'}</p>
    </div>
  `).join('');
}

function renderMoves(movesList) {
  const container = document.getElementById('moves-grid');
  if (!container) return;

  container.innerHTML = movesList.map(m => `
    <div class="card">
      <div class="card-header">
        <h3>${m.name}</h3>
        <span class="dex-badge">${m.is_fast ? 'FAST' : 'CHARGED'}</span>
      </div>
      <div class="tag-list">
        <span class="tag tag-type">${m.type}</span>
      </div>
      <p style="color: var(--text-muted); font-size: 0.9rem;">PvE Power: ${m.pve_power || 'N/A'} • PvP Power: ${m.pvp_power || 'N/A'}</p>
    </div>
  `).join('');
}

function renderProgression(progList) {
  const container = document.getElementById('progression-table-body');
  if (!container) return;

  container.innerHTML = progList.map(p => `
    <tr>
      <td style="padding: 0.5rem; border-bottom: 1px solid var(--border);">Level ${p.level}</td>
      <td style="padding: 0.5rem; border-bottom: 1px solid var(--border);">${p.cp_multiplier}</td>
    </tr>
  `).join('');
}

function renderTypeEffectiveness(typeList) {
  const container = document.getElementById('type-effectiveness-body');
  if (!container) return;

  container.innerHTML = typeList.slice(0, 50).map(t => `
    <tr>
      <td style="padding: 0.5rem; border-bottom: 1px solid var(--border);">${t.attacking_type}</td>
      <td style="padding: 0.5rem; border-bottom: 1px solid var(--border);">${t.defending_type}</td>
      <td style="padding: 0.5rem; border-bottom: 1px solid var(--border); font-weight: bold; color: ${t.multiplier > 1 ? '#4ade80' : t.multiplier < 1 ? '#f87171' : 'white'};">${t.multiplier}x</td>
    </tr>
  `).join('');
}

function renderCommunityDays(cdList) {
  const container = document.getElementById('community-days-grid');
  if (!container) return;

  container.innerHTML = cdList.map(c => `
    <div class="card">
      <h3>${c.name || 'Community Day'}</h3>
      <p style="color: var(--text-muted);">${c.date || 'Historical Event'}</p>
      <p><strong>Featured Pokémon:</strong> ${c.featured_pokemon || 'N/A'}</p>
    </div>
  `).join('');
}

function renderDiscrepancies(discList) {
  const container = document.getElementById('discrepancy-list');
  if (!container) return;

  if (!discList || discList.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted);">No cross-source discrepancies currently flagged.</p>';
    return;
  }

  container.innerHTML = discList.map(d => `
    <div class="card" style="border-left: 4px solid var(--accent-gold);">
      <h4>Entity: ${d.entity_id} — Attribute: ${d.attribute}</h4>
      <p><strong>Resolved Canonical Value:</strong> ${JSON.stringify(d.resolved_value)} (Winner: ${d.winning_source})</p>
      <div style="font-size: 0.85rem; color: var(--text-muted);">
        <strong>Raw Claims:</strong>
        <pre style="background: #0f172a; padding: 0.5rem; border-radius: 0.4rem; overflow-x: auto;">${JSON.stringify(d.claims, null, 2)}</pre>
      </div>
    </div>
  `).join('');
}

function setupSQLConsole() {
  const runBtn = document.getElementById('run-sql-btn');
  if (runBtn) {
    runBtn.addEventListener('click', executeUserSQL);
  }
}

async function executeUserSQL() {
  const sqlInput = document.getElementById('sql-input');
  const resultsContainer = document.getElementById('sql-results');
  if (!sqlInput || !resultsContainer) return;

  if (!conn) {
    resultsContainer.innerHTML = '<p style="color: #f87171;">DuckDB connection is not active. Please wait or reload the page.</p>';
    return;
  }

  const sql = sqlInput.value.trim();
  if (!sql) return;

  resultsContainer.innerHTML = '<p style="color: var(--accent-gold);">Executing SQL query...</p>';

  try {
    const startTime = performance.now();
    const result = await conn.query(sql);
    const endTime = performance.now();
    const duration = (endTime - startTime).toFixed(2);

    const rows = result.toArray().map(r => r.toJSON());
    if (rows.length === 0) {
      resultsContainer.innerHTML = `<p style="color: var(--text-muted);">Query executed successfully in ${duration}ms. 0 rows returned.</p>`;
      return;
    }

    const columns = Object.keys(rows[0]);
    let tableHtml = `
      <div style="margin-bottom: 0.5rem; color: var(--accent-gold); font-size: 0.85rem;">
        Query returned ${rows.length} row(s) in ${duration}ms
      </div>
      <table style="width: 100%; border-collapse: collapse; font-family: monospace; font-size: 0.85rem;">
        <thead>
          <tr style="background: var(--bg-hover); text-align: left;">
            ${columns.map(col => `<th style="padding: 0.5rem; border-bottom: 2px solid var(--border);">${col}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => `
            <tr>
              ${columns.map(col => {
                let val = row[col];
                if (typeof val === 'object' && val !== null) val = JSON.stringify(val);
                return `<td style="padding: 0.5rem; border-bottom: 1px solid var(--border);">${val !== undefined ? val : ''}</td>`;
              }).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    resultsContainer.innerHTML = tableHtml;
  } catch (err) {
    resultsContainer.innerHTML = `
      <div style="color: #f87171; padding: 0.5rem; background: #2d1215; border-radius: 0.5rem;">
        <strong>SQL Error:</strong> ${err.message || err}
      </div>
    `;
  }
}

function setupTabs() {
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      tab.classList.add('active');
      const targetId = tab.getAttribute('data-target');
      document.getElementById(targetId).classList.add('active');
    });
  });
}

function setupSearch() {
  const searchInput = document.getElementById('search-input');
  if (!searchInput) return;

  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    const filtered = (allData.species || []).filter(s => 
      (s.name && s.name.toLowerCase().includes(query)) || 
      String(s.dex_number).includes(query) ||
      (s.slug && s.slug.toLowerCase().includes(query))
    );
    renderSpecies(filtered);
  });
}

document.addEventListener('DOMContentLoaded', initExplorer);

