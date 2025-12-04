require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const path = require('path');
const cheerio = require('cheerio');

const TECHNET_URL = process.env.TECHNET_URL || 'https://technet.altice.csgfsm.com/altice/tn/technet.htm?Id=1';
const HEADLESS = (process.env.HEADLESS ? process.env.HEADLESS.toLowerCase() !== 'false' : true);
const SLOWMO = parseInt(process.env.SLOWMO || '0', 10);
const TECHS_JSON_ENV = process.env.TECHS_JSON || process.env.TECHS_JSON_PATH;
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || '600000', 10); // 10 minutes

const app = express();
app.use(morgan('dev'));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
      // Normalize badge across common states
      let badge = '';
      if (/complete|completed|done/i.test(status)) badge = 'completed';
      else if (/not\s*done/i.test(status)) badge = 'cancelled';
      else if (/pending|sched|scheduled|pending install|pending tc|pending cos|pending change/i.test(status)) badge = 'pending';
      else if (/cancel|cnx|canceled|cancelled/i.test(status)) badge = 'cancelled';
      else if (/unassign|unassigned/i.test(status)) badge = 'unassigned';
      else badge = status || '';
      const key = `${tech}|${dateIso}`;
      if (!group[key]) {
        group[key] = { techNo: tech || '', date: dateIso || '', stops: [], totalStops: 0, estimatedDuration: '' };
      }
      group[key].stops.push({ time, job: jobId, type, status, badge, tech, name, address: [addr, addr2, city].filter(Boolean).join(', '), phone });
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
        let badge = '';
        if (/complete|completed|done/i.test(status)) badge = 'completed';
        else if (/not\s*done/i.test(status)) badge = 'cancelled';
        else if (/pending|sched|scheduled|pending install|pending tc|pending cos|pending change/i.test(status)) badge = 'pending';
        else if (/cancel|cnx|canceled|cancelled/i.test(status)) badge = 'cancelled';
        else if (/unassign|unassigned/i.test(status)) badge = 'unassigned';
        const key = `${tech}|${dateIso}`;
        if (!group[key]) group[key] = { techNo: tech, date: dateIso, stops: [], totalStops: 0, estimatedDuration: '' };
        const time = ts;
        group[key].stops.push({ time, job: jobId, type, status, badge, tech, name, address: [addr, addr2, city].filter(Boolean).join(', ') });
      }
      for (const k of Object.keys(group)) { const r = group[k]; r.totalStops = r.stops.length; routes.push(r); }
    }
  } catch {}
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

async function fetchTechRoutesWithCache(tech, password, dateIso, opts = {}) {
  const cacheFile = getTechDateCachePath(tech, dateIso);
  if (!opts.force && isFreshCache(cacheFile)) {
    return readCachedRoutes(cacheFile);
  }
  const live = await fetchLiveHtmlWith(tech, password, TECHNET_URL);
  const routes = deriveRoutesFromHtml(live.html || '', tech);
  const techRoutes = routes.filter(r => String(r.techNo) === String(tech));
  const filtered = dateIso ? techRoutes.filter(r => String(r.date) === String(dateIso)) : techRoutes;
  writeCachedRoutes(cacheFile, filtered);
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
  const chunks = await parallelMap(list, parseInt(process.env.CONCURRENCY || '3', 10), async (t) => {
    const routes = await fetchTechRoutesWithCache(t.tech, t.password, dateIso, opts);
    // Persist per tech/date indefinitely
    const file = getTechDateCachePath(t.tech, dateIso || new Date().toISOString().slice(0,10));
    writeCachedRoutes(file, routes);
    return routes;
  });
  const aggregated = [];
  for (const arr of chunks) aggregated.push(...arr);
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
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOWMO });
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
  await browser.close();
  return { html, data: parseHtmlToData(html) };
}

async function fetchLiveHtmlWith(user, pass, targetUrl) {
  if (!user || !pass) {
    throw new Error('Missing user/pass');
  }
  const url = targetUrl || TECHNET_URL;
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOWMO });
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
  await browser.close();
  return { html, data: parseHtmlToData(html) };
}

// Ensure cache dir exists
const cacheDir = path.join(__dirname, 'cache');
if (!fs.existsSync(cacheDir)) {
  try { fs.mkdirSync(cacheDir); } catch {}
}

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
    return res.status(500).json({ error: err.message });
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
    return res.status(500).send('error: ' + err.message);
  }
});

