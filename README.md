# MathScape

Interactive experiments in mathematics, statistics, and machine learning.

Explore concepts by changing parameters, running experiments, and seeing the results. This repository brings together small, self-contained learning projects; each experiment keeps its own code, instructions, and tests.

## Experiments

| Project | Explore |
| --- | --- |
| [ProbabilityLab](ProbabilityLab/) | Biased dice, Monte Carlo simulation, sampling distributions, and the central limit theorem |

### ProbabilityLab

- Adjust all six face probabilities, rolls per group, and repeated groups.
- Compare sums, means, and standardized values with exact distributions and normal approximations.
- Run parallel CPU workers or verified WebGPU computation, with automatic measured routing.
- Switch between original day/night themes and nine complete interface languages.
- Pause, step through individual groups, or reproduce results with a fixed seed.

Install Node.js, then run from the repository root:

```sh
cd ProbabilityLab
npm start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). No runtime package installation, API key, or model download is required.

To run its tests:

```sh
cd ProbabilityLab
npm test
```

See the [project README](ProbabilityLab/README.md) for controls, numerical assumptions, browser support, and measured performance.

## Adding experiments

Add each new project in its own top-level folder and list it above. An experiment should include a README describing how to run it, its assumptions, and its tests. Future projects can explore linear algebra, optimization, statistics, and machine learning without being tied to one framework.

## License

[MIT](LICENSE).
