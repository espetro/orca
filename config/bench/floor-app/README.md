# Floor bench app

This app measures the bare Electron/Chromium floor: a single empty BrowserWindow with no
Orca runtime, plugins, or IPC surface. Use it to establish the minimum footprint any
Orca measurement should be compared against.

The terminal workflow baseline is measured in the real app via the bench startup switch
(`ORCA_BENCH_ONLY=terminal` / `--only=terminal`), which skips non-terminal subsystem init.

Run standalone (paths resolve relative to this file):

```
electron config/bench/floor-app/main.mjs
```