// CSV export for route list
app.get('/api/routes.csv', async (req, res) => {
  try {
    // Build dashboard payload similarly to /api/dashboard
    const forceLive = (req.query.mode || '').toLowerCase() === 'live';
    const wantAll = (String(req.query.tech || '').toLowerCase() === 'all') || (String(req.query.all || '') === '1');
    const dateIso = String(req.query.date || '').trim();
    const force = String(req.query.force || '') === '1';
    let payload;
    if (!forceLive) {
      const offline = tryOfflineCapture();
      if (offline) {
        const technicians = deriveTechniciansFromData(offline.data);
        const summary = deriveSummaryFromData(offline.data);
        payload = { mode: 'offline', title: offline.data.title, technicians, summary, routes: [], raw: offline };
      }
    }
    if (!payload) {
      if (wantAll) {
        const routes = await fetchAllTechRoutes(dateIso || undefined, { force });
        // Derive a minimal technicians list from the aggregated routes
        const techMap = new Map();
        for (const r of routes) {
          const key = String(r.techNo || '').trim();
          if (!key) continue;
          if (!techMap.has(key)) {
            techMap.set(key, {
              name: `Tech ${key}`,
              status: undefined,
              techNo: key,
              workSkill: undefined,
              provider: undefined,
              lastActivity: undefined
            });
          }
        }
        const technicians = Array.from(techMap.values());
        payload = { mode: 'live', title: 'All Techs', technicians, summary: {}, routes, raw: {} };
      } else {
        const live = await fetchLivePreferCreds(req);
        const technicians = deriveTechniciansFromData(live.data);
        const summary = deriveSummaryFromData(live.data);
        let routes = [];
        try { routes = deriveRoutesFromHtml(live.html || ''); } catch {}
        payload = { mode: 'live', title: live.data.title, technicians, summary, routes, raw: live };
      }
    }
    if (!payload.routes || payload.routes.length === 0) {
      try {
        const sampleDash = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-dashboard.json'), 'utf8'));
        payload.routes = sampleDash.routes || [];
      } catch {}
    }
    const rows = [];
    // Header
    rows.push(['date','techNo','time','job','type','status','badge','tech','name','address','phone']);
    const routesOut = wantAll ? (payload.routes || []) : [ (payload.routes || [])[0] || { stops: [], date: '', techNo: '' } ];
    for (const route of routesOut) {
      for (const s of route.stops || []) {
        rows.push([
          route.date || '',
          route.techNo || '',
          s.time || '',
          s.job || '',
          s.type || '',
          s.status || '',
          s.badge || '',
          s.tech || '',
          s.name || '',
          s.address || '',
          s.phone || ''
        ]);
      }
    }
    const toCsv = (rows) => rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
    const csv = toCsv(rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="routes.csv"');
    return res.send(csv);
  } catch (err) {
    return res.status(500).send('error: ' + err.message);
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
    let payload;
    if (!payload) {
      const routes = await fetchAllTechRoutes(dateIso, { force });
      const techJson = getAllTechsFromJson();
      const technicians = techJson.map(t => ({
        name: t.name || `Tech ${t.tech}`,
        status: t.status || 'Off Duty',
        techNo: String(t.tech),
        workSkill: t.workSkill || 'FTTH, COAX',
        provider: t.provider || 'Altice/Optimum',
        lastActivity: t.lastActivity || 'N/A'
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
            result.push({ tech: t, path: full, date: f.replace(/\.json$/, ''), mtimeMs: stat.mtimeMs });
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
    const jobId = String(req.params.jobId || '').trim();
    if (!jobId) return res.status(400).json({ error: 'jobId is required' });
    // Attempt offline cache first
    let dataObj = null;
    try {
      const latestJson = path.join(cacheDir, 'latest.json');
      if (fs.existsSync(latestJson)) {
        dataObj = JSON.parse(fs.readFileSync(latestJson, 'utf8'));
      }
    } catch {}
    // If not available, do a live fetch using env creds
    if (!dataObj) {
      const envUser = process.env.TECHNET_USER || process.env.TECHNET_USERNAME;
      const envPass = process.env.TECHNET_PASS || process.env.TECHNET_PASSWORD;
      if (!envUser || !envPass) return res.status(400).json({ error: 'Missing global TECHNET credentials for live fetch' });
      const live = await fetchLiveHtmlWith(envUser, envPass, TECHNET_URL);
      dataObj = live.data;
      try { fs.writeFileSync(path.join(cacheDir, 'latest.json'), JSON.stringify(dataObj, null, 2), 'utf8'); } catch {}
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
        return m ? String(m[1]).trim() : '';
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

    return res.json(result);
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

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Technet dashboard running on http://localhost:${port}`);
});
