# Running `orca serve` from the packaged macOS app

How to get a browser-tab Orca client (no GUI window) from the packaged `.app`, and the two
launch pitfalls that make it look like serve mode is broken when it is not.

For the server-side contract (bind policy, data root, supervision, readiness payload), see
[`orcad-operations.md`](./orcad-operations.md). This doc covers the local desktop-app
launcher path on macOS.

## The straightforward invocation

Launch the app binary directly, not through the `orca` CLI shim:

```sh
~/Applications/Orca.app/Contents/MacOS/Orca serve --port 6799 --json
```

The readiness line on stdout contains `pairing.webClientUrl`:

```
http://127.0.0.1:6799/web-index.html#pairing=orca%3A%2F%2Fpair%3Fcode%3D...
```

Opening that URL in any browser pairs the tab with the runtime; the browser is then the
shell (the web preload API in `src/renderer/src/web/preload-api/` serves the same
`window.api` contract the Electron preload implements over IPC).

Verified working against both `Orca.app` (stable) and `Orca Canary.app` on macOS 26,
packaged builds. The `[app-icon] failed to clear macOS dock icon` errors on startup are
cosmetic: the icon-clearing `osascript`/`xattr` calls lack permission for user-land
`~/Applications` bundles and do not affect serve mode.

## Pitfall 1: the CLI shim breaks serve mode

The packaged CLI (`<app>/Contents/Resources/bin/orca`, what `orca` in `PATH` points at)
runs the CLI entrypoint under `ELECTRON_RUN_AS_NODE=1`. When that CLI then resolves the
foreground serve executable, two failure modes exist:

1. **Stable builds**: `serve` crashes with `AppEnvironment not initialized — call
setAppEnvironment() during startup before resolving app paths`. The serve-supervisor
   install path in the packaged `app.asar` resolves app paths before the app environment is
   set.
2. **Canary builds**: the bundled shim itself is broken. It hardcodes
   `CONTENTS/MacOS/Orca`, but the Canary binary is named `Orca Canary`, so the shim exits
   with `No such file or directory` before reaching the CLI at all.

Neither is a stable-vs-canary difference in serve capability — both bundles serve fine when
the real binary is invoked directly.

## Pitfall 2: the single-instance profile lock

A serve instance and a running GUI app (or a second serve instance) that share the default
user-data profile collide on the Electron single-instance lock:

```
[single-instance] Another Orca instance is already running for this userData profile
```

The env var the packaged app honors for profile isolation is `ORCA_USER_DATA_PATH_OVERRIDE`
(`src/main/startup/configure-process.ts` — it wins over all other resolution). Plain
`ORCA_USER_DATA_PATH` is not sufficient: main canonicalizes that env var _from_
`app.getPath('userData')`, so it cannot redirect the profile.

```sh
ORCA_USER_DATA_PATH_OVERRIDE="$TMPDIR/orca-serve-profile" \
  ~/Applications/Orca.app/Contents/MacOS/Orca serve --port 6800 --json
```

Isolated profiles also enable parallel serve instances against different app variants.

## Reference wrapper

A local wrapper that handles binary-name detection and profile isolation:

```bash
#!/usr/bin/env bash
# orca-serve: run the Orca runtime headless; open the printed webClientUrl in a browser tab.
# Usage: orca-serve [--port N] [extra orca serve args]
# Env:   ORCA_APP (app bundle path), ORCA_USER_DATA_PATH (isolated profile => parallel servers)
set -euo pipefail
APP="${ORCA_APP:-}"
if [ -z "$APP" ]; then
	for cand in "$HOME/Applications/Orca Canary.app" "/Applications/Orca Canary.app" "$HOME/Applications/Orca.app" "/Applications/Orca.app"; do
		if [ -d "$cand" ]; then APP="$cand"; break; fi
	done
fi
[ -n "$APP" ] || { echo "orca-serve: no Orca.app found (set ORCA_APP)" >&2; exit 1; }
# Binary name varies: 'Orca' vs 'Orca Canary' (the bundled bin/orca shim hardcodes 'Orca' and breaks on Canary).
BIN="$(ls "$APP/Contents/MacOS/" | grep -E '^Orca( Canary)?$' | head -1)"
[ -n "$BIN" ] || { echo "orca-serve: no Orca binary in $APP" >&2; exit 1; }
[ -n "${ORCA_USER_DATA_PATH:-}" ] || ORCA_USER_DATA_PATH="${TMPDIR:-/tmp}/orca-serve-profile-$(basename "$APP" .app)"
mkdir -p "$ORCA_USER_DATA_PATH"
export ORCA_USER_DATA_PATH_OVERRIDE="$ORCA_USER_DATA_PATH"
exec "$APP/Contents/MacOS/$BIN" serve "$@"
```

## Upstream bugs worth filing

1. `orca serve` crashes under the packaged CLI shim (`AppEnvironment not initialized` from
   the serve-supervisor install path when launched with `ELECTRON_RUN_AS_NODE=1`).
2. The Canary bundle's `Resources/bin/orca` shim hardcodes `Contents/MacOS/Orca` and cannot
   launch a bundle whose binary is `Orca Canary` (binary name should be resolved, as
   `cli-dev-launcher.ts` does for dev launchers).
