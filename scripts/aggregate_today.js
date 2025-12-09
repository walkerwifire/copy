const fs = require('fs');
const path = require('path');

const date = '2025-12-08';
const liveRoot = path.join(__dirname, '..', 'cache', 'live');
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
console.log(JSON.stringify({ date, totalRoutes: aggregated.length, sample: aggregated.slice(0,5) }, null, 2));
