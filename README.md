# Hat Tiling Billiards Simulation

This repository contains an interactive simulation and analysis tools for studying
tiling billiards on aperiodic hat tilings.

The project was developed as companion research code for a math paper, which can be found in the 
project page link. The mathematical motivation is to study billiard-like trajectories on aperiodic
tilings, a setting that appears to have seen very little direct exploration.
Diana Davis has briefly mentioned considering related simulations for Penrose
tiling billiards with Pat Hooper; this project focuses on the hat monotile substitution tiling.

Project page: https://aidan-perry.github.io/Hat-tiling-billiards-simulation/

The code began from Craig S. Kaplan's `hatviz` visualizer for constructing
aperiodic hat tilings. This repository extends that visualizer with trajectory
simulation, diagnostics, symbolic cutting sequences, and batch experiment
runners.

## What The App Does

- Builds finite patches of the aperiodic hat tiling from substitution rules.
- Lets the user choose a starting hat, edge, edge parameter, and direction.
- Traces a billiard-like path across adjacent hats.
- Displays one or two trajectories in the browser.
- Computes diagnostics such as distance between trajectories, distance from
  the starting point, vertex clearance, symbolic cutting sequences, and
  substring/language complexity.
- Includes command-line scripts for larger angle sweep experiments used during
  research.

## Quick Start

This project does not require installing npm packages. It uses plain JavaScript,
Node.js built-in modules, and a bundled copy of `p5.min.js`.

### Option 1: macOS launcher

On macOS, double-click:

```text
Start Hat Billiards Simulation.command
```

This starts the local compute server and opens:

- `http://127.0.0.1:8765/app.html`
- `http://127.0.0.1:8765/diagnostics.html`

Leave the terminal window open while using the app.

### Option 2: command line

From the repository directory:

```sh
node --max-old-space-size=12288 server.js
```

Then open:

```text
http://127.0.0.1:8765/app.html
```

The diagnostics page is:

```text
http://127.0.0.1:8765/diagnostics.html
```

The first trajectory run at supertile-level 6 may take roughly 20 seconds while the
server builds the tiling. Later runs with the same root type and level are
usually faster because the server caches the generated tiling. Trajectory runs with many bounces may take longer however.

## File Guide

- `app.html` - Main browser page for the simulation.
- `geometry.js` - Basic geometry helpers and the hat outline coordinates.
- `tiling.js` - Hat/metatile substitution rules, drawing code, browser UI,
  trajectory controls, SVG export, and JSON import/export.
- `engine.js` - Core simulation engine: builds tilings, computes adjacency,
  locates tiles, and traces trajectories.
- `server.js` - Local Node.js server for heavier trajectory computation,
  diagnostics, saved JSON output, and static file serving.
- `diagnostics.html` - Browser page shell for diagnostic graphs and sequences.
- `diagnostics.js` - Browser-side rendering for diagnostic graphs, statistics,
  and symbolic sequence displays.
- `batch-hat-sequences.js` - Command-line angle sweep for hat-edge cutting
  sequences.
- `run-hats-per-bounce-experiment.js` - Command-line experiment measuring
  distinct hats visited per bounce.
- `run-global-language-complexity-estimate.js` - Command-line estimate of
  global symbolic language complexity across sampled trajectories.
- `p5.min.js` - Bundled p5.js graphics library.

## Generated Files

The app and experiment runners can generate large local output folders/files.
These generated outputs are ignored by Git by default:

- `Diagnostics/`
- `Experiments/`
- `hat-billiards-trajectory-*.json`

The source code does not require these files to run. If you want to publish
specific data used in a paper, add only a curated subset and describe it.

## Known Limitations

The simulation uses floating-point arithmetic. In particular, the geometry
depends on numerical approximations to values such as `sqrt(3)`, so small errors
can accumulate when generating large finite patches and tracing long
trajectories.

All computations are also bounded by the generated tiling patch. A trajectory
may stop because it reaches the boundary of the available level rather than
because of an intrinsic mathematical obstruction.

## Citation And Attribution

If you use this code in academic work, please cite or acknowledge:

- Craig S. Kaplan's original hat tiling visualizer.
- The hat monotile work of David Smith, Joseph Samuel Myers, Craig S. Kaplan,
  and Chaim Goodman-Strauss.
- This repository, if the billiards simulation or diagnostics are used.

See `ACKNOWLEDGMENTS.md` for more detail.

## License

This project is distributed under the BSD 3-Clause License. See `LICENSE`.
