require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const cheerio = require('cheerio');

const TECHNET_URL = process.env.TECHNET_URL || 'https://technet.altice.csgfsm.com/altice/tn/technet.htm?Id=1';
const OUT_HTML = path.join(__dirname, '..', 'tmp', `live_render_${Date.now()}.html`);

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
  // also capture text blocks for hashObj search
  const htmlStr = String(html || '');
  return { title, tables, html: htmlStr };
}

function normalizeUsDateToIso(usDate) {
  if (!usDate || typeof usDate !== 'string') return '';
  const m = usDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return '';
  const [_, mm, dd, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

function parseHashObjRoutes(html, forcedTech) {
  const routes = [];
  try {
    const objs = [];
    const regex = /hashObj\[[^\]]+\]\s*=\s*\{([\s\S]*?)\};/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const objText = `{${match[1]}}`;
      try { const json = JSON.parse(objText); objs.push(json); } catch (e) {}
    }
    if (!objs.length) return routes;
    const group = {};
    const cleanVal = (v) => String(v||'').trim().replace(/^"+\s*/, '').replace(/\s*"+$/, '').trim();
    for (const o of objs) {
      const liRaw = Array.isArray(o.lineItems) ? o.lineItems.map(s => String(s||'').replace(/<[^>]+>/g, '').trim()) : [];
      const li = liRaw.map(x => cleanVal(x));
      const kv = {};
      for (let i=0;i<li.length;i++){
        const cur = li[i];
        const m = cur.match(/^([A-Za-z# ]+)\s*:\s*(.*)$/);
        if (m) {
          const key = cleanVal(m[1]+':');
          const rest = cleanVal(m[2]);
          if (rest) kv[key] = rest; else if (i+1<li.length) kv[key] = cleanVal(li[i+1]);
        }
      }
      const get = (label) => { if (kv[label]!=null) return kv[label]; const spaced = label.replace(':',' :'); if (kv[spaced]!=null) return kv[spaced]; const item = li.find(s=>s.startsWith(label)); return item ? cleanVal(item.replace(label,'')) : ''; };
      let tech = get('Tech:')||'';
      const type = get('Type:')||get('TYPE:')||'';
      const jobId = get('Job ID:')||get('JobID:')||String(o.woJobNumber||'').replace(/<[^>]+>/g,'').split(' ')[0];
      const statusRaw = get('DS:')||get('DS :')||get('Status:')||get('STATUS:')||get('Disposition:')||'';
      const ts = get('TS:')||get('TS :');
      const addr = get('Addr:');
      const addr2 = get('Addr2:');
      const city = get('City:');
      let dateIso = normalizeUsDateToIso(get('Schd:')||get('Schd :')) || String(o.drawStartDate||'').replace(/\//g,'-');
      if (!dateIso || !/\d{4}-\d{2}-\d{2}/.test(dateIso)) dateIso = new Date().toISOString().slice(0,10);
      const normalizeStatus = (s)=>{ const v=String(s||'').trim().toLowerCase(); if(!v) return ''; if(/^not\s*done$/.test(v)) return 'not-done'; if(/complete|completed\b/.test(v)) return 'completed'; if(/pending|sched|scheduled/.test(v)) return 'pending'; if(/cancel|cnx|canceled|cancelled/.test(v)) return 'cancelled'; if(/unassign|unassigned/.test(v)) return 'unassigned'; return v; };
      const badge = normalizeStatus(statusRaw);
      const key = `${tech}|${dateIso}`;
      if (!group[key]) group[key] = { techNo: tech||'', date: dateIso||'', stops: [], totalStops:0 };
      group[key].stops.push({ time: ts, job: jobId, type, status: statusRaw, normalizedStatus: badge, badge, tech, name: get('Name:'), address: [addr,addr2,city].filter(Boolean).join(', '), phone: get('Home #:')||get('Work #:') });
    }
    for (const k of Object.keys(group)) { const r = group[k]; r.totalStops = r.stops.length; routes.push(r); }
  } catch (e) {}
  return routes;
}

function parseTableRoutes(html, forcedTech) {
  const routes = [];
  try {
    const data = parseHtmlToData(html||'');
    const tables = data.tables || [];
    for (const t of tables) {
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
        const tech = String(row[idx.tech] || forcedTech || '').trim();
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
  } catch (e) {}
  return routes;
}

(async function main(){
  try {
    // Ensure tmp dir
    const tmpDir = path.join(__dirname, '..', 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    // Launch Playwright
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    // Apply credentials if provided in env (TECHNET_USER/TECHNET_PASS)
    const user = process.env.TECHNET_USER || process.env.TECHNET_USERNAME || '';
    const pass = process.env.TECHNET_PASS || process.env.TECHNET_PASSWORD || '';
    if (user && pass) {
      // attempt basic auth if url requires it
      // (This is app-specific; some setups use form-based login.)
    }
    console.log('Navigating to', TECHNET_URL);
    await page.goto(TECHNET_URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(e=>{});
    // give page some time to hydrate client-side content
    await page.waitForTimeout(2000);
    const html = await page.content();
    fs.writeFileSync(OUT_HTML, html, 'utf8');
    await browser.close();

    // Parse using hashObj and table fallbacks
    const hashRoutes = parseHashObjRoutes(html, '');
    const tableRoutes = parseTableRoutes(html, '');
    const combined = (hashRoutes.length ? hashRoutes : []).concat(tableRoutes.filter(r=>!hashRoutes.find(h=>h.techNo===r.techNo && h.date===r.date)));
    const date = new Date().toISOString().slice(0,10);
    console.log(JSON.stringify({ date, renderedHtmlPath: OUT_HTML, hashCount: hashRoutes.length, tableCount: tableRoutes.length, totalRoutes: combined.length, sample: combined.slice(0,10) }, null, 2));
  } catch (e) {
    console.error('error', e && e.message);
    process.exit(1);
  }
})();
