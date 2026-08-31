// Look at the browser the harness is holding open.
//
// Attaches over CDP, screenshots the Gemini tab, and leaves the browser running.
// This is the whole point of the harness: a bug like the three stacked
// "Start a new chat?" modals that blocked every mode toggle on 2026-08-31 is
// obvious in a picture and invisible in the DOM reads we were doing instead.
//
//   node playwright/shot.mjs [--out FILE] [--full] [--url SUBSTRING]
import { chromium } from 'playwright';
import { parseArgs } from 'node:util';
import { existsSync, statSync } from 'node:fs';

// parseArgs, not a hand-rolled indexOf: `--out` as the LAST argument used to
// yield `undefined`, which Playwright takes as "do not save the file". It then
// printed a success line with the key silently dropped by JSON.stringify, and
// exited 0. A screenshot tool that reports success without writing a file is
// worse than one that crashes.
const { values } = parseArgs({
  options: {
    out: { type: 'string', default: '/tmp/gemini-shot.png' },
    url: { type: 'string', default: 'gemini.google.com' },
    full: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

const OUT = values.out;
const MATCH = values.url;
const FULL = values.full;
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

// Say it wrote a file only after seeing the file.
if (!existsSync(OUT)) {
  console.error(`FAILED: screenshot reported no error but ${OUT} does not exist.`);
  process.exit(1);
}
console.log(JSON.stringify({
  out: OUT,
  bytes: statSync(OUT).size,
  url: page.url(),
  title: await page.title(),
}, null, 2));

// Deliberately no browser.close(): that would take the harness's browser with
// it. Dropping the CDP socket by exiting is what leaves it running.
process.exit(0);
