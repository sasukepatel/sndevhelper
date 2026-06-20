#!/usr/bin/env bash
#
# Build a clean Chrome Web Store / distribution zip.
# Includes everything Chrome needs (manifest + all assets) and EXCLUDES dev,
# VCS and tooling files. Run from the project root:  bash package.sh
#
set -euo pipefail

OUT="sn-dev-helper.zip"
rm -f "$OUT"

# Allowlist-by-exclusion: anything not excluded ships. New asset files (icons,
# extra scripts) are picked up automatically; dev/meta files are not.
zip -r "$OUT" . \
  -x '.git/*' \
     '.gitignore' \
     '.claude/*' \
     'CLAUDE.md' \
     'README.md' \
     'node_modules/*' \
     'dist/*' \
     'package.sh' \
     '*.zip' \
     '.DS_Store' \
     '*/.DS_Store'

echo "Built $OUT"
echo "Contents:"
unzip -l "$OUT"
