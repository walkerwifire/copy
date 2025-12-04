/**
 * tools/capture-all.mjs
 *
 * Puppeteer-based capture script:
 * - Launches a Chromium browser (headful) so you can log in and interact.
 * - Saves every successful response body it sees (HTML/CSS/JS/images/fonts/json) to disk.
 * - Writes a manifest mapping URL => saved file path.
 *
 * Usage:
 *   node tools/capture-all.mjs <startUrl> <outDir> [seconds] [--visit "/path1,/path2"]
 *
 * Examples:
 *   node tools/capture-all.mjs "https://example.com" "./capture-out" 180
 *   node tools/capture-all.mjs "https://example.com" "./capture-out" 120 --visit "/dashboard,/map"
 *
 * Notes:
 * - Default capture time is 120 seconds (2 minutes). Increase if you need more time to click around.
 * - Script runs headful (headless: false) so you can log in interactively. Keep the browser window visible.
 * - Large sites with many assets can generate many files and large disk usage.
 *
 * After capture: zip the outDir and upload it / share it so I can reconstruct the frontend.
 */

import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function sanitizeUrlPath(u) {
  // Remove protocol + hostname, strip query/hash, decode percent-encoding, replace illegal chars
  try {
    const parsed = new URL(u);
    let p = parsed.pathname;
    if (p === '/' || !p) p = '/index.html';
    p = decodeURIComponent(p);
    p = p.replace(/^\/+/, ''); // no leading slash in saved paths
    // map root to index.html
    if (!path.extname(p)) {
      // if ends with slash, add index.html
      if (u.endsWith('/')) p = path.join(p, 'index.html');
    }
    // replace illegal filename chars
    p = p.replace(/[:*?"<>|]/g, '_');
    return p;
  } catch {
    // fallback for non-url (data: etc.)
    return u.replace(/[:*?"<>|\/\\]+/g, '_').slice(0, 200);
  }
}

function pickFilenameFromResponse(url, contentType) {
  let rel = sanitizeUrlPath(url);
  // add extension if none and content-type hints it
  if (!path.extname(rel)) {
    if (contentType && contentType.includes('html')) rel = rel + '.html';
    else if (contentType && contentType.includes('javascript')) rel = rel + '.js';
    else if (contentType && contentType.includes('css')) rel = rel + '.css';
    else if (contentType && contentType.includes('json')) rel = rel + '.json';
  }
  return rel;
}

function wantedContentType(contentType) {
  if (!contentType) return false;
  return /html|css|javascript|json|image\/|font\/|svg|woff|octet-stream/.test(contentType);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    console.error('Usage: node tools/capture-all.mjs <startUrl> <outDir> [seconds] [--visit "/path1,/path2"]');
    process.exit(1);
  }
  const startUrl = argv[0];
  const outDir = path.resolve(argv[1]);
  const seconds = Number(argv[2] || 120);
  // parse optional --visit option (comma separated paths)
  const visitArgIndex = argv.indexOf('--visit');
  const visitList = (visitArgIndex >= 0 && argv[visitArgIndex + 1]) ? argv[visitArgIndex + 1].split(',').map(s => s.trim()).filter(Boolean) : [];

  ensureDir(outDir);
  ensureDir(path.join(outDir, '_responses'));

  console.log('Starting Puppeteer capture');
  console.log('Start URL:', startUrl);
  console.log('Output dir:', outDir);
  console.log('Capture time (s):', seconds);
  if (visitList.length) console.log('Will auto-visit paths:', visitList);

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  const manifest = [];
  const savedUrls = new Set();

  page.on('response', async (response) => {
    try {
      const url = response.url();
      const status = response.status();
      if (status < 200 || status >= 300) return;
      const headers = response.headers();
      const contentType = headers['content-type'] || '';
      if (!wantedContentType(contentType)) return;

      // Avoid saving same URL repeatedly (unless query differs)
      // but allow multiple if different content-type/length
      const key = url;
      if (savedUrls.has(key)) return;
      savedUrls.add(key);

      // Get buffer (some responses like CSS/JS/images are binary)
      let buffer;
      try {
        buffer = await response.buffer();
      } catch (err) {
        // sometimes binary fails — fallback to text
        try {
          const txt = await response.text();
          buffer = Buffer.from(txt, 'utf8');
        } catch {
          return;
        }
      }
      if (!buffer || !buffer.length) return;

      const relPath = pickFilenameFromResponse(url, contentType);
      const outPath = path.join(outDir, '_responses', relPath);
      ensureDir(path.dirname(outPath));
      fs.writeFileSync(outPath, buffer);
      manifest.push({ url, status, contentType, savedTo: path.relative(outDir, outPath) });
      console.log('Saved:', url, '->', path.relative(outDir, outPath));
    } catch (e) {
      // ignore per-response errors
    }
  });

  // Optional: store console messages to a log file
  page.on('console', msg => {
    try {
      const txt = msg.text();
      fs.appendFileSync(path.join(outDir, 'page_console.log'), txt + '\n');
    } catch {}
  });

  // Navigate to start URL and let you interact
  await page.goto(startUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  // Auto-visit paths if provided (helps load route-specific chunks)
  for (const p of visitList) {
    try {
      const full = new URL(p, startUrl).href;
      console.log('Auto-visiting', full);
      await page.goto(full, { waitUntil: 'networkidle2', timeout: 60000 });
      // slight wait per page for lazy assets
      await page.waitForTimeout(2000);
    } catch (err) {
      console.warn('Auto-visit failed for', p, err?.message || err);
    }
  }

  console.log(`You may now interact with the page in the opened browser window. Capture will continue for ${seconds} seconds.`);
  await new Promise(res => setTimeout(res, seconds * 1000));

  // Save final page HTML snapshots for pages visited
  try {
    const html = await page.content();
    const htmlPath = path.join(outDir, 'page_snapshot.html');
    fs.writeFileSync(htmlPath, html, 'utf8');
    manifest.push({ url: page.url(), status: 200, contentType: 'text/html', savedTo: path.relative(outDir, htmlPath) });
    console.log('Saved page snapshot to', htmlPath);
  } catch (err) {}

  // close
  await browser.close();

  // Write manifest
  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log('Capture complete. Manifest at', manifestPath);
  console.log('Total unique saved URLs:', manifest.length);
  console.log('Files saved under:', path.join(outDir, '_responses'));
  console.log('Zip the outDir and upload it so I can reconstruct the frontend.');
  process.exit(0);
}

main().catch(err => {
  console.error('Capture failed:', err && err.message ? err.message : err);
  process.exit(2);
});