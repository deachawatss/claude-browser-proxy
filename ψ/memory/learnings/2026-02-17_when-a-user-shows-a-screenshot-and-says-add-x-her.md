---
title: When a user shows a screenshot and says "add X here", the screenshot defines WHE
tags: [ui, chrome-extension, user-intent, content-script, string-matching]
created: 2026-02-17
source: rrr: claude-browser-proxy
---

# When a user shows a screenshot and says "add X here", the screenshot defines WHE

When a user shows a screenshot and says "add X here", the screenshot defines WHERE the feature should live. Don't build it in a different surface (side panel, debug page) — build it exactly where they're pointing. The screenshot IS the specification. Also: `.includes()` string matching for menu items is fragile — use exact first-line matching (`text.split('\n')[0].trim() === target`) to prevent cross-contamination between items that have description text below them.

---
*Added via Oracle Learn*
