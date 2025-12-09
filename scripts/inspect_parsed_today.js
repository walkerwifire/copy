const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

function parseHtmlToData(html) {
  const $ = cheerio.load(html);
  const title = $('title').text() || $('h1').first().text() || 'Technet';
  const tables = [];
  $('table').each((i, table) => {
    const headers = [];
    const rows = [];
    const $table = $(table);
    $table.find('thead tr th, tr th').each((_, th) => {
      headers.push($(th).text().trim());
    });
    $table.find('tbody tr, tr').each((_, tr) => {
      const cells = [];
      $(tr).find('td').each((__, td) => {
        cells.push($(td).text().trim());
      });
      if (cells.length) rows.push(cells);
    });
    if (headers.length || rows.length) tables.push({ headers, rows });
  });
  return { title, tables };
}

function normalizeUsDateToIso(usDate) {
  if (!usDate || typeof usDate !== 'string') return '';
  const m = usDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return '';
  const [_, mm, dd, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

(async function main(){
  try {
    const respPath = path.join(__dirname, '..', '..', '_responses', 'dashboard.html');
    const snapPath = path.join(__dirname, '..', '..', 'page_snapshot.html');
    let html = '';
    if (fs.existsSync(respPath)) html = fs.readFileSync(respPath, 'utf8');
    else if (fs.existsSync(snapPath)) html = fs.readFileSync(snapPath, 'utf8');
    else {
      console.error('offline HTML not found at', respPath, 'or', snapPath);
      process.exit(2);
    }
    const data = parseHtmlToData(html);
    const routes = [];
    for (const t of data.tables) {
      const headers = (t.headers || []).map(h => String(h||'').trim());
      const headerLower = headers.map(h => h.toLowerCase());
      if (!(headerLower.some(h => h.includes('job')) || headerLower.some(h => h.includes('tech')) || headerLower.some(h => h.includes('schd')))) continue;
      const idx = {};
      headers.forEach((h,i)=>{
        const v = h.toLowerCase();
        if (v.includes('tech')) idx.tech = i;
        else if (v.includes('job')) idx.job = i;
        else if (v.includes('time')) idx.time = i;
        else if (v.includes('name')) idx.name = i;
        else if (v.includes('addr')) idx.addr = i;
        else if (v.includes('city')) idx.city = i;
        else if (v.includes('status')) idx.status = i;
        else if (v.includes('type')) idx.type = i;
        else if (v.includes('phone')) idx.phone = i;
        else if (v.includes('schd')) idx.schd = i;
      });
      const group = {};
      for (const row of (t.rows||[])) {
        const tech = String(row[idx.tech] || '').trim();
        const jobId = String(row[idx.job] || '').trim();
        const time = String(row[idx.time] || '').trim();
        const name = String(row[idx.name] || '').trim();
        const addr = String(row[idx.addr] || '').trim();
        const city = String(row[idx.city] || '').trim();
        const status = String(row[idx.status] || '').trim();
        const type = String(row[idx.type] || '').trim();
        let dateIso = '';
        if (idx.schd !== undefined) dateIso = normalizeUsDateToIso(String(row[idx.schd] || '').trim());
        if (!dateIso) dateIso = new Date().toISOString().slice(0,10);
        const badge = (function(s){ const v=String(s||'').trim().toLowerCase(); if(!v) return ''; if(/^not\\s*done$/.test(v)) return 'not-done'; if(/complete|completed\\b/.test(v)) return 'completed'; if(/pending|sched|scheduled/.test(v)) return 'pending'; if(/cancel|cnx|canceled|cancelled/.test(v)) return 'cancelled'; if(/unassign|unassigned/.test(v)) return 'unassigned'; return v; })(status);
        const key = `${tech}|${dateIso}`;
        if (!group[key]) group[key] = { techNo: tech || '', date: dateIso || '', stops: [], totalStops: 0 };
        group[key].stops.push({ time, job: jobId, type, status, normalizedStatus: badge, badge, tech, name, address: [addr, city].filter(Boolean).join(', '), phone: String(row[idx.phone]||'').trim() });
      }
      for (const k of Object.keys(group)) { const r = group[k]; r.totalStops = r.stops.length; routes.push(r); }
    }
    // Output summary for today (2025-12-08)
    const date = '2025-12-08';
    const filtered = routes.filter(r => String(r.date) === date || !r.date);
    console.log(JSON.stringify({ date, totalRoutes: filtered.length, sample: filtered.slice(0,5) }, null, 2));
  } catch (e) {
    console.error('error', e && e.message);
    process.exit(1);
  }
})();
