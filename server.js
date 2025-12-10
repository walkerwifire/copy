require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const path = require('path');
const cheerio = require('cheerio');
const ExcelJS = require('exceljs');

const TECHNET_URL = process.env.TECHNET_URL || 'https://technet.altice.csgfsm.com/altice/tn/technet.htm?Id=1';
const HEADLESS = (process.env.HEADLESS ? process.env.HEADLESS.toLowerCase() !== 'false' : true);
const SLOWMO = parseInt(process.env.SLOWMO || '0', 10);
const TECHS_JSON_ENV = process.env.TECHS_JSON || process.env.TECHS_JSON_PATH;
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || '600000', 10); // 10 minutes
const MAPTILER_KEY = process.env.MAPTILER_KEY || '';
const BROWSER_REUSE = (process.env.BROWSER_REUSE || 'true').toLowerCase() !== 'false';
// Geocoding constraints to avoid wildly incorrect results
const GEO_COUNTRY = (process.env.GEO_COUNTRY || 'US').toUpperCase();
// Default proximity center near central Brooklyn; override via env if needed
const GEO_PROX_LNG = parseFloat(process.env.GEO_PROX_LNG || '-73.95');
const GEO_PROX_LAT = parseFloat(process.env.GEO_PROX_LAT || '40.65');
// Default to NYC + Long Island bounding box (minLng,minLat,maxLng,maxLat). Override via env if needed.
// Covers NYC boroughs and Long Island eastward roughly to Suffolk county.
const GEO_BBOX = process.env.GEO_BBOX || '-74.5,40.2,-72.5,41.2';

const app = express();
app.use(morgan('dev'));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Admin: clear in-memory auth failure markers (requires ADMIN_SECRET)
app.post('/api/admin/clear-auth-errors', (req, res) => {
  try {
    const provided = req.body && (req.body.secret || req.body.ADMIN_SECRET) || req.headers['x-admin-secret'];
    if (!provided || String(provided) !== String(ADMIN_SECRET)) return res.status(403).json({ ok: false, error: 'forbidden' });
    badTechCreds.clear();
    Object.keys(authErrorMap).forEach(k => delete authErrorMap[k]);
    console.log('[admin] cleared auth error markers');
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e && e.message || e) }); }
});

