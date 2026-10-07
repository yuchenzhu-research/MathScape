const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const Compute = require('../compute.js');

const directory = path.resolve(__dirname, '..');
const bootstrap = `
  const fs = require('node:fs');
  const vm = require('node:vm');
  const path = require('node:path');
  const { parentPort, workerData } = require('node:worker_threads');
  global.postMessage = (value, transfer) => parentPort.postMessage(value, transfer);
  global.importScripts = (...files) => files.forEach(file => {
    if (file === 'engine.js') global.DiceMath = require(path.join(workerData.directory, file));
    else vm.runInThisContext(fs.readFileSync(path.join(workerData.directory, file), 'utf8'));
  });
  vm.runInThisContext(fs.readFileSync(path.join(workerData.directory, 'worker.js'), 'utf8'));
  parentPort.on('message', data => global.onmessage({ data }));
`;

function workerFactory() {
  const thread = new Worker(bootstrap, { eval: true, workerData: { directory } });
  const adapter = {
    onmessage: null, onerror: null,
    postMessage(message) { thread.postMessage(message); },
    terminate() { thread.terminate(); }
  };
  thread.on('message', data => { if (adapter.onmessage) adapter.onmessage({ data }); });
  thread.on('error', error => { if (adapter.onerror) adapter.onerror(error); });
  return adapter;
}

async function main() {
  const target = Number(process.env.BENCHMARK_GROUPS || 5000000);
  const n = Number(process.env.BENCHMARK_DICE || 10);
  const logicalCores = os.availableParallelism();
  const trials = [];
  for (const workers of [1, 2, 4, 8, 12, 0]) {
    const configuration = { probabilities: [0.41, 0.26, 0.17, 0.09, 0.05, 0.02], n, target, seed: 20261007, workers, computeMode: 'cpu', recalibrate: true };
    const started = performance.now();
    const controller = Compute.create(configuration, () => {}, { workerFactory, navigator: { hardwareConcurrency: logicalCores } });
    const final = await controller.done;
    const totalWallMs = performance.now() - started;
    const summary = { requestedWorkers: workers, selectedWorkers: final.workers, groups: final.completed, rolls: final.completed * (n + 28), elapsedMs: final.elapsedMs, totalWallMs, preparationMs: final.info.preparationMs, cumulativeWorkerMs: final.computeMs, groupsPerSecond: final.completed * 1000 / final.elapsedMs, mean: final.states[0].counts.reduce((sum, count, value) => sum + count * value, 0) / final.completed, profile: final.info.profile };
    trials.push(summary);
    process.stdout.write(JSON.stringify(summary) + '\n');
  }
  const serial = trials[0].elapsedMs;
  const best = trials.reduce((a, b) => a.elapsedMs < b.elapsedMs ? a : b);
  process.stdout.write(JSON.stringify({ logicalCores, bestWorkers: best.selectedWorkers, speedup: serial / best.elapsedMs, note: 'Node worker_threads execute the browser worker protocol; these are not browser or GPU measurements.' }) + '\n');
}

main().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
