#!/usr/bin/env bash
# Screenshot the live Gemini tab and put the PNG in docs/img/.
#
#   scripts/shot.sh [name]        -> docs/img/<name>.png   (default: shot-<ts>.png)
#   scripts/shot.sh --out PATH    -> exactly PATH
#
# Why a script instead of the extension writing there directly: chrome.downloads
# only accepts a path RELATIVE to the browser's own download directory. Measured
# 2026-09-01, all four refused with "Invalid filename":
#   /home/deachawat/...            C:\Users\deach\...
#   ../../...                      \\wsl$\Ubuntu\home\...
# and only `gemini-proxy/ok.txt` was accepted. So the extension drops the capture
# in Downloads and this moves it. The default save location is docs/img/ from the
# caller's point of view, which is what was asked for.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMG_DIR="$REPO/docs/img"
DOWNLOADS="${GEMINI_DOWNLOADS_DIR:-/mnt/c/Users/deach/Downloads}"
HOST="${MQTT_HOST:-localhost}"

OUT=""
if [[ "${1:-}" == "--out" ]]; then
  OUT="${2:?--out needs a path}"
else
  NAME="${1:-shot-$(date +%Y%m%d-%H%M%S)}"
  OUT="$IMG_DIR/${NAME%.png}.png"
fi
mkdir -p "$(dirname "$OUT")"

id="shot-$$-${RANDOM}"
resp=$(mktemp)
# Line-buffered and id-filtered: the response topic also carries the side panel's
# own state polls, so taking the first message that arrives reads someone else's mail.
timeout 70 stdbuf -oL mosquitto_sub -h "$HOST" -t claude/browser/response > "$resp" 2>&1 &
subpid=$!
sleep 1
mosquitto_pub -h "$HOST" -q 1 -t claude/browser/command \
  -m "{\"id\":\"$id\",\"ts\":$(date +%s%3N),\"action\":\"screenshot\"}"

line=""
for _ in $(seq 1 60); do
  line=$(/usr/bin/grep -F "$id" "$resp" 2>/dev/null | head -1 || true)
  [ -n "$line" ] && break
  sleep 1
done
kill $subpid 2>/dev/null || true
rm -f "$resp"

if [ -z "$line" ]; then
  echo "no answer from the bridge. Is the extension online? (bun ~/.claude/skills/gemini/scripts/check.ts)" >&2
  exit 1
fi
if ! printf '%s' "$line" | /usr/bin/grep -q '"success":true'; then
  # The refusal carries its own fix - print it rather than a generic failure.
  printf '%s\n' "$line" >&2
  exit 1
fi

# The extension reports the filename it asked chrome.downloads for, relative to
# the download directory. Trust it only far enough to look for the file.
rel=$(printf '%s' "$line" | sed -n 's/.*"filename":"\([^"]*\)".*/\1/p')
src="$DOWNLOADS/$rel"
for _ in $(seq 1 20); do
  [ -f "$src" ] && break
  sleep 1
done
if [ ! -f "$src" ]; then
  echo "the bridge reported $rel but nothing appeared at $src" >&2
  exit 1
fi

mv "$src" "$OUT"
printf '%s\n' "$OUT"
