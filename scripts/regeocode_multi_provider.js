const fs = require('fs');
const path = require('path');
const https = require('https');

const CACHE_DIR = path.join(__dirname, '..', 'cache', 'geocode', 'v2');
const REPORTS_DIR = path.join(__dirname, '..', 'reports');

const DEFAULT_ORDER = 'google,opencage,mapbox';
const PROVIDER_ORDER = (process.env.PROVIDER_ORDER || DEFAULT_ORDER).split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true' || !process.env.REGEOCODE_ALLOW; // default to true unless allowed
const ALLOW = process.env.REGEOCODE_ALLOW === '1' || process.env.REGEOCODE_ALLOW === 'true';
const REQ_DELAY_MS = parseInt(process.env.REGEOCODE_DELAY_MS || '600', 10);

const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY || null;
const OPENCAGE_KEY = process.env.OPENCAGE_KEY || null;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || null;

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
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
  const preferTypes = ['street_address','premise','subpremise','intersection'];
  for (const t of preferTypes) {
    const r = results.find(r => (r.types||[]).includes(t));
    if (r) return r;
  }
  const rooftop = results.find(r => (r.geometry && r.geometry.location_type && r.geometry.location_type.toUpperCase()==='ROOFTOP'));
  if (rooftop) return rooftop;
  return results[0];
}

function pickMapboxFeature(features) {
  if (!features || features.length === 0) return null;
  // prefer address or poi
  const pref = features.find(f => (f.id||'').startsWith('address') || (f.place_type||[]).includes('address'));
  return pref || features[0];
}

function pickOpenCageResult(results) {
  if (!results || results.length === 0) return null;
  // prefer components with 'house_number' or 'building'
  const pref = results.find(r => r.components && (r.components.house_number || r.components.building));
  return pref || results[0];
}

function filenameToAddress(filename) {
  let s = filename.replace(/\.json$/i,'');
  s = s.replace(/_/g,' ');
  s = s.replace(/\s+\d{3,4}$/, '');
  s = s.replace(/\b(brooklyn|bronx|queens|manhattan|staten island|ny|nyc)\b/gi, '');
  s = s.replace(/\s+/g,' ').trim();
  return s;
}

async function geocodeWithProvider(provider, address, filename) {
  try {
    if (provider === 'google') {
      if (!GOOGLE_KEY) return { error: 'missing_google_key' };
      const zipMatch = filename.match(/(\d{5})/);
      const components = zipMatch ? `&components=postal_code:${zipMatch[1]}|country:US` : '&components=country:US';
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}${components}&key=${GOOGLE_KEY}`;
      const res = await fetchJson(url);
      if (!res || res.status !== 'OK') return { error: 'no_google_result', raw: res };
      const best = preferGoogleResult(res.results);
      const loc = best.geometry.location;
      const locType = best.geometry.location_type;
      const confidence = googleConfidenceFromLocationType(locType);
      return { lat: loc.lat, lng: loc.lng, provider: 'google', quality: (best.types&&best.types[0])||'unknown', confidence, raw: best };
    }

    if (provider === 'opencage') {
      if (!OPENCAGE_KEY) return { error: 'missing_opencage_key' };
      const url = `https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(address)}&key=${OPENCAGE_KEY}&countrycode=us&limit=5`;
      const res = await fetchJson(url);
      if (!res || !res.results || res.results.length === 0) return { error: 'no_opencage_result', raw: res };
      const best = pickOpenCageResult(res.results);
      const lat = best.geometry.lat; const lng = best.geometry.lng;
      // OpenCage has 'confidence' (0-10) or 'confidence' field; normalize
      const conf = (typeof best.confidence === 'number') ? Math.min(1, best.confidence / 10) : (best.annotations && best.annotations.DMS ? 0.7 : 0.7);
      return { lat, lng, provider: 'opencage', quality: best.components && best.components._type || 'unknown', confidence: conf, raw: best };
    }

    if (provider === 'mapbox') {
      if (!MAPBOX_TOKEN) return { error: 'missing_mapbox_token' };
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?access_token=${MAPBOX_TOKEN}&limit=5&country=us`;
      const res = await fetchJson(url);
      if (!res || !res.features || res.features.length === 0) return { error: 'no_mapbox_result', raw: res };
      const f = pickMapboxFeature(res.features);
      const [lng, lat] = f.center || [null, null];
      // mapbox relevance 0-1
      const conf = typeof f.relevance === 'number' ? f.relevance : 0.6;
      return { lat, lng, provider: 'mapbox', quality: (f.place_type&&f.place_type[0])||'unknown', confidence: conf, raw: f };
    }

    return { error: 'unknown_provider' };
  } catch (err) {
    return { error: 'request_error', message: err && err.message };
  }
}

