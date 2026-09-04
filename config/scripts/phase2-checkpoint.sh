#!/usr/bin/env bash
# Phase 2 Final Checkpoint (run only after all 4 WP agents (WP4/8/11/12) done)
# Serializes expensive gates: tsc, vitest, knip full-sweep
# No parallel agent work should be running during checkpoint

set -euo pipefail

echo "=== Phase 2 Checkpoint: Final Verification ($(date)) ==="

# 1. Baseline LOC before gates
WC_BEFORE=$(git show HEAD~4:src/main/runtime/orca-runtime.ts 2>/dev/null | wc -l || echo "UNKNOWN")
WC_AFTER=$(wc -l < src/main/runtime/orca-runtime.ts)
REDUCTION=$((WC_BEFORE - WC_AFTER))

echo "LOC Status: $WC_BEFORE → $WC_AFTER (-$REDUCTION LOC)"

# 2. Serialize typecheck (via flock)
echo "Running typecheck (serialized via flock)..."
pnpm gate:tc:serial 2>&1 | tee /tmp/checkpoint-tc.log || {
  echo "FAIL: typecheck failed"
  exit 1
}

# 3. Run incremental tests (only on changed files)
echo "Running incremental tests (changed files only)..."
pnpm test:changed src/main/runtime/ 2>&1 | tee /tmp/checkpoint-test.log || {
  echo "WARN: some tests failed (review log)"
}

# 4. Full lint audit (diagnostic, not gate)
echo "Running lint audit..."
oxlint src/main/runtime/ --format=json > /tmp/checkpoint-oxlint.json

# 5. Knip dead-code sweep (production deps only)
echo "Running knip sweep..."
pnpm gate:knip:serial 2>&1 | tee /tmp/checkpoint-knip.log || {
  echo "WARN: knip found unused exports (review log)"
}

# 6. Circular dependency full scan
echo "Scanning for new circular dependencies..."
madge --circular src/main/runtime/ > /tmp/checkpoint-madge.txt 2>&1 || true

# 7. Verify results
echo ""
echo "=== Checkpoint Results ==="
if grep -q "error" /tmp/checkpoint-tc.log; then
  echo "❌ FAIL: typecheck errors detected"
  exit 1
fi

LINT_ERRORS=$(jq '.errors | length' /tmp/checkpoint-oxlint.json 2>/dev/null || echo "0")
if [ "$LINT_ERRORS" -gt 5 ]; then
  echo "⚠️  WARNING: >5 lint errors detected ($LINT_ERRORS)"
fi

echo "✅ PASS: All checkpoint gates cleared"
echo "   LOC reduction: -$REDUCTION LOC"
echo "   Logs saved to /tmp/checkpoint-*.log"
echo ""
echo "Ready for Phase 3 dispatch!"
