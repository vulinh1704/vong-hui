/**
 * v0 demo page: renders the simulation (sim.ts) and wires the buttons. All money logic lives in the
 * SDK and the covenant; this file only shows what happened.
 */
import { C, DEPOSIT, HuiSim, NAMES, PARAMS, sat, signedSat, type LogEntry, type MemberView } from './sim.js';
import { hasBit } from '../../src/hui.js';

declare const __HUI_COMMIT__: string;
declare const __HUI_BUILT__: string;

const sim = new HuiSim();
let busy = false;
// ?fast skips the pauses between scenario steps (used by the headless check of the built page)
const STEP_PAUSE_MS = window.location.search.includes('fast') ? 0 : 110;

const $ = (id: string): Element => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
};
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const short = (s: string, head = 10, tail = 6): string => (s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s);
const blocks = (n: number): string => sat(BigInt(n));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ rendering

function renderCircle(): void {
  const s = sim.state;
  const r = s.round + 1;
  let status: string;
  let tone = 'neutral';
  if (sim.phase === 'new') {
    status = `Not created yet. Press <b>Create circle</b>: ${NAMES[0]} sends a ${sat(DEPOSIT)} sat deposit to the covenant.`;
  } else if (sim.phase === 'closed') {
    tone = sim.closedBy === 'payout' ? 'good' : 'warn';
    status = sim.closedBy === 'payout' ? 'Closed: all 4 pots paid out, collateral returned.' : `Closed: cancelled in round ${(sim.cancelState?.round ?? s.round) + 1}, everyone owed was refunded.`;
  } else if (s.refunded !== 0) {
    tone = 'warn';
    status = `Round ${r} cancelled after its deadline: refunding the members.`;
  } else if (s.paid === 15) {
    tone = 'good';
    status = `Round ${r} fully funded. Anyone can now pay out the pot, but only to <b>${NAMES[s.round]}</b>.`;
  } else {
    status = `Round ${r} of 4: collecting. This round's pot goes to <b>${NAMES[s.round]}</b>.`;
  }

  const b = sim.breakdown;
  const dots = NAMES.map((n, m) => {
    const on = sim.phase === 'open' && hasBit(s.paid, m);
    return `<span class="dot${on ? ' on' : ''}" title="${esc(n)} ${on ? 'paid' : 'has not paid'} this round">${esc(n[0]!)}</span>`;
  }).join('');
  const bits = (x: number) => x.toString(2).padStart(4, '0');
  const clock =
    sim.phase === 'open'
      ? `Block ${blocks(sim.height)} · round ${r} deadline: block ${blocks(sim.deadline)}${
          s.paid !== 15 && sim.height >= sim.cancelFrom ? ' · <b>cancellable now</b>' : ''
        }`
      : `Block ${blocks(sim.height)}`;

  $('circle-body').innerHTML = `
    <p class="status ${tone}">${status}</p>
    <div class="pot">
      <div><span class="big">${sat(sim.circleSats)}</span> <span class="unit">sat</span></div>
      <div class="muted">held by the covenant${sim.phase === 'open' ? '' : ' (nothing locked)'}</div>
    </div>
    ${
      b
        ? `<dl class="breakdown">
            <div><dt>This round</dt><dd>${sat(b.thisRound)}</dd></div>
            <div><dt>Collateral</dt><dd>${sat(b.collateral)}</dd></div>
            <div><dt>Creation deposit</dt><dd>${sat(b.deposit)}</dd></div>
          </dl>`
        : ''
    }
    <div class="paidrow"><span class="muted">Paid this round</span> ${dots}</div>
    <p class="muted small">${clock}</p>
    <details class="tech">
      <summary>Covenant state</summary>
      <p class="small">State bytes <code>[round, paid, refunded] = [${s.round}, ${bits(s.paid)}b, ${bits(s.refunded)}b]</code> live in the
      first push of the redeem script, so every state has its own P2SH32 address. Current:</p>
      <p class="small"><code title="${esc(sim.circle.addressAt(s))}">${esc(short(sim.circle.addressAt(s), 18, 10))}</code></p>
      <p class="small muted">${sim.txCount} transactions so far · contribution ${sat(C)} sat · max miner fee per payout/refund ${sat(PARAMS.maxFee)} sat
      · rounds every ${PARAMS.roundLength} blocks · grace ${PARAMS.grace} block</p>
    </details>`;
}

function collateralText(v: MemberView): string {
  switch (v.collateral) {
    case 'none':
      return '—';
    case 'locked':
      return `${sat(C)} locked`;
    case 'returned':
      return `${sat(C)} returned`;
    case 'forfeited':
      return `<span class="bad">forfeited</span>`;
  }
}