async function main() {
  const reportArg = process.argv[2] || path.join(REPORTS_DIR, `geocode-scan-${new Date().toISOString().slice(0,10)}.json`);
  if (!fs.existsSync(reportArg)) {
    console.error('Report not found:', reportArg);
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(reportArg, 'utf8'));
  const details = report.details || {};
  const filesToProcess = Object.keys(details).filter(fn => details[fn] && (details[fn].lowConfidence || details[fn].outOfBounds));
  console.log('Files flagged in report:', filesToProcess.length);
  if (filesToProcess.length === 0) return;

  const summary = { total: filesToProcess.length, processed: 0, suggestedUpdates: [], errors: [] };

  for (let i = 0; i < filesToProcess.length; i++) {
    const filename = filesToProcess[i];
    const cachePath = path.join(CACHE_DIR, filename);
    if (!fs.existsSync(cachePath)) {
      summary.errors.push({ file: filename, error: 'missing_cache' });
      continue;
    }
    let data;
    try { data = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch (err) { summary.errors.push({ file: filename, error: 'parse_error', message: err.message }); continue; }

    const address = (data && data.query) ? data.query : filenameToAddress(filename);

    let chosen = data.chosen || null;
    let candidateAccepted = null;
    const tried = [];

    for (const provider of PROVIDER_ORDER) {
      const result = await geocodeWithProvider(provider, address, filename);
      tried.push({ provider, result });
      if (result && result.error) {
        // continue to next provider
        continue;
      }

      // heuristics: accept rooftop or high confidence in bbox
      const within = inBbox(result.lat, result.lng);
      const rooftop = (result.raw && ((result.raw.geometry && result.raw.geometry.location_type && result.raw.geometry.location_type.toUpperCase()==='ROOFTOP') || (result.raw.properties && result.raw.properties.location_type && result.raw.properties.location_type.toUpperCase()==='ROOFTOP')));
      const highConf = result.confidence >= 0.85;

      if (rooftop || (within && highConf)) {
        candidateAccepted = result;
        break; // stop at first acceptable provider in order
      }

      // otherwise, keep first non-error candidate as suggestion but continue
      if (!candidateAccepted && result && !result.error) candidateAccepted = result;

      // continue to next provider
    }

    if (!candidateAccepted) {
      summary.errors.push({ file: filename, error: 'no_candidate', tried });
      continue;
    }

    // record suggestion
    summary.suggestedUpdates.push({ file: filename, address, chosenBefore: chosen, suggestion: candidateAccepted, tried });

    // write only if allowed and not dry-run
    if (!DRY_RUN && ALLOW) {
      // load again and update
      data.candidates = data.candidates || [];
      // push suggestion at front, avoid duplicate provider
      data.candidates = [candidateAccepted].concat(data.candidates.filter(c => c.provider !== candidateAccepted.provider));
      // decide to set chosen if rooftop or high confidence in bbox
      const within = inBbox(candidateAccepted.lat, candidateAccepted.lng);
      const rooftop = candidateAccepted.raw && ((candidateAccepted.raw.geometry && candidateAccepted.raw.geometry.location_type && candidateAccepted.raw.geometry.location_type.toUpperCase()==='ROOFTOP') || false);
      if (rooftop || (within && candidateAccepted.confidence >= 0.8)) {
        data.chosen = { lat: candidateAccepted.lat, lng: candidateAccepted.lng, provider: candidateAccepted.provider, quality: candidateAccepted.quality, confidence: candidateAccepted.confidence };
      } else {
        data._last_suggested = { ...candidateAccepted, time: new Date().toISOString() };
      }
      fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf8');
    }

    summary.processed++;

    if (i < filesToProcess.length - 1) await sleep(REQ_DELAY_MS);
  }

  const outPath = path.join(REPORTS_DIR, `regeocode-multi-suggest-${new Date().toISOString().slice(0,10)}.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log('Done. Summary saved to', outPath);
  console.log('Processed:', summary.processed, 'Suggested updates:', summary.suggestedUpdates.length, 'Errors:', summary.errors.length);
  console.log('Provider order used:', PROVIDER_ORDER.join(','));
  console.log(DRY_RUN ? 'DRY RUN: no cache files were modified.' : 'WROTE CHANGES: caches may have been updated.');
}

main().catch(err => { console.error('Fatal', err && err.message); process.exit(2); });
