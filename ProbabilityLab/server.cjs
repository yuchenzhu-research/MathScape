const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.wgsl': 'text/plain; charset=utf-8' };
const allowed = new Set(['index.html', 'styles.css', 'engine.js', 'i18n.js', 'app.js', 'worker.js', 'compute.js', 'gpu.js', 'dice.wgsl', 'appearance.js', 'assets/hero-night.webp', 'assets/hero-day.webp']);
if (process.env.LAB_TESTS === '1') ['tests/checks.html', 'tests/browser-checks.js'].forEach((file) => allowed.add(file));

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (file === 'favicon.ico') { response.writeHead(204); response.end(); return; }
  if (!allowed.has(file)) { response.writeHead(404); response.end('Not found'); return; }
  fs.readFile(path.join(__dirname, file), (error, data) => {
    if (error) { response.writeHead(500); response.end('Unable to read file'); return; }
    response.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(data);
  });
});
server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log('ProbabilityLab: http://127.0.0.1:' + port));
