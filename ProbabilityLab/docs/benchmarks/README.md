# Browser benchmark evidence

`browser-parallel-gpu-2026-10-07.json` records actual browser-worker and WebGPU runs, not synthetic speed estimates. All runs use the biased-die preset and a fixed seed of 42. One million groups were compared across one, four, and eight CPU workers and GPU computation. GPU fixtures cover group sizes 1, 10, and 100, zero probabilities, and large stream offsets. The stress run retains five histograms with exactly 100 million observations each.

Preparation and sampling wall time are recorded separately. The stress run reused a measured session profile. Browser memory is an approximate browser hint, not installed RAM. Timings describe this individual session and do not guarantee performance on another device.

Regenerate with the opt-in verification page described in the project README. Generated screenshots and temporary diagnostics stay in the ignored `artifacts/` directory; this small numerical report is kept as documentation evidence.
