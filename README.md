# Manual Studio Standalone

This folder is a self-contained source project for the Manual Studio desktop application. It includes the shared analysis and manual libraries and a source snapshot of MarkIts.

## Prerequisites

- Rust and Cargo
- Node.js and npm
- Tauri 2 platform build prerequisites for your operating system
- Google Chrome for browser UI checks

## Setup and launch

Run `npm ci`, then `./start-manual-studio.sh` (or `python3 start_manual_studio.py`). The launcher builds the Manual Studio frontend, MarkIts frontend and desktop executable, and the Manual Studio app as needed. It adds this checkout's `target/debug` directory to `PATH` so Manual Studio can find the locally built MarkIts executable.

Use `./start-manual-studio.sh --dev` to launch Tauri's development mode. It prepares both frontends and the `manualctl` and MarkIts executables before starting the app. Use `npm run manual:bundle` to produce a distributable application. The Tauri bundle does not embed MarkIts Desktop; install `markits-desktop` separately and make it available on `PATH` when running the packaged app.

## Checks

`npm run manual:check` runs the isolated Manual Studio unit, browser, and Rust checks. `npm run manual:smoke-native` runs the desktop MarkIts handoff smoke test and requires a graphical desktop session.

The root npm package only contains dependencies for Manual Studio and its checks. MarkIts's own frontend dependencies and lockfile are kept under `crates/markits/apps/desktop`.

See `openspec/specs/manual-authoring/spec.md` and `crates/markits/openspec/specs/` for the retained feature specifications. See [UPSTREAM.md](UPSTREAM.md) for source provenance.

## Cross-platform builds and releases

GitHub Actions builds portable ZIP packages for Linux x64, Windows x64, macOS
Intel, and macOS Apple Silicon on pushes to `main` and pull requests. Each ZIP
contains `manual-studio`, `manualctl`, and the customized `markits-desktop` as
sibling executables. Extract the whole archive before starting Manual Studio.

Pushing a version tag matching the app version (for example `0.1.0`) builds all
four packages and publishes them to GitHub Releases after every build succeeds.
The executables are unsigned. Linux requires GTK 3 and WebKitGTK 4.1; Windows
requires WebView2. On macOS, grant screen recording and accessibility permissions
when using desktop capture.
