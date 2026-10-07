const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const directory = path.resolve(__dirname, '..');
const publicFiles = [
  ['index.html', 'text/html; charset=utf-8'],
  ['styles.css', 'text/css; charset=utf-8'],
  ['engine.js', 'text/javascript; charset=utf-8'],
  ['i18n.js', 'text/javascript; charset=utf-8'],
  ['app.js', 'text/javascript; charset=utf-8'],
  ['worker.js', 'text/javascript; charset=utf-8'],
  ['compute.js', 'text/javascript; charset=utf-8'],
  ['gpu.js', 'text/javascript; charset=utf-8'],
  ['dice.wgsl', 'text/plain; charset=utf-8'],
  ['appearance.js', 'text/javascript; charset=utf-8'],
  ['assets/hero-night.webp', 'image/webp'],
  ['assets/hero-day.webp', 'image/webp']
];

async function availablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

async function stop(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Test server did not stop in time'));
    }, 3000);
    child.once('exit', () => { clearTimeout(deadline); resolve(); });
    child.kill('SIGTERM');
  });
}

async function startServer(enableChecks = false) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await availablePort();
    const environment = { ...process.env, PORT: String(port) };
    if (enableChecks) environment.LAB_TESTS = '1';
    else delete environment.LAB_TESTS;
    const child = spawn(process.execPath, [path.join(directory, 'server.cjs')], {
      cwd: directory,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let errors = '';
    try {
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Test server startup timed out')), 5000);
        function finish(error) { clearTimeout(deadline); error ? reject(error) : resolve(); }
        child.stdout.on('data', data => {
          output += data.toString();
          if (output.includes('ProbabilityLab: http://127.0.0.1:' + port)) finish();
        });
        child.stderr.on('data', data => { errors += data.toString(); });
        child.once('error', finish);
        child.once('exit', (code, signal) => finish(new Error('Test server exited before readiness: ' + (signal || code))));
      });
      return { port, close: () => stop(child) };
    } catch (error) {
      await stop(child);
      if (!errors.includes('EADDRINUSE') || attempt === 2) throw error;
    }
  }
  throw new Error('Unable to reserve a test port');
}

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const call = http.get({ hostname: '127.0.0.1', port, path: pathname }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    call.once('error', reject);
    call.setTimeout(5000, () => call.destroy(new Error('Test request timed out')));
  });
}

test('production server exposes only the explicit public routes', async t => {
  const server = await startServer();
  t.after(server.close);

  await t.test('all twelve production assets have exact content and safe MIME/cache headers', async () => {
    for (const [file, mime] of publicFiles) {
      const response = await request(server.port, '/' + file);
      assert.equal(response.status, 200, file);
      assert.equal(response.headers['content-type'], mime, file);
      assert.equal(response.headers['cache-control'], 'no-store', file);
      assert.equal(response.headers['x-content-type-options'], 'nosniff', file);
      assert.deepEqual(response.body, await fs.readFile(path.join(directory, file)), file);
    }
  });

  await t.test('root aliases index.html and query strings retain the intended route', async () => {
    const root = await request(server.port, '/');
    assert.equal(root.status, 200);
    assert.equal(root.headers['content-type'], 'text/html; charset=utf-8');
    assert.deepEqual(root.body, await fs.readFile(path.join(directory, 'index.html')));
    const queried = await request(server.port, '/compute.js?revision=server-test');
    assert.equal(queried.status, 200);
    assert.deepEqual(queried.body, await fs.readFile(path.join(directory, 'compute.js')));
  });

  await t.test('source files, workspace paths, configuration and original image files stay private', async () => {
    for (const route of ['/server.cjs', '/package.json', '/README.md', '/.env', '/.git/config', '/tests/server.test.cjs', '/assets/hero-day.png', '/assets/hero-night.png', '/Users/yuchenzhu/Desktop/github/ProbabilityLab/server.cjs']) {
      const response = await request(server.port, route);
      assert.equal(response.status, 404, route);
      assert.equal(response.body.toString(), 'Not found', route);
    }
  });

  await t.test('raw and encoded traversal never escape the route allowlist', async () => {
    for (const route of ['/../package.json', '/assets/../../server.cjs', '/%2e%2e/package.json', '/assets/%2e%2e/%2e%2e/.env', '/%2e%2e%2fpackage.json', '/assets%2fhero-day.webp', '/%2fUsers%2fyuchenzhu%2fDesktop%2fgithub%2fProbabilityLab%2fserver.cjs']) {
      const response = await request(server.port, route);
      assert.equal(response.status, 404, route);
      assert.equal(response.body.toString(), 'Not found', route);
    }
  });

  await t.test('browser verification pages are disabled without LAB_TESTS', async () => {
    for (const route of ['/tests/checks.html', '/tests/browser-checks.js']) assert.equal((await request(server.port, route)).status, 404, route);
  });

  await t.test('favicon is an empty 204 response', async () => {
    const response = await request(server.port, '/favicon.ico');
    assert.equal(response.status, 204);
    assert.equal(response.body.length, 0);
  });
});

test('browser verification is explicitly enabled only in test mode', async t => {
  const server = await startServer(true);
  t.after(server.close);
  for (const [file, mime] of [['tests/checks.html', 'text/html; charset=utf-8'], ['tests/browser-checks.js', 'text/javascript; charset=utf-8']]) {
    await t.test(file + ' is available with LAB_TESTS=1', async () => {
      const response = await request(server.port, '/' + file);
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-type'], mime);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.deepEqual(response.body, await fs.readFile(path.join(directory, file)));
    });
  }
  await t.test('test mode still does not expose arbitrary test source files', async () => {
    assert.equal((await request(server.port, '/tests/compute.test.cjs')).status, 404);
    assert.equal((await request(server.port, '/tests/server.test.cjs')).status, 404);
  });
});
