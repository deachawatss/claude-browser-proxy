#!/usr/bin/env bash
# Stop the harness. Leaves Xvfb alone unless --all is given: another harness, or
# a debugging session, may still be using that display.
set -uo pipefail

PORT="${GEMINI_PW_CDP_PORT:-9223}"
PIDFILE="/tmp/gemini-pw-harness-$PORT.pid"
READY="/tmp/gemini-pw-harness-$PORT.ready"
DISP="${GEMINI_PW_DISPLAY:-:99}"

# Same reasoning as up.sh: `kill -0` answers "does some process own this number",
# which after a pid recycle is a different question from "is our harness alive".
# Signalling on that answer would kill an innocent process.
harness_alive() {
  local pid="${1:-}"
  [[ -n "$pid" && -r "/proc/$pid/cmdline" ]] || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q 'harness\.mjs'
}

PID="$(cat "$PIDFILE" 2>/dev/null || true)"
if harness_alive "$PID"; then
  kill "$PID" 2>/dev/null
  for _ in $(seq 1 10); do
    sleep 1
    harness_alive "$PID" || break
  done
  if harness_alive "$PID"; then
    kill -9 "$PID" 2>/dev/null
    sleep 1
  fi
  # Report what happened, not what was attempted. The old version printed
  # "harness stopped" straight after kill -9, without ever looking again.
  if harness_alive "$PID"; then
    echo "FAILED to stop the harness (pid $PID) - it survived SIGKILL"
    exit 1
  fi
  echo "harness stopped (pid $PID)"
else
  echo "harness was not running"
fi
rm -f "$PIDFILE" "$READY"

if [[ "${1:-}" == "--all" ]]; then
  pkill -f "[X]vfb $DISP" && echo "Xvfb on $DISP stopped" || echo "no Xvfb on $DISP"
fi
