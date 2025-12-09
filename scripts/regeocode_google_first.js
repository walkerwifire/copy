const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE_DIR = path.join(__dirname, '..', 'cache', 'geocode', 'v2');
const REPORTS_DIR = path.join(__dirname, '..', 'reports');

const REQ_DELAY_MS = parseInt(process.env.REGEOCODE_DELAY_MS || '600', 10);
const ALLOW = process.env.REGEOCODE_ALLOW === '1';
const API_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;

if (!ALLOW) {
  console.error('Re-geocode blocked: set environment variable REGEOCODE_ALLOW=1 to allow changes.');
  process.exit(3);
}
if (!API_KEY) {
  console.error('Missing GOOGLE_MAPS_API_KEY in environment. Aborting.');
  process.exit(4);
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let raw = '';
      res.on('data', (chunk) => raw += chunk);
      res.on('end', () => {
        try {
          const obj = JSON.parse(raw);
          resolve(obj);
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

function inBbox(lat, lng) {
  const rawBbox = process.env.GEO_BBOX || '-74.5,40.2,-72.5,41.2';
  const parts = rawBbox.split(',').map(s => parseFloat(s.trim()));
  const [west, south, east, north] = parts;
  if (lat == null || lng == null) return false;
  return lng >= west && lng <= east && lat >= south && lat <= north;
}

function googleConfidenceFromLocationType(locType) {
  // maps Google location_type to a heuristic confidence
  switch ((locType||'').toUpperCase()) {
    case 'ROOFTOP': return 0.95;
    case 'RANGE_INTERPOLATED': return 0.8;
    case 'GEOMETRIC_CENTER': return 0.7;
    case 'APPROXIMATE': return 0.6;
    default: return 0.6;
  }
}

function preferGoogleResult(results) {
  if (!results || results.length === 0) return null;
  // prefer types that indicate precise address
  const preferTypes = ['street_address','premise','subpremise','intersection'];
  for (const t of preferTypes) {
    const r = results.find(r => (r.types||[]).includes(t));
    if (r) return r;
  }
  // otherwise prefer result with geometry.location_type ROOFTOP
  const rooftop = results.find(r => (r.geometry && r.geometry.location_type && r.geometry.location_type.toUpperCase()==='ROOFTOP'));
  if (rooftop) return rooftop;
  // fallback to first
  return results[0];
}

function filenameToAddress(filename) {
  // filename like: 150_malcolm_x_bl_11221_2222.json
  let s = filename.replace(/\.json$/i,'');
  s = s.replace(/_/g,' ');
  // strip trailing two numeric tokens that look like zip+ext or unit codes
  s = s.replace(/\s+\d{3,4}$/, '');
  // remove trailing borough tokens
  s = s.replace(/\b(brooklyn|bronx|queens|manhattan|staten island|ny|nyc)\b/gi, '');
  // remove multiple spaces
  s = s.replace(/\s+/g,' ').trim();
  return s;
}

async function main() {
  const reportArg = process.argv[2] || path.join(REPORTS_DIR, `geocode-scan-${new Date().toISOString().slice(0,10)}.json`);
  if (!fs.existsSync(reportArg)) {
    console.error('Report not found:', reportArg);
    process.exit(5);
  }
  const report = JSON.parse(fs.readFileSync(reportArg, 'utf8'));
  const details = report.details || {};
  const filesToProcess = Object.keys(details).filter(fn => details[fn] && (details[fn].lowConfidence || details[fn].outOfBounds));

  console.log('Files flagged in report:', filesToProcess.length);
  if (filesToProcess.length === 0) return;

  let updated = 0, skipped = 0, errors = 0;
  for (let i = 0; i < filesToProcess.length; i++) {
    const filename = filesToProcess[i];
    const cachePath = path.join(CACHE_DIR, filename);
    if (!fs.existsSync(cachePath)) {
      console.warn('Cache file missing, skipping:', filename);
      skipped++;
      continue;
    }

    const raw = fs.readFileSync(cachePath, 'utf8');
    let data;
    try { data = JSON.parse(raw); } catch (err) { console.error('JSON parse error', filename, err.message); errors++; continue; }

    const address = (data && data.query) ? data.query : filenameToAddress(filename);
    // try to extract a 5-digit ZIP from filename
    const zipMatch = filename.match(/(\d{5})/);
    const components = zipMatch ? `&components=postal_code:${zipMatch[1]}|country:US` : '&components=country:US';
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}${components}&key=${API_KEY}`;

    try {
      const res = await fetchJson(url);
      if (res.status !== 'OK' || !res.results || res.results.length === 0) {
        console.warn('Google no result for', filename, address, 'status', res.status);
        skipped++;
      } else {
        const best = preferGoogleResult(res.results);
        const loc = best.geometry && best.geometry.location;
        const locType = (best.geometry && best.geometry.location_type) || null;
        const confidence = googleConfidenceFromLocationType(locType);
        const quality = (best.types && best.types[0]) || 'unknown';
        const candidate = {
          lat: loc.lat,
          lng: loc.lng,
          provider: 'google',
          quality: quality,
          confidence: confidence,
          raw: { place_id: best.place_id, types: best.types, formatted_address: best.formatted_address, location_type: locType }
        };

        // insert google candidate at front (avoid duplicates)
        const existingCandidates = Array.isArray(data.candidates) ? data.candidates.filter(c => c && c.provider !== 'google') : [];
        data.candidates = [candidate, ...existingCandidates];

        // decide whether to make google the chosen candidate
        const geoOK = inBbox(candidate.lat, candidate.lng);
        const makeChosen = (locType && locType.toUpperCase() === 'ROOFTOP') || (geoOK && confidence >= 0.8);

        if (makeChosen) {
          data.chosen = { lat: candidate.lat, lng: candidate.lng, provider: 'google', quality: quality, confidence: confidence };
          fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf8');
          updated++;
          console.log(`[${i+1}/${filesToProcess.length}] Updated chosen -> google for`, filename, `(${address})`);
        } else {
          // write back only candidates (so we keep google suggestion) if not chosen
          data._last_suggested_google = { lat: candidate.lat, lng: candidate.lng, quality, confidence, time: new Date().toISOString() };
          fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf8');
          skipped++;
          console.log(`[${i+1}/${filesToProcess.length}] Added google candidate (not chosen) for`, filename);
        }
      }
    } catch (err) {
      console.error('Error fetching or processing', filename, err && err.message);
      errors++;
    }

    // rate limit
    if (i < filesToProcess.length - 1) await sleep(REQ_DELAY_MS);
  }

  console.log('Re-geocode run complete. updated:', updated, 'skipped:', skipped, 'errors:', errors);
}

main().catch(err => { console.error('Fatal error', err && err.message); process.exit(2); });
