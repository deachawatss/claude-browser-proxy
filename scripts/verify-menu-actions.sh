#!/bin/bash
# Verify every Tools-menu action against a LIVE Gemini tab.
#
# THIS DRIVES A REAL BROWSER. Menus open and close on screen for two to three
# minutes, in whatever Chrome window is signed in to Gemini. That is why it
# refuses to run without --yes: an accidental run is indistinguishable from a
# runaway loop to whoever is using that browser.
#
# Usage:  ./scripts/verify-menu-actions.sh --yes [--skip-upload]
#
# Preconditions:
#   - mosquitto broker on localhost:1883
#   - the extension loaded and reporting online
#   - exactly one Gemini tab, signed in
#
# For the lazy-render check to mean anything, RELOAD the Gemini tab immediately
# before running. The Tools menu's content is lazily loaded: the first open after
# a page load renders an empty shell. A run against an already-warm menu passes
# while that bug is present, so a warm run is not evidence.

set -u

CMD_TOPIC="claude/browser/command"
RES_TOPIC="claude/browser/response"
HOST="${MQTT_HOST:-localhost}"

PLANNED=0     # checks this script intends to run
RAN=0         # checks that actually produced a verdict
PASSED=0
FAILED=0

if [ "${1:-}" != "--yes" ]; then
  echo "Refusing to run: this drives a live browser for minutes."
  echo "Re-run with --yes if that is what you want."
  exit 2
fi
SKIP_UPLOAD=0
[ "${2:-}" = "--skip-upload" ] && SKIP_UPLOAD=1

# Send one command and print the response payload. Publishes at QoS 1 with a `ts`
# so the broker queues it if the MV3 worker is asleep, and so the extension's
# staleness check has something to judge.
send() {
  local payload="$1" timeout_s="${2:-45}"
  local id="verify-$$-${RANDOM}"
  local body
  body=$(printf '%s' "$payload" | sed "s/^{/{\"id\":\"$id\",\"ts\":$(date +%s)000,/")
  local out; out=$(mktemp)
  # The payload goes through a FILE, not -m. An upload_file body carries base64
  # bytes and can be megabytes; passed as an argument it dies with
  # "Argument list too long" (verified: a 12MB arg fails, -f succeeds).
  local bodyfile; bodyfile=$(mktemp)
  printf '%s' "$body" > "$bodyfile"
  timeout $((timeout_s + 10)) mosquitto_sub -h "$HOST" -t "$RES_TOPIC" > "$out" 2>&1 &
  local subpid=$!
  sleep 1
  mosquitto_pub -h "$HOST" -t "$CMD_TOPIC" -q 1 -f "$bodyfile"
  rm -f "$bodyfile"
  local waited=0 line=""
  while [ $waited -lt "$timeout_s" ]; do
    line=$(grep -F "$id" "$out" 2>/dev/null | head -1)
    [ -n "$line" ] && break
    sleep 1; waited=$((waited + 1))
  done
  kill $subpid 2>/dev/null
  rm -f "$out"
  printf '%s' "$line"
}

# A check records a verdict. A check that never runs is counted separately from
# one that fails, so a crash mid-run can never be read as "everything passed".
check() {
  local name="$1" got="$2" want="$3"
  RAN=$((RAN + 1))
  if printf '%s' "$got" | grep -qF "$want"; then
    PASSED=$((PASSED + 1)); printf '  PASS  %s\n' "$name"
  else
    FAILED=$((FAILED + 1)); printf '  FAIL  %s\n         expected to contain: %s\n         got: %s\n' \
      "$name" "$want" "${got:0:200}"
  fi
}

echo "== bridge =="
PLANNED=$((PLANNED + 1))
STATUS=$(timeout 20 mosquitto_sub -h "$HOST" -t claude/browser/status -C 1 -W 10 2>&1)
check "extension is online" "$STATUS" '"subscribed":true'
echo "  version: $(printf '%s' "$STATUS" | grep -o '"version":"[^"]*"')"

echo "== list_modes =="
MODES=$(send '{"action":"list_modes"}' 45)
PLANNED=$((PLANNED + 2))
check "menu was measured (not a silent empty read)" "$MODES" '"menuOpened":true'
check "Deep research is present" "$MODES" 'Deep research'
# Calibration: the same check must FAIL for something that is not in the menu.
# Without this, a check that matches everything looks identical to a passing one.
PLANNED=$((PLANNED + 1))
RAN=$((RAN + 1))
if printf '%s' "$MODES" | grep -qF 'Telepathy mode'; then
  FAILED=$((FAILED + 1)); echo "  FAIL  calibration: matched a mode that does not exist"
else
  PASSED=$((PASSED + 1)); echo "  PASS  calibration: absent mode correctly not matched"
fi

echo "== mode toggles =="
for MODE in "Create image" "Create video" "Create music" "Canvas" "Deep research" "Guided learning"; do
  PLANNED=$((PLANNED + 2))
  ON=$(send "{\"action\":\"select_mode\",\"mode\":\"$MODE\"}" 60)
  check "$MODE -> on"  "$ON"  '"toggled":"on"'
  sleep 1
  OFF=$(send "{\"action\":\"select_mode\",\"mode\":\"$MODE\"}" 60)
  check "$MODE -> off" "$OFF" '"toggled":"off"'
  sleep 1
done

if [ "$SKIP_UPLOAD" -eq 0 ]; then
  echo "== upload_file =="
  FIXTURE_NAME="verify-fixture-$$.txt"
  FIXTURE_B64=$(printf 'claude-browser-proxy upload verification fixture\n' | base64 -w0)
  PLANNED=$((PLANNED + 1))
  UP=$(send "{\"action\":\"upload_file\",\"filename\":\"$FIXTURE_NAME\",\"mimeType\":\"text/plain\",\"contentBase64\":\"$FIXTURE_B64\"}" 60)
  check "small text file attaches" "$UP" '"attached":true'

  # Oversize must be refused, not hung on.
  PLANNED=$((PLANNED + 1))
  BIG=$(head -c 9000000 /dev/zero | base64 -w0)
  OVER=$(send "{\"action\":\"upload_file\",\"filename\":\"too-big.bin\",\"mimeType\":\"application/octet-stream\",\"contentBase64\":\"$BIG\"}" 45)
  unset BIG
  check "oversize file is rejected" "$OVER" 'over the'
fi

echo
echo "planned $PLANNED | ran $RAN | passed $PASSED | failed $FAILED"
if [ "$RAN" -ne "$PLANNED" ]; then
  echo "RESULT: INCOMPLETE — $((PLANNED - RAN)) check(s) never ran. This is NOT a pass."
  exit 3
fi
[ "$FAILED" -eq 0 ] && { echo "RESULT: PASS"; exit 0; }
echo "RESULT: FAIL"
exit 1
