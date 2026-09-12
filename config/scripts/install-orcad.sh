#!/usr/bin/env bash
# Installer for orcad release artifacts from espetro/orca GitHub releases.
# Requires: curl, tar, sha256sum (or shasum on macOS), node >= 20.
set -euo pipefail

REPO="espetro/orca"
BASE_URL="https://github.com/${REPO}/releases"
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
INSTALL_ROOT="${HOME}/.local/share"
INSTALL_DIR="${INSTALL_ROOT}/orca-serve"
STAGING_DIR="${INSTALL_ROOT}/orca-serve.staging"
OLD_DIR="${INSTALL_ROOT}/orca-serve.old"

ORCAD_VERSION="${ORCAD_VERSION:-}"
HEALTH_PORT=""

usage() {
  cat <<EOF
Usage: install-orcad.sh [--version vX.Y.Z] [--health-port N] [--help]

Install the orcad release bundle for your platform into ${INSTALL_DIR}.

Options:
  --version vX.Y.Z   Pin a release tag (default: latest release). Same as ORCAD_VERSION env.
  --health-port N    After install, boot-check orcad on port N and report readiness (best effort).
  --help             Show this help.

Environment:
  ORCAD_VERSION      Release tag to install, e.g. v0.1.0.
EOF
}

fail() {
  echo "install-orcad: error: $*" >&2
  exit 1
}

log() {
  echo "install-orcad: $*"
}

# Parse flags
while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || fail "--version expects a value"
      ORCAD_VERSION="$2"
      shift 2
      ;;
    --version=*)
      ORCAD_VERSION="${1#--version=}"
      shift
      ;;
    --health-port)
      [ $# -ge 2 ] || fail "--health-port expects a value"
      HEALTH_PORT="$2"
      shift 2
      ;;
    --health-port=*)
      HEALTH_PORT="${1#--health-port=}"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown argument: $1"
      ;;
  esac
done

# Platform detection
case "$(uname -s)" in
  Linux) OS_NAME="linux" ;;
  Darwin) OS_NAME="darwin" ;;
  *)
    fail "unsupported platform '$(uname -s)'. See prebuilt assets at ${BASE_URL}"
    ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH_NAME="x64" ;;
  arm64|aarch64) ARCH_NAME="arm64" ;;
  *)
    fail "unsupported architecture '$(uname -m)'. See prebuilt assets at ${BASE_URL}"
    ;;
esac

SUPPORTED=false
[ "$OS_NAME" = "linux" ] && [ "$ARCH_NAME" = "x64" ] && SUPPORTED=true
[ "$OS_NAME" = "darwin" ] && [ "$ARCH_NAME" = "arm64" ] && SUPPORTED=true
if [ "$SUPPORTED" != "true" ]; then
  fail "no prebuilt orcad bundle for ${OS_NAME}-${ARCH_NAME}. See ${BASE_URL}"
fi
PLATFORM="${OS_NAME}-${ARCH_NAME}"

# Node check
if ! command -v node >/dev/null 2>&1; then
  fail "node is required but was not found in PATH. Install Node.js 20 or newer."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] 2>/dev/null || fail "node >= 20 required, found $(node --version)."

# Resolve version
resolve_latest_tag() {
  # Parse tag_name without jq. Handles both quoted and unquoted JSON strings.
  local response tag
  response="$(curl -sfL "$API_URL")" || response=""
  if [ -z "$response" ]; then
    log "failed to query GitHub API (rate limit or network error)."
    fail "set ORCAD_VERSION (e.g. ORCAD_VERSION=v0.1.0) or pass --version to pin a release."
  fi
  tag="$(printf '%s\n' "$response" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  if [ -z "$tag" ]; then
    # "Not Found" response means no releases exist yet for the repo.
    log "could not determine the latest release tag (no release published, or API response was unexpected)."
    fail "set ORCAD_VERSION (e.g. ORCAD_VERSION=v0.1.0) or pass --version to pin a release."
  fi
  printf '%s\n' "$tag"
}

if [ -z "$ORCAD_VERSION" ]; then
  log "resolving latest release..."
  ORCAD_VERSION="$(resolve_latest_tag)"
fi
TAG="$ORCAD_VERSION"
log "installing orcad ${TAG} for ${PLATFORM}"

