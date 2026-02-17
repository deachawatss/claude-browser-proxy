# Screenshot Is Specification

**Date**: 2026-02-17
**Context**: claude-browser-proxy - adding Canvas quick action button
**Source**: rrr

## Pattern

When a user shows a screenshot and says "add X here", the screenshot defines WHERE the feature should live. Don't build it in a different surface (side panel, debug page) — build it exactly where they're pointing.

## Specifics

- User showed Gemini page screenshot with injected buttons visible (⚡💭🧠🔬 TAB badge)
- Said "update the extension show quick link to canvas mode"
- I built mode buttons in the side panel instead of the Gemini page
- The right answer: add 🎨 Canvas button next to the existing 🔬 Research button in `content.js:injectInputAreaButtons()`
- It was 15 lines of code once I looked at the right file

## Related

- `.includes()` string matching for menu items is fragile — use exact first-line matching (`text.split('\n')[0].trim() === target`) to prevent cross-contamination between items with description text
- Chrome content scripts require page refresh after extension reload — always remind users of this requirement

## Tags

`ui`, `chrome-extension`, `user-intent`, `content-script`
