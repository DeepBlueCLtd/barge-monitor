#!/usr/bin/env bash
# Render the repository's documents to a static site under ./site.
#
# Usage: scripts/build-site.sh [OUT_DIR] [BANNER]
#   OUT_DIR  output directory (default: site)
#   BANNER   optional one-line notice shown at the top of every page,
#            e.g. "Preview of PR #12" for pull-request previews.
#
# Requires pandoc. Nothing here needs a server: open OUT_DIR/index.html.
set -euo pipefail

OUT_DIR="${1:-site}"
BANNER="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$OUT_DIR"
cp "$ROOT/scripts/site.css" "$OUT_DIR/site.css"

banner_args=()
if [ -n "$BANNER" ]; then
  banner_args=(--variable "banner=$BANNER")
fi

pandoc "$ROOT/srd-barge.md" \
  --standalone \
  --from gfm \
  --to html5 \
  --toc --toc-depth=2 \
  --template "$ROOT/scripts/site.html" \
  --css site.css \
  --metadata title="Software Requirements Document" \
  "${banner_args[@]}" \
  --output "$OUT_DIR/index.html"

# The implementation contract, as a page of its own beside the SRD.
pandoc "$ROOT/docs/v4-interfaces.md" \
  --standalone \
  --from gfm \
  --to html5 \
  --toc --toc-depth=2 \
  --template "$ROOT/scripts/site.html" \
  --css site.css \
  --metadata title="Version 4 interfaces" \
  "${banner_args[@]}" \
  --output "$OUT_DIR/interfaces.html"

# The SRD's companion mockups (non-normative).
mkdir -p "$OUT_DIR/mockups"
cp "$ROOT"/docs/mockups/*.png "$OUT_DIR/mockups/"

# GitHub Pages: serve files as-is, without Jekyll processing.
touch "$OUT_DIR/.nojekyll"

echo "Site written to $OUT_DIR"
