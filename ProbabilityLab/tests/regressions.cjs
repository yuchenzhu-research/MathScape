const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath() });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('probabilitylab.language', 'zh-Hant');
      localStorage.setItem('probabilitylab.compute', 'cpu');
      localStorage.setItem('probabilitylab.workers', '0');
      window.workerCreations = 0;
      const OriginalWorker = Worker;
      window.Worker = class extends OriginalWorker {
        constructor(...args) { super(...args); window.workerCreations += 1; }
      };
    });
    await page.goto(process.env.PROBABILITYLAB_URL || 'http://127.0.0.1:4173/');
    await page.waitForFunction(() => window.diceLab && window.diceLab.getState().phase === 'done', null, { timeout: 60000 });
    const data = await page.evaluate(() => ({
      workers: window.workerCreations,
      reportedWorkers: window.diceLab.getState().workers,
      logicalCores: navigator.hardwareConcurrency,
      englishHeader: document.querySelector('.topbar-note').textContent,
      englishWords: document.body.innerText.match(/[A-Za-z]{3,}/g) || [],
      language: document.documentElement.lang,
      backend: window.diceLab.getState().backend,
      theme: document.documentElement.dataset.theme,
      elapsedMs: window.diceLab.getState().elapsedMs
    }));
    const failures = [];
    if (data.logicalCores > 1 && data.workers < 2) failures.push('Parallel CPU simulation: expected multiple workers, got ' + data.workers);
    if (data.backend !== 'cpu') failures.push('Requested CPU execution unexpectedly used ' + data.backend);
    if (data.language !== 'zh-Hant') failures.push('Traditional Chinese was not applied');
    if (/[A-Za-z]{3,}/.test(data.englishHeader)) failures.push('Traditional Chinese header still contains English: ' + data.englishHeader);
    if (data.englishWords.length) failures.push('Traditional Chinese interface still contains English words: ' + data.englishWords.join(', '));
    console.log(JSON.stringify({ schemaVersion: 2, project: 'ProbabilityLab', testedAt: new Date().toISOString(), ...data, failures }, null, 2));
    assert.deepEqual(failures, []);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
