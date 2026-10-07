const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const D = require('../engine.js');

const root = path.resolve(__dirname, '..');
const target = Number(process.env.STRESS_GROUPS || 100000000);
const n = Number(process.env.STRESS_N || 10);
const requestedBackend = process.env.STRESS_BACKEND || 'auto';
const requestedWorkers = Number(process.env.STRESS_WORKERS || 0);
assert.ok(Number.isInteger(target) && target >= 1000000 && target <= 100000000, 'STRESS_GROUPS must be an integer from 1,000,000 to 100,000,000');
assert.ok(Number.isInteger(n) && n >= 1 && n <= 100, 'STRESS_N must be an integer from 1 to 100');
assert.ok(['auto', 'cpu', 'gpu'].includes(requestedBackend), 'STRESS_BACKEND must be auto, cpu or gpu');
assert.ok(Number.isInteger(requestedWorkers) && requestedWorkers >= 0 && requestedWorkers <= 128, 'STRESS_WORKERS must be an integer from 0 to 128');
const port = 4188;
const server = spawn(process.execPath, ['server.cjs'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;

(async () => {
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server timeout')), 10000);
      server.stdout.once('data', () => { clearTimeout(timeout); resolve(); });
      server.once('exit', (code) => { clearTimeout(timeout); reject(new Error('Server exit: ' + code)); });
    });
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath() });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    await page.addInitScript(() => {
      localStorage.setItem('probabilitylab.language', 'zh-Hant');
      localStorage.setItem('probabilitylab.theme', 'dark');
      localStorage.setItem('probabilitylab.compute', 'cpu');
      localStorage.setItem('probabilitylab.workers', '0');
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + port);
    await page.waitForFunction(() => window.diceLab && window.diceLab.getState().phase === 'done');
    await page.locator('#fixed-seed').check();
    await page.locator('#seed').fill('42');
    await page.locator('#seed').dispatchEvent('change');
    await page.locator('#group-size').evaluate((element, value) => {
      element.value = String(value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, n);
    await page.locator('.compute-settings summary').click();
    await page.locator('#compute-mode').selectOption(requestedBackend);
    const available = Number(await page.locator('#worker-count').getAttribute('max'));
    await page.locator('#worker-count').fill(String(Math.min(requestedWorkers, available)));
    await page.locator('#worker-count').dispatchEvent('change');
    await page.locator('#sample-count-input').fill(String(target));
    await page.locator('#sample-count-input').dispatchEvent('change');
    await page.locator('#start').click();
    await page.waitForFunction(() => window.diceLab.getState().completed >= 500000, null, { timeout: 60000 });
    const before = performance.now();
    await page.locator('[data-mode="mean"]').click({ timeout: 5000 });
    assert.equal(await page.evaluate(() => window.diceLab.getState().mode), 'mean');
    const interactionMs = performance.now() - before;
    let paused = null;
    if (await page.evaluate(() => window.diceLab.getState().phase) !== 'done') {
      await page.locator('#pause').click();
      await page.waitForFunction(() => ['paused', 'done'].includes(window.diceLab.getState().phase), null, { timeout: 10000 });
      if (await page.evaluate(() => window.diceLab.getState().phase) === 'paused') {
        paused = await page.evaluate(() => window.diceLab.getState().completed);
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => window.diceLab.getState().completed), paused);
        await page.locator('#pause').click();
      }
    }
    await page.waitForFunction(() => window.diceLab.getState().phase === 'done', null, { timeout: 300000 });
    const result = await page.evaluate(() => window.diceLab.getState());
    assert.equal(result.completed, target);
    assert.equal(result.n, n);
    assert.equal(result.seed, 42);
    assert.ok(['cpu', 'gpu', 'local'].includes(result.backend));
    if (requestedBackend === 'cpu') assert.ok(['cpu', 'local'].includes(result.backend));
    const source = D.moments(result.probabilities);
    const measured = result.states.map((dataset) => {
      assert.ok(dataset.counts.every((count) => Number.isInteger(count) && count >= 0));
      const moments = D.empiricalMoments(dataset.counts);
      assert.equal(moments.total, target);
      const expected = source.mean * dataset.n;
      const standardError = source.std * Math.sqrt(dataset.n / target);
      const tolerance = Math.max(1e-12, 6 * standardError);
      assert.ok(Math.abs(moments.mean - expected) <= tolerance, 'Mean smoke check failed for n=' + dataset.n);
      return { n: dataset.n, groups: moments.total, empiricalMean: moments.mean, theoreticalMean: expected, standardError, tolerance };
    });
    assert.deepEqual(errors, []);
    const report = {
      schemaVersion: 2, project: 'ProbabilityLab', runner: 'Playwright Chromium', testedAt: new Date().toISOString(),
      passed: true, target, n, requestedBackend, requestedWorkers, actualBackend: result.backend,
      workers: result.workers ?? result.info?.workers ?? null, preparationMs: result.info?.preparationMs ?? null,
      mainRolls: target * n, totalRolls: target * (n + 28), computeMs: result.computeMs, elapsedMs: result.elapsedMs,
      interactionMs, pausedAt: paused, distributions: measured, errors,
      statisticalNote: 'The six-standard-error mean check is a deterministic PRNG smoke test, not a proof of sample independence. See docs/numerical-contract.md.'
    };
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    const filename = ['stress', target, 'n' + n, requestedBackend, result.backend, 'workers' + requestedWorkers].join('-') + '.json';
    fs.writeFileSync(path.join(root, 'artifacts', filename), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
