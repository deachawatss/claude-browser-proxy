// Look at the browser the harness is holding open.
//
// Attaches over CDP, screenshots the Gemini tab, and leaves the browser running.
// This is the whole point of the harness: a bug like the three stacked
// "Start a new chat?" modals that blocked every mode toggle on 2026-08-31 is
// obvious in a picture and invisible in the DOM reads we were doing instead.
//
//   node playwright/shot.mjs [--out FILE] [--full] [--url SUBSTRING]
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const OUT = flag('--out', '/tmp/gemini-shot.png');
const MATCH = flag('--url', 'gemini.google.com');
const FULL = args.includes('--full');
const CDP = process.env.GEMINI_PW_CDP_PORT
  ? `http://127.0.0.1:${process.env.GEMINI_PW_CDP_PORT}`
  : 'http://127.0.0.1:9223';

const browser = await chromium.connectOverCDP(CDP).catch((e) => {
  console.error(`cannot reach the harness on ${CDP} - is it up? (playwright/up.sh)`);
  console.error(String(e).split('\n')[0]);
  process.exit(1);
});

const pages = browser.contexts().flatMap((c) => c.pages());
const page = pages.find((p) => p.url().includes(MATCH));
if (!page) {
  console.error(`no open tab matching "${MATCH}". Open tabs:`);
  for (const p of pages) console.error(`  ${p.url()}`);
  process.exit(1);
}

await page.screenshot({ path: OUT, fullPage: FULL });
console.log(JSON.stringify({ out: OUT, url: page.url(), title: await page.title() }, null, 2));

// Deliberately no browser.close(): that would take the harness's browser with
// it. Dropping the CDP socket by exiting is what leaves it running.
process.exit(0);
