#!/usr/bin/env bash
# Deploy the dashboard to Netlify as a prebuilt static deploy.
#
#   NETLIFY_AUTH_TOKEN=... ./deploy-netlify.sh
#
# Only index.html, mv7-core.js and _headers are uploaded. The site is
# https://mv7plus-control.netlify.app/ ; WebHID works there because Netlify
# serves HTTPS, and the page talks to the microphone attached to the visitor's
# own machine.
set -euo pipefail

SITE_ID="0d12ed95-c9e2-4268-b36c-8b194ac6f9ec"
API="https://api.netlify.com/api/v1"
DIR="$(cd "$(dirname "$0")" && pwd)"
ZIP="$DIR/dist/netlify-deploy.zip"

: "${NETLIFY_AUTH_TOKEN:?set NETLIFY_AUTH_TOKEN before running}"

mkdir -p "$DIR/dist"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp "$DIR/index.html" "$DIR/mv7-core.js" "$DIR/_headers" "$stage"/
rm -f "$ZIP"
( cd "$stage" && zip -q -r "$ZIP" . )

deploy_id="$(curl -sS -X POST \
  -H "Authorization: Bearer $NETLIFY_AUTH_TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary "@$ZIP" \
  "$API/sites/$SITE_ID/deploys" \
  | python3 -c 'import sys, json; print(json.load(sys.stdin)["id"])')"

echo "deploy $deploy_id uploaded, waiting for it to go live"
for _ in $(seq 1 30); do
  state="$(curl -sS -H "Authorization: Bearer $NETLIFY_AUTH_TOKEN" \
    "$API/sites/$SITE_ID/deploys/$deploy_id" \
    | python3 -c 'import sys, json; print(json.load(sys.stdin).get("state"))')"
  case "$state" in
    ready) echo "live: https://mv7plus-control.netlify.app/"; exit 0 ;;
    error) echo "deploy failed" >&2; exit 1 ;;
  esac
  sleep 4
done

echo "timed out waiting for the deploy" >&2
exit 1
