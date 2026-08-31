// Keeps one real browser open, with this checkout's extension loaded into it.
//
// Why this exists (2026-08-31):
//   1. The agent could not see the screen. Everything was read through the DOM
//      over MQTT, so a stack of modals blocking every click was invisible.
//      A browser Playwright owns can be screenshotted at any time - see shot.mjs.
//   2. Chrome loaded the extension from a hand-made copy at
//      C:\Users\deach\gemini-proxy, so every code change needed a manual reload
//      click. This loads the extension straight from the git checkout, so a
//      change ships by restarting the harness.
//
// The window is NOT visible on Wind's desktop: .wslconfig sets
// guiApplications=false, so WSLg is off and there is no X server. up.sh runs a
// virtual display (Xvfb) instead. Headed rendering is real; only the monitor is
// missing. Screenshots are the way anyone looks at it.
import { chromium } from 'playwright';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeBridge } from './bridge-probe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = resolve(HERE, '..');
const PROFILE = process.env.GEMINI_PW_PROFILE
  || `${process.env.HOME}/.cache/gemini-proxy-pw-profile`;
const CDP_PORT = process.env.GEMINI_PW_CDP_PORT || '9223';
const READY_FILE = '/tmp/gemini-pw-harness.ready';
const force = process.argv.includes('--force');

// One bridge at a time. The extension's MQTT client id is a fixed string
// (background.js: MQTT_CLIENT_ID), so two copies of it - one here, one in
// Wind's own Chrome - claim the same identity, and the broker evicts whichever
// connected first. Measured with both live on 2026-08-31: status publishes went
// from ~5/min to 29/min, the take-over fired the loser's last-will `offline`,
// and the evicted side had not published again 60s later. Refuse rather than
// produce that. This is a prediction, though, not a guarantee - see the tab
// ownership check further down, which is the observation.
const existing = await probeBridge({ timeoutMs: 6000 });
if (existing && !force) {
  console.error('REFUSING TO START: a bridge is already answering commands.');
  console.error(`  it replied: ${JSON.stringify(existing)}`);
  console.error('  That is almost certainly the extension in your own Chrome.');
  console.error('  Disable it there (chrome://extensions), or re-run with --force.');
  process.exit(2);
}
if (existing && force) {
  console.warn('WARNING: another bridge is live; --force given, starting anyway.');
  console.warn('  Expect both to fight over the MQTT client id until one is stopped.');
}

if (!existsSync(PROFILE)) mkdirSync(PROFILE, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: null,
  args: [
    // Google's sign-in refuses browsers that advertise automation, and this is
    // the flag that hides it. Measured on 2026-08-31 across four launches:
    // neither flag -> navigator.webdriver true; ignoreDefaultArgs
    // ['--enable-automation'] alone -> still true (Playwright 1.62.1 never adds
    // that switch, so dropping it does nothing); this flag alone -> false.
    // The sign-in was then done by hand in this profile and persists here.
    '--disable-blink-features=AutomationControlled',
    `--remote-debugging-port=${CDP_PORT}`,
    `--disable-extensions-except=${EXTENSION}`,
    `--load-extension=${EXTENSION}`,
    '--start-maximized',
  ],
});

// MV3 service worker. On a cold profile it registers a moment after launch.
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
if (!sw) {
  console.error('FAILED: the extension service worker never registered.');
  await ctx.close();
  process.exit(1);
}
console.log('extension service worker:', sw.url());

const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);

// Three states, not two. An evaluate that threw, or a page that has not painted
// yet, is "unknown" - and an unknown that reports itself as "signed in" is the
// same bug as a bridge that reports itself healthy while dropping commands.
// The whole text is tested, not the first 300 characters: a "Sign in" further
// down used to read as signed in.
let signedOut = null;
try {
  const text = await page.evaluate(() => document.body?.innerText || '');
  signedOut = text.trim() === '' ? null : /\bSign in\b/i.test(text);
} catch {
  signedOut = null;
}
if (signedOut === true) {
  console.warn('WARNING: this profile is signed out of Gemini.');
  console.warn('  See playwright/README.md for the one-off sign-in over noVNC.');
} else if (signedOut === null) {
  console.warn('WARNING: could not read the page, so the sign-in state is unknown.');
}

