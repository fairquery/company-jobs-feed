#!/usr/bin/env bash
# Builds an MCPB bundle (build/fairquery-company-jobs-feed-mcp-<version>.mcpb) for local/stdio installs
# (Smithery "Local (MCPB Bundle)", Claude Desktop and other MCPB-aware clients).
# Contents: manifest.json, icon, compiled dist/, production node_modules only. No secrets, no .env.
set -euo pipefail
cd "$(dirname "$0")/.."
MCPB_CLI="@anthropic-ai/mcpb@2.1.2"
VERSION="$(node -p "require('./package.json').version")"
MANIFEST_VERSION="$(node -p "require('./manifest.json').version")"
if [ "$VERSION" != "$MANIFEST_VERSION" ]; then
  echo "manifest.json version ($MANIFEST_VERSION) != package.json version ($VERSION)" >&2; exit 1
fi
npm ci --ignore-scripts --no-audit --no-fund
npx tsc
STAGE="build/mcpb"
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp -R dist "$STAGE/dist"
cp package.json package-lock.json LICENSE README.md manifest.json "$STAGE/"
cp assets/icon.png "$STAGE/icon.png"
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && rm -f package-lock.json)
npx --yes "$MCPB_CLI" validate "$STAGE/manifest.json"
OUT="build/fairquery-company-jobs-feed-mcp-${VERSION}.mcpb"
rm -f "$OUT"
npx --yes "$MCPB_CLI" pack "$STAGE" "$OUT"
echo "Built $OUT"
# Smithery upload variant: same bundle, manifest tools carry inputSchema (see scripts/smithery-bundle.mjs).
SMITHERY_OUT="${OUT%.mcpb}-smithery.mcpb"
rm -f "$SMITHERY_OUT"
node scripts/smithery-bundle.mjs "$STAGE" "$OUT" "$SMITHERY_OUT"
