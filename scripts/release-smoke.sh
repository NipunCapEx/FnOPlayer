#!/usr/bin/env bash
# Safe deployment smoke checks for FnOPlayer. Never logs bearer tokens or response bodies.
set -euo pipefail

BASE_URL="${FOPLAYER_SMOKE_BASE_URL:-}"
if [[ -z "$BASE_URL" ]]; then
  echo "::error::Set FOPLAYER_SMOKE_BASE_URL to the deployed API HTTPS URL."
  exit 2
fi
BASE_URL="${BASE_URL%/}"
if [[ "$BASE_URL" != https://* && "${FOPLAYER_SMOKE_ALLOW_HTTP:-false}" != "true" ]]; then
  echo "::error::Smoke checks require HTTPS (set FOPLAYER_SMOKE_ALLOW_HTTP=true only for local testing)."
  exit 2
fi
if [[ "$BASE_URL" == *" "* ]]; then
  echo "::error::Base URL must not contain spaces."
  exit 2
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

request() {
  local path="$1"
  local output="$2"
  shift 2
  curl --silent --show-error --max-time "${FOPLAYER_SMOKE_TIMEOUT_SECONDS:-15}" \
    --output "$output" --write-out '%{http_code}' "$@" "$BASE_URL$path"
}

echo "Checking API liveness..."
health_status="$(request /health "$tmpdir/health.json")"
if [[ "$health_status" != "200" ]]; then
  echo "::error::GET /health returned HTTP $health_status."
  exit 1
fi
node - "$tmpdir/health.json" <<'NODE'
const fs = require('node:fs');
const health = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (health.status !== 'ok' || health.service !== 'foplayer-api') {
  console.error('Health response has an unexpected status or service identifier.');
  process.exit(1);
}
if (health.marketHoursConfigurationValid !== true) {
  console.error('Market-hours configuration is invalid; monitoring must remain fail-closed.');
  process.exit(1);
}
if (!health.monitoringReadiness || !health.notificationReadiness) {
  console.error('Health response is missing monitoring or notification diagnostics.');
  process.exit(1);
}
NODE

echo "Checking protected API rejects anonymous access..."
anonymous_status="$(request /api/dashboard "$tmpdir/anonymous.json")"
if [[ "$anonymous_status" != "401" ]]; then
  echo "::error::Unauthenticated GET /api/dashboard returned HTTP $anonymous_status (expected 401)."
  exit 1
fi

if [[ -n "${FOPLAYER_SMOKE_BEARER_TOKEN:-}" ]]; then
  echo "Checking authenticated dashboard access..."
  authenticated_status="$(request /api/dashboard "$tmpdir/dashboard.json" \
    --header "Authorization: Bearer $FOPLAYER_SMOKE_BEARER_TOKEN" \
    --header 'Accept: application/json')"
  if [[ "$authenticated_status" != "200" ]]; then
    echo "::error::Authenticated GET /api/dashboard returned HTTP $authenticated_status (expected 200)."
    exit 1
  fi
  node - "$tmpdir/dashboard.json" <<'NODE'
const fs = require('node:fs');
const dashboard = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!dashboard || typeof dashboard !== 'object' || Array.isArray(dashboard)) {
  console.error('Authenticated dashboard response is not a JSON object.');
  process.exit(1);
}
NODE

  echo "Checking authenticated watchlist endpoint (regression check for HTTP 500)..."
  watchlist_status="$(request /api/strategies "$tmpdir/watchlist.json" \
    --header "Authorization: Bearer $FOPLAYER_SMOKE_BEARER_TOKEN" \
    --header 'Accept: application/json')"
  if [[ "$watchlist_status" != "200" ]]; then
    echo "::error::Authenticated GET /api/strategies returned HTTP $watchlist_status (expected 200)."
    exit 1
  fi
  node - "$tmpdir/watchlist.json" <<'NODE'
const fs = require('node:fs');
const watchlist = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(watchlist)) {
  console.error('Authenticated watchlist response is not a JSON array.');
  process.exit(1);
}
NODE
else
  echo "Authenticated dashboard check skipped; FOPLAYER_SMOKE_BEARER_TOKEN was not supplied."
fi

echo "Smoke checks passed. This confirms API liveness and anonymous-access denial; it does not prove live market-data freshness or real Telegram/FCM delivery."