// content.js paints its own tab id into the page ("TAB:12345"). That is how
// this harness can tell whether the browser that answered the probe was THIS
// one - a plain round trip cannot, because two bridges share one client id.
const ownTabId = await (async () => {
  for (let i = 0; i < 10; i++) {
    const id = await page.evaluate(() => {
      const el = document.querySelector('#claude-header-tab')
        || document.querySelector('#claude-tab-inline');
      const m = el?.textContent?.match(/TAB:\s*(\d+)/);
      return m ? Number(m[1]) : null;
    }).catch(() => null);
    if (id) return id;
    await page.waitForTimeout(1000);
  }
  return null;
})();

// Readiness is a round trip, not a flag: the extension has to answer a command
// published by someone else before this harness calls itself up.
const answer = await probeBridge({ timeoutMs: 20000 });
if (!answer) {
  console.error('FAILED: the extension loaded but the bridge did not answer a command.');
  await ctx.close();
  process.exit(1);
}

// "Something answered" is never evidence that WE answered, so this runs on
// every start - not only when the startup probe happened to notice a rival.
// That probe waits 6 seconds; the extension in Wind's Chrome runs on a ~24s
// keepalive alarm (background.js: 'mqtt-keepalive'), so it can be asleep for
// the whole probe, wake up afterwards, take the shared client id back, and
// answer the readiness check itself. Gating the check on the prediction would
// skip it in exactly that case.
if (ownTabId === null) {
  console.error('FAILED: cannot tell which browser answered.');
  console.error('  content.js paints a TAB:<id> badge into the page and this one has none,');
  console.error('  so ownership is unverifiable. Refusing rather than assuming it is ours.');
  await ctx.close();
  process.exit(1);
}
if (answer.tabId !== ownTabId) {
  console.error('FAILED: the answer came from a different browser.');
  console.error(`  our tab: ${ownTabId}, answering tab: ${answer.tabId}`);
  console.error('  Another bridge holds the MQTT client id. Stop it, then start again.');
  await ctx.close();
  process.exit(1);
}
console.log(`ownership verified: tab ${ownTabId} answered`);

writeFileSync(READY_FILE, JSON.stringify({
  pid: process.pid,
  cdp: `http://127.0.0.1:${CDP_PORT}`,
  profile: PROFILE,
  extension: EXTENSION,
  serviceWorker: sw.url(),
  signedOut,
  tabId: ownTabId,
  bridge: answer,
  started: new Date().toISOString(),
}, null, 2));

console.log(`READY - bridge answered from tab ${answer.tabId}, CDP on 127.0.0.1:${CDP_PORT}`);
console.log(`state: ${READY_FILE}`);

// The ready file is the state anyone else reads, so it must not outlive the
// browser it describes. A crash an hour from now would otherwise leave a file
// still naming a CDP endpoint and a successful bridge answer.
const dropReadyFile = () => {
  try {
    unlinkSync(READY_FILE);
  } catch { /* already gone */ }
};

let stopping = false;
const shutdown = async () => {
  stopping = true;
  console.log('\nshutting down');
  dropReadyFile();
  await ctx.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Chrome exiting on its own (a crash, or someone closing the last window) must
// take the harness with it, or up.sh would report a ready harness on a dead
// browser. `stopping` keeps this from firing during an intentional shutdown,
// where it would kill the process mid-teardown; and an unplanned death exits
// non-zero, because that is a failure, not a completed run.
ctx.on('close', () => {
  if (stopping) return;
  console.error('the browser closed unexpectedly');
  dropReadyFile();
  process.exit(1);
});
