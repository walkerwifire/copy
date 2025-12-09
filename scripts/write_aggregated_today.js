const fs = require('fs');
const path = require('path');

const date = '2025-12-08';
const liveRoot = path.join(__dirname, '..', 'cache', 'live');
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const aggregated = [];
if (fs.existsSync(liveRoot)) {
  for (const tech of fs.readdirSync(liveRoot)) {
    try {
      const file = path.join(liveRoot, tech, `${date}.json`);
      if (!fs.existsSync(file)) continue;
      const txt = fs.readFileSync(file, 'utf8');
      const json = JSON.parse(txt || '[]');
      if (Array.isArray(json) && json.length) {
        for (const r of json) aggregated.push(r);
      } else if (Array.isArray(json.routes) && json.routes.length) {
        for (const r of json.routes) aggregated.push(r);
      }
    } catch (e) {
      // ignore
    }
  }
}
const out = { date, generatedAt: new Date().toISOString(), routes: aggregated };
const outPath = path.join(dataDir, `stops-${date}.json`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
console.log('Wrote', outPath, 'routes:', aggregated.length);
