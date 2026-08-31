#!/usr/bin/env bash
# Stop the harness. Leaves Xvfb alone unless --all is given: another harness, or
# a debugging session, may still be using that display.
set -uo pipefail

PIDFILE=/tmp/gemini-pw-harness.pid
READY=/tmp/gemini-pw-harness.ready
DISP="${GEMINI_PW_DISPLAY:-:99}"

if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  PID="$(cat "$PIDFILE")"
  kill "$PID" 2>/dev/null
  for _ in $(seq 1 10); do
    sleep 1
    kill -0 "$PID" 2>/dev/null || break
  done
  kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
  echo "harness stopped (pid $PID)"
else
  echo "harness was not running"
fi
rm -f "$PIDFILE" "$READY"

if [[ "${1:-}" == "--all" ]]; then
  pkill -f "[X]vfb $DISP" && echo "Xvfb on $DISP stopped" || echo "no Xvfb on $DISP"
fi
