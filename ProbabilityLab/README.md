# ProbabilityLab

An interactive probability playground. Adjust a six-sided die, repeat Monte Carlo experiments, and explore how sampling distributions emerge. The first experiment teaches the central limit theorem; more educational demos can follow.

## Run locally

Install Node.js, open a terminal in this folder, and run:

```sh
npm start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). There are no runtime package dependencies, external fonts, model downloads, API keys, or data uploads. The server binds to your computer only. Static hosting over HTTPS also works.

Opening `index.html` directly uses a responsive chunked CPU fallback. A local server is recommended for parallel workers and WebGPU. Browser capabilities are detected at runtime; GPU support is not assumed from a device name.

## Controls

| Control | Range / behavior |
| --- | --- |
| Six face probabilities | 0–100%; other faces redistribute the remainder |
| Dice per group, n | 1–100 |
| Repeated groups, M | 1–100,000,000; logarithmic slider and exact input |
| Fixed seed | Optional unsigned 32-bit seed |
| Statistic | Sum, mean, standardized Z |
| Playback | Start, pause/resume, single step, clear, slow animation |
| Compute route | Automatic, CPU workers, GPU with verified fallback |
| CPU workers | Automatic or manual, capped by reported logical cores |
| Appearance | Night, day, system; saved locally |
| Language | English, Traditional Chinese, Simplified Chinese, Spanish, Brazilian Portuguese, Japanese, Korean, French, German |

Four comparison panels independently sample n = 1, 2, 10, and 15. A run performs **M × (n + 28)** rolls across five distributions. Slow playback is approximately ten groups per second and is for observation, not throughput.

Changing sampling parameters resets the experiment. Changing language, theme, plot overlays, or statistic preserves its results.

## Reading the plots

More groups M reduce sampling noise; more rolls n per group make non-degenerate sums and means approach normality. Repeating a single biased die does not turn its six possible outcomes into a bell curve.

- One roll: mean μ, standard deviation σ.
- Sum S: mean nμ, standard deviation √n·σ.
- Mean X̄: mean μ, standard deviation σ/√n.
- Z = (S − nμ)/(√n·σ), defined only when σ > 0.

Bars show actual sample frequencies. The exact line uses discrete convolution. The normal approximation integrates each bar interval with continuity correction, rather than comparing density to probability. A deterministic die remains a point mass; normal approximation and Z are disabled.

## Computation

The coordinator partitions an indexed seeded stream into disjoint ranges and merges integer histogram counts. Worker count, batch size, and pause timing do not change seeded final results.

Large automatic runs warm up and measure CPU candidates and an available GPU, validate GPU results against CPU fixtures, and choose a measured route. A session cache avoids repeating calibration for unchanged settings. Small runs use a lightweight route. Manual worker counts apply to CPU computation.

WebGPU uses exact unsigned-integer sampling and local workgroup histograms. Missing support, failed validation, or execution errors trigger a visible fallback. Browser memory hints are approximate and optional, not installed RAM measurements. Only histograms and the latest group are retained, not every group.

Timing separates preparation/calibration, accumulated active computation, and sampling wall time. CPU active time is summed across workers. GPU time includes submission/readback, not only shader execution. The generator is pseudorandom, not cryptographic or a mathematical independence guarantee; see the [numerical contract](docs/numerical-contract.md) for finite-period limitations.

## Tests

```sh
npm test
node tests/pool-benchmark.cjs
```

Dependency-free tests cover probability math, exact convolution, seed/range partitioning, actual worker protocol, pause/step/cancellation, failure recovery, GPU integer logic/lifecycle, localization, and static-server access boundaries.

Enable the opt-in real-browser verification page with `LAB_TESTS=1 npm start`. On PowerShell use `$env:LAB_TESTS="1"; npm start`. Open [the verification page](http://127.0.0.1:4173/tests/checks.html). It compares actual workers and GPU dispatch with CPU results and can run 100 million groups. Diagnostics are not served in normal mode.

Optional Playwright scripts provide UI, regression, and stress checks for maintainers with Playwright/Chromium installed. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select an existing Chrome executable. They are not runtime dependencies.

### Measured browser example

2026-10-07, local in-app browser on the user's Apple M5 Pro, 18 exposed logical cores, biased-die preset, n = 10, all five histograms. Individual measurements, not guaranteed performance:

| Run | Sampling wall time | Separate preparation |
| --- | ---: | ---: |
| 1 million, 1 CPU worker | 0.808 s | 0.007 s |
| 1 million, 4 CPU workers | 0.217 s | 0.006 s |
| 1 million, 8 CPU workers | 0.114 s | 0.010 s |
| 1 million, warmed GPU | 0.006 s | 0.003 s |
| 100 million, automatic GPU, earlier cold run | 0.860 s | 0.503 s |
| 100 million, automatic GPU, cached profile | 0.438 s | 0.009 s |

Million-group CPU/GPU histograms and latest dice were bit-exact. Real GPU fixtures passed for n = 1, 10, and 100, zero probabilities and large offsets. The 100-million run produced five totals of exactly 100 million and main mean 22.74949973 versus theoretical 22.75. Hardware, browser, UI updates, temperature, and other running software affect timings. The [latest real-browser report](docs/benchmarks/browser-parallel-gpu-2026-10-07.json) records raw measurements; [historical single-worker results](docs/baseline-single-worker.md) are kept separately.

## Files

- `engine.js`: math and indexed seeded simulation.
- `compute.js`, `worker.js`: routing, worker pool, progress, cancellation.
- `gpu.js`, `dice.wgsl`: optional GPU computation.
- `i18n.js`: complete locale dictionaries and number formatting.
- `appearance.js`, `styles.css`: persisted themes and responsive design.
- `app.js`, `index.html`: controls, Canvas charts, explanations.
- `assets/`: original night/day artwork; [references and generation prompts](docs/design-notes.md).
- `server.cjs`: dependency-free loopback-only server.
- `tests/`: numerical, lifecycle, locale, server and browser checks.

ProbabilityLab is an experiment in [MathScape](../README.md). The repository's [MIT license](../LICENSE) applies to this project.
