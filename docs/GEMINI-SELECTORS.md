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

### ⚠ The mode list in `mode_state` is NOT the Tools menu (found 2026-08-31)

`publishModeState()` runs with the menu **shut**, so the menu items are not in the DOM at all. It
filters *visible buttons* against a hardcoded list of six known names, which means it reports the
**composer quick-pill row** and can only ever return names we already expected.

Two consequences, and both were mistaken for evidence about the menu:

- A mode that lives only inside the menu can never appear in `mode_state.modes`.
- The pill row is A/B tested, so two accounts legitimately return different lists.

On 2026-08-30 this produced `["Create image","Create music","Canvas"]` on one account and
`["Create image","Create video","Create music"]` on another, and the absence of "Deep research"
from both was read as "the menu no longer offers Deep Research". **That conclusion is not supported
by that measurement** — nobody had enumerated the open menu. The payload now carries
`modesSource: "composer-quick-pills"` and `modesComplete: false` so it cannot be misread again.

**To ask what the menu actually contains, use the `list_modes` action** (or `dump_menu` for the raw
items plus menu HTML). Both open the menu, expand anything collapsed, accept
`menuitemcheckbox`/`menuitem`/`menuitemradio`/`option`, close the menu again, and match against
nothing.

## content.js injected UI — NEEDS LIVE VERIFICATION
- Response 3-dot menu labels ("Export to Docs", "Listen", "Double-check") + `waitForDocsLink` "Open Docs"
  were not capturable (Angular needs a trusted click). Kept as case-insensitive text match; verify before editing.
- The `TAB:<id>` badge injects fine (confirms content.js runs).

## The Tools menu, measured end to end (2026-08-31)

Captured live over MQTT with **zero human clicks**, once the bridge could answer commands.

| Item | Role | Where |
|---|---|---|
| Upload files | `menuitem` | top level |
| Add from Drive | `menuitem` | top level |
| Create image | `menuitemcheckbox` | top level |
| Create video | `menuitemcheckbox` | top level |
| Create music | `menuitemcheckbox` | top level |
| Canvas | `menuitemcheckbox` | behind **More tools** |
| Deep research | `menuitemcheckbox` | behind **More tools** |
| Guided learning | `menuitemcheckbox` | behind **More tools** |

Gemini spells it **`Deep research`**, lowercase r.

### The menu's content is LAZILY LOADED
The first open renders an empty shell — **2 descendant elements, zero items**. A later open of the
same menu renders **88**. Anything that opens the menu, reads once and believes an empty result will
report every mode as missing. Close and re-open; that is what fills it.

### Submenu trigger
`Canvas`, `Deep research` and `Guided learning` are behind a submenu whose trigger carries
`data-test-id="more-tools-button"`. Expand it before concluding a mode is absent.

### How to tell whether a mode is ON
Selecting an item **closes** the menu, so its `aria-checked` cannot be re-read afterwards. The
composer carries the authoritative signal instead: while a mode is on there is a
`button[aria-label="Deselect <mode>"]`, and it disappears when the mode goes off. Verified both ways.

### File upload needs no native dialog
While the menu is open the page contains **3 real `input[type="file"]` elements**, and zero while it
is shut. Build a `File`, put it in a `DataTransfer`, assign `input.files`, dispatch `change`.

### The composer's emoji row is OURS, not Gemini's
`⚡ 💭 🧠 🔬 🎨` are injected by this extension and mirror the side panel's Model/Mode buttons. They
carry no `aria-label` and their text is a single emoji. Code that scans visible buttons for mode
names finds these and nothing else — which is how the "Deep Research is gone" conclusion was reached.

## How to re-capture when the UI drifts again

**Correction (2026-08-31):** this section used to say *"Synthetic `.click()` does NOT open Angular
menus — use a trusted event"*. **That is wrong.** A purely synthetic `.click()` opens a fully
populated Tools menu; measured repeatedly with no human involved. The behaviour that looked like a
trusted-click requirement was the lazy first render described above. Acting on the old claim would
have meant adding the `debugger` permission for nothing.

Use the `describe` action (selector → label, role, `aria-checked`, visibility) against a logged-in
Gemini tab. `execute` cannot help — the page CSP forbids `eval` — and `get_html` truncates at 50000
characters, which on this page ends inside `<head>`. Put text in the composer first to make the send
button render.
