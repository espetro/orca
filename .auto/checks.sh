#!/bin/bash
# Fast chrome check for the resource-observability chrome (exp/mem-autoresearch).
set -euo pipefail

CHROME_TESTS=(
  src/main/metrics/resource-recorder.test.ts
  src/main/metrics/resource-recorder-ipc.test.ts
  src/shared/resource-recorder-parsers.test.ts
  src/renderer/src/lib/resource-e2e-bridge.test.ts
  config/scripts/run-release-memory-benchmark.test.mjs
  config/scripts/resource-metrics-analysis.test.mjs
)

pnpm vitest run --config config/vitest.config.ts "${CHROME_TESTS[@]}"

pnpm tc:node 2>&1 | tail -50

BASE=a1f198be0d96c7152997a1fd178ad4f201fa7e67
if ! git cat-file -e "$BASE" 2>/dev/null; then
  BASE=HEAD~1
fi
if git diff --name-only "$BASE" -- src/renderer/src | grep -q .; then
  pnpm tc:web 2>&1 | tail -50
fi
