(function () {
  'use strict';

  var D = DiceMath;
  var i18n = ProbabilityI18n.create(ProbabilityI18n.detect());
  var t = i18n.t;
  var $ = function (id) { return document.getElementById(id); };
  var presets = { fair: [1, 1, 1, 1, 1, 1], skew: [40, 25, 15, 10, 7.5, 2.5], ends: [45, 2.5, 2.5, 2.5, 2.5, 45] };
  var probabilities = D.normalize(presets.skew);
  var n = 10;
  var target = 100000;
  var mode = 'sum';
  var phase = 'ready';
  var backend = 'cpu';
  var computeInfo = null;
  var statusKey = 'statusReady';
  var logicalCores = Math.max(1, Math.floor(navigator.hardwareConcurrency || 2));
  var controller = null;
  var epoch = 0;
  var snapshot = null;
  var stats = D.moments(probabilities);
  var theories = {};
  var chartHit = null;
  var colors = {};
  var probabilityRows = [];
  var comparisonNodes = [];
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var positions = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

  function fmt(value, digits) {
    return i18n.number(value, digits);
  }

  function compact(value) {
    return i18n.compact(value);
  }

  function makeDie(value, size) {
    var die = document.createElement('span');
    die.className = 'die' + (size ? ' ' + size : '');
    die.setAttribute('role', 'img');
    die.setAttribute('aria-label', t('face', { face: fmt(value) }));
    positions[value].forEach(function (position) {
      var pip = document.createElement('span');
      pip.className = 'pip';
      pip.style.gridColumn = String(position % 3 + 1);
      pip.style.gridRow = String(Math.floor(position / 3) + 1);
      die.appendChild(pip);
    });
    return die;
  }

  function mountControls() {
    probabilities.forEach(function (_, index) {
      var row = document.createElement('div');
      row.className = 'probability-row';
      var head = document.createElement('div');
      head.className = 'probability-label';
      head.appendChild(makeDie(index + 1, 'tiny'));
      var label = document.createElement('label');
      label.htmlFor = 'probability-' + index;
      label.textContent = t('face', { face: fmt(index + 1) });
      var output = document.createElement('output');
      output.setAttribute('for', label.htmlFor);
      head.append(label, output);
      var input = document.createElement('input');
      input.id = label.htmlFor;
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.step = '0.1';
      input.setAttribute('aria-label', t('probabilityOf', { face: fmt(index + 1) }));
      input.addEventListener('input', function () {
        probabilities = D.adjustProbability(probabilities, index, Number(input.value) / 100);
        document.querySelectorAll('[data-preset]').forEach(function (button) { button.setAttribute('aria-pressed', 'false'); });
        reset('statusProbabilities');
      });
      row.append(head, input);
      $('probability-controls').appendChild(row);
      probabilityRows.push({ input: input, output: output, label: label, die: head.firstChild });
    });
    [1, 2, 10, 15].forEach(function (size) {
      var panel = document.createElement('section');
      panel.className = 'comparison-panel panel';
      var top = document.createElement('div');
      top.className = 'comparison-top';
      var heading = document.createElement('h3');
      heading.textContent = t('groupTitle', { n: fmt(size) });
      var count = document.createElement('span');
      top.append(heading, count);
      var dice = document.createElement('div');
      dice.className = 'comparison-dice';
      var wrap = document.createElement('div');
      wrap.className = 'comparison-canvas';
      var canvas = document.createElement('canvas');
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', t('groupTitle', { n: fmt(size) }));
      wrap.appendChild(canvas);
      panel.append(top, dice, wrap);
      $('comparison-grid').appendChild(panel);
      comparisonNodes.push({ n: size, panel: panel, heading: heading, count: count, dice: dice, canvas: canvas });
    });
  }

  function updateSettings() {
    probabilityRows.forEach(function (row, index) {
      row.input.value = String(probabilities[index] * 100);
      row.label.textContent = t('face', { face: fmt(index + 1) });
      row.die.setAttribute('aria-label', t('face', { face: fmt(index + 1) }));
      row.input.setAttribute('aria-label', t('probabilityOf', { face: fmt(index + 1) }));
      row.input.setAttribute('aria-valuetext', i18n.percent(probabilities[index], 2));
      row.output.textContent = i18n.percent(probabilities[index], 1);
      row.output.title = i18n.percent(probabilities[index], 6);
    });
    $('probability-total').textContent = t('probabilityTotal', { probability: i18n.percent(1) });
    $('group-size-value').textContent = i18n.quantity('roll', n);
    $('sample-count-value').textContent = t('groupCount_other', { count: compact(target) });
    $('sample-count').setAttribute('aria-valuetext', i18n.quantity('group', target));
    $('group-size').setAttribute('aria-valuetext', i18n.quantity('roll', n));
    $('total-rolls').textContent = t('totalRolls', { count: compact(n * target) });
    document.querySelectorAll('[data-count]').forEach(function (button) { button.textContent = i18n.shortNumber(Number(button.dataset.count)); });
    $('show-normal').disabled = stats.std === 0;
    document.querySelector('[data-mode="z"]').disabled = stats.std === 0;
    $('single-moments').textContent = t('singleMoments', { mean: fmt(stats.mean, 3), std: fmt(stats.std, 3) });
    $('source-chart').setAttribute('aria-label', t('sourceSummary', { values: probabilities.map(function (p, i) { return t('sourceFace', { face: fmt(i + 1), probability: i18n.percent(p, 2) }); }).join('; ') }));
    $('worker-count').max = String(logicalCores);
    $('worker-hint').textContent = t('workerHint', { max: fmt(logicalCores) });
    updateCalibrationControl();
    updateLesson();
  }

  function updateCalibrationControl() {
    $('calibrate').disabled = $('slow-mode').checked || Number($('worker-count').value) !== 0 || $('compute-mode').value === 'gpu';
  }

  function updateLesson() {
    if (stats.std === 0) {
      $('lesson-title').textContent = t('lessonZeroTitle');
      $('lesson-text').textContent = t('lessonZeroText');
    } else if (n === 1) {
      $('lesson-title').textContent = t('lessonOneTitle');
      $('lesson-text').textContent = t('lessonOneText');
    } else {
      $('lesson-title').textContent = t('lessonManyTitle');
      $('lesson-text').textContent = t('lessonManyText', { n: fmt(n), sumStd: fmt(Math.sqrt(n) * stats.std, 3), meanStd: fmt(stats.std / Math.sqrt(n), 3) });
    }
  }

  function buildTheories() {
    theories = {};
    [n, 1, 2, 10, 15].forEach(function (size) {
      if (!theories[size]) theories[size] = D.exactDistribution(probabilities, size);
    });
  }

  function cancelRun() {
    epoch += 1;
    if (controller) controller.dispose();
    controller = null;
  }

  function reset(message) {
    cancelRun();
    phase = 'ready';
    computeInfo = null;
    statusKey = message || 'statusReady';
    stats = D.moments(probabilities);
    if (stats.std === 0 && mode === 'z') mode = 'sum';
    buildTheories();
    snapshot = D.createSimulation(probabilities, n, 0).snapshot();
    snapshot.computeMs = 0;
    snapshot.elapsedMs = 0;
    updateSettings();
    renderAll();
    updateRunLabels();
  }

  function validateConfig() {
    var count = Number($('sample-count-input').value);
    var validCount = $('sample-count-input').value !== '' && Number.isInteger(count) && count >= 1 && count <= 100000000;
    $('count-error').hidden = validCount;
    $('count-error').textContent = validCount ? '' : t('invalidCount');
    var seed = Number($('seed').value);
    var validSeed = !$('fixed-seed').checked || ($('seed').value !== '' && Number.isInteger(seed) && seed >= 0 && seed <= 4294967295);
    $('seed-error').hidden = validSeed;
    $('seed-error').textContent = validSeed ? '' : t('invalidSeed');
    var workers = Number($('worker-count').value);
    var validWorkers = $('worker-count').value !== '' && Number.isInteger(workers) && workers >= 0 && workers <= logicalCores;
    $('worker-error').hidden = validWorkers;
    $('worker-error').textContent = validWorkers ? '' : t('invalidWorkers', { max: fmt(logicalCores) });
    if (!validCount || !validSeed || !validWorkers) return false;
    if (count !== target) {
      target = count;
      $('sample-count').value = String(Math.max(2, Math.log10(target)));
      reset('statusM');
    }
    return true;
  }

  function chooseSeed() {
    return $('fixed-seed').checked ? Number($('seed').value) >>> 0 : crypto.getRandomValues(new Uint32Array(1))[0];
  }

  function receive(data, token) {
    if (token !== epoch) return;
    snapshot = data;
    phase = data.phase;
    backend = data.backend || backend;
    computeInfo = data.info || computeInfo;
    renderAll();
    updateRunLabels();
  }

  function updateRunLabels() {
    var key = phase === 'done' ? 'statusDone' : phase === 'paused' ? 'statusPaused' : phase === 'preparing' ? (computeInfo && computeInfo.calibrating ? 'calibrating' : 'preparing') : phase === 'error' ? 'statusError' : phase === 'running' ? ($('slow-mode').checked ? 'statusSlow' : 'statusRunning') : statusKey;
    $('status').textContent = t(key, { count: compact(snapshot.completed) });
    $('timing').textContent = phase === 'ready' ? t('timingPending') : t('timingParallel', { compute: fmt((snapshot.computeMs || 0) / 1000, 3), elapsed: fmt((snapshot.elapsedMs || 0) / 1000, 2) });
    if (phase !== 'ready' && computeInfo && computeInfo.preparationMs > 0) {
      $('timing').textContent += ' · ' + t('timingPreparation', { preparation: fmt(computeInfo.preparationMs / 1000, 2) });
    }
    $('used-seed').textContent = phase === 'ready' ? t('seedPending') : t('seedUsed', { seed: fmt(snapshot.seed) });
    var pieces = [t('hardwareCores', { cores: fmt(logicalCores) })];
    if (!computeInfo) pieces.push(t('hardwarePending'));
    else {
      pieces.push(t(backend === 'gpu' ? 'hardwareGpu' : backend === 'local' ? 'hardwareLocal' : 'hardwareCpu', { workers: fmt(computeInfo.workers || snapshot.workers || 1) }));
      if (computeInfo.groupsPerSecond) pieces.push(t('throughput', { rate: compact(computeInfo.groupsPerSecond) }));
      var fallbackKeys = { gpu_unavailable: 'gpuUnavailable', gpu_mismatch: 'gpuMismatch', gpu_error: 'gpuError', worker_error: 'workerError', file_protocol: 'fileProtocol' };
      if (fallbackKeys[computeInfo.fallbackReason]) pieces.push(t(fallbackKeys[computeInfo.fallbackReason]));
    }
    $('hardware-info').textContent = pieces.join(' · ');
    $('hardware-info').title = t('hardwareHint');
  }

  function createRun(paused, recalibrate) {
    if (!validateConfig()) return false;
    cancelRun();
    var token = epoch;
    var seed = chooseSeed();
    var config = { probabilities: probabilities.slice(), n: n, target: target, seed: seed, slow: $('slow-mode').checked, paused: paused,
      computeMode: $('compute-mode').value, workers: Number($('worker-count').value), recalibrate: !!recalibrate };
    snapshot = D.createSimulation(probabilities, n, seed).snapshot();
    snapshot.computeMs = 0;
    snapshot.elapsedMs = 0;
    phase = 'preparing';
    computeInfo = null;
    renderAll();
    updateRunLabels();
    controller = ProbabilityCompute.create(config, function (data) { receive(data, token); });
    return true;
  }

  function setupCanvas(canvas) {
    var rect = canvas.getBoundingClientRect();
    var ratio = Math.min(window.devicePixelRatio || 1, 3);
    var width = Math.max(1, rect.width);
    var height = Math.max(1, rect.height);
    var pixelsW = Math.round(width * ratio);
    var pixelsH = Math.round(height * ratio);
    if (canvas.width !== pixelsW || canvas.height !== pixelsH) { canvas.width = pixelsW; canvas.height = pixelsH; }
    var context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.font = '11px -apple-system, BlinkMacSystemFont, "PingFang TC", sans-serif';
    return { ctx: context, width: width, height: height };
  }

  function tickStep(span, amount) {
    var raw = span / amount;
    var base = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-10))));
    var fraction = raw / base;
    return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * base;
  }

  function drawSource() {
    var scene = setupCanvas($('source-chart'));
    var c = scene.ctx;
    var left = 41, right = scene.width - 10, top = 24, bottom = scene.height - 33;
    var yMax = Math.min(1, Math.max(0.25, Math.ceil(Math.max.apply(null, probabilities) * 4) / 4));
    for (var i = 0; i <= 2; i += 1) {
      var value = yMax * i / 2;
      var y = bottom - (bottom - top) * i / 2;
      c.strokeStyle = colors.grid; c.lineWidth = 1;
      c.beginPath(); c.moveTo(left, y); c.lineTo(right, y); c.stroke();
      c.fillStyle = colors.muted; c.textAlign = 'right'; c.fillText(i18n.percent(value), left - 7, y + 4);
    }
    var step = (right - left) / 6;
    probabilities.forEach(function (p, index) {
      var x = left + step * (index + 0.5);
      var height = p / yMax * (bottom - top);
      c.fillStyle = colors.cyan;
      c.globalAlpha = 0.75; c.fillRect(x - step * .31, bottom - height, step * .62, height); c.globalAlpha = 1;
      c.fillStyle = colors.text; c.textAlign = 'center'; c.fillText(i18n.percent(p, 1), x, bottom - height - 7);
      drawCanvasDie(c, x - 10, bottom + 9, 20, index + 1);
    });
  }

  function drawCanvasDie(c, x, y, size, value) {
    c.fillStyle = colors.die;
    c.strokeStyle = colors['die-border'];
    c.lineWidth = 1;
    c.beginPath(); c.roundRect(x, y, size, size, 4); c.fill(); c.stroke();
    c.fillStyle = colors.cyan;
    positions[value].forEach(function (position) {
      c.beginPath(); c.arc(x + size * (.25 + (position % 3) * .25), y + size * (.25 + Math.floor(position / 3) * .25), size * .065, 0, Math.PI * 2); c.fill();
    });
  }

  function transformed(sum, size) {
    if (mode === 'mean') return sum / size;
    if (mode === 'z') return (sum - size * stats.mean) / (Math.sqrt(size) * stats.std);
    return sum;
  }

  function focusedRange(pmf, counts, size) {
    if ($('full-range').checked) return [size, 6 * size];
    var peak = Math.max.apply(null, pmf);
    var first = size, last = 6 * size;
    while (first < last && pmf[first] < peak * 1e-7 && !counts[first]) first += 1;
    while (last > first && pmf[last] < peak * 1e-7 && !counts[last]) last -= 1;
    return [Math.max(size, first - 1), Math.min(size * 6, last + 1)];
  }

  function line(c, points, color, dash, width) {
    if (!points.length) return;
    c.beginPath(); c.strokeStyle = color; c.lineWidth = width || 1.6; c.setLineDash(dash || []);
    points.forEach(function (point, i) { if (i === 0) c.moveTo(point[0], point[1]); else c.lineTo(point[0], point[1]); });
    c.stroke(); c.setLineDash([]);
  }

  function drawHistogram(canvas, dataset, small) {
    var scene = setupCanvas(canvas);
    var c = scene.ctx;
    var left = small ? 52 : 61, right = scene.width - 15, top = 18, bottom = scene.height - 47;
    var plotWidth = Math.max(1, right - left), plotHeight = Math.max(1, bottom - top);
    var pmf = theories[dataset.n];
    var range = focusedRange(pmf, dataset.counts, dataset.n);
    var binned = D.binDistribution(pmf, dataset.counts, dataset.n, small ? 6 * dataset.n + 1 : Math.max(6, Math.floor(plotWidth / 10)), range);
    var bins = binned.bins;
    var total = snapshot.completed;
    var sumMean = stats.mean * dataset.n;
    var sumStd = stats.std * Math.sqrt(dataset.n);
    var exact = $('show-exact').checked;
    var normal = $('show-normal').checked && sumStd > 0;
    bins.forEach(function (bin) {
      bin.frequency = total ? bin.count / total : 0;
      bin.normal = normal ? D.normalBinMass(bin.start, bin.end, sumMean, sumStd) : 0;
    });
    var peak = Math.max.apply(null, bins.map(function (bin) { return Math.max(bin.frequency, exact ? bin.probability : 0, normal ? bin.normal : 0); }));
    var yMax = Math.min(1, Math.max(0.05, Math.ceil(peak * 1.15 / tickStep(Math.max(peak, .01), 4)) * tickStep(Math.max(peak, .01), 4)));
    var low = transformed(range[0] - 0.5, dataset.n);
    var high = transformed(range[1] + 0.5, dataset.n);
    var xScale = function (x) { return left + (x - low) / (high - low) * plotWidth; };
    var yScale = function (p) { return bottom - p / yMax * plotHeight; };
    for (var j = 0; j <= 4; j += 1) {
      var probability = yMax * j / 4;
      var y = yScale(probability);
      c.strokeStyle = colors.grid; c.lineWidth = 1;
      c.beginPath(); c.moveTo(left, y); c.lineTo(right, y); c.stroke();
      c.fillStyle = colors.muted; c.textAlign = 'right'; c.fillText(i18n.percent(probability, yMax < .1 ? 1 : 0), left - 7, y + 4);
    }
    c.save();
    c.beginPath(); c.rect(left, top, plotWidth, plotHeight); c.clip();
    bins.forEach(function (bin) {
      var x1 = xScale(transformed(bin.start - .5, dataset.n));
      var x2 = xScale(transformed(bin.end + .5, dataset.n));
      var barTop = yScale(bin.frequency);
      c.fillStyle = bin.start <= dataset.sum && dataset.sum <= bin.end ? colors.highlight : colors.green;
      c.globalAlpha = .85;
      c.fillRect(x1 + .8, barTop, Math.max(.8, x2 - x1 - 1.6), bottom - barTop);
      c.globalAlpha = 1;
      bin.x1 = x1; bin.x2 = x2;
    });
    if (exact) line(c, bins.map(function (bin) { return [xScale(transformed(bin.center, dataset.n)), yScale(bin.probability)]; }), colors.cyan, [], 1.7);
    if (normal) line(c, bins.map(function (bin) { return [xScale(transformed(bin.center, dataset.n)), yScale(bin.normal)]; }), colors.amber, [5, 4], 1.8);
    if (bins.length === 1 && exact) {
      c.fillStyle = colors.cyan; c.beginPath(); c.arc(xScale(transformed(bins[0].center, dataset.n)), yScale(bins[0].probability), 3, 0, Math.PI * 2); c.fill();
    }
    c.restore();
    c.strokeStyle = colors.axis; c.lineWidth = 1;
    c.beginPath(); c.moveTo(left, top); c.lineTo(left, bottom); c.lineTo(right, bottom); c.stroke();
    var step = tickStep(high - low, plotWidth < 300 ? 3 : 6);
    if (mode === 'sum') step = Math.max(1, step);
    var decimals = mode === 'sum' ? 0 : Math.max(0, Math.min(3, -Math.floor(Math.log10(step))));
    c.textAlign = 'center'; c.fillStyle = colors.muted;
    for (var tick = Math.ceil(low / step) * step; tick <= high + step * 1e-5; tick += step) {
      var x = xScale(tick);
      if (x < left - .1 || x > right + .1) continue;
      c.beginPath(); c.moveTo(x, bottom); c.lineTo(x, bottom + 4); c.stroke();
      c.fillText(fmt(Math.abs(tick) < 1e-9 ? 0 : tick, decimals), x, bottom + 18);
    }
    var axisLabel = t(mode === 'sum' ? 'axisSum' : mode === 'mean' ? 'axisMean' : 'axisZ');
    c.fillStyle = colors.text; c.fillText(axisLabel, (left + right) / 2, scene.height - 6);
    c.save(); c.translate(12, (top + bottom) / 2); c.rotate(-Math.PI / 2); c.fillStyle = colors.muted; c.fillText(t('relativeFrequency'), 0, 0); c.restore();
    if (!total && !small) {
      c.fillStyle = colors.muted; c.textAlign = 'right'; c.fillText(t('chartEmpty'), right - 5, top + 13);
    }
    if (!small) {
      chartHit = { bins: bins, left: left, right: right, top: top, bottom: bottom, n: dataset.n };
      var omitted = 0;
      for (var s = dataset.n; s <= dataset.n * 6; s += 1) if (s < range[0] || s > range[1]) omitted += pmf[s];
      $('bin-note').textContent = t('binNote', { width: fmt(binned.width) }) + (omitted > 0 ? t('tailNote', { probability: i18n.percent(Math.max(.00000001, omitted), 6) }) : '');
      canvas.setAttribute('aria-label', t('chartSummary', { axis: axisLabel, count: fmt(total), mean: fmt(transformed(sumMean, dataset.n), 3) }));
    } else canvas.setAttribute('aria-label', t('compareSummary', { n: fmt(dataset.n), axis: axisLabel, count: fmt(total) }));
  }

  function updateDice(container, dice, size, maxVisible) {
    container.replaceChildren();
    if (!dice.length) {
      var empty = document.createElement('span');
      empty.className = 'extra-dice';
      empty.textContent = t('emptyDice');
      container.setAttribute('aria-label', t('emptyDice'));
      container.appendChild(empty);
      return;
    }
    var fragment = document.createDocumentFragment();
    dice.slice(0, maxVisible).forEach(function (value) { fragment.appendChild(makeDie(value, size)); });
    if (dice.length > maxVisible) {
      var extra = document.createElement('span');
      extra.className = 'extra-dice';
      extra.textContent = t('extraDice', { count: fmt(dice.length - maxVisible) });
      fragment.appendChild(extra);
    }
    container.appendChild(fragment);
    container.setAttribute('aria-label', t('diceSummary', { values: dice.map(function (value) { return fmt(value); }).join(', ') }));
  }

  function renderAll() {
    var style = getComputedStyle(document.documentElement);
    ['grid', 'cyan', 'green', 'amber', 'text', 'muted', 'die', 'die-border', 'highlight', 'axis'].forEach(function (key) { colors[key] = style.getPropertyValue('--' + key).trim(); });
    var main = snapshot.states[0];
    var empirical = D.empiricalMoments(main.counts);
    var theoryMean = mode === 'z' ? 0 : mode === 'mean' ? stats.mean : n * stats.mean;
    var theoryStd = mode === 'z' ? 1 : mode === 'mean' ? stats.std / Math.sqrt(n) : stats.std * Math.sqrt(n);
    var actualMean = empirical.mean === null ? null : transformed(empirical.mean, n);
    $('distribution-title').textContent = t(mode === 'sum' ? 'titleSum' : mode === 'mean' ? 'titleMean' : 'titleZ');
    $('theory-label').textContent = t(mode === 'sum' ? 'theorySum' : mode === 'mean' ? 'theoryMean' : 'theoryZ');
    $('observed-label').textContent = t(mode === 'sum' ? 'observedSum' : mode === 'mean' ? 'observedMean' : 'observedZ');
    $('theory-mean').textContent = fmt(theoryMean, 3);
    $('observed-mean').textContent = fmt(actualMean, 3);
    $('completed').innerHTML = compact(snapshot.completed) + ' <small>/ ' + compact(target) + '</small>';
    $('completed').setAttribute('aria-label', t('completedAria', { count: fmt(snapshot.completed), target: fmt(target) }));
    $('stat-note').textContent = t('statsNote', { std: fmt(theoryStd, 3), skew: fmt(stats.skewness / Math.sqrt(n), 3) });
    $('last-sum').textContent = main.sum === null ? '—' : fmt(main.sum);
    $('last-mean').textContent = main.sum === null ? '—' : fmt(main.sum / n, 2);
    $('latest-index').textContent = snapshot.completed ? t('latestGroup', { count: compact(snapshot.latestGroup || snapshot.completed) }) : t('latestEmpty');
    updateDice($('dice-tray'), main.dice, '', 24);
    $('dice-tray').classList.toggle('rolling', phase === 'running' && $('slow-mode').checked && !reducedMotion.matches);
    var percentage = snapshot.completed / target * 100;
    $('progress-fill').style.width = percentage + '%';
    document.querySelector('.progress-track').setAttribute('aria-valuenow', String(Math.min(100, percentage)));
    $('pause').disabled = phase !== 'running' && phase !== 'paused';
    $('pause').textContent = t(phase === 'paused' ? 'resume' : 'pause');
    $('step').disabled = phase === 'running' || phase === 'preparing';
    $('start').textContent = t(phase === 'running' || phase === 'paused' || phase === 'preparing' ? 'restart' : 'start');
    document.querySelectorAll('[data-mode]').forEach(function (button) { button.setAttribute('aria-pressed', String(button.dataset.mode === mode)); });
    drawSource();
    drawHistogram($('histogram'), main, false);
    comparisonNodes.forEach(function (node, index) {
      var data = snapshot.states[index + 1];
      node.heading.textContent = t('groupTitle', { n: fmt(node.n) });
      node.count.textContent = t('groupCount_other', { count: compact(snapshot.completed) });
      updateDice(node.dice, data.dice, 'mini', 15);
      if (data.sum !== null) {
        var result = document.createElement('span');
        result.textContent = 'Σ = ' + fmt(data.sum);
        node.dice.appendChild(result);
      }
      drawHistogram(node.canvas, data, true);
    });
  }

  function showTooltip(event) {
    if (!chartHit) return;
    var canvas = $('histogram'), rect = canvas.getBoundingClientRect();
    var x = event.clientX - rect.left, y = event.clientY - rect.top;
    var tip = $('chart-tooltip');
    if (x < chartHit.left || x > chartHit.right || y < chartHit.top || y > chartHit.bottom) { tip.hidden = true; return; }
    var bin = chartHit.bins.find(function (item) { return x >= item.x1 && x <= item.x2; });
    if (!bin) { tip.hidden = true; return; }
    var start = transformed(bin.start, n), end = transformed(bin.end, n);
    var precision = mode === 'sum' ? 0 : 3;
    var label = fmt(start, precision) + (bin.start === bin.end ? '' : ' – ' + fmt(end, precision));
    tip.textContent = t('tooltip', { label: t(mode === 'sum' ? 'sum' : mode === 'mean' ? 'mean' : 'z') + ' ' + label,
      count: fmt(bin.count), observed: i18n.percent(bin.frequency, 3), exact: i18n.percent(bin.probability, 3) });
    tip.hidden = false;
    tip.style.left = Math.max(0, Math.min(rect.width - tip.offsetWidth, x + 10)) + 'px';
    tip.style.top = Math.max(0, Math.min(rect.height - tip.offsetHeight, y - tip.offsetHeight - 8)) + 'px';
  }

  function refreshLanguage() {
    i18n.applyStatic(document);
    ProbabilityI18n.languages.forEach(function (language) {
      var option = $('language-select').querySelector('option[value="' + language.id + '"]');
      option.textContent = t('language_' + language.id);
    });
    $('language-select').value = i18n.language;
    $('chart-tooltip').hidden = true;
    updateSettings();
    if (!$('count-error').hidden) $('count-error').textContent = t('invalidCount');
    if (!$('seed-error').hidden) $('seed-error').textContent = t('invalidSeed');
    if (!$('worker-error').hidden) $('worker-error').textContent = t('invalidWorkers', { max: fmt(logicalCores) });
    if (snapshot) { renderAll(); updateRunLabels(); }
  }

  function savedSetting(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; }
  }

  function savePerformance() {
    var workers = Number($('worker-count').value);
    var valid = $('worker-count').value !== '' && Number.isInteger(workers) && workers >= 0 && workers <= logicalCores;
    $('worker-error').hidden = valid;
    $('worker-error').textContent = valid ? '' : t('invalidWorkers', { max: fmt(logicalCores) });
    if (!valid) return;
    updateCalibrationControl();
    try {
      localStorage.setItem('probabilitylab.compute', $('compute-mode').value);
      localStorage.setItem('probabilitylab.workers', String(workers));
    } catch (_) {}
    if (phase === 'ready') { statusKey = 'computeChange'; updateRunLabels(); }
  }

  ProbabilityI18n.languages.forEach(function (language) {
    var option = document.createElement('option');
    option.value = language.id;
    option.textContent = t('language_' + language.id);
    $('language-select').appendChild(option);
  });
  i18n.applyStatic(document);
  var savedCompute = savedSetting('probabilitylab.compute', 'auto');
  $('compute-mode').value = ['auto', 'cpu', 'gpu'].indexOf(savedCompute) >= 0 ? savedCompute : 'auto';
  var savedWorkers = Number(savedSetting('probabilitylab.workers', '0'));
  $('worker-count').value = String(Number.isInteger(savedWorkers) && savedWorkers >= 0 && savedWorkers <= logicalCores ? savedWorkers : 0);
  if (window.ProbabilityAppearance) $('theme-select').value = ProbabilityAppearance.getPreference();
  $('language-select').value = i18n.language;
  $('language-select').addEventListener('change', function () { i18n.setLanguage(this.value); refreshLanguage(); });
  $('theme-select').addEventListener('change', function () { if (window.ProbabilityAppearance) ProbabilityAppearance.setTheme(this.value); });
  document.addEventListener('probabilitylab:appearance', function () { if (snapshot) renderAll(); });
  $('compute-mode').addEventListener('change', savePerformance);
  $('worker-count').addEventListener('change', savePerformance);
  $('calibrate').addEventListener('click', function () { createRun(false, true); });
  mountControls();
  document.querySelectorAll('[data-preset]').forEach(function (button) {
    button.addEventListener('click', function () {
      probabilities = D.normalize(presets[button.dataset.preset]);
      document.querySelectorAll('[data-preset]').forEach(function (other) { other.setAttribute('aria-pressed', String(other === button)); });
      reset('statusPreset');
    });
  });
  $('group-size').addEventListener('input', function () { n = Number(this.value); reset('statusN'); });
  $('sample-count').addEventListener('input', function () {
    target = Math.max(100, Math.min(100000000, Math.round(Math.pow(10, Number(this.value)))));
    $('sample-count-input').value = String(target);
    $('count-error').hidden = true;
    reset('statusM');
  });
  $('sample-count-input').addEventListener('change', validateConfig);
  document.querySelectorAll('[data-count]').forEach(function (button) {
    button.addEventListener('click', function () { $('sample-count-input').value = button.dataset.count; validateConfig(); });
  });
  $('fixed-seed').addEventListener('change', function () { $('seed').disabled = !this.checked; reset('statusSeed'); });
  $('seed').addEventListener('change', function () { if (validateConfig()) reset('statusSeed'); });
  $('slow-mode').addEventListener('change', function () { if (controller) controller.send({ type: 'speed', slow: this.checked }); updateCalibrationControl(); updateRunLabels(); });
  $('start').addEventListener('click', function () { createRun(false); });
  $('pause').addEventListener('click', function () { if (controller) controller.send({ type: phase === 'paused' ? 'resume' : 'pause' }); });
  $('step').addEventListener('click', function () {
    if (!validateConfig()) return;
    if (!controller || phase === 'done' || phase === 'error') { if (!createRun(true)) return; }
    controller.send({ type: 'step' });
  });
  $('clear').addEventListener('click', function () { reset('statusCleared'); });
  document.querySelectorAll('[data-mode]').forEach(function (button) {
    button.addEventListener('click', function () { mode = button.dataset.mode; $('chart-tooltip').hidden = true; renderAll(); });
  });
  ['show-exact', 'show-normal', 'full-range'].forEach(function (id) {
    $(id).addEventListener('change', function () { $('chart-tooltip').hidden = true; renderAll(); });
  });
  $('histogram').addEventListener('pointermove', showTooltip);
  $('histogram').addEventListener('pointerdown', showTooltip);
  $('histogram').addEventListener('pointerleave', function () { $('chart-tooltip').hidden = true; });
  var resizeFrame = null;
  new ResizeObserver(function () {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(function () { resizeFrame = null; if (snapshot) renderAll(); });
  }).observe(document.querySelector('.visuals'));
  window.addEventListener('pagehide', cancelRun);
  window.diceLab = {
    getState: function () {
      return { probabilities: probabilities.slice(), n: n, target: target, mode: mode, phase: phase, backend: backend,
        language: i18n.language, theme: document.documentElement.dataset.theme,
        workers: snapshot.workers || 0, info: computeInfo, latestGroup: snapshot.latestGroup || snapshot.completed,
        completed: snapshot.completed, seed: snapshot.seed, computeMs: snapshot.computeMs, elapsedMs: snapshot.elapsedMs,
        states: snapshot.states.map(function (state) { return { n: state.n, counts: Array.from(state.counts), dice: state.dice.slice(), sum: state.sum }; }) };
    }
  };
  reset();
  createRun(false);
}());
