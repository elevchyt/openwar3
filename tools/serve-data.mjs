// Zero-dependency static server for `Warcraft III/ExtractedData/`.
//
//   node tools/serve-data.mjs [--port 8787] [--no-open]
//
// The data browser (index.html) fetches the .csv/.txt/.j files next to it, and
// browsers block fetch() over file:// — so it needs to be served over http.

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(REPO, 'Warcraft III', 'ExtractedData');

const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
// Deliberately clear of Vite's 5173+ range. Bind and advertise 127.0.0.1 rather than
// `localhost`: a dev server holding [::1]:PORT while we hold 0.0.0.0:PORT both "succeed",
// and the browser then resolves localhost to ::1 and silently loads the wrong app.
const PORT = portArg !== -1 ? Number(argv[portArg + 1]) : 8787;
const HOST = '127.0.0.1';
const OPEN = !argv.includes('--no-open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};
// Everything else (.slk/.txt/.j/.ai/.fdf/.toc) is plain text. WC3 data files are
// windows-1252, but the browser only ever reads them as text for display; declaring
// utf-8 would mangle the few accented bytes, so serve them as latin1.
const DEFAULT_MIME = 'text/plain; charset=windows-1252';

createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';

  // Contain every request inside ROOT — no `..` escapes.
  const target = normalize(join(ROOT, pathname));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  let stat;
  try {
    stat = statSync(target);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  if (stat.isDirectory()) {
    res.writeHead(403).end('forbidden');
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(target).toLowerCase()] ?? DEFAULT_MIME,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  createReadStream(target).pipe(res);
})
  .on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is busy. Pick another: node tools/serve-data.mjs --port 8788`);
      process.exit(1);
    }
    throw err;
  })
  .listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}/`;
    console.log(`OpenWar3 data browser -> ${url}`);
    console.log(`serving ${ROOT}`);
    console.log('Ctrl+C to stop.');
    if (OPEN) {
      const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref();
    }
  });
