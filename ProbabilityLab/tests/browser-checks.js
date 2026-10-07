(function () {
  'use strict';
  var report = { phase: 'ready', cores: navigator.hardwareConcurrency, gpuExposed: Boolean(navigator.gpu), checks: [], timings: [] };
  var button = document.getElementById('verify');
  function show() { document.getElementById('report').textContent = JSON.stringify(report, null, 2); }
  function same(a, b) {
    return a.completed === b.completed && a.states.every(function (s, i) {
      var o = b.states[i];
      return s.n === o.n && s.sum === o.sum && s.counts.every(function (v, j) { return v === o.counts[j]; }) && s.dice.every(function (v, j) { return v === o.dice[j]; });
    });
  }
  async function run(config) {
    var before = performance.now();
    var controller = ProbabilityCompute.create(config, function (value) { report.current = { phase: value.phase, completed: value.completed, backend: value.backend }; show(); });
    var result = await controller.done;
    controller.dispose();
    if (!result || result.phase !== 'done') throw new Error('Simulation did not complete: ' + JSON.stringify(result));
    return { result: result, totalMs: performance.now() - before };
  }
  button.addEventListener('click', async function () {
    button.disabled = true;
    report.phase = 'running'; show();
    try {
      var config = { probabilities: [40, 25, 15, 10, 7.5, 2.5], n: 10, target: 1000000, seed: 42, workers: 1, computeMode: 'cpu' };
      var baseline = null;
      for (var workers of [1, 4, 8]) {
        var trial = await run(Object.assign({}, config, { workers: workers }));
        if (!baseline) baseline = trial.result;
        if (!same(baseline, trial.result)) throw new Error('CPU partitions changed the seeded results');
        report.timings.push({ requested: workers, actual: trial.result.workers, backend: trial.result.backend, target: config.target, wallMs: trial.result.elapsedMs, preparationMs: trial.result.info.preparationMs, totalMs: trial.totalMs });
        show();
      }
      report.checks.push('CPU 1/4/8 workers: bit-exact histograms and latest dice');
      if (navigator.gpu) {
        try {
          for (var size of [1, 10, 100]) {
            var adapter = await ProbabilityGpu.create(size);
            report.gpuName = adapter.name;
            try {
              for (var probabilities of [[40,25,15,10,7.5,2.5], [0,0,1,0,0,0], [1,1,1,1,1,1], [0,.2,0,.3,0,.5]]) {
                for (var start of [0, 10737419, 99999500]) {
                  var expected = DiceMath.createSimulation(probabilities, size, 4294967295, start);
                  expected.advance(513);
                  var actual = await adapter.run({ probabilities: probabilities, seed: 4294967295 }, start, 513);
                  if (!same(expected.snapshot(), actual)) throw new Error('GPU mismatch n=' + size + ', start=' + start);
                }
              }
              report.checks.push('Real GPU n=' + size + ': 12 exact integer fixtures passed'); show();
            } finally { await adapter.close(); }
          }
          var gpuTrial = await run(Object.assign({}, config, { workers: 0, computeMode: 'gpu' }));
          if (!same(baseline, gpuTrial.result)) throw new Error('GPU million-group result changed seed');
          report.timings.push({ requested: 'gpu', actual: gpuTrial.result.workers, backend: gpuTrial.result.backend, wallMs: gpuTrial.result.elapsedMs, preparationMs: gpuTrial.result.info.preparationMs, totalMs: gpuTrial.totalMs, fallback: gpuTrial.result.info.fallbackReason });
          report.checks.push('GPU million-group end-to-end result matches CPU');
        } catch (error) { report.gpuError = error.message; }
      }
      var automatic = await run(Object.assign({}, config, { workers: 0, computeMode: 'auto', recalibrate: true }));
      if (!same(baseline, automatic.result)) throw new Error('Auto routing changed seeded results');
      report.auto = automatic.result.info;
      report.timings.push({ requested: 'auto', backend: automatic.result.backend, actual: automatic.result.workers, wallMs: automatic.result.elapsedMs, preparationMs: automatic.result.info.preparationMs, totalMs: automatic.totalMs });
      report.phase = report.gpuError ? 'passed_cpu_gpu_unavailable' : 'passed';
    } catch (error) { report.phase = 'failed'; report.error = error.message; }
    delete report.current;
    show(); button.disabled = false;
  });
  document.getElementById('stress').addEventListener('click', async function () {
    this.disabled = true;
    var n = Number(document.getElementById('stress-size').value);
    if (!Number.isInteger(n) || n < 1 || n > 100) { this.disabled = false; return; }
    report.stress = { phase: 'running', target: 100000000, n: n }; show();
    try {
      var stress = await run({ probabilities: [40,25,15,10,7.5,2.5], n: n, target: 100000000, seed: 42, computeMode: 'auto', workers: 0 });
      var moments = DiceMath.moments([40,25,15,10,7.5,2.5]);
      stress.result.states.forEach(function (state) {
        var empirical = DiceMath.empiricalMoments(state.counts);
        if (empirical.total !== 100000000) throw new Error('Lost or duplicated groups');
        if (Math.abs(empirical.mean - state.n * moments.mean) > 6 * moments.std * Math.sqrt(state.n / 100000000)) throw new Error('Mean outside six standard errors');
      });
      report.stress = { phase: 'passed', target: stress.result.completed, n: n, backend: stress.result.backend, workers: stress.result.workers, wallMs: stress.result.elapsedMs, preparationMs: stress.result.info.preparationMs, totalMs: stress.totalMs, allFiveHistogramTotals: stress.result.states.map(function (state) { return state.counts.reduce(function (a, b) { return a + b; }, 0); }), mean: DiceMath.empiricalMoments(stress.result.states[0].counts).mean };
    } catch (error) { report.stress = { phase: 'failed', error: error.message }; }
    delete report.current; show(); this.disabled = false;
  });
  show();
}());
