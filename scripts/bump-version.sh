#!/usr/bin/env bash
# Set manifest.json's version to a Chrome-legal CalVer, and refuse to write one
# Chrome would silently reinterpret.
#
# Chrome parses each dot-separated part as an integer 0..65535 and DROPS leading
# zeros, so a hand-written "26.9.1.0816" loads with the warning
#   "The extension version is parsed as '26.9.1.816'."
# and the manifest then disagrees with the version Chrome actually reports - the
# one that comes back on the MQTT status topic. Zero-padded %H%M produces that
# every day before 10am, which is exactly when nobody is looking closely.
#
# The trap inside the trap: $((0816)) is a bash error, not 816, because a
# leading zero means octal and 8 is not an octal digit. 10# forces base 10.
#
#   scripts/bump-version.sh            -> set from the clock
#   scripts/bump-version.sh --check    -> validate the current manifest, write nothing
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$HERE/manifest.json"

# A part is legal if it is 0, or starts 1-9, and is at most 65535.
version_is_legal() {
  local v="$1" part
  [[ "$v" =~ ^[0-9]+(\.[0-9]+){0,3}$ ]] || return 1
  while IFS= read -r part; do
    [[ "$part" =~ ^(0|[1-9][0-9]*)$ ]] || return 1   # rejects leading zeros
    (( part <= 65535 )) || return 1
  done < <(tr '.' '\n' <<<"$v")
  return 0
}

if [[ "${1:-}" == "--check" ]]; then
  current="$(grep -o '"version": *"[^"]*"' "$MANIFEST" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')"
  if version_is_legal "$current"; then
    echo "OK: $current is a version Chrome will not reinterpret"
    exit 0
  fi
  echo "ILLEGAL: $current — Chrome will reinterpret this (leading zero, or a part over 65535)"
  exit 1
fi

# %-m and %-d already drop the leading zero. HHMM cannot use %-, because the zero
# to strip is in the middle (08:16 -> 0816), so it goes through 10# arithmetic.
NEW="$(date +%y).$(date +%-m).$(date +%-d).$((10#$(date +%H%M)))"

version_is_legal "$NEW" || { echo "refusing to write an illegal version: $NEW"; exit 1; }

sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW\"/" "$MANIFEST"
echo "$NEW"