// Normalize multiple slashes in request URLs (e.g., //api/routes.csv -> /api/routes.csv)
app.use((req, _res, next) => {
  try {
    if (typeof req.url === 'string') {
      // Preserve querystring while collapsing duplicate slashes in pathname
      const [pathPart, queryPart] = req.url.split('?');
      const normalizedPath = pathPart.replace(/\/{2,}/g, '/');
      req.url = queryPart ? `${normalizedPath}?${queryPart}` : normalizedPath;
    }
  } catch {}
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

/**
 * Parse a generic HTML page for tables, labeled fields, and key text.
 * Returns { title, tables: Array<{headers:[], rows:[][]}>, textBlocks: [], fields: Array<{label, value}> }
 */
function parseHtmlToData(html) {
  const $ = cheerio.load(html);
  const title = $('title').text() || $('h1').first().text() || 'Technet';
  const tables = [];
  $('table').each((i, table) => {
    const headers = [];
    const rows = [];
    const $table = $(table);
    // headers
    $table.find('thead tr th, tr th').each((_, th) => {
      headers.push($(th).text().trim());
    });
    // rows
    $table.find('tbody tr, tr').each((_, tr) => {
      const cells = [];
      $(tr).find('td').each((__, td) => {
        cells.push($(td).text().trim());
      });
      if (cells.length) rows.push(cells);
    });
    if (headers.length || rows.length) {
      tables.push({ headers, rows });
    }
  });
  const textBlocks = [];
  $('p, li, label').each((i, el) => {
    const txt = $(el).text().trim();
    if (txt && txt.length > 0) textBlocks.push(txt);
  });
  // Extract labeled fields: label + input/next sibling value pairs
  const fields = [];
  $('label').each((_, label) => {
    const $label = $(label);
    const labelText = $label.text().trim();
    let value = '';
    // For inputs associated via for=id
    const forId = $label.attr('for');
    if (forId) {
      const $inp = $(`#${forId}`);
      if ($inp.length) {
        value = ($inp.val() || $inp.attr('value') || '').toString().trim();
      }
    }
    if (!value) {
      // Try next input or text node
      const $nextInput = $label.nextAll('input').first();
      if ($nextInput.length) {
        value = ($nextInput.val() || $nextInput.attr('value') || '').toString().trim();
      } else {
        const siblingText = ($label.next().text() || '').trim();
        if (siblingText) value = siblingText;
      }
    }
    if (labelText) fields.push({ label: labelText, value });
  });
  // Also attempt definition lists
  $('dl').each((_, dl) => {
    const $dl = $(dl);
    const dts = $dl.find('dt');
    const dds = $dl.find('dd');
    dts.each((i, dt) => {
      const labelText = $(dt).text().trim();
      const valueText = (dds.eq(i).text() || '').trim();
      if (labelText) fields.push({ label: labelText, value: valueText });
    });
  });
  return { title, tables, textBlocks, fields };
}

/**
 * Try offline mode first: read captured files from the workspace.
 * Since the server runs outside VS Code tooling, we assume paths relative to repo.
 */
const fs = require('fs');
function tryOfflineCapture() {
  try {
    const base = path.resolve(__dirname, '..');
    const respDir = path.join(base, '_responses');
    // Allow env override
    const envPath = process.env.OFFLINE_HTML;
    const candidates = [
      envPath && path.isAbsolute(envPath) ? envPath : null,
      envPath ? path.join(base, envPath) : null,
      path.join(respDir, 'dashboard.html'),
      path.join(base, 'page_snapshot.html'),
      path.join(base, 'manifest.html')
    ].filter(Boolean);
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const html = fs.readFileSync(p, 'utf8');
        return { source: 'offline', html, data: parseHtmlToData(html), offlinePath: p };
      }
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function normalizeUsDateToIso(usDate) {
  // Expects MM/DD/YYYY
  if (!usDate || typeof usDate !== 'string') return '';
  const m = usDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return '';
  const [_, mm, dd, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, '').trim();
}

function deriveRoutesFromHtml(html, forcedTech) {
  const routes = [];
  try {
    const objs = [];
    const regex = /hashObj\[[^\]]+\]\s*=\s*\{([\s\S]*?)\};/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const objText = `{${match[1]}}`;
      try {
        const json = JSON.parse(objText);
        objs.push(json);
      } catch {}
    }
    if (!objs.length) return routes;
    // Group by tech and date
    const group = {};
    const cleanVal = (v) => {
      let s = String(v || '').trim();
      // Remove leading/trailing quotes and stray spaces
      s = s.replace(/^"+\s*/, '').replace(/\s*"+$/, '').trim();
      return s;
    };
    for (const o of objs) {
      const liRaw = Array.isArray(o.lineItems) ? o.lineItems.map(stripTags) : [];
      const li = liRaw.map(x => cleanVal(x));
      // Build a simple label->value map where labels like 'DS:' may be followed by a separate value entry
      const kv = {};
      for (let i = 0; i < li.length; i++) {
        const cur = li[i];
        // Match a label that ends with ':' possibly with spaces before ':'
        const m = cur.match(/^([A-Za-z# ]+)\s*:\s*(.*)$/);
        if (m) {
          const key = cleanVal(m[1] + ':');
          const rest = cleanVal(m[2]);
          if (rest) kv[key] = rest;
          else if (i + 1 < li.length) kv[key] = cleanVal(li[i + 1]);
        }
      }
      const get = (label) => {
        // Try direct kv map first
        if (kv[label] != null) return kv[label];
        // Try spaced variant (e.g., 'DS :')
        const spaced = label.replace(':', ' :');
        if (kv[spaced] != null) return kv[spaced];
        // Fallback: inline replacement
        const item = li.find(s => s.startsWith(label));
        return item ? cleanVal(item.replace(label, '')) : '';
      };
      // Tech number and identifiers
      let tech = get('Tech:') || '';
      if (!tech && forcedTech) tech = String(forcedTech);
      const type = get('Type:') || get('TYPE:') || '';
      const jobId = get('Job ID:') || get('JobID:') || stripTags(o.woJobNumber || '').split(' ')[0];
      // Status/disposition may be labeled differently across views
      const statusRaw = get('DS:') || get('DS :') || get('Status:') || get('STATUS:') || get('Disposition:') || '';
      const status = statusRaw || '';
      const ts = get('TS:') || get('TS :');
      const startTime = o.drawStartTime || '';
      const endTime = o.drawEndTime || '';
      const time = ts || (startTime && endTime ? `${startTime}-${endTime}` : (startTime || ''));
      const addr = get('Addr:');
      const addr2 = get('Addr2:');
      const city = get('City:');
      const name = get('Name:');
      const phone = get('Home #:') || get('Work #:');
      let dateIso = normalizeUsDateToIso(get('Schd:') || get('Schd :')) || (String(o.drawStartDate || '').replace(/\//g, '-'));
      if (!dateIso || !/\d{4}-\d{2}-\d{2}/.test(dateIso)) {
        // Default to today to avoid filtering out stops when schedule date is formatted unexpectedly
        dateIso = new Date().toISOString().slice(0,10);
      }
      // Normalize status across common states
      const normalizeStatus = (s) => {
        const v = String(s || '').trim().toLowerCase();
        if (!v) return '';
        if (/^not\s*done$/.test(v)) return 'not-done';
        if (/complete|completed\b/.test(v)) return 'completed';
        if (/pending|sched|scheduled|pending install|pending tc|pending cos|pending change/.test(v)) return 'pending';
        if (/cancel|cnx|canceled|cancelled/.test(v)) return 'cancelled';
        if (/unassign|unassigned/.test(v)) return 'unassigned';
        return v;
      };
      const badge = normalizeStatus(status);
      // Detect CSG Technet header prefix [IS:...] near this job in the source HTML
      let hasIS = false;
      try {
        const safeId = String(jobId).replace(/[.*+?^${}()|[\]\\]/g, r=>r);
        const re = new RegExp(safeId + "[^\n\r]*\\[\\s*IS\\s*:[^\]]*\]", 'i');
        hasIS = re.test(String(html||''));
        if (!hasIS) {
          // Fallback: header class "job IS" near the job id line
          const re2 = new RegExp(safeId + "[\s\S]{0,80}class=\\\"job\\s+IS\\\"", 'i');
          hasIS = re2.test(String(html||''));
        }
      } catch {}
      const key = `${tech}|${dateIso}`;
      if (!group[key]) {
        group[key] = { techNo: tech || '', date: dateIso || '', stops: [], totalStops: 0, estimatedDuration: '' };
      }
      group[key].stops.push({ time, job: jobId, type, status, normalizedStatus: badge, badge, tech, name, address: [addr, addr2, city].filter(Boolean).join(', '), phone, hasIS });
    }
    // Compute totals
    for (const k of Object.keys(group)) {
      const r = group[k];
      r.totalStops = r.stops.length;
      // Rough estimate: sum durations if available
      let totalMin = 0;
      for (const o of objs) {
        if ((stripTags(o.lineItems?.find(x => /Tech:/.test(x)) || '').includes(r.techNo)) && (normalizeUsDateToIso(stripTags(o.lineItems?.find(x => /Schd:/.test(x)) || '').replace('Schd:', '').trim()) === r.date)) {
          const dur = parseInt(String(o.drawTotalDuration || '0'), 10);
          if (!isNaN(dur)) totalMin += dur;
        }
      }
      if (totalMin > 0) {
        const h = Math.floor(totalMin / 60);
        const m = totalMin % 60;
        r.estimatedDuration = `${h}h ${m}m`;
      }
      routes.push(r);
    }
  } catch {}
  // Fallback: parse text blocks by Job ID sections if hashObj not found
  try {
    const blocks = String(html||'').split(/\bJob ID\s*:\s*/i).slice(1);
    if (blocks.length) {
      const group = {};
      for (const blk of blocks) {
        const tech = String(forcedTech||'').trim();
        const jobId = (blk.match(/^(\d{6,})/)||[])[1] || '';
        const getField = (label) => {
          const m = blk.match(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, r=>r), 'i'));
          if (!m) return '';
          const rest = blk.slice(m.index + label.length);
          const line = (rest.match(/^[^\r\n]+/)||[''])[0];
          return cleanVal(line);
        };
        const status = getField('DS:') || getField('DS :') || '';
        const type = getField('Type:') || '';
        const ts = getField('TS:') || getField('TS :') || '';
        const name = getField('Name:') || '';
        const addr = getField('Addr:') || '';
        const addr2 = getField('Addr2:') || '';
        const city = getField('City:') || '';
        let dateIso = normalizeUsDateToIso(getField('Schd:') || getField('Schd :')) || new Date().toISOString().slice(0,10);
        const normalizeStatus = (s) => {
          const v = String(s || '').trim().toLowerCase();
          if (!v) return '';
          if (/^not\s*done$/.test(v)) return 'not-done';
          if (/complete|completed\b/.test(v)) return 'completed';
          if (/pending|sched|scheduled|pending install|pending tc|pending cos|pending change/.test(v)) return 'pending';
          if (/cancel|cnx|canceled|cancelled/.test(v)) return 'cancelled';
          if (/unassign|unassigned/.test(v)) return 'unassigned';
          return v;
        };
        const badge = normalizeStatus(status);
        // Detect IS prefix in full HTML context for this job
        let hasIS = false;
        try {
          const safeId = String(jobId).replace(/[.*+?^${}()|[\]\\]/g, r=>r);
          const re = new RegExp(safeId + "[^\n\r]*\\[\\s*IS\\s*:[^\]]*\]", 'i');
          hasIS = re.test(String(html||''));
          if (!hasIS) {
            const re2 = new RegExp(safeId + "[\s\S]{0,80}class=\\\"job\\s+IS\\\"", 'i');
            hasIS = re2.test(String(html||''));
          }
        } catch {}
        const key = `${tech}|${dateIso}`;
        if (!group[key]) group[key] = { techNo: tech, date: dateIso, stops: [], totalStops: 0, estimatedDuration: '' };
        const time = ts;
        group[key].stops.push({ time, job: jobId, type, status, normalizedStatus: badge, badge, tech, name, address: [addr, addr2, city].filter(Boolean).join(', '), hasIS });
      }
      for (const k of Object.keys(group)) { const r = group[k]; r.totalStops = r.stops.length; routes.push(r); }
    }
  } catch {}

  // Additional fallback: parse table-based HTML (useful for newer/SSR pages)
  try {
    if (!routes.length) {
      const data = parseHtmlToData(html || '');
      const tables = data.tables || [];
      for (const t of tables) {
        const headers = (t.headers || []).map(h => String(h || '').trim());
        const headerLower = headers.map(h => h.toLowerCase());
        // Heuristic: require at least one of these columns
        if (!(headerLower.some(h => h.includes('job')) || headerLower.some(h => h.includes('tech')) || headerLower.some(h => h.includes('schd')))) continue;
        const idx = {};
        headers.forEach((h,i) => {
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
        for (const row of (t.rows || [])) {
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
          const badge = (function(s){ const v=String(s||'').trim().toLowerCase(); if(!v) return ''; if(/^not\s*done$/.test(v)) return 'not-done'; if(/complete|completed\b/.test(v)) return 'completed'; if(/pending|sched|scheduled/.test(v)) return 'pending'; if(/cancel|cnx|canceled|cancelled/.test(v)) return 'cancelled'; if(/unassign|unassigned/.test(v)) return 'unassigned'; return v; })(status);
          const key = `${tech}|${dateIso}`;
          if (!group[key]) group[key] = { techNo: tech || '', date: dateIso || '', stops: [], totalStops: 0, estimatedDuration: '' };
          group[key].stops.push({ time, job: jobId, type, status, normalizedStatus: badge, badge, tech, name, address: [addr, city].filter(Boolean).join(', '), phone: String(row[idx.phone]||'').trim() });
        }
        for (const k of Object.keys(group)) { const r = group[k]; r.totalStops = r.stops.length; routes.push(r); }
      }
    }
  } catch (e) {}

  return routes;
}

// Resolve credentials from a techs.json file
function getTechsJsonPath() {
  try {
    if (TECHS_JSON_ENV && fs.existsSync(TECHS_JSON_ENV)) return TECHS_JSON_ENV;
  } catch {}
  try {
    const localPath = path.join(__dirname, 'techs.json');
    if (fs.existsSync(localPath)) return localPath;
  } catch {}
  try {
    const abs = 'C:/Users/njdru/dispatcher-app/technet-sync/server/techs.json';
    if (fs.existsSync(abs)) return abs;
  } catch {}
  return null;
}

function resolveCredsFromTechs(techId) {
  try {
    const p = getTechsJsonPath();
    if (!p) return null;
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(arr)) return null;
    const tech = techId ? arr.find(t => String(t.tech) === String(techId)) : arr[0];
    if (!tech) return null;
    return { user: String(tech.tech), pass: String(tech.password || '') };
  } catch { return null; }
}

function getAllTechsFromJson() {
  try {
    const p = getTechsJsonPath();
    if (!p) return [];
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(arr)) return [];
    return arr.map(t => ({
      tech: String(t.tech),
      password: String(t.password || ''),
      status: t.status,
      workSkill: t.workSkill,
      provider: t.provider,
      lastActivity: t.lastActivity,
      name: t.name
    }));
  } catch { return []; }
}

function getTechDateCachePath(tech, dateIso) {
  const dir = path.join(cacheDir, 'live', tech);
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {}
  return path.join(dir, `${dateIso || 'latest'}.json`);
}

function isFreshCache(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    const age = Date.now() - stat.mtimeMs;
    return age < CACHE_TTL_MS;
  } catch { return false; }
}

function readCachedRoutes(filePath) {
  try {
    const txt = fs.readFileSync(filePath, 'utf8');
    const obj = JSON.parse(txt);
    return Array.isArray(obj) ? obj : [];
  } catch { return []; }
}

function writeCachedRoutes(filePath, routes) {
  try { fs.writeFileSync(filePath, JSON.stringify(routes || [], null, 2), 'utf8'); } catch {}
}

function isTodayDateIso(dateIso) {
  try {
    if (!dateIso) return true;
    const today = new Date().toISOString().slice(0,10);
    return String(dateIso) === today;
  } catch { return false; }
}

async function fetchTechRoutesWithCache(tech, password, dateIso, opts = {}) {
  const tStart = Date.now();
  const cacheFile = getTechDateCachePath(tech, dateIso);
  const cacheExists = fs.existsSync(cacheFile);
  // For past dates, prefer any existing cache regardless of freshness and avoid overwriting it.
  if (!isTodayDateIso(dateIso) && cacheExists && !opts.force) {
    const routes = readCachedRoutes(cacheFile);
    console.log(`[fetchTechRoutesWithCache] tech=${tech} date=${dateIso} source=cache cacheExists=${cacheExists} count=${(routes||[]).length} durationMs=${Date.now()-tStart}`);
    return routes;
  }
  // For today (or when no file exists yet), use freshness to decide whether to refetch
  if (!opts.force && isFreshCache(cacheFile)) {
    const routes = readCachedRoutes(cacheFile);
    console.log(`[fetchTechRoutesWithCache] tech=${tech} date=${dateIso} source=fresh-cache cacheExists=${cacheExists} count=${(routes||[]).length} durationMs=${Date.now()-tStart}`);
    return routes;
  }
  console.log(`[fetchTechRoutesWithCache] tech=${tech} date=${dateIso} source=live start`);
  // If this tech previously failed auth, skip re-attempts unless forced
  if (badTechCreds.has(String(tech)) && !opts.force) {
    console.log(`[fetchTechRoutesWithCache] tech=${tech} skipping live fetch due to prior auth failure`);
    return [];
  }

  let live;
  try {
    live = await fetchLiveHtmlWith(tech, password, TECHNET_URL);
  } catch (err) {
    // If fetch throws, treat as auth failure for this tech to avoid repeated retries
    const msg = String(err && err.message ? err.message : err);
    if (password) {
      badTechCreds.add(String(tech));
      authErrorMap[String(tech)] = msg;
      console.log(`[fetchTechRoutesWithCache] tech=${tech} live fetch error -> marking auth failed: ${msg}`);
    } else {
      console.log(`[fetchTechRoutesWithCache] tech=${tech} live fetch error (no creds supplied): ${msg}`);
    }
    return [];
  }
  const htmlStr = String(live && live.html || '');
  // Heuristics: detect login page or explicit failure messages and mark auth failure
  try {
    const looksLikeLoginPage = /Log\s*On/i.test(htmlStr) && (/input[^>]+name=["']?pinVal/i.test(htmlStr) || /input[^>]+type=["']?password/i.test(htmlStr));
    const showsError = /invalid|failed|locked|try\s*again/i.test(htmlStr);
    if ((looksLikeLoginPage || showsError) && password) {
      // Marking auth failures based on HTML heuristics can produce false-positives.
      // Require explicit opt-in via STRICT_AUTH_FAIL=1 to enable automatic marking.
      if (String(process.env.STRICT_AUTH_FAIL || '') === '1') {
        badTechCreds.add(String(tech));
        authErrorMap[String(tech)] = 'login failed or invalid credentials';
        console.log(`[fetchTechRoutesWithCache] tech=${tech} detected login failure in returned HTML (STRICT_AUTH_FAIL=1)`);
        return [];
      } else {
        console.log(`[fetchTechRoutesWithCache] tech=${tech} detected login-like content but STRICT_AUTH_FAIL not enabled — not marking auth failure`);
      }
    }
  } catch (e) {}
  const routes = deriveRoutesFromHtml(live.html || '', tech);
  const techRoutes = routes.filter(r => String(r.techNo) === String(tech));
  const filtered = dateIso ? techRoutes.filter(r => String(r.date) === String(dateIso)) : techRoutes;
  // Only write cache if we have data or it's explicitly for today. This preserves past-day caches.
  if (filtered.length > 0 || isTodayDateIso(dateIso)) {
    writeCachedRoutes(cacheFile, filtered);
  }
  console.log(`[fetchTechRoutesWithCache] tech=${tech} date=${dateIso} source=live done count=${filtered.length} durationMs=${Date.now()-tStart}`);
  return filtered;
}

async function parallelMap(items, limit, mapper) {
  const results = [];
  let i = 0;
  const workers = new Array(Math.max(1, limit)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await mapper(items[idx]);
      } catch (e) {
        results[idx] = [];
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchAllTechRoutes(dateIso, opts = {}) {
  const list = getAllTechsFromJson();
  const concurrency = parseInt(process.env.CONCURRENCY || '3', 10);
  const tAllStart = Date.now();
  console.log(`[fetchAllTechRoutes] start date=${dateIso} techs=${list.length} concurrency=${concurrency}`);
  const chunks = await parallelMap(list, concurrency, async (t) => {
    const routes = await fetchTechRoutesWithCache(t.tech, t.password, dateIso, opts);
    // Persist per tech/date indefinitely
    const file = getTechDateCachePath(t.tech, dateIso || new Date().toISOString().slice(0,10));
    // Do NOT overwrite past-day caches with empty arrays.
    // Only write when we have data, or when caching today's runs.
    if ((Array.isArray(routes) && routes.length > 0) || isTodayDateIso(dateIso)) {
      writeCachedRoutes(file, routes);
    }
    return routes;
  });
  const aggregated = [];
  for (const arr of chunks) aggregated.push(...arr);
  // Persist aggregated routes for this date to local data directory
  try { persistAggregatedRoutes(dateIso || new Date().toISOString().slice(0,10), aggregated); } catch {}
  console.log(`[fetchAllTechRoutes] done date=${dateIso} aggregatedRoutes=${aggregated.length} totalDurationMs=${Date.now()-tAllStart}`);
  return aggregated;
}

// Removed single-tech preference: the server aggregates all techs from techs.json

/**
 * Live fetch via Playwright with credentials.
 * Requires TECHNET_USER and TECHNET_PASS in .env.
 * Returns { html, data }
 */
async function fetchLiveHtml() {
  const user = process.env.TECHNET_USER || process.env.TECHNET_USERNAME;
  const pass = process.env.TECHNET_PASS || process.env.TECHNET_PASSWORD;
  if (!user || !pass) {
    throw new Error('Missing TECHNET_USER/TECHNET_PASS or TECHNET_USERNAME/TECHNET_PASSWORD in environment');
  }
  const browser = await acquireBrowser();
  // Provide geolocation permissions to satisfy Technet nextPage() logic
  const context = await browser.newContext({
    permissions: ['geolocation'],
    geolocation: { latitude: 40.7128, longitude: -74.0060, accuracy: 100 }
  });
  const page = await context.newPage();
  await page.goto(TECHNET_URL, { waitUntil: 'domcontentloaded' });

  // Attempt to fill login fields by known input names (techVal/pinVal)
  try {
    const techInput = page.locator('input[name="techVal"]');
    const pwInput = page.locator('input[name="pinVal"]');
    if (await techInput.count()) { await techInput.fill(user); }
    if (await pwInput.count()) { await pwInput.fill(pass); }
    // Click the explicit Log On button
    const loginBtn = page.locator('input[type="button"][value="Log On"], input[value="Log On"], button:has-text("Log On")');
    if (await loginBtn.count()) {
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        loginBtn.click().catch(() => {})
      ]);
    } else {
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
    }
  } catch (e) {
    // Fallback: programmatically submit the form
    try {
      await page.evaluate(() => {
        const fm = document.forms[0];
        if (!fm) return;
        fm.XgeoX && (fm.XgeoX.value = 'geoNoNav');
        fm.submit();
      });
      await page.waitForLoadState('networkidle').catch(() => {});
    } catch {}
  }

  // After login, take the resulting page content
  const html = await page.content();
  await context.close();
  if (!BROWSER_REUSE) await browser.close();
  return { html, data: parseHtmlToData(html) };
}

async function fetchLiveHtmlWith(user, pass, targetUrl) {
  if (!user || !pass) {
    throw new Error('Missing user/pass');
  }
  const url = targetUrl || TECHNET_URL;
  const browser = await acquireBrowser();
  const context = await browser.newContext({
    permissions: ['geolocation'],
    geolocation: { latitude: 40.7128, longitude: -74.0060, accuracy: 100 }
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  try {
    const techInput = page.locator('input[name="techVal"]');
    const pwInput = page.locator('input[name="pinVal"]');
    if (await techInput.count()) { await techInput.fill(user); }
    if (await pwInput.count()) { await pwInput.fill(pass); }
    const loginBtn = page.locator('input[type="button"][value="Log On"], input[value="Log On"], button:has-text("Log On")');
    if (await loginBtn.count()) {
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        loginBtn.click().catch(() => {})
      ]);
    } else {
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
    }
  } catch {}
  const html = await page.content();
  await context.close();
  if (!BROWSER_REUSE) await browser.close();
  return { html, data: parseHtmlToData(html) };
}

// Navigate after login to a specific job detail pane and return its HTML
async function fetchJobDetailHtmlWith(user, pass, jobId, targetUrl) {
  if (!user || !pass) throw new Error('Missing user/pass');
  if (!jobId) throw new Error('Missing jobId');
  const url = targetUrl || TECHNET_URL;
  const browser = await acquireBrowser();
  const context = await browser.newContext({ permissions: ['geolocation'], geolocation: { latitude: 40.7128, longitude: -74.0060, accuracy: 100 } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Login
  try {
    const techInput = page.locator('input[name="techVal"], input[name="tech"], input[placeholder*="Tech"]');
    const pwInput = page.locator('input[name="pinVal"], input[name="pin"], input[type="password"]');
    if (await techInput.count()) { await techInput.fill(user); }
    if (await pwInput.count()) { await pwInput.fill(pass); }
    const loginBtn = page.locator('input[type="button"][value="Log On"], input[value="Log On"], button:has-text("Log On")');
    if (await loginBtn.count()) {
      await Promise.all([ page.waitForLoadState('networkidle').catch(() => {}), loginBtn.click().catch(() => {}) ]);
    } else {
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
    }
  } catch {}
  // Try to open job details
  try {
    // Strategy A: Click folded job tile div.job containing the jobId
    const foldedTile = page.locator(`div.job:has-text("${jobId}")`);
    if (await foldedTile.count()) {
      await foldedTile.first().scrollIntoViewIfNeeded().catch(() => {});
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        foldedTile.first().click({ force: true }).catch(() => {})
      ]);
    } else {
      // Strategy B: Click any element with text containing jobId (opened tile/td)
      const jobText = page.locator(`text=${jobId}`);
      if (await jobText.count()) {
        await jobText.first().scrollIntoViewIfNeeded().catch(() => {});
        await Promise.all([
          page.waitForLoadState('networkidle').catch(() => {}),
          jobText.first().click({ force: true }).catch(() => {})
        ]);
      } else {
        // Strategy C: Fill a visible text input with jobId and press Enter
        const anyText = page.locator('input[type="text"]');
        if (await anyText.count()) {
          await anyText.first().fill(jobId).catch(() => {});
          await page.keyboard.press('Enter').catch(() => {});
          await page.waitForLoadState('networkidle').catch(() => {});
        }
        // Strategy D: Click a "Go" button if present
        const goBtn = page.locator('input[type="button"][value="Go"], button:has-text("Go")');
        if (await goBtn.count()) {
          await Promise.all([
            page.waitForLoadState('networkidle').catch(() => {}),
            goBtn.first().click().catch(() => {})
          ]);
        }
      }
    }
    // Wait for job details signature to appear
    await page.waitForFunction((jid) => {
      const html = document.body.innerText || '';
      return /Job\s*ID:/i.test(html) && html.includes(jid);
    }, jobId, { timeout: 5000 }).catch(() => {});
  } catch {}
  const html = await page.content();
  await context.close();
  if (!BROWSER_REUSE) await browser.close();
  return { html, data: parseHtmlToData(html) };
}

// Ensure cache dir exists
const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) {
  try { fs.mkdirSync(cacheDir); } catch {}
}
const GEOCODE_CACHE_VERSION = process.env.GEOCODE_CACHE_VERSION || 'v2';
const geocodeCacheDir = path.join(cacheDir, 'geocode', GEOCODE_CACHE_VERSION);
try { if (!fs.existsSync(geocodeCacheDir)) fs.mkdirSync(geocodeCacheDir, { recursive: true }); } catch {}

function geocodeCachePath(address) {
  const key = String(address || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0,120);
  return path.join(geocodeCacheDir, key + '.json');
}

// Playwright browser reuse helper
let sharedBrowserPromise = null;
const acquireBrowser = async () => {
  const { chromium } = require('playwright');
  if (!BROWSER_REUSE) {
    return await chromium.launch({ headless: HEADLESS, slowMo: SLOWMO });
  }
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = chromium.launch({ headless: HEADLESS, slowMo: SLOWMO });
    // best-effort cleanup on exit
    process.on('exit', async () => {
      try { const b = await sharedBrowserPromise; await b.close(); } catch {};
    });
    process.on('SIGINT', async () => { try { const b = await sharedBrowserPromise; await b.close(); } catch {}; process.exit(); });
  }
  return await sharedBrowserPromise;
};

// Geocode overrides (manual corrections)
const geocodeOverridesPath = path.join(geocodeCacheDir, 'overrides.json');
function readGeocodeOverrides() {
  try {
    if (fs.existsSync(geocodeOverridesPath)) return JSON.parse(fs.readFileSync(geocodeOverridesPath, 'utf8'));
  } catch {}
  return { jobs: {}, addresses: {} };
}
function writeGeocodeOverrides(obj) {
  try { fs.writeFileSync(geocodeOverridesPath, JSON.stringify(obj, null, 2), 'utf8'); } catch {}
}

// Delegate address normalization to shared module (keeps logic centralized)
const { normalizeAddress: _normalizeFromLib } = require(path.join(__dirname, 'lib', 'normalizeAddress'));
function normalizeAddress(addr, extra = {}) {
  try {
    const res = _normalizeFromLib(String(addr || '')) || { normalized: '' };
    // If extra.zip provided and module didn't capture it, append it
    let normalized = String(res.normalized || '').trim();
    if ((!res.zip || !res.zip.length) && extra && extra.zip) {
      const z = String(extra.zip || '').trim();
      if (z) normalized = (normalized + ' ' + z).trim();
    }
    return normalized;
  } catch (e) {
    // Fallback to raw minimal normalization
    return String(addr || '').replace(/\s+/g, ' ').trim();
  }
}

async function geocodeAddress(address, context = {}, opts = {}) {
  const raw = String(address || '').trim();
  if (!raw) return null;
  const addr = normalizeAddress(raw, context);
  const hasStreetNumber = /^\s*\d{1,6}\b/.test(addr);
  // Overrides first (unless force-refresh requested)
  const overrides = readGeocodeOverrides();
  const addrKey = addr.toLowerCase();
  if (!opts.force) {
    if (overrides.addresses[addrKey]) return overrides.addresses[addrKey];
    if (context.jobId && overrides.jobs[context.jobId]) return overrides.jobs[context.jobId];
    // Cache hit - cache stores { chosen: {lat,lng,...}, candidates: [...] }
    const p = geocodeCachePath(addr);
    try {
      if (fs.existsSync(p)) {
        const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (obj && obj.chosen && typeof obj.chosen.lat === 'number' && typeof obj.chosen.lng === 'number') return obj.chosen;
      }
    } catch {}
  }

  // Tier 0: parse coords from job details URL/fields when available (best source)
  const p = geocodeCachePath(addr);
  if (context.jobDetail && typeof context.jobDetail === 'object') {
    const jd = context.jobDetail;
    if (typeof jd.lat === 'number' && typeof jd.lng === 'number') {
      const point = { lat: jd.lat, lng: jd.lng, provider: 'job', quality: 'rooftop', confidence: 1.0 };
      try { fs.writeFileSync(p, JSON.stringify({ chosen: point, candidates: [point] }, null, 2), 'utf8'); } catch {}
      return point;
    }
    const link = jd.mapLink || jd.googleMapsUrl || '';
    const m = String(link).match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m) {
      const point = { lat: Number(m[1]), lng: Number(m[2]), provider: 'job-link', quality: 'rooftop', confidence: 0.99 };
      try { fs.writeFileSync(p, JSON.stringify({ chosen: point, candidates: [point] }, null, 2), 'utf8'); } catch {}
      return point;
    }
  }

  // Helper: provider query functions (return candidate or null)
  const candidates = [];
  const providerPriority = { google: 4, mapbox: 3, opencage: 2, nominatim: 1 };

  // Google - prefer ROOFTOP and street_address results; include postal_code in components when available
  try {
    const key = process.env.GOOGLE_MAPS_API_KEY || '';
    if (key) {
      // Try to extract ZIP from normalized addr (if present as trailing token)
      let zip = '';
      const zipMatch = addr.match(/(\b\d{5}(?:-\d{4})?\b)$/);
      if (zipMatch) zip = zipMatch[1];

      const params = new URLSearchParams();
      params.set('address', addr);
      params.set('key', key);
      // Prefer US and, when available, narrow by postal code for rooftop-quality matches
      let comps = 'country:US';
      if (zip) comps += `|postal_code:${zip}`;
      params.set('components', comps);
      const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;
      const r = await fetch(url);
      const j = await r.json();
      const results = Array.isArray(j.results) ? j.results : [];
      // Process all results and boost rooftop/street_address types
      for (const res of results) {
        if (!res || !res.geometry) continue;
        const loc = res.geometry.location;
        const lt = (res.geometry.location_type || '').toUpperCase();
        const types = Array.isArray(res.types) ? res.types : [];
        const isRooftop = lt === 'ROOFTOP' || types.includes('street_address');
        // Base confidence: rooftop->0.95, partial->0.75
        let baseConf = isRooftop ? 0.95 : 0.75;
        // Inspect address_components for street_number/route/postal_code to boost certainty
        try {
          const comps = Array.isArray(res.address_components) ? res.address_components : [];
          const hasStreetNumber = comps.some(c => Array.isArray(c.types) && c.types.includes('street_number'));
          const hasRoute = comps.some(c => Array.isArray(c.types) && c.types.includes('route'));
          const postalComp = comps.find(c => Array.isArray(c.types) && c.types.includes('postal_code'));
          const countryComp = comps.find(c => Array.isArray(c.types) && c.types.includes('country'));
          const compPost = postalComp ? (postalComp.long_name || postalComp.short_name || '') : '';
          if (hasStreetNumber && hasRoute) baseConf += 0.05;
          if (compPost && zip && compPost === zip) baseConf += 0.03;
          if (countryComp && countryComp.short_name && countryComp.short_name.toUpperCase() !== (GEO_COUNTRY||'US')) {
            // country mismatch — de-prioritize heavily
            baseConf = Math.min(baseConf, 0.2);
          }
        } catch (e) {}
        // If formatted address contains the exact house number and street, give a small boost
        try {
          const formatted = (res.formatted_address || '').toLowerCase();
          const simpleAddr = addr.toLowerCase().replace(/\s+/g,' ').trim();
          if (simpleAddr && formatted.includes(simpleAddr.split(' ').slice(0,3).join(' '))) baseConf += 0.02;
        } catch {}
        const cand = { lat: Number(loc.lat), lng: Number(loc.lng), provider: 'google', quality: isRooftop ? 'rooftop' : lt || 'partial', confidence: Math.min(1, baseConf) };
        candidates.push(cand);
      }
    }
  } catch (e) {}

  // Mapbox - prefer place_type 'address' and high relevance as high-precision
  try {
    const token = process.env.MAPBOX_TOKEN || '';
    if (token) {
      const q = encodeURIComponent(addr);
      const params = new URLSearchParams();
      params.set('access_token', token);
      params.set('country', 'US');
      params.set('types', 'address');
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${q}.json?${params.toString()}`;
      const r = await fetch(url);
      const j = await r.json();
      const f = Array.isArray(j.features) ? j.features[0] : null;
      if (f && f.center) {
        const rel = Number(f.relevance || 0);
        // Treat high relevance and 'address' place_type as rooftop-like
        const isAddr = Array.isArray(f.place_type) && f.place_type.includes('address');
        let conf = rel;
        if (isAddr && rel >= 0.9) conf = Math.max(conf, 0.9);
        const cand = { lat: Number(f.center[1]), lng: Number(f.center[0]), provider: 'mapbox', quality: isAddr ? 'address' : (f.place_type && f.place_type[0] || 'unknown'), confidence: conf };
        candidates.push(cand);
      }
    }
  } catch (e) {}

  // MapTiler geocoding fallback (uses MAPTILER_KEY env or MAPTILER_KEY constant)
  try {
    const mtKey = process.env.MAPTILER_KEY || MAPTILER_KEY || '';
    if (mtKey) {
      const q = encodeURIComponent(addr);
      const params = new URLSearchParams();
      params.set('key', mtKey);
      params.set('limit', '1');
      params.set('language', 'en');
      params.set('country', 'US');
      const url = `https://api.maptiler.com/geocoding/${q}.json?${params.toString()}`;
      const r = await fetch(url);
      const j = await r.json();
      const f = Array.isArray(j.features) ? j.features[0] : null;
      if (f && Array.isArray(f.center) && f.center.length >= 2) {
        const conf = Number(f.properties && f.properties.confidence ? f.properties.confidence : 0.8) || 0.8;
        const cand = { lat: Number(f.center[1]), lng: Number(f.center[0]), provider: 'maptiler', quality: f.properties && f.properties.matching_type || 'unknown', confidence: conf };
        candidates.push(cand);
      }
    }
  } catch (e) {}

  // OpenCage (if configured) - treat house/component types as higher precision
  try {
    const key = process.env.OPENCAGE_KEY || '';
    if (key) {
      const params = new URLSearchParams();
      params.set('q', addr);
      params.set('key', key);
      params.set('limit', '1');
      const url = `https://api.opencagedata.com/geocode/v1/json?${params.toString()}`;
      const r = await fetch(url);
      const j = await r.json();
      const res = Array.isArray(j.results) ? j.results[0] : null;
      if (res && res.geometry) {
        const baseConf = Number(res.annotations?.confidence || 0.7) || 0.7;
        const isHouse = res.components && (res.components._type === 'house' || res.components._type === 'building');
        const conf = isHouse ? Math.min(1, baseConf + 0.1) : baseConf;
        const cand = { lat: Number(res.geometry.lat), lng: Number(res.geometry.lng), provider: 'opencage', quality: res.components && res.components._type || 'unknown', confidence: conf };
        candidates.push(cand);
      }
    }
  } catch (e) {}

  // Nominatim (OpenStreetMap public endpoint) as last resort - prefer 'house' or 'building' types
  try {
    // Respect rate limits; only call when no high-confidence candidates exist
    if (candidates.length === 0) {
      const q = encodeURIComponent(addr + (GEO_COUNTRY ? `, ${GEO_COUNTRY}` : ''));
      const params = new URLSearchParams();
      params.set('format', 'json');
      params.set('addressdetails', '0');
      params.set('limit', '1');
      const url = `https://nominatim.openstreetmap.org/search/${q}?${params.toString()}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'technet-dashboard/1.0 (+https://example.local)' } });
      const j = await r.json();
      const f = Array.isArray(j) ? j[0] : null;
      if (f && f.lat && f.lon) {
        const isHouse = (f.type || '').toLowerCase() === 'house' || (f.type || '').toLowerCase() === 'building';
        const conf = isHouse ? 0.85 : 0.6;
        const cand = { lat: Number(f.lat), lng: Number(f.lon), provider: 'nominatim', quality: f.type || 'unknown', confidence: conf };
        candidates.push(cand);
      }
    }
  } catch (e) {}

  // Compute a precision score and choose the best candidate by adjusted confidence and provider priority
  if (candidates.length) {
    // Augment candidates with a small precision boost for rooftop/address/house quality
    // Also penalize or drop candidates outside the GEO_BBOX
    const bboxParts = (String(GEO_BBOX||'').split(',').map(x=>parseFloat(x.trim()))).filter(x=>!isNaN(x));
    let minLng, minLat, maxLng, maxLat;
    if (bboxParts.length === 4) {
      [minLng, minLat, maxLng, maxLat] = bboxParts;
    }
    for (const c of candidates) {
      let precisionBoost = 0;
      const q = String(c.quality || '').toLowerCase();
      if (q === 'rooftop' || q === 'street_address' || q === 'address') precisionBoost += 0.12;
      if (q === 'house' || q === 'building') precisionBoost += 0.08;
      // provider priority as a tiny tiebreaker
      const pp = providerPriority[c.provider] || 0;
      // Penalize out-of-bounds coordinates
      let outOfBounds = false;
      try {
        if (typeof minLng === 'number' && typeof minLat === 'number' && typeof maxLng === 'number' && typeof maxLat === 'number') {
          const lat = Number(c.lat);
          const lng = Number(c.lng);
          if (!(lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat)) {
            outOfBounds = true;
          }
        }
      } catch(e){}
      if (outOfBounds) {
        // heavy penalty for out-of-region results
        c.adjusted = (Number(c.confidence || 0) * 0.3) + (pp * 0.001) - 0.1;
        c.outOfBounds = true;
      } else {
        c.adjusted = (Number(c.confidence || 0) + precisionBoost) + (pp * 0.001);
        c.outOfBounds = false;
      }
    }
    candidates.sort((a,b) => {
      if ((b.adjusted || 0) !== (a.adjusted || 0)) return (b.adjusted||0) - (a.adjusted||0);
      return (providerPriority[b.provider]||0) - (providerPriority[a.provider]||0);
    });
    const chosen = candidates[0];
    // Persist full candidate list and chosen pick
    try { fs.writeFileSync(p, JSON.stringify({ chosen, candidates }, null, 2), 'utf8'); } catch (e) {}
    return chosen;
  }

  return null;
}

// Persistent data directory for exported/stored stops (per-day)
const dataDir = path.join(__dirname, 'data');
try { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true }); } catch {}

function persistAggregatedRoutes(dateIso, routes) {
  try {
    const d = String(dateIso || new Date().toISOString().slice(0,10)).slice(0,10);
    const p = path.join(dataDir, `stops-${d}.json`);
    fs.writeFileSync(p, JSON.stringify({ date: d, generatedAt: new Date().toISOString(), routes: routes || [] }, null, 2), 'utf8');
  } catch (e) {
    // ignore write errors
  }
}

// Endpoint to retrieve stored aggregated stops for a given date
app.get('/api/stored', (req, res) => {
  try {
    const dateIso = String(req.query.date || '').trim() || new Date(Date.now() - 24*3600*1000).toISOString().slice(0,10);
    const p = path.join(dataDir, `stops-${dateIso}.json`);
    // If an aggregated file exists and has routes, return it.
    try {
      if (fs.existsSync(p)) {
        const txt = fs.readFileSync(p, 'utf8');
        try {
          const obj = JSON.parse(txt || '{}');
          if (Array.isArray(obj.routes) && obj.routes.length > 0) {
            return res.json(obj);
          }
        } catch (e) {
          // fallthrough to aggregation
        }
      }
    } catch (e) {}

    // Aggregate per-tech cached routes from cache/live if available
    try {
      const liveRoot = path.join(cacheDir, 'live');
      const aggregated = [];
      if (fs.existsSync(liveRoot)) {
        for (const tech of fs.readdirSync(liveRoot)) {
          try {
            const file = path.join(liveRoot, tech, `${dateIso}.json`);
            if (!fs.existsSync(file)) continue;
            const txt = fs.readFileSync(file, 'utf8');
            const json = JSON.parse(txt || '[]');
            if (Array.isArray(json) && json.length) {
              // json may be an array of route objects
              for (const r of json) aggregated.push(r);
            } else if (Array.isArray(json.routes) && json.routes.length) {
              for (const r of json.routes) aggregated.push(r);
            }
          } catch (e) {
            // ignore per-file errors
          }
        }
      }
      if (aggregated.length) {
        // persist aggregated for future fast reads
        try { persistAggregatedRoutes(dateIso, aggregated); } catch (e) {}
        return res.json({ date: dateIso, generatedAt: new Date().toISOString(), routes: aggregated });
      }
    } catch (e) {
      // ignore aggregation errors
    }

    // If nothing found, return empty result to the client so UI can show fallback
    return res.json({ date: dateIso, generatedAt: new Date().toISOString(), routes: [] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Geocode cache admin endpoints
app.get('/api/geocode/cache', requireAdmin, (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();
    const items = [];
    if (fs.existsSync(geocodeCacheDir)) {
      for (const f of fs.readdirSync(geocodeCacheDir)) {
        if (!f.endsWith('.json')) continue;
        if (q && !f.includes(q)) continue;
        const full = path.join(geocodeCacheDir, f);
        const stat = fs.statSync(full);
        items.push({ file: f, path: full, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }
    return res.json({ version: GEOCODE_CACHE_VERSION, dir: geocodeCacheDir, items });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
app.delete('/api/geocode/cache', requireAdmin, (req, res) => {
  try {
    const address = String(req.query.address || '').trim();
    if (!address) return res.status(400).json({ error: 'address is required' });
    const p = geocodeCachePath(address);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return res.json({ ok: true, removed: p });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
app.post('/api/geocode/cache/clearAll', requireAdmin, (req, res) => {
  try {
    let count = 0;
    if (fs.existsSync(geocodeCacheDir)) {
      for (const f of fs.readdirSync(geocodeCacheDir)) {
        if (f.endsWith('.json')) { fs.unlinkSync(path.join(geocodeCacheDir, f)); count++; }
      }
    }
    return res.json({ ok: true, cleared: count });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Rebuild geocode cache for a given stored date (batch re-geocode)
app.post('/api/geocode/rebuild', requireAdmin, async (req, res) => {
  try {
    const dateIso = String(req.query.date || req.body?.date || '').trim();
    if (!dateIso || !/\d{4}-\d{2}-\d{2}/.test(dateIso)) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
    const p = path.join(dataDir, `stops-${dateIso}.json`);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'stored stops file not found for date ' + dateIso });
    const txt = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(txt || '{}');
    const routes = Array.isArray(obj.routes) ? obj.routes : [];
    const threshold = parseFloat(String(req.query.threshold || req.body?.threshold || '0.85'));
    const low = [];
    let total = 0, updated = 0;
    for (const r of routes) {
      const stops = Array.isArray(r.stops) ? r.stops : [];
      for (const s of stops) {
        const address = s.address || [s.addr, s.addr2, s.city].filter(Boolean).join(', ');
        if (!address) continue;
        total++;
        try {
          const point = await geocodeAddress(address, { jobId: s.job }, { force: true });
          if (point) updated++;
          const conf = (point && typeof point.confidence === 'number') ? point.confidence : 0;
          if (!point || conf < threshold) {
            low.push({ job: s.job || s.jobId || '', address, result: point || null, confidence: conf });
          }
        } catch (e) {
          low.push({ job: s.job || s.jobId || '', address, error: String(e.message || e) });
        }
      }
    }
    return res.json({ date: dateIso, totalAddresses: total, updatedCache: updated, lowConfidenceCount: low.length, lowConfidenceExamples: low.slice(0, 200) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Admin auth configuration
const crypto = require('crypto');
const ADMIN_USER = process.env.ADMIN_USER || process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || process.env.ADMIN_PASSWORD || 'admin';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me';
const adminTokens = new Set();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > -1) {
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  });
  return out;
}

function requireAdmin(req, res, next) {
  try {
    const cookies = parseCookies(req);
    const token = cookies['admin_token'];
    if (token && adminTokens.has(token)) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// Fail-fast guard: if a login attempt fails once, skip further attempts for a cooldown period
let loginFailUntilMs = 0;
const LOGIN_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

// Per-tech credential failure tracking: when a tech's creds fail once, skip further live attempts
const badTechCreds = new Set();
const authErrorMap = {}; // tech -> message

function isLoginCoolingDown() {
  return Date.now() < loginFailUntilMs;
}

function markLoginFailed() {
  loginFailUntilMs = Date.now() + LOGIN_COOLDOWN_MS;
}

// Prefer per-tech creds; single attempt only; detect login failure and do NOT retry
async function fetchLivePreferCreds(req) {
  if (isLoginCoolingDown()) {
    const mins = Math.ceil((loginFailUntilMs - Date.now()) / 60000);
    const err = new Error(`Login attempts paused for ${mins} min due to prior failure`);
    err.code = 'LOGIN_COOLDOWN';
    throw err;
  }
  // Resolve credentials: tech param -> techs.json; else env
  const techParam = String(req.query.tech || '').trim();
  let user = '';
  let pass = '';
  if (techParam) {
    const creds = resolveCredsFromTechs(techParam) || {};
    user = creds.user || creds.username || '';
    pass = creds.pass || creds.password || '';
  } else {
    user = process.env.TECHNET_USER || process.env.TECHNET_USERNAME || '';
    pass = process.env.TECHNET_PASS || process.env.TECHNET_PASSWORD || '';
  }
  if (!user || !pass) {
    const err = new Error('Missing TECHNET credentials');
    err.code = 'MISSING_CREDS';
    throw err;
  }
  // Single live attempt
  const result = await fetchLiveHtmlWith(user, pass, TECHNET_URL);
  const html = String(result.html || '');
  // Heuristics: if page still shows a login form or explicit invalid message, mark failure
  const looksLikeLoginPage = /Log\s*On/i.test(html) && /input[^>]+name=["']?pinVal|input[^>]+type=["']?password/i.test(html);
  const showsError = /invalid|failed|locked|try\s*again/i.test(html);
  if (looksLikeLoginPage || showsError) {
    markLoginFailed();
    const err = new Error('Login failed – skipping further attempts to avoid account lock');
    err.code = 'LOGIN_FAILED';
    throw err;
  }
  return result;
}

// Admin login/logout
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = crypto
      .createHash('sha256')
      .update(`${username}:${ADMIN_SECRET}:${Date.now()}`)
      .digest('hex');
    adminTokens.add(token);
    res.cookie('admin_token', token, { httpOnly: true, sameSite: 'lax' });
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies['admin_token'];
  if (token) adminTokens.delete(token);
  res.clearCookie('admin_token');
  return res.json({ ok: true });
});

// Admin UI page
app.get('/admin', (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Admin geocode UI page
app.get('/admin/geocode', requireAdmin, (req, res) => {
  return res.sendFile(path.join(__dirname, 'public', 'admin-geocode.html'));
});

// Endpoint: list low-confidence addresses for a date
app.get('/api/geocode/low', requireAdmin, (req, res) => {
  try {
    const dateIso = String(req.query.date || '').trim();
    if (!dateIso || !/\d{4}-\d{2}-\d{2}/.test(dateIso)) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
    const threshold = parseFloat(String(req.query.threshold || '0.85'));
    const p = path.join(dataDir, `stops-${dateIso}.json`);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'stored stops file not found for date ' + dateIso });
    const txt = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(txt || '{}');
    const routes = Array.isArray(obj.routes) ? obj.routes : [];
    const low = [];
    let total = 0;
    for (const r of routes) {
      const stops = Array.isArray(r.stops) ? r.stops : [];
      for (const s of stops) {
        const address = s.address || [s.addr, s.addr2, s.city].filter(Boolean).join(', ');
        if (!address) continue;
        total++;
        const keyPath = geocodeCachePath(normalizeAddress(address));
        let cache = null;
        try { if (fs.existsSync(keyPath)) cache = JSON.parse(fs.readFileSync(keyPath, 'utf8')); } catch {}
        const chosen = cache && cache.chosen ? cache.chosen : null;
        const conf = chosen && typeof chosen.confidence === 'number' ? chosen.confidence : 0;
        if (!chosen || conf < threshold) {
          low.push({ job: s.job || s.jobId || '', address, result: chosen, confidence: conf });
        }
      }
    }
    return res.json({ date: dateIso, totalAddresses: total, low });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Endpoint: apply manual override (by job or address)
app.post('/api/geocode/override', requireAdmin, (req, res) => {
  try {
    const body = req.body || {};
    const address = String(body.address || '').trim();
    const job = String(body.job || '').trim();
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!address || !isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: 'address, lat, lng required' });
    const keyPath = geocodeCachePath(normalizeAddress(address));
    const point = { lat: Number(lat), lng: Number(lng), provider: 'override', quality: 'manual', confidence: 1.0 };
    const obj = { chosen: point, candidates: [point] };
    try { fs.writeFileSync(keyPath, JSON.stringify(obj, null, 2), 'utf8'); } catch (e) {}
    // also persist to overrides.json for future preference
    const overrides = readGeocodeOverrides();
    if (job) overrides.jobs[job] = point;
    overrides.addresses[normalizeAddress(address).toLowerCase()] = point;
    writeGeocodeOverrides(overrides);
    return res.json({ ok: true, path: keyPath, point });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/technet', async (req, res) => {
  try {
    const forceLive = (req.query.mode || '').toLowerCase() === 'live';
    if (!forceLive) {
      const offline = tryOfflineCapture();
      if (offline) {
        // cache
        try {
          fs.writeFileSync(path.join(cacheDir, 'latest.html'), offline.html, 'utf8');
          fs.writeFileSync(path.join(cacheDir, 'latest.json'), JSON.stringify(offline.data, null, 2), 'utf8');
        } catch {}
        return res.json({ mode: 'offline', ...offline });
      }
    }
    const result = await fetchLivePreferCreds(req);
    // cache
    try {
      fs.writeFileSync(path.join(cacheDir, 'latest.html'), result.html, 'utf8');
      fs.writeFileSync(path.join(cacheDir, 'latest.json'), JSON.stringify(result.data, null, 2), 'utf8');
    } catch {}
    return res.json({ mode: 'live', ...result });
  } catch (err) {
    const code = err && err.code;
    const status = code === 'LOGIN_COOLDOWN' ? 429 : (code === 'LOGIN_FAILED' ? 401 : 500);
    return res.status(status).json({ error: err.message, code });
  }
});

// Live fetch via POST with credentials
app.post('/api/technet/live', async (req, res) => {
  try {
    const { user, pass, url } = req.body || {};
    const result = await fetchLiveHtmlWith(user, pass, url);
    // cache
    try {
      fs.writeFileSync(path.join(cacheDir, 'latest.html'), result.html, 'utf8');
      fs.writeFileSync(path.join(cacheDir, 'latest.json'), JSON.stringify(result.data, null, 2), 'utf8');
    } catch {}
    return res.json({ mode: 'live', ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// CSV export of parsed tables
app.get('/api/technet.csv', async (req, res) => {
  try {
    const resp = await (async () => {
      const forceLive = (req.query.mode || '').toLowerCase() === 'live';
      if (!forceLive) {
        const offline = tryOfflineCapture();
        if (offline) return { mode: 'offline', ...offline };
      }
      const live = await fetchLivePreferCreds(req);
      return { mode: 'live', ...live };
    })();
    const tables = resp.data?.tables || [];
    const toCsv = (rows) => rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
    let csv = '';
    tables.forEach((t, i) => {
      if (i) csv += '\n';
      if (t.headers?.length) csv += toCsv([t.headers]) + '\n';
      if (t.rows?.length) csv += toCsv(t.rows) + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="technet.csv"');
    return res.send(csv || '');
  } catch (err) {
    const code = err && err.code;
    const status = code === 'LOGIN_COOLDOWN' ? 429 : (code === 'LOGIN_FAILED' ? 401 : 500);
    res.status(status);
    return res.send('error: ' + err.message + (code ? ` (${code})` : ''));
  }
});

// Import routes from offline HTML into per-tech/date caches for a given date
app.post('/api/routes.importOffline', async (req, res) => {
  try {
    const dateIso = String(req.query.date || req.body?.date || '').trim();
    if (!dateIso || !/\d{4}-\d{2}-\d{2}/.test(dateIso)) {
      return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
    }
    const offline = tryOfflineCapture();
    if (!offline || !offline.html) return res.status(404).json({ error: 'offline HTML not found' });
    const routes = deriveRoutesFromHtml(offline.html);
    const filtered = Array.isArray(routes) ? routes.filter(r => String(r.date) === String(dateIso)) : [];
    if (!filtered.length) return res.status(404).json({ error: 'no routes found in offline HTML for date ' + dateIso });
    // Write per-tech/date caches
    let written = 0;
    for (const r of filtered) {
      const tech = String(r.techNo || '').trim();
      if (!tech) continue;
      const file = getTechDateCachePath(tech, dateIso);
      writeCachedRoutes(file, [r]);
      written++;
    }
    return res.json({ ok: true, date: dateIso, techs: written });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Pin a day's routes: copy per-tech date caches to a protected folder
const pinnedDir = path.join(cacheDir, 'pinned');
try { if (!fs.existsSync(pinnedDir)) fs.mkdirSync(pinnedDir, { recursive: true }); } catch {}

app.get('/api/routes.pinned', (req, res) => {
  try {
    const items = [];
    if (fs.existsSync(pinnedDir)) {
      for (const f of fs.readdirSync(pinnedDir)) {
        if (f.endsWith('.json')) {
          const full = path.join(pinnedDir, f);
          const stat = fs.statSync(full);
          items.push({ file: f, path: full, mtimeMs: stat.mtimeMs, size: stat.size });
        }
      }
    }
    return res.json({ dir: pinnedDir, items });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/routes.pinDay', async (req, res) => {
  try {
    const dateIso = String(req.query.date || req.body?.date || '').trim();
    if (!dateIso || !/\d{4}-\d{2}-\d{2}/.test(dateIso)) {
      return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
    }
    const liveRoot = path.join(cacheDir, 'live');
    if (!fs.existsSync(liveRoot)) return res.status(404).json({ error: 'no live cache root' });
    let copied = 0;
    for (const tech of fs.readdirSync(liveRoot)) {
      const src = path.join(liveRoot, tech, `${dateIso}.json`);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(pinnedDir, `${tech}-${dateIso}.json`);
      try {
        const buf = fs.readFileSync(src);
        fs.writeFileSync(dst, buf);
        copied++;
      } catch {}
    }
    if (!copied) return res.status(404).json({ error: 'no per-tech caches found for date ' + dateIso });
    return res.json({ ok: true, date: dateIso, copied });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// CSV export for route list
async function exportRoutesCsv(req, res) {
  try {
    // Defaults: aggregate all techs for today, stream CSV
    const forceLive = (req.query.mode || '').toLowerCase() === 'live';
    const paramTech = String(req.query.tech || '').trim().toLowerCase();
    const wantAll = paramTech !== '' ? paramTech === 'all' : true;
    const dateIso = String(req.query.date || '').trim() || new Date().toISOString().slice(0,10);
    const force = String(req.query.force || '') === '1';

    // Prepare response headers for streaming
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="routes-' + dateIso + (wantAll ? '-all' : '-' + (paramTech || '')) + '.csv"');

    // Helper: write a single CSV line
    const writeCsvRow = (arr) => {
      const line = arr.map(c => '"' + String(c ?? '').replace(/"/g, '""') + '"').join(',') + '\n';
      if (!res.write(line)) {
        // backpressure: wait for drain before continuing
        return new Promise(resolve => res.once('drain', resolve));
      }
      return Promise.resolve();
    };

    // Write header first (without normalizedStatus for export)
    await writeCsvRow(['date','techNo','time','job','type','status','tech','name','address','phone']);

    // Resolve payload routes
    let routes = [];
    if (wantAll) {
      routes = await fetchAllTechRoutes(dateIso, { force });
      // Strictly filter to requested date to avoid prior-day cache bleed
      routes = Array.isArray(routes) ? routes.filter(r => String(r.date) === String(dateIso)) : [];
      // Fallback: if empty, try offline capture
      if (!routes.length) {
        try {
          const offline = tryOfflineCapture();
          if (offline && offline.html) {
            const derived = deriveRoutesFromHtml(offline.html);
            const filtered = Array.isArray(derived) ? derived.filter(r => String(r.date) === String(dateIso)) : [];
            if (filtered.length) routes = filtered;
          }
        } catch {}
      }
    } else {
      // Single-tech: prefer cache helper
      const techId = String(req.query.tech || '').trim();
      if (techId) {
        const creds = resolveCredsFromTechs(techId) || {};
        const arr = await fetchTechRoutesWithCache(techId, creds.password || '', dateIso, { force });
        routes = Array.isArray(arr) ? arr : [];
      } else {
        // Fallback to live single-page parse
        const live = await fetchLivePreferCreds(req);
        routes = deriveRoutesFromHtml(live.html || '');
        routes = routes.filter(r => String(r.date) === dateIso);
        // Additional offline fallback if still empty
        if (!routes.length) {
          try {
            const offline = tryOfflineCapture();
            if (offline && offline.html) {
              const derived = deriveRoutesFromHtml(offline.html);
              const filtered = Array.isArray(derived) ? derived.filter(r => String(r.date) === String(dateIso)) : [];
              if (filtered.length) routes = filtered;
            }
          } catch {}
        }
      }
    }

    // Stream rows per stop without accumulating in memory
    // Optional: stable sort by tech then time
    try {
      routes.sort((a,b) => String(a.techNo).localeCompare(String(b.techNo)) || String(a.date).localeCompare(String(b.date)));
    } catch {}
    const normalizeStatus = (s) => {
      const v = String(s || '').trim().toLowerCase();
      if (!v) return '';
      if (/^not\s*done$/.test(v)) return 'not-done';
      if (/complete|completed\b/.test(v)) return 'completed';
      if (/pending|sched|scheduled|pending install|pending tc|pending cos|pending change/.test(v)) return 'pending';
      if (/cancel|cnx|canceled|cancelled/.test(v)) return 'cancelled';
      if (/unassign|unassigned/.test(v)) return 'unassigned';
      return v;
    };
    for (const route of routes) {
      for (const s of (route.stops || [])) {
        // eslint-disable-next-line no-await-in-loop
        await writeCsvRow([
          route.date || dateIso,
          route.techNo || '',
          s.time || '',
          s.job || '',
          s.type || '',
          s.status || '',
          s.tech || '',
          s.name || '',
          s.address || '',
          s.phone || ''
        ]);
      }
    }
    return res.end();
  } catch (err) {
    // If streaming fails mid-way, ensure proper error response
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/plain');
    }
    try { res.write('error: ' + err.message); } catch {}
    return res.end();
  }
}

// Register handlers for common path variants (defensive against double-slash URLs)
app.get('/api/routes.csv', exportRoutesCsv);
app.get('//api/routes.csv', exportRoutesCsv);

// Excel export: aggregate all techs stops into a single worksheet
app.get('/api/routes.xlsx', async (req, res) => {
  try {
    const dateIso = String(req.query.date || '').trim() || new Date().toISOString().slice(0,10);
    const force = String(req.query.force || '') === '1';
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Routes');
    sheet.columns = [
      { header: 'date', key: 'date', width: 12 },
      { header: 'techNo', key: 'techNo', width: 10 },
      { header: 'time', key: 'time', width: 10 },
      { header: 'job', key: 'job', width: 12 },
      { header: 'type', key: 'type', width: 8 },
      { header: 'status', key: 'status', width: 18 },
      { header: 'tech', key: 'tech', width: 10 },
      { header: 'name', key: 'name', width: 28 },
      { header: 'address', key: 'address', width: 40 },
      { header: 'phone', key: 'phone', width: 18 }
    ];
    // Fetch all tech routes and strictly filter to requested date
    let routes = await fetchAllTechRoutes(dateIso, { force });
    routes = Array.isArray(routes) ? routes.filter(r => String(r.date) === String(dateIso)) : [];
    // Fallback: if no routes found (e.g., past day closed or creds failing), try offline capture
    if (!routes.length) {
      try {
        const offline = tryOfflineCapture();
        if (offline && offline.html) {
          const derived = deriveRoutesFromHtml(offline.html);
          const filtered = Array.isArray(derived) ? derived.filter(r => String(r.date) === String(dateIso)) : [];
          if (filtered.length) routes = filtered;
        }
      } catch {}
    }
    try { routes.sort((a,b) => String(a.techNo).localeCompare(String(b.techNo)) || String(a.date).localeCompare(String(b.date))); } catch {}
    const normalizeStatus = (s) => {
      const v = String(s || '').trim().toLowerCase();
      if (!v) return '';
      if (/^not\s*done$/.test(v)) return 'not-done';
      if (/complete|completed\b/.test(v)) return 'completed';
      if (/pending|sched|scheduled|pending install|pending tc|pending cos|pending change/.test(v)) return 'pending';
      if (/cancel|cnx|canceled|cancelled/.test(v)) return 'cancelled';
      if (/unassign|unassigned/.test(v)) return 'unassigned';
      return v;
    };
    for (const route of routes) {
      for (const s of (route.stops || [])) {
        sheet.addRow({
          date: route.date || dateIso,
          techNo: route.techNo || '',
          time: s.time || '',
          job: s.job || '',
          type: s.type || '',
          status: s.status || '',
          tech: s.tech || '',
          name: s.name || '',
          address: s.address || '',
          phone: s.phone || ''
        });
      }
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="routes-${dateIso}-all.xlsx"`);
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err) {
    return res.status(500).send('error: ' + err.message);
  }
});

// Preview first N rows for a given date (JSON), mirroring Excel/CSV logic with offline fallback
app.get('/api/routes.sample', async (req, res) => {
  try {
    const dateIso = String(req.query.date || '').trim() || new Date().toISOString().slice(0,10);
    const force = String(req.query.force || '') === '1';
    const limit = Math.max(1, Math.min(50, parseInt(String(req.query.limit||'10'), 10) || 10));
    let routes = await fetchAllTechRoutes(dateIso, { force });
    routes = Array.isArray(routes) ? routes.filter(r => String(r.date) === String(dateIso)) : [];
    if (!routes.length) {
      try {
        const offline = tryOfflineCapture();
        if (offline && offline.html) {
          const derived = deriveRoutesFromHtml(offline.html);
          const filtered = Array.isArray(derived) ? derived.filter(r => String(r.date) === String(dateIso)) : [];
          if (filtered.length) routes = filtered;
        }
      } catch {}
    }
    const rows = [];
    for (const route of (routes||[])) {
      for (const s of (route.stops||[])) {
        rows.push({
          date: route.date || dateIso,
          techNo: route.techNo || '',
          time: s.time || '',
          job: s.job || '',
          type: s.type || '',
          status: s.status || '',
          tech: s.tech || '',
          name: s.name || '',
          address: s.address || '',
          phone: s.phone || ''
        });
        if (rows.length >= limit) break;
      }
      if (rows.length >= limit) break;
    }
    return res.json({ date: dateIso, count: rows.length, rows });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Derive a technicians array from parsed data tables
function deriveTechniciansFromData(data) {
  const result = [];
  const tables = data?.tables || [];
  for (const t of tables) {
    const headers = t.headers.map(h => h.toLowerCase());
    const idxName = headers.findIndex(h => h.includes('name'));
    const idxStatus = headers.findIndex(h => h.includes('status'));
    const idxTech = headers.findIndex(h => h.includes('tech'));
    const idxSkill = headers.findIndex(h => h.includes('skill'));
    const idxProvider = headers.findIndex(h => h.includes('provider'));
    const idxLast = headers.findIndex(h => h.includes('last'));
    if (t.rows && t.rows.length) {
      for (const r of t.rows) {
        result.push({
          name: idxName >= 0 ? r[idxName] : undefined,
          status: idxStatus >= 0 ? r[idxStatus] : undefined,
          techNo: idxTech >= 0 ? r[idxTech] : undefined,
          workSkill: idxSkill >= 0 ? r[idxSkill] : undefined,
          provider: idxProvider >= 0 ? r[idxProvider] : undefined,
          lastActivity: idxLast >= 0 ? r[idxLast] : undefined
        });
      }
    }
  }
  return result.filter(x => x.name || x.techNo);
}

// Enrichment helper: geocode missing stops in parallel and normalize statuses
async function enrichRoutes(routes, opts = {}) {
  try {
    // Compute centroid of known points to bias geocoding proximity
    let sumLat = 0, sumLng = 0, countPts = 0;
    routes.forEach(r => (r.stops||[]).forEach(s => {
      const p = s.point || s.location;
      if (p && typeof p.lat === 'number' && typeof p.lng === 'number') { sumLat += p.lat; sumLng += p.lng; countPts++; }
    }));
    const proxLat = countPts ? (sumLat / countPts) : GEO_PROX_LAT;
    const proxLng = countPts ? (sumLng / countPts) : GEO_PROX_LNG;
    // Collect tasks for geocoding to run in parallel with a sensible concurrency limit
    const geocodeConc = Math.max(1, parseInt(process.env.GEOCODE_CONC || '8', 10));
    const geoTasks = [];
    for (const r of routes) {
      for (const s of (r.stops || [])) {
        const p = s.point || s.location;
        if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') geoTasks.push({ route: r, stop: s });
      }
    }
    if (geoTasks.length) {
      console.log(`[enrichRoutes] geocoding ${geoTasks.length} stops with concurrency=${geocodeConc}`);
      await parallelMap(geoTasks, geocodeConc, async (task) => {
        const s = task.stop;
        try {
          const g = await geocodeAddress(s.address || s.name || '', { proxLat, proxLng, state: s.state, city: s.city, zip: s.zip, jobId: s.job });
          if (g) s.point = g;
        } catch (e) {}
      });
    }
    // After geocoding pass, normalize statuses for all stops
    for (const r of routes) {
      for (const s of (r.stops || [])) {
        const raw = String(s.status || s.badge || '').trim().toLowerCase();
        const hints = [String(s.staticStatus||'').toLowerCase(), String(s.description||'').toLowerCase(), String(s.jobComment||'').toLowerCase(), String(s.timeFrame||'').toLowerCase(), String(s.dispatchComment||'').toLowerCase(), String(s.staticCompletionTime||'').toLowerCase()];
        const text = [raw].concat(hints).join(' ');
        const hasCpTime = !!s.staticCompletionTime || /\bcp\s*time\b/.test(text) || /\bcomplete(d)?\b/.test(text);
        const isCancelled = /\bcancel(l|ed|led)?\b|\bcnx\b/.test(text);
        const isNotDone = /\bnot\s*done\b/.test(text);
        const hasDispatchActivity = Boolean(s.dispatchComment) || /dispatch\s*(started|begin|en\s*route|on\s*route|arriv(ed|ing)|working)/.test(text);
        const hasISPrefix = Boolean(s.hasIS) || /\[\s*IS\s*:/i.test(text);
        const hasStartWords = /\b(in\s*progress|started|begin|working|on\s*route|en\s*route)\b/.test(text);
        const isAssigned = /\bassign(ed)?\b/.test(text);
        const isPendingWords = /\bpending\b|\bsched(uled)?\b|awaiting\s*start|not\s*started/.test(text);
        const withinTimeWindow = (() => {
          const tf = String(s.timeFrame||'').trim();
          const m = tf.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
          if (!m) return false;
          const now = new Date();
          const [ , start, end ] = m;
          const toDate = (hhmm) => { const [h, min] = hhmm.split(':').map(Number); const d = new Date(now); d.setHours(h, min, 0, 0); return d; };
          const sD = toDate(start); const eD = toDate(end); return now >= sD && now <= eD;
        })();
        let norm = '';
        if (isNotDone) norm = 'not-done';
        else if (isCancelled) norm = 'cancelled';
        else if (hasCpTime) norm = 'completed';
        else if (hasISPrefix || hasDispatchActivity || hasStartWords || isAssigned || withinTimeWindow) norm = 'in-progress';
        else if (isPendingWords) norm = 'pending';
        else norm = raw || '';
        s.normalizedStatus = norm;
        if (norm === 'in-progress') { s.badge = 'In Progress'; s.status = 'In Progress'; }
      }
    }
  } catch (e) {
    console.error('[enrichRoutes] error', e && (e.message||e));
  }
}

// Simple summary derivation from tables (best-effort)
function deriveSummaryFromData(data) {
  const summary = { TC: { total: 0, pending: 0, done: 0, cancelled: 0 }, IN: { total: 0, pending: 0, done: 0, cancelled: 0 }, COS: { total: 0, pending: 0, done: 0, cancelled: 0 }, RST: { total: 0, pending: 0, done: 0, cancelled: 0 }, SUMMARY: { total: 0, pending: 0, done: 0, cancelled: 0 } };
  const tables = data?.tables || [];
  for (const t of tables) {
    for (const r of t.rows || []) {
      const line = r.join(' ').toLowerCase();
      const types = ['tc','in','cos','rst'];
      for (const type of types) {
        if (line.includes(type)) {
          summary[type.toUpperCase()].total++;
          summary.SUMMARY.total++;
          if (line.includes('pending')) { summary[type.toUpperCase()].pending++; summary.SUMMARY.pending++; }
          if (line.includes('complete') || line.includes('done')) { summary[type.toUpperCase()].done++; summary.SUMMARY.done++; }
          if (line.includes('cancel')) { summary[type.toUpperCase()].cancelled++; summary.SUMMARY.cancelled++; }
        }
      }
    }
  }
  return summary;
}

// Dashboard route: returns technicians array, title, summary, routes
app.get('/api/dashboard', async (req, res) => {
  try {
    const forceLive = true; // always fetch live when needed
    const wantAll = true; // always aggregate all techs
    const dateIso = String(req.query.date || '').trim() || new Date().toISOString().slice(0,10);
    const force = String(req.query.force || '') === '1';

    // If we have a stored aggregated file, return it quickly and start background enrichment
    try {
      const aggPath = path.join(dataDir, `stops-${dateIso}.json`);
      if (fs.existsSync(aggPath)) {
        const txt = fs.readFileSync(aggPath, 'utf8');
        try {
          const obj = JSON.parse(txt || '{}');
          if (Array.isArray(obj.routes) && obj.routes.length) {
            // Kick off background enrichment (non-blocking)
            (async () => {
              try {
                console.log(`[dashboard] background enrich start date=${dateIso}`);
                const refreshed = await fetchAllTechRoutes(dateIso, { force: true });
                await enrichRoutes(refreshed, {});
                try { persistAggregatedRoutes(dateIso, refreshed); } catch (e) {}
                console.log(`[dashboard] background enrich done date=${dateIso}`);
              } catch (e) { console.error('[dashboard] background enrich error', e && (e.message||e)); }
            })();
            // Return the stored aggregated data immediately
            const techJson = getAllTechsFromJson();
            const technicians = techJson.map(t => ({
              name: t.name || `Tech ${t.tech}`,
              status: t.status || 'Off Duty',
              techNo: String(t.tech),
              workSkill: t.workSkill || 'FTTH, COAX',
              provider: t.provider || 'Altice/Optimum',
              lastActivity: t.lastActivity || 'N/A',
              hasCredentials: !!(t.password || t.pass || ''),
              authError: !!authErrorMap[String(t.tech)],
              authMessage: authErrorMap[String(t.tech)] || undefined
            }));
            return res.json({ mode: 'cached', title: 'All Techs', technicians, summary: {}, routes: obj.routes, raw: {} });
          }
        } catch (e) { /* fallthrough to live */ }
      }
    } catch (e) {}

    let payload;
    if (!payload) {
      const routes = await fetchAllTechRoutes(dateIso, { force });
      await enrichRoutes(routes, { req });
      const techJson = getAllTechsFromJson();
      const technicians = techJson.map(t => ({
        name: t.name || `Tech ${t.tech}`,
        status: t.status || 'Off Duty',
        techNo: String(t.tech),
        workSkill: t.workSkill || 'FTTH, COAX',
        provider: t.provider || 'Altice/Optimum',
        lastActivity: t.lastActivity || 'N/A',
        hasCredentials: !!(t.password || t.pass || ''),
        authError: !!authErrorMap[String(t.tech)],
        authMessage: authErrorMap[String(t.tech)] || undefined
      }));
      payload = { mode: 'live', title: 'All Techs', technicians, summary: {}, routes, raw: {} };
    }
    // If still no technicians, attempt sample fallback
    if (!payload.technicians || payload.technicians.length === 0) {
      try {
        const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-technicians.json'), 'utf8'));
        payload.technicians = sample;
      } catch {}
    }
    // If summary/routes empty, fallback to sample dashboard
    if (!payload.summary || Object.values(payload.summary.SUMMARY || {}).every(v => v === 0)) {
      try {
        const sampleDash = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-dashboard.json'), 'utf8'));
        if (!payload.summary) payload.summary = sampleDash.summary;
        if (!payload.routes || payload.routes.length === 0) payload.routes = sampleDash.routes;
      } catch {}
    }
    return res.json(payload);
  } catch (err) {
    const code = err && err.code;
    const status = code === 'LOGIN_COOLDOWN' ? 429 : (code === 'LOGIN_FAILED' ? 401 : 500);
    return res.status(status).json({ error: err.message, code });
  }
});

// Server-side geocode helper endpoint
app.get('/api/geocode', async (req, res) => {
  try {
    const address = String(req.query.address || '').trim();
    if (!address) return res.status(400).json({ error: 'address is required' });
    const context = { city: req.query.city, state: req.query.state, zip: req.query.zip, jobId: req.query.jobId };
    const point = await geocodeAddress(address, context);
    if (!point) return res.status(404).json({ error: 'not found' });
    return res.json({ address, point });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
// Persist manual geocode overrides
app.post('/api/geocode/override', async (req, res) => {
  try {
    const { jobId, address, lat, lng } = req.body || {};
    const point = { lat: Number(lat), lng: Number(lng), provider: 'override', quality: 'rooftop', confidence: 1.0 };
    if (!address && !jobId) return res.status(400).json({ error: 'address or jobId is required' });
    const ov = readGeocodeOverrides();
    if (jobId) ov.jobs[String(jobId)] = point;
    if (address) ov.addresses[String(address).toLowerCase()] = point;
    writeGeocodeOverrides(ov);
    return res.json({ ok: true, saved: point });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
// Scheduled hourly refresh: fetch all tech routes for today and persist
async function scheduledRefresh() {
  try {
    const today = new Date().toISOString().slice(0,10);
    await fetchAllTechRoutes(today);
    console.log(`[scheduler] Refreshed routes for ${today}`);
  } catch (e) {
    console.error('[scheduler] Refresh error:', e.message || e);
  }
}
// Start immediately, then hourly
scheduledRefresh();
setInterval(scheduledRefresh, 60 * 60 * 1000);

// Manual refresh: trigger fetch and persist for a given date (YYYY-MM-DD)
app.post('/api/refresh', async (req, res) => {
  try {
    const dateIso = String((req.body && req.body.date) || req.query.date || '').trim() || new Date().toISOString().slice(0,10);
    await fetchAllTechRoutes(dateIso);
    return res.json({ ok: true, date: dateIso });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Debug: inspect credential resolution
app.get('/api/debug/creds', (req, res) => {
  try {
    const tech = req.query.tech || '4682';
    const pathUsed = getTechsJsonPath();
    const creds = resolveCredsFromTechs(tech);
    return res.json({ tech, pathUsed, creds, envUser: process.env.TECHNET_USER || process.env.TECHNET_USERNAME, envPass: process.env.TECHNET_PASS || process.env.TECHNET_PASSWORD, TECHNET_URL });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Cache inspection: GET returns freshness; DELETE invalidates cache for tech+date
app.get('/api/cache/routes', requireAdmin, (req, res) => {
  try {
    const tech = String(req.query.tech || '').trim();
    const dateIso = String(req.query.date || '').trim();
    if (!tech) return res.status(400).json({ error: 'tech is required' });
    const file = getTechDateCachePath(tech, dateIso || 'latest');
    const exists = fs.existsSync(file);
    let ageMs = null;
    const fresh = exists && isFreshCache(file);
    if (exists) {
      const stat = fs.statSync(file);
      ageMs = Date.now() - stat.mtimeMs;
    }
    const routes = exists ? readCachedRoutes(file) : [];
    return res.json({ tech, date: dateIso || 'latest', path: file, exists, fresh, ageMs, ttlMs: CACHE_TTL_MS, count: routes.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
app.delete('/api/cache/routes', requireAdmin, (req, res) => {
  try {
    const tech = String(req.query.tech || '').trim();
    const dateIso = String(req.query.date || '').trim();
    if (!tech) return res.status(400).json({ error: 'tech is required' });
    const file = getTechDateCachePath(tech, dateIso || 'latest');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return res.json({ ok: true, path: file });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Cache list: enumerate cached tech/date files
app.get('/api/cache/routes/list', requireAdmin, (req, res) => {
  try {
    const base = path.join(cacheDir, 'live');
    const result = [];
    if (fs.existsSync(base)) {
      const techDirs = fs.readdirSync(base);
      techDirs.forEach(t => {
        const dir = path.join(base, t);
        if (fs.statSync(dir).isDirectory()) {
          const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
          files.forEach(f => {
            const full = path.join(dir, f);
            const stat = fs.statSync(full);
            let routes = [];
            try { routes = JSON.parse(fs.readFileSync(full, 'utf8')); } catch {}
            const stops = Array.isArray(routes) ? routes.reduce((n, r) => n + ((r && Array.isArray(r.stops)) ? r.stops.length : 0), 0) : 0;
            result.push({ tech: t, path: full, date: f.replace(/\.json$/, ''), mtimeMs: stat.mtimeMs, size: stat.size, routesCount: Array.isArray(routes) ? routes.length : 0, stopsCount: stops });
          });
        }
      });
    }
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Health check for deployment
app.get('/api/health', (req, res) => {
  try {
    return res.json({ ok: true, uptime: process.uptime(), time: new Date().toISOString(), headless: HEADLESS, slowMo: SLOWMO });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Simple in-memory store for profiles, schedules, notes
const store = {
  profile: new Map(), // key: techNo -> { name, status, provider, workSkill, lastActivity, email }
  schedule: new Map(), // key: techNo -> { days: [1..31], lastSaved }
  notes: new Map() // key: techNo -> [ { text, ts } ]
};

function ensureTechRecord(techNo) {
  const key = String(techNo);
  if (!store.profile.has(key)) store.profile.set(key, { name: `Tech ${key}`, status: 'Off Duty', provider: 'Altice/Optimum', workSkill: 'FTTH, COAX', lastActivity: 'N/A', email: '' });
  if (!store.schedule.has(key)) store.schedule.set(key, { days: [], lastSaved: null });
  if (!store.notes.has(key)) store.notes.set(key, []);
}

// Profile endpoints
app.get('/api/tech/:id/profile', (req, res) => {
  try {
    const id = req.params.id;
    ensureTechRecord(id);
    return res.json(store.profile.get(String(id)));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
app.post('/api/tech/:id/profile', (req, res) => {
  try {
    const id = req.params.id;
    ensureTechRecord(id);
    const cur = store.profile.get(String(id));
    const next = { ...cur, ...req.body };
    store.profile.set(String(id), next);
    return res.json({ ok: true, profile: next });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Schedule endpoints
app.get('/api/tech/:id/schedule', (req, res) => {
  try {
    const id = req.params.id;
    ensureTechRecord(id);
    return res.json(store.schedule.get(String(id)));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
app.post('/api/tech/:id/schedule', (req, res) => {
  try {
    const id = req.params.id;
    ensureTechRecord(id);
    const { days } = req.body || {};
    const normalized = Array.isArray(days) ? days.map(n => parseInt(n, 10)).filter(n => !isNaN(n)) : [];
    store.schedule.set(String(id), { days: normalized, lastSaved: new Date().toISOString() });
    return res.json({ ok: true, schedule: store.schedule.get(String(id)) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Notes endpoints
app.get('/api/tech/:id/notes', (req, res) => {
  try {
    const id = req.params.id;
    ensureTechRecord(id);
    return res.json(store.notes.get(String(id)));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
app.post('/api/tech/:id/notes', (req, res) => {
  try {
    const id = req.params.id;
    ensureTechRecord(id);
    const { text } = req.body || {};
    const note = { text: String(text || ''), ts: new Date().toISOString() };
    const arr = store.notes.get(String(id));
    arr.push(note);
    return res.json({ ok: true, notes: arr });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Last activity via live Technet scrape for a specific tech
// Returns { tech, lastActivity, source }
app.get('/api/tech/:id/activity', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'tech id is required' });
    // Resolve credentials from techs.json or env
    let creds;
    try { creds = resolveCredsFromTechs(id); } catch {}
    if (!creds || !creds.user || !creds.pass) {
      // Fallback to env if direct resolution fails
      const envUser = process.env.TECHNET_USER || process.env.TECHNET_USERNAME;
      const envPass = process.env.TECHNET_PASS || process.env.TECHNET_PASSWORD;
      if (!envUser || !envPass) return res.status(400).json({ error: 'Missing credentials for tech ' + id });
      creds = { user: envUser, pass: envPass };
    }

    // Fetch live HTML for this tech; parse tables and find last activity
    const result = await fetchLiveHtmlWith(creds.user, creds.pass, TECHNET_URL);
    const data = result && result.data ? result.data : {};
    const tables = Array.isArray(data.tables) ? data.tables : [];
    let lastActivity = null;
    for (const t of tables) {
      const headers = (t.headers || []).map(h => String(h).toLowerCase());
      const idxTech = headers.findIndex(h => h.includes('tech'));
      const idxLast = headers.findIndex(h => h.includes('last'));
      if (idxLast < 0) continue;
      for (const r of t.rows || []) {
        const techVal = idxTech >= 0 ? String(r[idxTech] || '').trim() : '';
        if (!techVal || (techVal !== id && techVal !== String(parseInt(id, 10)))) continue;
        const val = r[idxLast];
        if (val && String(val).trim()) {
          lastActivity = String(val).trim();
          break;
        }
      }
      if (lastActivity) break;
    }

    // Fallback: try derive from first stop time in cached/latest route
    if (!lastActivity) {
      try {
        const latestPath = getTechDateCachePath(id, 'latest');
        const cached = readCachedRoutes(latestPath);
        if (Array.isArray(cached) && cached.length) {
          const firstRoute = cached[0];
          const firstStop = (firstRoute.stops || [])[0];
          if (firstStop && firstStop.time) lastActivity = firstStop.time;
        }
      } catch {}
    }

    return res.json({ tech: id, lastActivity: lastActivity || 'N/A', source: lastActivity ? 'technet' : 'fallback' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Job details: fetch and parse fields for a specific job number
app.get('/api/job/:jobId', async (req, res) => {
  try {
    const rawJob = String(req.params.jobId || '').trim();
    const jobId = (rawJob.match(/\d{6,}/) || [rawJob])[0];
    if (!jobId) return res.status(400).json({ error: 'jobId is required' });
    const techParam = String(req.query.tech || '').trim();
    console.log(`[job] req jobId=${jobId} tech=${techParam}`);
    // Attempt offline cache first
    let dataObj = null;
    try {
      const latestJson = path.join(cacheDir, 'latest.json');
      if (fs.existsSync(latestJson)) {
        dataObj = JSON.parse(fs.readFileSync(latestJson, 'utf8'));
      }
    } catch {}
    // If not available, do a live fetch using per-tech creds when provided, else global env creds
    if (!dataObj) {
      let user = '';
      let pass = '';
      if (techParam) {
        const creds = resolveCredsFromTechs(techParam);
        if (!creds || !creds.user || !creds.pass) {
          return res.status(400).json({ error: `Missing credentials for tech ${techParam}` });
        }
        user = creds.user; pass = creds.pass;
      } else {
        user = process.env.TECHNET_USER || process.env.TECHNET_USERNAME || '';
        pass = process.env.TECHNET_PASS || process.env.TECHNET_PASSWORD || '';
        if (!user || !pass) {
          return res.status(400).json({ error: 'Missing TECHNET credentials: provide ?tech=<id> or set global env TECHNET_USER/TECHNET_PASS' });
        }
      }
      console.log(`[job] live fetch (job detail) with user=${user ? '***' : ''} pass=${pass ? '***' : ''}`);
      const live = await fetchJobDetailHtmlWith(user, pass, jobId, TECHNET_URL);
      dataObj = live.data;
      console.log(`[job] live html length=${(live.html||'').length} tables=${Array.isArray(dataObj?.tables)?dataObj.tables.length:0} fields=${Array.isArray(dataObj?.fields)?dataObj.fields.length:0}`);
      try { fs.writeFileSync(path.join(cacheDir, 'latest.json'), JSON.stringify(dataObj, null, 2), 'utf8'); } catch {}
    }
    // Offline HTML fallback: parse local snapshot files when structured data is missing
    if (!dataObj || (!dataObj.tables && !dataObj.fields)) {
      const candidates = [
        path.join(__dirname, 'page_snapshot.html'),
        path.join(__dirname, '_responses', 'dashboard.html'),
        path.join(__dirname, '_responses', 'index.html'),
      ];
      for (const f of candidates) {
        if (fs.existsSync(f)) {
          try {
            const html = fs.readFileSync(f, 'utf8');
            dataObj = Object.assign({}, dataObj || {}, { html });
            console.log(`[job] offline html from ${path.basename(f)} length=${html.length}`);
            break;
          } catch {}
        }
      }
    }

    const tables = Array.isArray(dataObj?.tables) ? dataObj.tables : [];
    const fields = Array.isArray(dataObj?.fields) ? dataObj.fields : [];
    const result = { job: jobId };
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const isLabel = (label, patterns) => {
      const L = norm(label).replace(/:$/, '');
      return patterns.some(p => {
        if (typeof p === 'string') return L === norm(p);
        if (p instanceof RegExp) return p.test(L);
        return false;
      });
    };
    const setIfEmpty = (obj, key, val) => { if (val && obj[key] == null) obj[key] = val; };
    // Scan tables for a row containing the job number and map nearby headers
    for (const t of tables) {
      const headers = (t.headers || []).map(h => String(h).trim());
      for (const r of t.rows || []) {
        if (r.some(cell => String(cell).includes(jobId))) {
          headers.forEach((h, idx) => {
            const key = norm(h);
            const val = String(r[idx] ?? '').trim();
            if (!val) return;
            if (isLabel(key, [/^job\s*type$/])) setIfEmpty(result, 'jobType', val);
            if (isLabel(key, [/^status$/])) setIfEmpty(result, 'staticStatus', val);
            if (isLabel(key, [/^completion\s*time$/, /^cp\s*time$/, /^cptime$/])) setIfEmpty(result, 'staticCompletionTime', val);
            if (isLabel(key, [/^account(\s*#|\s*number)?$/])) setIfEmpty(result, 'accountNumber', val);
            if (isLabel(key, [/^units$/])) setIfEmpty(result, 'units', val);
            if (isLabel(key, [/^priority$/])) setIfEmpty(result, 'priority', val);
            if (isLabel(key, [/^schd$/, /^schedule(\s*date)?$/])) setIfEmpty(result, 'scheduleDate', val);
            if (isLabel(key, [/^origin$/])) setIfEmpty(result, 'origin', val);
            if (isLabel(key, [/^resolution(\s*codes?)?$/])) setIfEmpty(result, 'resolutionCodes', val);
            if (isLabel(key, [/^phone(\s*#)?$/])) setIfEmpty(result, 'phone', val);
            if (isLabel(key, [/^(customer\s*)?name$/])) setIfEmpty(result, 'name', val);
            if (isLabel(key, [/^address$/])) setIfEmpty(result, 'address', val);
            if (isLabel(key, [/^addr2$/])) setIfEmpty(result, 'address2', val);
            if (isLabel(key, [/^city$/])) setIfEmpty(result, 'city', val);
          });
        }
      }
    }
    // Augment with labeled fields and normalize to requested keys
    fields.forEach(f => {
      const labelRaw = String(f.label || '');
      const label = norm(labelRaw);
      const val = String(f.value ?? '').trim();
      if (!val) return;
      if (isLabel(label, [/^priority$/])) result.priority = val;
      if (isLabel(label, [/^create$/])) result.create = val;
      if (isLabel(label, [/^schd$/, /^schedule(\s*date)?$/])) result.scheduleDate = val;
      if (isLabel(label, [/^completion\s*time$/, /^cp\s*time$/, /^cptime$/])) result.staticCompletionTime = val;
      if (isLabel(label, [/^ds$/, /^status$/])) result.staticStatus = val;
      if (isLabel(label, [/^ts$/, /^time\s*frame$/])) result.timeFrame = val;
      if (isLabel(label, [/^type$/, /^job\s*type$/])) result.jobType = val;
      if (isLabel(label, [/^units$/])) result.units = val;
      if (isLabel(label, [/^reacd$/, /^rea\s*cd$/, /^readesc$/, /^rea\s*desc$/, /^reason$/])) result.reason = val;
      if (isLabel(label, [/^rescd$/])) result.resolutionCodes = val;
      if (isLabel(label, [/^fc$/])) result.accountNumber = val;
      if (isLabel(label, [/^tech$/])) result.assignedTech = val;
      if (isLabel(label, [/^addr$/, /^address$/])) setIfEmpty(result, 'address', val);
      if (isLabel(label, [/^addr2$/, /^address\s*2$/])) setIfEmpty(result, 'address2', val);
      if (isLabel(label, [/^city$/])) result.city = val;
      if (isLabel(label, [/^name$/, /^(customer\s*)?name$/])) setIfEmpty(result, 'name', val);
      if (isLabel(label, [/^home(\s*#)?$/])) result.homePhone = val;
      if (isLabel(label, [/^work(\s*#)?$/])) result.workPhone = val;
      if (isLabel(label, [/^map\s*cd$/, /^map$/])) result.mapCd = val;
      if (isLabel(label, [/^job\s*cmt$/, /^job\s*comment$/])) result.jobComment = val;
      if (isLabel(label, [/^node$/])) result.node = val;
      if (isLabel(label, [/^delq$/])) result.delq = val;
      if (isLabel(label, [/^dispatch\s*cmt$/])) result.dispatchComment = val;
      if (isLabel(label, [/^receipt\s*cmt$/])) result.receiptComment = val;
      if (isLabel(label, [/^fsm\s*cmt$/])) result.fsmComment = val;
      if (isLabel(label, [/^account(\s*#|\s*number)?$/])) result.accountNumber = val;
      if (isLabel(label, [/^resolution(\s*codes?)?$/])) result.resolutionCodes = val;
      if (isLabel(label, [/^phone(\s*#)?$/])) setIfEmpty(result, 'phone', val);
      if (isLabel(label, [/^origin$/])) result.origin = val;
    });

    // Fallback: scan tables for label/value rows (first column is label)
    for (const t of tables) {
      const headers = (t.headers || []).map(h => norm(h));
      const isTwoCol = headers.length === 2 || (t.rows && t.rows[0] && t.rows[0].length === 2);
      if (!isTwoCol) continue;
      for (const r of t.rows || []) {
        if (!Array.isArray(r) || r.length < 2) continue;
        const label = norm(r[0]).replace(/:$/, '');
        const val = String(r[1] ?? '').trim();
        if (!val) continue;
        if (isLabel(label, [/^job\s*id$/])) setIfEmpty(result, 'job', val);
        if (isLabel(label, [/^tech$/])) setIfEmpty(result, 'assignedTech', val);
        if (isLabel(label, [/^rescd$/])) setIfEmpty(result, 'resolutionCodes', val);
        if (isLabel(label, [/^fc$/])) setIfEmpty(result, 'accountNumber', val);
        if (isLabel(label, [/^create$/])) setIfEmpty(result, 'create', val);
        if (isLabel(label, [/^schd$/])) setIfEmpty(result, 'scheduleDate', val);
        if (isLabel(label, [/^cptime$/])) setIfEmpty(result, 'staticCompletionTime', val);
        if (isLabel(label, [/^ds$/])) setIfEmpty(result, 'staticStatus', val);
        if (isLabel(label, [/^ts$/])) setIfEmpty(result, 'timeFrame', val);
        if (isLabel(label, [/^type$/])) setIfEmpty(result, 'jobType', val);
        if (isLabel(label, [/^units$/])) setIfEmpty(result, 'units', val);
        if (isLabel(label, [/^reacd\/?readesc$/])) setIfEmpty(result, 'reason', val);
        if (isLabel(label, [/^addr$/])) setIfEmpty(result, 'address', val);
        if (isLabel(label, [/^addr2$/])) setIfEmpty(result, 'address2', val);
        if (isLabel(label, [/^city$/])) setIfEmpty(result, 'city', val);
        if (isLabel(label, [/^name$/])) setIfEmpty(result, 'name', val);
        if (isLabel(label, [/^home(\s*#)?$/])) setIfEmpty(result, 'homePhone', val);
        if (isLabel(label, [/^work(\s*#)?$/])) setIfEmpty(result, 'workPhone', val);
        if (isLabel(label, [/^map\s*cd$/])) setIfEmpty(result, 'mapCd', val);
        if (isLabel(label, [/^job\s*cmt$/])) setIfEmpty(result, 'jobComment', val);
        if (isLabel(label, [/^node$/])) setIfEmpty(result, 'node', val);
        if (isLabel(label, [/^delq$/])) setIfEmpty(result, 'delq', val);
        if (isLabel(label, [/^dispatch\s*cmt$/])) setIfEmpty(result, 'dispatchComment', val);
        if (isLabel(label, [/^receipt\s*cmt$/])) setIfEmpty(result, 'receiptComment', val);
        if (isLabel(label, [/^fsm\s*cmt$/])) setIfEmpty(result, 'fsmComment', val);
      }
    }

    // Final fallback: parse raw HTML/text blocks for labeled lines
    try {
      const html = String(dataObj?.html || '');
      const pick = (re) => {
        const m = html.match(re);
        let v = m ? String(m[1]).trim() : '';
        v = v.replace(/^"|"$/g, '').trim();
        return v;
      };
      // Extract values for all known labels
      const job = pick(/Job\s*ID:\s*([^\n<"]+)/i);
      const tech = pick(/Tech:\s*(\d{3,})/i);
      const rescd = pick(/ResCd:\s*([^\n<"]*)/i);
      const fc = pick(/FC:\s*([^\n<"]*)/i);
      const create = pick(/Create:\s*([^\n<"]+)/i);
      const schd = pick(/Schd:\s*([^\n<"]+)/i);
      const cptime = pick(/CpTime:\s*([^\n<"]+)/i);
      const ds = pick(/DS:\s*([^\n<"]+)/i);
      const ts = pick(/TS:\s*([^\n<"]]+)/i);
      const type = pick(/Type:\s*([^\n<"]]+)/i);
      const units = pick(/Units:\s*([^\n<"]]+)/i);
      const reason = pick(/ReaCd\/?\s*ReaDesc:\s*([^\n<"]]+)/i);
      const addr = pick(/Addr:\s*([^\n<"]]+)/i);
      const addr2 = pick(/Addr2:\s*([^\n<"]]+)/i);
      const city = pick(/City:\s*([^\n<"]]+)/i);
      const name = pick(/Name:\s*([^\n<"]]+)/i);
      const home = pick(/Home\s*#:\s*([^\n<"]]+)/i);
      const work = pick(/Work\s*#:\s*([^\n<"]]+)/i);
      const mapCd = pick(/Map\s*CD:\s*([^\n<"]]+)/i);
      const jobCmt = pick(/Job\s*Cmt:\s*([^\n<"]]+)/i);
      const node = pick(/Node:\s*([^\n<"]]+)/i);
      const delq = pick(/Delq:\s*([^\n<"]]*)/i);
      const dispatchCmt = pick(/Dispatch\s*Cmt:\s*([^\n<"]]+)/i);
      const receiptCmt = pick(/Receipt\s*Cmt:\s*([^\n<"]]*)/i);
      const fsmCmt = pick(/FSM\s*Cmt:\s*([^\n<"]]*)/i);
      if (job) result.job = job;
      if (dispatchCmt) result.dispatchComment = dispatchCmt;
      if (receiptCmt) result.receiptComment = receiptCmt;
      if (fsmCmt) result.fsmComment = fsmCmt;
      if (mapCd) setIfEmpty(result, 'mapCd', mapCd);
      if (node) setIfEmpty(result, 'node', node);
      if (tech) setIfEmpty(result, 'assignedTech', tech);
      if (fc) setIfEmpty(result, 'accountNumber', fc);
      if (rescd) setIfEmpty(result, 'resolutionCodes', rescd);
      if (create) setIfEmpty(result, 'create', create);
      if (schd) setIfEmpty(result, 'scheduleDate', schd);
      if (cptime) setIfEmpty(result, 'staticCompletionTime', cptime);
      if (ds) setIfEmpty(result, 'staticStatus', ds);
      if (ts) setIfEmpty(result, 'timeFrame', ts);
      if (type) setIfEmpty(result, 'jobType', type);
      if (units) setIfEmpty(result, 'units', units);
      if (reason) setIfEmpty(result, 'reason', reason);
      if (addr) setIfEmpty(result, 'address', addr);
      if (addr2) setIfEmpty(result, 'address2', addr2);
      if (city) setIfEmpty(result, 'city', city);
      if (name) setIfEmpty(result, 'name', name);
      if (home) setIfEmpty(result, 'homePhone', home);
      if (work) setIfEmpty(result, 'workPhone', work);
    } catch {}

    // DOM-based fallback: parse <b>Label:</b> value patterns common in CSG Technet
    try {
      const html = String(dataObj?.html || '');
      if (html) {
        const $ = cheerio.load(html);
        const mapLabel = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const getValueAfterBold = (bElem) => {
          let val = '';
          const node = bElem.get(0);
          if (!node) return val;
          // Traverse siblings to gather text until next <b> or <br>
          let curr = node.nextSibling;
          while (curr) {
            const name = curr.name || curr.type;
            if (name === 'b' || name === 'tag' && curr.name === 'b') break;
            if (curr.type === 'text') val += curr.data || '';
            if (curr.name === 'br') break;
            if (curr.children && curr.children.length) {
              val += $(curr).text();
            }
            curr = curr.nextSibling;
          }
          return val.replace(/[\n]+/g, '').replace(/^"|"$/g, '').trim();
        };
        $('b').each((_, el) => {
          const label = mapLabel($(el).text()).replace(/:$/, '');
          const val = getValueAfterBold($(el));
          if (!val) return;
          const L = label.toLowerCase();
          const set = (k) => setIfEmpty(result, k, val);
          if (L === 'job id') set('job');
          else if (L === 'tech') set('assignedTech');
          else if (L === 'rescd') set('resolutionCodes');
          else if (L === 'fc') set('accountNumber');
          else if (L === 'create') set('create');
          else if (L === 'schd') set('scheduleDate');
          else if (L === 'cptime') set('staticCompletionTime');
          else if (L === 'ds') set('staticStatus');
          else if (L === 'ts') set('timeFrame');
          else if (L === 'type') set('jobType');
          else if (L === 'units') set('units');
          else if (L === 'reacd/readesc' || L === 'reacd/ readesc') set('reason');
          else if (L === 'addr') set('address');
          else if (L === 'addr2') set('address2');
          else if (L === 'city') set('city');
          else if (L === 'name') set('name');
          else if (L === 'home #') set('homePhone');
          else if (L === 'work #') set('workPhone');
          else if (L === 'map cd') set('mapCd');
          else if (L === 'job cmt') set('jobComment');
          else if (L === 'node') set('node');
          else if (L === 'delq') set('delq');
          else if (L === 'dispatch cmt') set('dispatchComment');
          else if (L === 'receipt cmt') set('receiptComment');
          else if (L === 'fsm cmt') set('fsmComment');
        });
        console.log(`[job] parsed keys: ${Object.keys(result).filter(k=>k!=='job').join(', ')}`);
      }
    } catch {}

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Debug: Inspect parsed job details with metadata
app.get('/api/job/debug/:jobId', async (req, res) => {
  try {
    const rawJob = String(req.params.jobId || '').trim();
    const jobId = (rawJob.match(/\d{6,}/) || [rawJob])[0];
    const techParam = String(req.query.tech || '').trim();
    const out = { job: jobId, tech: techParam, htmlLength: 0, tables: 0, fields: 0, parsedKeys: [], data: {} };
    // Reuse the main endpoint logic by programmatically requesting it
    // But we reconstruct minimal flow here for clarity
    let dataObj = null;
    // Try cache
    try {
      const latestJson = path.join(cacheDir, 'latest.json');
      if (fs.existsSync(latestJson)) {
        dataObj = JSON.parse(fs.readFileSync(latestJson, 'utf8'));
      }
    } catch {}
    // Live fetch
    if (!dataObj) {
      let user = '';
      let pass = '';
      if (techParam) {
        const creds = resolveCredsFromTechs(techParam);
        if (!creds || !creds.user || !creds.pass) return res.status(400).json({ error: `Missing credentials for tech ${techParam}` });
        user = creds.user; pass = creds.pass;
      } else {
        user = process.env.TECHNET_USER || process.env.TECHNET_USERNAME || '';
        pass = process.env.TECHNET_PASS || process.env.TECHNET_PASSWORD || '';
        if (!user || !pass) return res.status(400).json({ error: 'Missing TECHNET credentials' });
      }
      const live = await fetchLiveHtmlWith(user, pass, TECHNET_URL);
      dataObj = live.data;
      out.htmlLength = (live.html || '').length;
      out.tables = Array.isArray(dataObj?.tables) ? dataObj.tables.length : 0;
      out.fields = Array.isArray(dataObj?.fields) ? dataObj.fields.length : 0;
    }
    // Offline fallback if needed
    if (!dataObj || (!dataObj.tables && !dataObj.fields)) {
      const candidates = [
        path.join(__dirname, 'page_snapshot.html'),
        path.join(__dirname, '_responses', 'dashboard.html'),
        path.join(__dirname, '_responses', 'index.html'),
      ];
      for (const f of candidates) {
        if (fs.existsSync(f)) {
          try { const html = fs.readFileSync(f, 'utf8'); dataObj = Object.assign({}, dataObj || {}, { html }); out.htmlLength = html.length; break; } catch {}
        }
      }
    }
    // Parse using same helpers as main route
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const isLabel = (label, patterns) => { const L = norm(label).replace(/:$/, ''); return patterns.some(p => typeof p === 'string' ? L === norm(p) : p instanceof RegExp ? p.test(L) : false); };
    const setIfEmpty = (obj, key, val) => { if (val && obj[key] == null) obj[key] = val; };
    const result = { job: jobId };
    const tables = Array.isArray(dataObj?.tables) ? dataObj.tables : [];
    const fields = Array.isArray(dataObj?.fields) ? dataObj.fields : [];
    for (const t of tables) {
      const headers = (t.headers || []).map(h => String(h).trim());
      for (const r of t.rows || []) {
        if (r.some(cell => String(cell).includes(jobId))) {
          headers.forEach((h, idx) => {
            const key = norm(h);
            const val = String(r[idx] ?? '').trim();
            if (!val) return;
            if (isLabel(key, [/^job\s*type$/])) setIfEmpty(result, 'jobType', val);
            if (isLabel(key, [/^status$/])) setIfEmpty(result, 'staticStatus', val);
            if (isLabel(key, [/^completion\s*time$/, /^cp\s*time$/, /^cptime$/])) setIfEmpty(result, 'staticCompletionTime', val);
            if (isLabel(key, [/^account(\s*#|\s*number)?$/])) setIfEmpty(result, 'accountNumber', val);
            if (isLabel(key, [/^units$/])) setIfEmpty(result, 'units', val);
            if (isLabel(key, [/^priority$/])) setIfEmpty(result, 'priority', val);
            if (isLabel(key, [/^schd$/, /^schedule(\s*date)?$/])) setIfEmpty(result, 'scheduleDate', val);
            if (isLabel(key, [/^origin$/])) setIfEmpty(result, 'origin', val);
            if (isLabel(key, [/^resolution(\s*codes?)?$/])) setIfEmpty(result, 'resolutionCodes', val);
            if (isLabel(key, [/^phone(\s*#)?$/])) setIfEmpty(result, 'phone', val);
            if (isLabel(key, [/^(customer\s*)?name$/])) setIfEmpty(result, 'name', val);
            if (isLabel(key, [/^address$/])) setIfEmpty(result, 'address', val);
            if (isLabel(key, [/^addr2$/])) setIfEmpty(result, 'address2', val);
            if (isLabel(key, [/^city$/])) setIfEmpty(result, 'city', val);
          });
        }
      }
    }
    fields.forEach(f => {
      const labelRaw = String(f.label || '');
      const label = norm(labelRaw);
      const val = String(f.value ?? '').trim();
      if (!val) return;
      if (isLabel(label, [/^priority$/])) result.priority = val;
      if (isLabel(label, [/^create$/])) result.create = val;
      if (isLabel(label, [/^schd$/, /^schedule(\s*date)?$/])) result.scheduleDate = val;
      if (isLabel(label, [/^completion\s*time$/, /^cp\s*time$/, /^cptime$/])) result.staticCompletionTime = val;
      if (isLabel(label, [/^ds$/, /^status$/])) result.staticStatus = val;
      if (isLabel(label, [/^ts$/, /^time\s*frame$/])) result.timeFrame = val;
      if (isLabel(label, [/^type$/, /^job\s*type$/])) result.jobType = val;
      if (isLabel(label, [/^units$/])) result.units = val;
      if (isLabel(label, [/^reacd$/, /^rea\s*cd$/, /^readesc$/, /^rea\s*desc$/, /^reason$/])) result.reason = val;
      if (isLabel(label, [/^rescd$/])) result.resolutionCodes = val;
      if (isLabel(label, [/^fc$/])) result.accountNumber = val;
      if (isLabel(label, [/^tech$/])) result.assignedTech = val;
      if (isLabel(label, [/^addr$/, /^address$/])) setIfEmpty(result, 'address', val);
      if (isLabel(label, [/^addr2$/, /^address\s*2$/])) setIfEmpty(result, 'address2', val);
      if (isLabel(label, [/^city$/])) result.city = val;
      if (isLabel(label, [/^name$/, /^(customer\s*)?name$/])) setIfEmpty(result, 'name', val);
      if (isLabel(label, [/^home(\s*#)?$/])) result.homePhone = val;
      if (isLabel(label, [/^work(\s*#)?$/])) result.workPhone = val;
      if (isLabel(label, [/^map\s*cd$/, /^map$/])) result.mapCd = val;
      if (isLabel(label, [/^job\s*cmt$/, /^job\s*comment$/])) result.jobComment = val;
      if (isLabel(label, [/^node$/])) result.node = val;
      if (isLabel(label, [/^delq$/])) result.delq = val;
      if (isLabel(label, [/^dispatch\s*cmt$/])) result.dispatchComment = val;
      if (isLabel(label, [/^receipt\s*cmt$/])) result.receiptComment = val;
      if (isLabel(label, [/^fsm\s*cmt$/])) result.fsmComment = val;
      if (isLabel(label, [/^phone(\s*#)?$/])) setIfEmpty(result, 'phone', val);
      if (isLabel(label, [/^origin$/])) result.origin = val;
    });
    // HTML regex fallback
    try {
      const html = String(dataObj?.html || '');
      const pick = (re) => { const m = html.match(re); let v = m ? String(m[1]).trim() : ''; v = v.replace(/^"|"$/g, '').trim(); return v; };
      const fieldsMap = {
        job: /Job\s*ID:\s*([^\n<"]+)/i,
        assignedTech: /Tech:\s*(\d{3,})/i,
        resolutionCodes: /ResCd:\s*([^\n<"]]*)/i,
        accountNumber: /FC:\s*([^\n<"]]*)/i,
        create: /Create:\s*([^\n<"]+)/i,
        scheduleDate: /Schd:\s*([^\n<"]]+)/i,
        staticCompletionTime: /CpTime:\s*([^\n<"]]+)/i,
        staticStatus: /DS:\s*([^\n<"]]+)/i,
        timeFrame: /TS:\s*([^\n<"]]+)/i,
        jobType: /Type:\s*([^\n<"]]+)/i,
        units: /Units:\s*([^\n<"]]+)/i,
        reason: /ReaCd\/?\s*ReaDesc:\s*([^\n<"]]+)/i,
        address: /Addr:\s*([^\n<"]]+)/i,
        address2: /Addr2:\s*([^\n<"]]+)/i,
        city: /City:\s*([^\n<"]]+)/i,
        name: /Name:\s*([^\n<"]]+)/i,
        homePhone: /Home\s*#:\s*([^\n<"]]+)/i,
        workPhone: /Work\s*#:\s*([^\n<"]]+)/i,
        mapCd: /Map\s*CD:\s*([^\n<"]]+)/i,
        jobComment: /Job\s*Cmt:\s*([^\n<"]]+)/i,
        node: /Node:\s*([^\n<"]]+)/i,
        delq: /Delq:\s*([^\n<"]]*)/i,
        dispatchComment: /Dispatch\s*Cmt:\s*([^\n<"]]+)/i,
        receiptComment: /Receipt\s*Cmt:\s*([^\n<"]]*)/i,
        fsmComment: /FSM\s*Cmt:\s*([^\n<"]]*)/i,
      };
      Object.entries(fieldsMap).forEach(([k, re]) => { const v = pick(re); if (v) setIfEmpty(result, k, v); });
    } catch {}
    // Cheerio DOM fallback
    try {
      const html = String(dataObj?.html || '');
      if (html) {
        const $ = cheerio.load(html);
        const mapLabel = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const getValueAfterBold = (bElem) => {
          let val = '';
          const node = bElem.get(0);
          if (!node) return val;
          let curr = node.nextSibling;
          while (curr) {
            const name = curr.name || curr.type;
            if (name === 'b' || name === 'tag' && curr.name === 'b') break;
            if (curr.type === 'text') val += curr.data || '';
            if (curr.name === 'br') break;
            if (curr.children && curr.children.length) val += $(curr).text();
            curr = curr.nextSibling;
          }
          return val.replace(/[\n]+/g, '').replace(/^"|"$/g, '').trim();
        };
        $('b').each((_, el) => {
          const label = mapLabel($(el).text()).replace(/:$/, '');
          const val = getValueAfterBold($(el));
          if (!val) return;
          const L = label.toLowerCase();
          const set = (k) => setIfEmpty(result, k, val);
          if (L === 'job id') set('job');
          else if (L === 'tech') set('assignedTech');
          else if (L === 'rescd') set('resolutionCodes');
          else if (L === 'fc') set('accountNumber');
          else if (L === 'create') set('create');
          else if (L === 'schd') set('scheduleDate');
          else if (L === 'cptime') set('staticCompletionTime');
          else if (L === 'ds') set('staticStatus');
          else if (L === 'ts') set('timeFrame');
          else if (L === 'type') set('jobType');
          else if (L === 'units') set('units');
          else if (L === 'reacd/readesc' || L === 'reacd/ readesc') set('reason');
          else if (L === 'addr') set('address');
          else if (L === 'addr2') set('address2');
          else if (L === 'city') set('city');
          else if (L === 'name') set('name');
          else if (L === 'home #') set('homePhone');
          else if (L === 'work #') set('workPhone');
          else if (L === 'map cd') set('mapCd');
          else if (L === 'job cmt') set('jobComment');
          else if (L === 'node') set('node');
          else if (L === 'delq') set('delq');
          else if (L === 'dispatch cmt') set('dispatchComment');
          else if (L === 'receipt cmt') set('receiptComment');
          else if (L === 'fsm cmt') set('fsmComment');
        });
      }
    } catch {}
    out.parsedKeys = Object.keys(result).filter(k => k !== 'job');
    out.data = result;
    return res.json(out);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Debug: report aggregated and per-tech cache counts for a given date
app.get('/api/debug/aggregate', (req, res) => {
  try {
    const dateIso = String(req.query.date || '').trim() || new Date().toISOString().slice(0,10);
    const aggPath = path.join(dataDir, `stops-${dateIso}.json`);
    const liveRoot = path.join(cacheDir, 'live');
    const report = { date: dateIso, aggregated: { exists: false, path: aggPath, routesCount: 0, stopsCount: 0 }, perTech: {} };
    // aggregated file
    try {
      if (fs.existsSync(aggPath)) {
        report.aggregated.exists = true;
        const txt = fs.readFileSync(aggPath, 'utf8');
        const obj = JSON.parse(txt || '{}');
        if (Array.isArray(obj.routes)) {
          report.aggregated.routesCount = obj.routes.length;
          report.aggregated.stopsCount = obj.routes.reduce((n, r) => n + ((r && Array.isArray(r.stops)) ? r.stops.length : 0), 0);
        }
      }
    } catch (e) {
      // ignore
    }
    // per-tech caches
    try {
      if (fs.existsSync(liveRoot)) {
        for (const tech of fs.readdirSync(liveRoot)) {
          try {
            const file = path.join(liveRoot, tech, `${dateIso}.json`);
            if (!fs.existsSync(file)) continue;
            const txt = fs.readFileSync(file, 'utf8');
            const json = JSON.parse(txt || '[]');
            let routesCount = 0, stopsCount = 0;
            if (Array.isArray(json)) {
              routesCount = json.length;
              stopsCount = json.reduce((n, r) => n + ((r && Array.isArray(r.stops)) ? r.stops.length : 0), 0);
            } else if (json && Array.isArray(json.routes)) {
              routesCount = json.routes.length;
              stopsCount = json.routes.reduce((n, r) => n + ((r && Array.isArray(r.stops)) ? r.stops.length : 0), 0);
            }
            report.perTech[tech] = { path: file, routesCount, stopsCount };
          } catch (e) {
            // ignore per-file errors
          }
        }
      }
    } catch (e) {}
    return res.json(report);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Force rebuild aggregated file from per-tech caches for a date
app.post('/api/debug/aggregate/rebuild', (req, res) => {
  try {
    const dateIso = String(req.query.date || req.body?.date || '').trim() || new Date().toISOString().slice(0,10);
    const liveRoot = path.join(cacheDir, 'live');
    const aggregated = [];
    if (fs.existsSync(liveRoot)) {
      for (const tech of fs.readdirSync(liveRoot)) {
        try {
          const file = path.join(liveRoot, tech, `${dateIso}.json`);
          if (!fs.existsSync(file)) continue;
          const txt = fs.readFileSync(file, 'utf8');
          const json = JSON.parse(txt || '[]');
          if (Array.isArray(json) && json.length) {
            for (const r of json) aggregated.push(r);
          } else if (json && Array.isArray(json.routes) && json.routes.length) {
            for (const r of json.routes) aggregated.push(r);
          }
        } catch (e) {
          // ignore per-file errors
        }
      }
    }
    // persist even if empty to overwrite prior bad aggregates
    try { persistAggregatedRoutes(dateIso, aggregated); } catch (e) {}
    return res.json({ date: dateIso, rebuilt: true, routesCount: aggregated.length, stopsCount: aggregated.reduce((n,r)=>n+((r&&Array.isArray(r.stops))?r.stops.length:0),0) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Live test summary for multiple tech IDs
app.get('/api/test/techs', async (req, res) => {
  try {
    const idsParam = String(req.query.ids || '').trim();
    const dateIso = String(req.query.date || '').trim() || new Date().toISOString().slice(0,10);
    if (!idsParam) return res.status(400).json({ error: 'ids is required (comma-separated tech numbers)' });
    const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
    const results = [];
    for (const tech of ids) {
      const entry = { tech, date: dateIso, dash: { routes: 0, stops: 0, ok: false }, technet: { length: 0, ok: false } };
      try {
        const creds = resolveCredsFromTechs(tech);
        if (!creds || !creds.user || !creds.pass) {
          entry.error = 'Missing credentials';
        } else {
          const routes = await fetchTechRoutesWithCache(creds.user, creds.pass, dateIso);
          entry.dash.routes = Array.isArray(routes) ? routes.length : 0;
          entry.dash.stops = Array.isArray(routes) ? routes.reduce((acc, r) => acc + (Array.isArray(r.stops) ? r.stops.length : 0), 0) : 0;
          entry.dash.ok = true;
          const htmlObj = await fetchLiveHtmlWith(creds.user, creds.pass, TECHNET_URL);
          entry.technet.length = htmlObj && htmlObj.html ? htmlObj.html.length : 0;
          entry.technet.ok = !!(htmlObj && htmlObj.html);
        }
      } catch (err) {
        entry.error = err.message || String(err);
      }
      results.push(entry);
    }
    return res.json({ ok: true, results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Technet dashboard running on http://localhost:${port}`);
});
