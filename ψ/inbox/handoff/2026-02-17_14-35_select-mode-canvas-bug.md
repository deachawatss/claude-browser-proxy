# Handoff: select_mode Canvas Bug + Debug Console Improvements

**Date**: 2026-02-17 14:35
**Context**: ~60%

## What We Did
- Created GitHub Gist with all extension files (4 files)
- Merged feat/tab-management branch to main (squash merge, PR #1)
- Set up dev-browser extension mode to control real Chrome browser
- Successfully sent message to Gemini via dev-browser ("What is 2+2?" -> "2+2=4")
- Added Deep Research button to debug.html (`select_mode` action)
- Added Canvas button to debug.html
- Made `select_mode` handler generic (uses `modeName` param instead of hardcoded "Deep Research")
- Discovered Gemini Tools menu uses `role="menuitemcheckbox"` with `aria-checked` for mode state
- Rewrote `select_mode` to: deselect any active mode first, then select new one

## Bug: Canvas Button Still Selects Deep Research
- Clicking Canvas button in debug.html sends `{action: 'select_mode', mode: 'Canvas'}` via MQTT
- But Gemini still selects Deep Research instead of Canvas
- The `menuitemcheckbox` iteration with `.includes(modeName)` should work
- Possible causes:
  - Extension not reloaded after code changes (most likely)
  - Menu items order: Deep Research comes first and somehow matches
  - `textContent.includes('Canvas')` matching wrong item

## Pending
- [ ] Fix Canvas mode selection (debug why it picks Deep Research)
- [ ] Test with extension reloaded (chrome://extensions -> reload)
- [ ] Verify MQTT command payload has `mode: "Canvas"` not `mode: "Deep Research"`
- [ ] Update second `select_mode` handler (content script message handler) - DONE
- [ ] Commit debug.html + background.js changes

## Next Session
- [ ] Reload extension and test Canvas button
- [ ] If still broken: add console.log to see what `modeName` arg is received
- [ ] If `.includes()` is the issue: use exact first-line match instead
- [ ] Test Deep Research -> Canvas switching (deselect + select flow)
- [ ] Commit and push all changes

## Key Files
- `background.js` - select_mode handler at ~line 834 (MQTT) and ~line 1109 (content script)
- `debug.html` - Canvas button at line 96, selectMode() JS function at ~line 267
- `manifest.json` - version 2.9.39

## Dev Browser Setup Notes
- Relay server: `cd ~/.claude/skills/dev-browser && nohup npx tsx scripts/start-relay.ts > /tmp/dev-browser-relay.log 2>&1 &`
- Extension must be toggled on in Chrome after relay starts
- Pages: `gemini` (Gemini tab), `debug` (debug.html tab)
