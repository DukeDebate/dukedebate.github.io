#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# serve.sh -- build the site, then serve it locally for preview.
#
# The pages are BUILT from content/*.md into dist/ (see build.mjs) and this
# script serves that folder, so what you preview is exactly what gets
# published. Two steps, still one command -- you never have to remember to run
# the build yourself.
#
# Usage:
#   ./serve.sh          # builds, then serves on http://localhost:8000
#   ./serve.sh 9000     # or pick your own port
# Press Ctrl+C to stop.
#
# Re-run it after editing anything in content/ to rebuild.
# ---------------------------------------------------------------------------
set -euo pipefail

# Default port is 8000; first argument overrides it.
PORT="${1:-8000}"

# Always work from the directory this script lives in, no matter where it's
# called from, so build.mjs and dist/ are found.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is not installed or not on your PATH." >&2
  echo "Node.js builds the pages from the content/ folder; install it first." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is not installed or not on your PATH." >&2
  echo "Install Python 3, or serve the dist/ folder with any other static server." >&2
  exit 1
fi

echo "Duke University Debating Society"
echo "Building pages from content/ ..."
node build.mjs
echo

echo "Serving $SCRIPT_DIR/dist"
echo "Open your browser at:  http://localhost:${PORT}/"
echo "Press Ctrl+C to stop."
echo

# --directory serves the BUILT site. Python's http.server answers /about/ with
# dist/about/index.html and 301-redirects /about -> /about/, which is the same
# directory-index behavior GitHub Pages has, so links behave identically here
# and in production. (It does not serve dist/404.html for unknown paths -- that
# part is the host's job -- so a typo'd URL shows Python's own plain 404 here.)
exec python3 -m http.server "$PORT" --directory dist