# Download
TMP_DIR="$(mktemp -d)"
cleanup_tmp() { rm -rf "$TMP_DIR"; }
trap cleanup_tmp EXIT

ASSET_BASE="${BASE_URL}/download/${TAG}"
TARBALL="orca-serve-${PLATFORM}.tar.gz"
log "downloading ${TARBALL}..."
curl -fL --retry 3 -o "${TMP_DIR}/${TARBALL}" "${ASSET_BASE}/${TARBALL}" \
  || fail "download failed for ${TARBALL} at tag ${TAG}. Check ${BASE_URL}"
curl -fL --retry 3 -o "${TMP_DIR}/${TARBALL}.sha256" "${ASSET_BASE}/${TARBALL}.sha256" \
  || fail "download failed for ${TARBALL}.sha256 at tag ${TAG}."

# Checksum verification
if command -v sha256sum >/dev/null 2>&1; then
  SHASUM="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHASUM="shasum -a 256"
else
  fail "neither sha256sum nor shasum is available; cannot verify checksum."
fi
# sha files may contain "<hash>  <filename>"; strip everything after the hash.
EXPECTED_SHA="$(cut -d' ' -f1 "${TMP_DIR}/${TARBALL}.sha256" | head -1)"
ACTUAL_SHA="$($SHASUM "${TMP_DIR}/${TARBALL}" | cut -d' ' -f1)"
[ "$EXPECTED_SHA" = "$ACTUAL_SHA" ] || fail "checksum mismatch: expected ${EXPECTED_SHA}, got ${ACTUAL_SHA}"
log "checksum verified: ${ACTUAL_SHA}"

# Extract to staging, then atomic swap
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
tar -xzf "${TMP_DIR}/${TARBALL}" -C "$STAGING_DIR"

# Sanity check the staged tree before swapping. The bundle ships orcad.js
# (see config/scripts/build-orcad.mjs) next to its entry output.
[ -f "$STAGING_DIR/orcad.js" ] || fail "staged bundle is missing orcad.js; refusing to swap a broken install."

cleanup_staging() { rm -rf "$STAGING_DIR"; }
trap cleanup_staging EXIT

mkdir -p "$INSTALL_ROOT"
if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$OLD_DIR"
  mv "$INSTALL_DIR" "$OLD_DIR"
  if mv "$STAGING_DIR" "$INSTALL_DIR"; then
    rm -rf "$OLD_DIR"
  else
    # Restore the previous install rather than leaving nothing in place.
    mv "$OLD_DIR" "$INSTALL_DIR"
    fail "failed to move staged bundle into place; previous install restored."
  fi
else
  mv "$STAGING_DIR" "$INSTALL_DIR"
fi

log "installed orcad ${TAG} to ${INSTALL_DIR}"

# Optional health check: orcad accepts --port, --json, --bind, --no-pairing
# (see src/main/orcad/orcad-entry.ts parseArgs).
health_check() {
  local port="$1"
  local log_file pid
  log_file="$(mktemp)"
  node "${INSTALL_DIR}/orcad.js" --port "$port" --json >"$log_file" 2>&1 &
  pid=$!
  for _ in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "install-orcad: health check FAILED: orcad exited early. Output:" >&2
      tail -5 "$log_file" >&2
      rm -f "$log_file"
      return 1
    fi
    if node -e "fetch('http://127.0.0.1:${port}/').then(r => process.exit(r.ok || r.status < 500 ? 0 : 1)).catch(() => process.exit(1))" 2>/dev/null; then
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null || true
      rm -f "$log_file"
      echo "install-orcad: health check OK on port ${port}"
      return 0
    fi
    sleep 1
  done
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null || true
  rm -f "$log_file"
  echo "install-orcad: health check timed out waiting for port ${port}" >&2
  return 1
}

if [ -n "$HEALTH_PORT" ]; then
  case "$HEALTH_PORT" in
    ''|*[!0-9]*) fail "--health-port expects an integer port, got '${HEALTH_PORT}'" ;;
  esac
  # Best effort: a failed health check does not roll back the install.
  health_check "$HEALTH_PORT" || log "health check did not pass; the install itself is still in place."
fi

cat <<EOF

Next steps:
  1. Import the orcad oxmgr config:
       oxmgr import deploy/oxmgr/orcad.oxfile
  2. Start orcad through oxmgr, or manually:
       node ${INSTALL_DIR}/orcad.js --port <port>
EOF
