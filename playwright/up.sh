#!/usr/bin/env bash
# Start the virtual display and the browser harness, then wait until the bridge
# actually answers a command. Idempotent: a second run reports the running one.
#
#   playwright/up.sh [--force]     --force starts even if another bridge is live
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISP="${GEMINI_PW_DISPLAY:-:99}"
LOG=/tmp/gemini-pw-harness.log
PIDFILE=/tmp/gemini-pw-harness.pid
READY=/tmp/gemini-pw-harness.ready

# A running process is not a working one. An "already running" harness may still
# be inside page.goto, inside the readiness probe, or one second away from
# failing the ownership check - all of which satisfy `kill -0`. So this path
# does NOT return early: it falls through to the same wait below, and exit 0
# means "the bridge answered" no matter which path got us here.
if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "already running (pid $(cat "$PIDFILE")) - waiting for it to report ready"
else
  rm -f "$READY"

  # WSLg is off on this box (.wslconfig: guiApplications=false), so there is no X
  # server and a headed browser has nowhere to draw. Xvfb is that nowhere.
  if ! DISPLAY="$DISP" xdpyinfo >/dev/null 2>&1; then
    echo "starting Xvfb on $DISP"
    Xvfb "$DISP" -screen 0 "${GEMINI_PW_GEOMETRY:-1600x1000x24}" >/tmp/gemini-pw-xvfb.log 2>&1 &
    for _ in $(seq 1 15); do
      sleep 1
      DISPLAY="$DISP" xdpyinfo >/dev/null 2>&1 && break
    done
    DISPLAY="$DISP" xdpyinfo >/dev/null 2>&1 || { echo "FAILED: Xvfb did not come up on $DISP"; exit 1; }
  fi
  echo "display $DISP is up"

  cd "$HERE"
  DISPLAY="$DISP" node harness.mjs "$@" >"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
fi

# The harness writes the ready file only after the extension answers a command
# published by someone else. Waiting on the file means waiting on evidence.
for _ in $(seq 1 180); do
  sleep 1
  [[ -f "$READY" ]] && { echo "READY"; cat "$READY"; exit 0; }
  kill -0 "$(cat "$PIDFILE")" 2>/dev/null || { echo "harness exited early:"; cat "$LOG"; exit 1; }
done

echo "TIMED OUT waiting for the bridge to answer. Log:"
cat "$LOG"
exit 1
