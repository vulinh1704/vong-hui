/**
 * Headless check of the BUILT demo page (dist/demo/index.html): loads its markup into happy-dom, runs
 * its inlined script in Node, clicks through the three scenarios and a few manual steps, and checks
 * what the page shows. Nothing is served or opened in a browser.  Run: npm run demo:check
 */
import { readFile } from 'node:fs/promises';
import { Window } from 'happy-dom';

const file = new URL('../dist/demo/index.html', import.meta.url);
const html = await readFile(file, 'utf8');

const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
if (scripts.length !== 1) throw new Error(`expected 1 inline module script, found ${scripts.length}`);
if (/<script[^>]+src=/.test(html) || /<link[^>]+rel="stylesheet"/.test(html)) throw new Error('the page still loads external files');
if (!/<style>/.test(html)) throw new Error('styles are not inlined');

const window = new Window({
  url: 'https://example.invalid/hui/?fast', // ?fast: no pauses between scenario steps
  settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
});
const document = window.document;
document.write(html.replace(scripts[0][0], ''));
globalThis.window = window;
globalThis.document = document;

const started = performance.now();
await import(`data:text/javascript;base64,${Buffer.from(scripts[0][1]).toString('base64')}`);

let failures = 0;
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) failures++;
};
const text = (selector) => document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const rows = (kind) => document.querySelectorAll(`#log-body tr.${kind}`).length;
const reasons = () => [...document.querySelectorAll('#log-body tr.refused .reason')].map((e) => e.textContent).reverse();
const enabled = (action, member) => {
  const selector = member === undefined ? `button[data-action="${action}"]:not([data-member])` : `button[data-action="${action}"][data-member="${member}"]`;
  const button = document.querySelector(selector);
  if (!button) throw new Error(`no button ${selector}`);
  return button.hasAttribute('disabled') ? null : button;
};
async function click(action, member) {
  const button = enabled(action, member);
  if (!button) throw new Error(`button "${action}"${member === undefined ? '' : ` (member ${member})`} is disabled`);
  button.click();
  const t0 = Date.now();
  while (document.body.getAttribute('data-busy') === '1') {
    if (Date.now() - t0 > 60_000) throw new Error(`"${action}" did not finish`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

console.log(`Built page: ${(html.length / 1024).toFixed(0)} KiB, script ready in ${Math.round(performance.now() - started)} ms`);
check(!document.body.classList.contains('loading'), 'script ran (loading state cleared)');
check(text('#build-info').startsWith('Built from commit'), `footer: "${text('#build-info')}"`);
check(text('.banner').includes('v0 · 14 Nov 2026 starting point'), 'v0 banner present');
check(enabled('create') && !enabled('payout') && !enabled('pay', 0), 'fresh page: only "Create circle" (and the scenarios) enabled');

let t = performance.now();
await click('scenarioFull');
check(rows('tx') === 21 && rows('refused') === 0, `Full circle: ${rows('tx')} accepted, ${rows('refused')} refused (${Math.round(performance.now() - t)} ms)`);
check(document.body.getAttribute('data-phase') === 'closed' && text('#circle-body .status').startsWith('Closed: all 4 pots'), `circle: "${text('#circle-body .status')}"`);
check(text('#log-body tr:first-child').includes('Circle complete after 21 transactions'), 'closing summary shown');

t = performance.now();
await click('scenarioDefault');
check(
  JSON.stringify(reasons()) === JSON.stringify(['Hui: the round deadline has not passed', 'Hui: nothing to refund for this member']),
  `Lan defaults: refused ${JSON.stringify(reasons())} (${Math.round(performance.now() - t)} ms)`,
);
check(rows('tx') === 12 && document.querySelectorAll('.member.defaulted').length === 1, `Lan defaults: ${rows('tx')} accepted, Lan's card marked as defaulted`);
check(text('#log-body tr:first-child').includes('split among Minh, Hoa and Tuan'), 'collateral split summary shown');

await click('scenarioCheats');
check(
  JSON.stringify(reasons()) ===
    JSON.stringify(['Hui: the round is not fully funded', 'Hui: wrong contribution amount', "Hui: the pot must go to this round's recipient", 'Hui: next state mismatch']),
  `Try to cheat: refused ${JSON.stringify(reasons())}`,
);

await click('reset');
check(rows('tx') === 0 && enabled('create'), 'reset clears the simulation');
await click('create');
await click('pay', 0);
await click('pay', 1);
check(document.querySelectorAll('#circle-body .dot.on').length === 2, 'manual: Lan and Minh paid (2 dots on)');
await click('earlyPayout');
check(reasons().at(-1) === 'Hui: the round is not fully funded', 'manual: early payout refused');
await click('payAll');
check(text('button[data-action="payout"]') === 'Pay out the pot → Lan', 'manual: payout button names the recipient');
await click('stealPot');
check(reasons().at(-1) === "Hui: the pot must go to this round's recipient", 'manual: pot to a stranger refused');
await click('payout');
check(text('#circle-body .status').startsWith('Round 2 of 4'), `manual: "${text('#circle-body .status')}"`);
check(text('#log-count') === '6 accepted · 2 refused', `log counter: "${text('#log-count')}"`);
check(text('#error') === '', 'no unexpected errors');

await window.happyDOM.close();
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed.');