function renderMembers(): void {
  const can = sim.can;
  const due = sim.state.round === 0 ? 2n * C : C;
  $('members-body').innerHTML = NAMES.map((_, m) => {
    const v = sim.member(m);
    const turn = sim.phase === 'open' && sim.state.refunded === 0 && sim.state.round === m;
    const rows = [
      ['Takes the pot', `round ${m + 1}`],
      ['Paid this round', sim.phase === 'open' && sim.state.refunded === 0 ? (v.paid ? '<span class="good">✓ paid</span>' : 'not yet') : '—'],
      ['Pot received', v.received === null ? '—' : `<span class="good">${sat(v.received)}</span>`],
      ['Collateral', collateralText(v)],
    ];
    if (v.owed !== null) rows.push(['Refund due', `${sat(v.owed)}`]);
    if (v.refunded !== null) rows.push(['Refunded', `<span class="good">${sat(v.refunded)}</span>`]);
    return `
      <article class="member${turn ? ' turn' : ''}${v.collateral === 'forfeited' ? ' defaulted' : ''}">
        <header>
          <h3>${esc(v.name)}</h3>
          <span class="muted small" title="${esc(v.address)}">${esc(short(v.address.replace(/^bchtest:/, ''), 6, 4))}</span>
        </header>
        <div class="wallet"><span class="big2">${sat(v.wallet)}</span> <span class="unit">sat</span>
          <span class="net ${v.net < 0n ? 'down' : v.net > 0n ? 'up' : ''}">${v.net === 0n ? '' : signedSat(v.net)}</span></div>
        <dl class="facts">${rows.map(([k, val]) => `<div><dt>${k}</dt><dd>${val}</dd></div>`).join('')}</dl>
        <div class="actions">
          <button data-action="pay" data-member="${m}" ${!busy && can.pay(m) ? '' : 'disabled'}>Pay ${sat(due)}</button>
          <button data-action="refund" data-member="${m}" ${!busy && can.refund(m) ? '' : 'disabled'}>Refund</button>
        </div>
      </article>`;
  }).join('');
}

function renderButtons(): void {
  const can = sim.can;
  const label: Record<string, string> = {
    payAll: `Everyone pays round ${sim.state.round + 1}`,
    payout: `Pay out the pot → ${sim.recipient}`,
  };
  for (const button of Array.from(document.querySelectorAll('button[data-action]'))) {
    const action = button.getAttribute('data-action')!;
    if (button.hasAttribute('data-member')) continue; // member cards handle their own
    const allowed = action.startsWith('scenario') || action === 'reset' ? true : Boolean((can as Record<string, unknown>)[action]);
    if (busy || !allowed) button.setAttribute('disabled', '');
    else button.removeAttribute('disabled');
    if (label[action]) button.textContent = label[action]!;
  }
}

function logRow(e: LogEntry): string {
  if (e.kind === 'note') {
    return `<tr class="note ${esc(e.label)}"><td class="n">${e.n}</td><td colspan="5">${esc(e.text)}</td></tr>`;
  }
  const result =
    e.kind === 'tx'
      ? '<span class="pill ok">accepted</span>'
      : `<span class="pill no">refused</span><div class="reason">${esc(e.reason ?? '')}</div>`;
  return `<tr class="${e.kind}">
    <td class="n">${e.n}</td>
    <td>${esc(e.text)}</td>
    <td>${result}</td>
    <td class="mono">${e.txid ? `<span title="${esc(e.txid)}">${esc(short(e.txid, 8, 4))}</span>` : '—'}</td>
    <td class="num">${e.bytes ?? '—'}</td>
    <td class="num">${e.fee === undefined ? '—' : sat(e.fee)}</td>
  </tr>`;
}

function renderLog(): void {
  const rows = [...sim.log].reverse().map(logRow).join('');
  $('log-body').innerHTML = rows || '<tr class="empty"><td colspan="6">No transactions yet. Start a scenario or press Create circle.</td></tr>';
  const refused = sim.log.filter((e) => e.kind === 'refused').length;
  $('log-count').textContent = `${sim.txCount} accepted · ${refused} refused`;
}

function render(): void {
  renderCircle();
  renderMembers();
  renderButtons();
  renderLog();
  document.body.setAttribute('data-busy', busy ? '1' : '0');
  document.body.setAttribute('data-phase', sim.phase);
}

// ------------------------------------------------------------------ actions

const actions: Record<string, (member: number) => Promise<unknown>> = {
  create: () => sim.create(),
  payAll: () => sim.payAll(),
  payout: () => sim.payout(),
  advance: () => sim.advance(),
  refundAll: () => sim.refundAll(),
  pay: (m) => sim.contribute(m),
  refund: (m) => sim.refund(m),
  earlyPayout: () => sim.tryEarlyPayout(),
  stealPot: () => sim.tryStealPot(),
  underpay: () => sim.tryUnderpay(),
  skipRound: () => sim.trySkipRound(),
  earlyRefund: () => sim.tryEarlyRefund(),
  refundDefaulter: () => sim.tryRefundDefaulter(),
  reset: async () => sim.reset(),
  scenarioFull: async () => {
    sim.reset();
    await sim.runFullCircle();
  },
  scenarioDefault: async () => {
    sim.reset();
    await sim.runDefault();
  },
  scenarioCheats: async () => {
    sim.reset();
    await sim.runCheats();
  },
};

async function run(action: string, member: number): Promise<void> {
  const fn = actions[action];
  if (!fn || busy) return;
  const animated = action.startsWith('scenario');
  busy = true;
  sim.onStep = animated ? async () => (render(), await sleep(STEP_PAUSE_MS)) : () => render();
  render();
  try {
    await fn(member);
  } catch (error) {
    console.error(error);
    $('error').textContent = `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    busy = false;
    render();
  }
}

document.addEventListener('click', (event) => {
  const button = (event.target as Element | null)?.closest?.('button[data-action]');
  if (!button || button.hasAttribute('disabled')) return;
  void run(button.getAttribute('data-action')!, Number(button.getAttribute('data-member') ?? -1));
});

$('build-info').textContent = `Built from commit ${__HUI_COMMIT__} on ${__HUI_BUILT__}.`;
document.body.classList.remove('loading');
render();
