const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const I18n = require('../i18n.js');

const root = path.resolve(__dirname, '..');
const port = 4187;
const server = spawn(process.execPath, ['server.cjs'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
const errors = [];
const reports = [];
let browser;

async function ready() {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timeout')), 10000);
    server.stdout.once('data', () => { clearTimeout(timeout); resolve(); });
    server.once('exit', (code) => { clearTimeout(timeout); reject(new Error('Server exited: ' + code)); });
  });
}

function initialSettings() {
  try {
    const defaults = { 'probabilitylab.language': 'zh-Hant', 'probabilitylab.compute': 'cpu', 'probabilitylab.workers': '0', 'probabilitylab.theme': 'dark' };
    Object.entries(defaults).forEach(([key, value]) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, value); });
  } catch (_) {}
}

async function state(page) { return page.evaluate(() => window.diceLab.getState()); }
async function done(page) { await page.waitForFunction(() => window.diceLab && window.diceLab.getState().phase === 'done', null, { timeout: 60000 }); }
async function inputRange(page, selector, value) {
  await page.locator(selector).evaluate((element, next) => {
    element.value = String(next);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
async function setCount(page, value) {
  await page.locator('#sample-count-input').fill(String(value));
  await page.locator('#sample-count-input').dispatchEvent('change');
}
async function setWorkers(page, value) {
  await page.locator('#worker-count').fill(String(value));
  await page.locator('#worker-count').dispatchEvent('change');
}
async function overflow(page) {
  return page.evaluate(() => ({
    document: document.documentElement.scrollWidth > innerWidth + 1,
    elements: Array.from(document.querySelectorAll('main *')).filter((element) => {
      if (element.classList.contains('sr-only')) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.right > innerWidth + 2 || rect.left < -2);
    }).map((element) => element.className || element.id || element.tagName)
  }));
}
async function language(page, id) {
  await page.locator('#language-select').selectOption(id);
  assert.equal(await page.locator('html').getAttribute('lang'), id);
}
async function translatedStatic(page, id) {
  const expected = I18n.create(id);
  const labels = await page.locator('[data-i18n]').evaluateAll((elements) => elements.map((element) => ({ key: element.dataset.i18n, text: element.textContent })));
  for (const label of labels) assert.equal(label.text, expected.t(label.key), id + ': ' + label.key);
  const aria = await page.locator('[data-i18n-aria]').evaluateAll((elements) => elements.map((element) => ({ key: element.dataset.i18nAria, text: element.getAttribute('aria-label') })));
  for (const label of aria) assert.equal(label.text, expected.t(label.key), id + ' aria: ' + label.key);
  assert.equal(await page.title(), expected.t('pageTitle'));
}
async function theme(page, id) {
  await page.locator('#theme-select').selectOption(id);
  assert.equal(await page.locator('html').getAttribute('data-theme'), id);
}
async function run(page) { await page.locator('#start').click(); await done(page); return state(page); }

(async () => {
  try {
    await ready();
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath() });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
    await page.addInitScript(initialSettings);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto('http://127.0.0.1:' + port);
    await done(page);
    assert.equal((await state(page)).completed, 100000);
    assert.equal((await state(page)).backend, 'cpu');
    assert.equal(await page.locator('#comparison-grid canvas').count(), 4);
    assert.deepEqual(await overflow(page), { document: false, elements: [] });
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'artifacts', 'desktop-dark.png'), fullPage: true });

    const completedBaseline = await state(page);
    const languages = ['en', 'zh-Hant', 'zh-Hans', 'es', 'pt', 'ja', 'ko', 'fr', 'de'];
    assert.deepEqual(I18n.languages.map((item) => item.id), languages);
    for (const id of languages) {
      await language(page, id);
      await translatedStatic(page, id);
      assert.equal(await page.evaluate(() => localStorage.getItem('probabilitylab.language')), id);
      assert.deepEqual((await state(page)).states, completedBaseline.states, 'Language changes must not resample');
      assert.equal((await state(page)).seed, completedBaseline.seed);
      assert.deepEqual(await overflow(page), { document: false, elements: [] });
    }
    await language(page, 'zh-Hant');
    assert.doesNotMatch(await page.locator('.topbar-note').innerText(), /[A-Za-z]{3,}/);
    assert.equal(await page.locator('.brand [data-i18n]').innerText(), '機率實驗室');
    const nightCanvas = await page.locator('#histogram').evaluate((canvas) => canvas.toDataURL());
    await theme(page, 'light');
    await page.waitForFunction((reference) => document.querySelector('#histogram').toDataURL() !== reference, nightCanvas);
    const dayCanvas = await page.locator('#histogram').evaluate((canvas) => canvas.toDataURL());
    assert.notEqual(dayCanvas, nightCanvas, 'The canvas palette must follow the theme');
    assert.deepEqual((await state(page)).states, completedBaseline.states);
    await page.screenshot({ path: path.join(root, 'artifacts', 'desktop-light.png'), fullPage: true });
    await page.reload();
    await done(page);
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-Hant');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    reports.push('Nine localized interfaces and day/night canvas palettes preserve results; language/theme persist on reload');

    await page.locator('#fixed-seed').check();
    await page.locator('#seed').fill('42');
    await page.locator('#seed').dispatchEvent('change');
    await setCount(page, 10000);
    await page.locator('.compute-settings summary').click();
    await page.locator('#compute-mode').selectOption('cpu');
    await setWorkers(page, 1);
    const single = await run(page);
    assert.equal(single.backend, 'cpu');
    await setWorkers(page, Math.min(4, Number(await page.locator('#worker-count').getAttribute('max'))));
    const parallel = await run(page);
    assert.equal(parallel.backend, 'cpu');
    assert.deepEqual(parallel.states, single.states);
    assert.deepEqual((await run(page)).states, single.states);
    reports.push('Fixed seed: CPU one worker, parallel workers, and repeated runs match exactly');

    await page.locator('#compute-mode').selectOption('gpu');
    const accelerated = await run(page);
    assert.ok(['gpu', 'cpu', 'local'].includes(accelerated.backend));
    assert.deepEqual(accelerated.states, single.states);
    reports.push({ check: 'GPU if supported; otherwise explicit fallback', actualBackend: accelerated.backend, computeMs: accelerated.computeMs, elapsedMs: accelerated.elapsedMs });
    await page.locator('#compute-mode').selectOption('cpu');
    await setWorkers(page, 0);
    await page.locator('.compute-settings summary').click();

    await page.locator('[data-mode="mean"]').click();
    assert.equal((await state(page)).mode, 'mean');
    assert.match(await page.locator('#theory-mean').innerText(), /2\.275/);
    await page.locator('[data-mode="z"]').click();
    assert.equal((await state(page)).mode, 'z');
    assert.equal(await page.locator('#theory-mean').innerText(), '0.000');
    await inputRange(page, '#probability-5', 100);
    assert.deepEqual((await state(page)).probabilities, [0, 0, 0, 0, 0, 1]);
    assert.equal((await state(page)).completed, 0);
    assert.ok(await page.locator('[data-mode="z"]').isDisabled());
    assert.ok(await page.locator('#show-normal').isDisabled());
    await page.locator('#step').click();
    await page.waitForFunction(() => window.diceLab.getState().completed === 1);
    assert.equal((await state(page)).states[0].sum, 60);
    assert.match(await page.locator('#lesson-title').innerText(), /固定點/);
    reports.push('Degenerate die, mode switching and single step pass');

    await page.locator('[data-preset="skew"]').click();
    await setCount(page, 100);
    await page.locator('#slow-mode').check();
    await page.locator('#start').click();
    await page.waitForFunction(() => window.diceLab.getState().completed >= 3);
    await page.locator('#pause').click();
    await page.waitForFunction(() => window.diceLab.getState().phase === 'paused');
    const paused = await state(page);
    await language(page, 'es');
    await theme(page, 'dark');
    assert.deepEqual((await state(page)).states, paused.states);
    assert.equal((await state(page)).completed, paused.completed);
    assert.equal((await state(page)).phase, 'paused');
    await page.waitForTimeout(250);
    assert.equal((await state(page)).completed, paused.completed);
    await language(page, 'zh-Hant');
    await page.locator('#step').click();
    await page.waitForFunction((count) => window.diceLab.getState().completed === count + 1, paused.completed);
    await page.locator('#slow-mode').uncheck();
    await page.locator('#pause').click();
    await done(page);
    reports.push('Slow animation, pause, localized/theme changes, one step and resume preserve the experiment');

    await page.locator('#sample-count-input').fill('100000001');
    await page.locator('#start').click();
    assert.ok(await page.locator('#count-error').isVisible());
    await setCount(page, 100000000);
    assert.equal((await state(page)).target, 100000000);
    assert.equal((await state(page)).completed, 0);
    await setCount(page, 1000000);
    const million = await run(page);
    assert.equal(million.completed, 1000000);
    million.states.forEach((dataset) => assert.equal(dataset.counts.reduce((a, b) => a + b, 0), 1000000));
    reports.push({ benchmark: 'One million groups, all five distributions', n: million.n, backend: million.backend, computeMs: million.computeMs, elapsedMs: million.elapsedMs });

    await page.locator('[data-mode="mean"]').click();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(200);
      for (const id of languages) {
        await language(page, id);
        assert.deepEqual(await overflow(page), { document: false, elements: [] }, id + ' at ' + width + 'px');
      }
    }
    await language(page, 'zh-Hant');
    await page.screenshot({ path: path.join(root, 'artifacts', 'mobile.png'), fullPage: true });
    reports.push('1440px / 390px / 320px responsive layouts have no horizontal overflow in all nine languages');

    await page.locator('[data-mode="sum"]').click();
    await inputRange(page, '#group-size', 100);
    await setCount(page, 1000);
    await run(page);
    assert.equal((await state(page)).states[0].dice.length, 100);
    assert.deepEqual(await overflow(page), { document: false, elements: [] });

    const fallbackPage = await browser.newPage();
    await fallbackPage.addInitScript(() => {
      localStorage.setItem('probabilitylab.language', 'zh-Hant');
      localStorage.setItem('probabilitylab.compute', 'gpu');
    });
    await fallbackPage.route('**/dice.wgsl', (route) => route.abort());
    await fallbackPage.goto('http://127.0.0.1:' + port);
    await done(fallbackPage);
    const fallback = await state(fallbackPage);
    assert.ok(['cpu', 'local'].includes(fallback.backend));
    assert.equal(fallback.completed, 100000);
    fallback.states.forEach((dataset) => assert.equal(dataset.counts.reduce((a, b) => a + b, 0), 100000));
    reports.push({ check: 'Unavailable/blocked GPU shader falls back without losing samples', actualBackend: fallback.backend });
    await fallbackPage.close();

    const filePage = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await filePage.addInitScript(initialSettings);
    filePage.on('pageerror', (error) => errors.push(error.message));
    await filePage.goto('file://' + path.join(root, 'index.html'));
    await done(filePage);
    assert.equal((await state(filePage)).backend, 'local');
    assert.equal((await state(filePage)).completed, 100000);
    reports.push('Direct file mode: local chunked fallback passed');
    assert.deepEqual(errors, []);
    const report = { schemaVersion: 2, project: 'ProbabilityLab', runner: 'Playwright Chromium', testedAt: new Date().toISOString(), passed: true, reports, errors };
    fs.writeFileSync(path.join(root, 'artifacts', 'ui-test-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
