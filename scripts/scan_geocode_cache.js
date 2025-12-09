const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'cache', 'geocode', 'v2');
const REPORTS_DIR = path.join(__dirname, '..', 'reports');

const rawBbox = process.env.GEO_BBOX || '-74.5,40.2,-72.5,41.2';
const bboxParts = rawBbox.split(',').map(s => parseFloat(s.trim()));
const [west, south, east, north] = bboxParts;
const CONF_THRESHOLD = parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.8');

function inBbox(lat, lng) {
  if (lat == null || lng == null) return false;
  return lng >= west && lng <= east && lat >= south && lat <= north;
}

function safeReadJson(filePath) {
  try {
    const txt = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(txt);
  } catch (err) {
    return { __error: err.message };
  }
}

function scan() {
  if (!fs.existsSync(CACHE_DIR)) {
    console.error('Cache dir not found:', CACHE_DIR);
    process.exit(2);
  }
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  const report = {
    generatedAt: new Date().toISOString(),
    geoBbox: { west, south, east, north },
    confidenceThreshold: CONF_THRESHOLD,
    totals: {
      files: files.length,
      skipped: 0,
      noChosen: 0,
      lowConfidence: 0,
      outOfBounds: 0,
      errors: 0
    },
    samples: {
      lowConfidence: [],
      outOfBounds: [],
      errors: []
    },
    details: {}
  };

  files.forEach(filename => {
    const filePath = path.join(CACHE_DIR, filename);
    const data = safeReadJson(filePath);
    if (data && data.__error) {
      report.totals.errors += 1;
      report.samples.errors.push({ file: filename, error: data.__error });
      report.details[filename] = { error: data.__error };
      return;
    }

    const chosen = data.chosen;
    if (!chosen) {
      report.totals.noChosen += 1;
      report.details[filename] = { status: 'noChosen' };
      return;
    }

    const lat = Number(chosen.lat);
    const lng = Number(chosen.lng);
    const confidence = typeof chosen.confidence === 'number' ? chosen.confidence : (chosen.confidence ? Number(chosen.confidence) : null);

    const isLowConfidence = confidence == null || confidence < CONF_THRESHOLD;
    const isOutOfBounds = !inBbox(lat, lng);

    if (isLowConfidence) {
      report.totals.lowConfidence += 1;
      if (report.samples.lowConfidence.length < 50) {
        report.samples.lowConfidence.push({ file: filename, chosen, lat, lng, confidence });
      }
    }
    if (isOutOfBounds) {
      report.totals.outOfBounds += 1;
      if (report.samples.outOfBounds.length < 50) {
        report.samples.outOfBounds.push({ file: filename, chosen, lat, lng, confidence });
      }
    }

    report.details[filename] = {
      chosen: chosen,
      lowConfidence: isLowConfidence,
      outOfBounds: isOutOfBounds
    };
  });

  const outName = `geocode-scan-${new Date().toISOString().slice(0,10)}.json`;
  const outPath = path.join(REPORTS_DIR, outName);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('Scan complete. Files:', files.length);
  console.log('Low confidence:', report.totals.lowConfidence);
  console.log('Out of bounds:', report.totals.outOfBounds);
  console.log('No chosen candidate:', report.totals.noChosen);
  console.log('Errors reading files:', report.totals.errors);
  console.log('Report saved to:', outPath);
}

scan();
