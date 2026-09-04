#!/usr/bin/env bash
set -euo pipefail

LOCK_FILE="/tmp/orca-expensive-gates.lock"
TIMEOUT="${TIMEOUT:-600}"  # 10 min max hold
GATE_NAME="${1:?Missing gate name (tc|test|knip)}"
shift

# Acquire exclusive lock (blocks until available)
exec 9>"$LOCK_FILE"
if ! timeout "$TIMEOUT" flock -x 9 2>/dev/null; then
  echo "ERROR: Gate lock timeout after ${TIMEOUT}s" >&2
  exit 1
fi

# Log holder to help debugging
echo "Agent $$ holding $GATE_NAME gate at $(date)" >> /tmp/orca-gate-log.txt

# Run the gate
case "$GATE_NAME" in
  tc)
    pnpm tc "$@"
    ;;
  test)
    pnpm test --run "$@"
    ;;
  knip)
    pnpm knip --production "$@"
    ;;
  *)
    echo "Unknown gate: $GATE_NAME" >&2
    exit 1
    ;;
esac

# Lock automatically releases on exit
