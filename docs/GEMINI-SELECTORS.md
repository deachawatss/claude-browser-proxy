# Gemini UI selectors (verified live 2026-08-01)

Gemini's web UI drifts; when a feature breaks, the cause is usually a stale selector.
This is the ground truth captured live (via ego-browser) plus the fallback strategy the code uses.

**Strategy everywhere:** ADD the current selector as *primary*, KEEP the old as *fallback*
(never delete — the UI sometimes A/B-tests). Match menu/label text **case-insensitively**
(Gemini re-cases, e.g. "Deep research").

## Composer (prompt input) — `chat`, `type`, sidepanel `sendChat`
- Primary: `rich-textarea .ql-editor` (class `ql-editor ql-blank textarea new-input-ui`, role=textbox)
- aria-label is now **"Enter a prompt for Gemini"** (was "Enter a prompt here" — dead)

## Send button — appears only when the composer has text
- Primary: `button[aria-label="Send message"]` (contains `mat-icon[fonticon="arrow_upward"]`)
- Also matches `button[aria-label*="Send"]`; `:has(mat-icon[fonticon="arrow_upward"])` works (Chrome 105+)
- Dead: `.send-button`, `button[data-test-id="send-button"]`

## Response read — `get_response`, `wait_response`, `get_state`
- Primary: `MESSAGE-CONTENT` (custom element). Also present: `message-content`, `model-response`,
  `.model-response-text`, `.markdown`, `.markdown-main-panel`, `response-container`
- Loading/streaming: not re-verified — kept as-is (`mat-mdc-progress-spinner...`, `.streaming-indicator`)

## Model picker — `select_model`
- Trigger: `button[data-test-id="bard-mode-menu-button"]` (== legacy `.input-area-switch`; aria "Open mode picker, currently Pro")
- Items: `role="menuitem"`, titled **"3.5 Flash-Lite"** (Fastest answers), **"3.6 Flash"**, **"3.1 Pro"**, **"Extended thinking"** (Complex problem solving)
- Map: `fast→"Fast"` (matches "Fastest" desc), `pro→"Pro"` (title "3.1 Pro"), `thinking→"Thinking"` (title "Extended thinking")
- ⚠ Match the item **title** (first line) before full text, else `pro` also hits "Complex **pro**blem"

## Tools / mode — `select_mode` (Deep Research, Canvas)
- Trigger: `button[aria-label="Upload & tools"]` (was keyed on text "Tools" — DEAD; this silently
  disabled the whole injected pill row in content.js `injectInputAreaButtons`)
- Items: `button[role="menuitemcheckbox"]` with `aria-checked`, TOP-LEVEL (not nested under "More tools"):
  **"Canvas"**, **"Deep research"** (lowercase r), "Create image", "Create video", "Create music", "Guided learning"
- Active state: when Deep Research is on, a **"Try again without Deep Research"** control + a "Deep research" composer chip appear

## content.js injected UI — NEEDS LIVE VERIFICATION
- Response 3-dot menu labels ("Export to Docs", "Listen", "Double-check") + `waitForDocsLink` "Open Docs"
  were not capturable (Angular needs a trusted click). Kept as case-insensitive text match; verify before editing.
- The `TAB:<id>` badge injects fine (confirms content.js runs).

## How to re-capture when the UI drifts again
Use ego-browser against a logged-in Gemini tab. Synthetic `.click()` does NOT open Angular menus —
use ego's `click([x,y])` (trusted event) or `snapshotText()` (captures the a11y overlay tree) to read
menu items. Put text in the composer first to make the send button render.
