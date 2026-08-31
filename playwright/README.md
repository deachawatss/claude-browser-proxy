# Playwright harness — giving the agent eyes

The extension talks to Gemini through the DOM over MQTT. That works, but the
agent driving it is blind: on 2026-08-31 three stacked *"Start a new chat?"*
modals blocked every mode toggle for an hour, and nothing in the DOM reads said
so. Wind found them by looking at his screen.

This harness holds **one real browser** open with the extension loaded **from
this git checkout**, and lets anyone screenshot it at any time.

## What it fixes

| Before | Now |
|---|---|
| The agent could not see the page, only query it | `node shot.mjs` returns a picture |
| Chrome loaded the extension from a hand-made copy at `C:\Users\deach\gemini-proxy`; every change needed a manual reload click (~8 times in one session) | The extension loads from the checkout; a change ships by restarting the harness |
| Automation drove the browser Wind was using | A separate browser, separate profile |

## Quick start

```bash
playwright/up.sh          # start the display + browser, wait for the bridge to answer
node playwright/shot.mjs  # look at it  -> /tmp/gemini-shot.png
playwright/down.sh        # stop
```

`up.sh` prints `/tmp/gemini-pw-harness.ready`, which holds the CDP endpoint, the
profile path and the bridge's first answer.

## One bridge at a time

`background.js` uses a fixed MQTT client id (`MQTT_CLIENT_ID`). Two copies of
the extension — this one and one in your own Chrome — claim the same identity,
so the broker evicts whichever connected first and both keep reconnecting.

Measured on 2026-08-31, with both live: status publishes went from ~5 per minute
to **29 per minute**, the takeover fired the loser's last-will `offline`, and the
evicted side had not published anything again 60 seconds later. Commands did
keep reaching one browser (6 probes, all answered by the harness), so a run
against two bridges can look fine and still be reading the wrong browser.

`up.sh` therefore **refuses to start while another bridge answers commands**.
Disable the extension in your own Chrome (`chrome://extensions`), or pass
`--force` and accept the fight.

That refusal is a *prediction*, so it is never the last word. The startup probe
listens for 6 seconds, while the extension in your Chrome runs on a ~24 second
keepalive alarm — it can sleep through the whole probe, wake, take the shared
client id back, and answer the readiness check itself. So the harness **always**
requires the answering `tabId` to match its own, read from the `TAB:<id>` badge
`content.js` paints into the page. If it cannot read that badge it refuses to
start, rather than assume the answer was its own.

## No window on your desktop

`.wslconfig` sets `guiApplications=false`, so WSLg is off and this box has no X
server — `DISPLAY=:0` is set but nothing is listening on it. `up.sh` runs
**Xvfb**, a virtual display. Rendering is real and headed; only the monitor is
missing. Screenshots are how anyone looks at it.

To watch it live, or to sign in by hand, expose that display over noVNC:

```bash
Xvfb :99 -screen 0 1600x1000x24 &
env -u WAYLAND_DISPLAY x11vnc -display :99 -forever -shared -nopw -localhost -rfbport 5900 &
websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 &
# then open http://localhost:6080/vnc.html?autoconnect=1&resize=scale
```

`env -u WAYLAND_DISPLAY` is required: WSL exports `WAYLAND_DISPLAY=wayland-0`
with no compositor behind it, and x11vnc sees that, decides it is on Wayland,
and exits — leaving port 5900 dead while websockify serves a page as if all
were well.

## The Gemini login

The profile lives at `~/.cache/gemini-proxy-pw-profile` and keeps the session
across runs. It was signed in by hand over noVNC on 2026-08-31 and Google
accepted it.

Google refuses browsers that advertise automation, so the harness launches with
`ignoreDefaultArgs: ['--enable-automation']` and
`--disable-blink-features=AutomationControlled`, which put `navigator.webdriver`
back to `false`. If you ever wipe the profile, sign in again over noVNC as
above — the harness warns when the profile is signed out.

## Health is a round trip, never a flag

`bridge-probe.mjs` publishes a `get_url` carrying a unique id and waits for a
response with that id. Nothing else counts as alive.

The retained `claude/browser/status` topic is **not** a health check. Measured
on 2026-08-31: it reported `"subscribed": false` for 100 seconds straight while
the bridge answered every command. In mqtt.js, subscribing to a topic you are
already subscribed to calls back with `granted: []` and sends no packet, and
`background.js` reads an empty array as failure.
