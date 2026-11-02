/**
 * Simulation engine behind the v0 browser demo (demo/index.html).
 *
 * One 4-member circle on CashScript's MockNetworkProvider, driven through the same SDK as the CLI
 * and the tests (src/hui.ts). Every transaction is built by the SDK (or, for the cheating attempts,
 * by hand) and broadcast to the mock node, which evaluates it in the BCH VM against the real
 * covenant. This file decides what to try; the covenant decides what is allowed.
 *
 * No DOM code here: test/demo.test.ts drives exactly what the page drives.
 */
import { MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo, type SpendableUtxo } from 'cashscript';
import {
  ALL_PAID,
  START,
  afterContribute,
  afterPayout,
  afterRefund,
  amountDue,
  Circle,
  deadlineOf,
  defaultersOf,
  entitledMask,
  hasBit,
  owedTo,
  p2pkhAddress,
  type CircleParams,
  type CircleState,
} from '../../src/hui.js';
import { testKey } from '../../src/keys.js';

export const NAMES = ['Lan', 'Minh', 'Hoa', 'Tuan'];
export const STRANGER = 'Eve';
/** Satoshis each member pays per round. Collateral = one contribution, locked in round 1. */
export const C = 10_000n;
/** Creation deposit sent by the first member; the last payout or refund pays it back out. */
export const DEPOSIT = 1_000n;
/** Every simulated wallet starts with one coin of this size. */
export const WALLET = 100_000n;
/** MockNetworkProvider's initial block height. */
export const START_HEIGHT = 133_700;
const NET = 'mocknet';
const MEMBER_INDEXES = [0, 1, 2, 3];

// Deterministic throwaway TEST keys (public by construction).
const keys = NAMES.map((n) => testKey(`demo-${n}`));
export const MEMBER_ADDRESSES = keys.map((k) => p2pkhAddress(k.publicKey, NET));
export const STRANGER_ADDRESS = p2pkhAddress(testKey('demo-outsider').publicKey, NET);

export const PARAMS: CircleParams = {
  members: MEMBER_ADDRESSES,
  contribution: C,
  firstDeadline: BigInt(START_HEIGHT + 6),
  roundLength: 6n,
  maxFee: 2_000n,
  grace: 1n,
};

export type Phase = 'new' | 'open' | 'closed';

export interface LogEntry {
  n: number;
  /** tx = accepted by the (mock) node; refused = rejected, with the covenant's reason; note = time passing, summaries */
  kind: 'tx' | 'refused' | 'note';
  label: string;
  text: string;
  txid?: string;
  /** serialized transaction size in bytes */
  bytes?: number;
  fee?: bigint;
  reason?: string;
}

export type Collateral = 'none' | 'locked' | 'returned' | 'forfeited';

export interface MemberView {
  name: string;
  address: string;
  wallet: bigint;
  /** wallet change since the start of the simulation */
  net: bigint;
  /** paid the current round (open circle only) */
  paid: boolean;
  /** pot received (sat), null = not yet */
  received: bigint | null;
  /** refund received (sat), null = none */
  refunded: bigint | null;
  collateral: Collateral;
  /** what a refund would pay this member now (before the miner fee), null = not refundable now */
  owed: bigint | null;
}

type Sent = { txid: string; bytes: number; fee: bigint };

export const sat = (n: bigint): string => n.toLocaleString('en-US');
export const signedSat = (n: bigint): string => (n > 0n ? '+' : n < 0n ? '−' : '') + sat(n < 0n ? -n : n);
export const nameList = (members: number[]): string => {
  const names = members.map((m) => NAMES[m]!);
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};
const sum = (utxos: { satoshis: bigint }[]): bigint => utxos.reduce((t, u) => t + u.satoshis, 0n);

/**
 * Why a transaction was refused: the covenant's `require` message (found by replaying it in
 * CashScript's debugger), or else the first line of the node's / SDK's error.
 */
export function refusalReason(tb: TransactionBuilder | undefined, error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  if (tb) {
    try {
      tb.debug();
    } catch (debugError) {
      message = debugError instanceof Error ? debugError.message : String(debugError);
    }
  }
  return (message.match(/Hui: [^\n"]*/)?.[0] ?? message.split('\n')[0]!).replace(/\.$/, '');
}

export class HuiSim {
  provider!: MockNetworkProvider;
  circle!: Circle;
  phase!: Phase;
  /** current state while open; the last state once closed */
  state!: CircleState;
  closedBy!: 'payout' | 'refund' | null;
  /** state of the round when its first refund cancelled the circle */
  cancelState!: CircleState | null;
  height!: number;
  /** block of the last circle transaction (for the BIP68 `grace` rule, which the mock node does not check) */
  lastChange!: number;
  received!: (bigint | null)[];
  refunded!: (bigint | null)[];
  wallets!: bigint[];
  /** satoshis in the circle UTXO (0 before creation and after closing) */
  circleSats!: bigint;
  log!: LogEntry[];
  /** Called after every step: the page re-renders here (and pauses during scenarios). */
  onStep: () => void | Promise<void> = () => {};

  constructor() {
    this.reset();
  }

  reset(): void {
    this.provider = new MockNetworkProvider();
    this.circle = new Circle(PARAMS, this.provider);
    for (const address of [...MEMBER_ADDRESSES, STRANGER_ADDRESS]) {
      this.provider.addUtxo(address, randomUtxo({ satoshis: WALLET }));
    }
    this.phase = 'new';
    this.state = START;
    this.closedBy = null;
    this.cancelState = null;
    this.height = START_HEIGHT;
    this.lastChange = START_HEIGHT;
    this.received = [null, null, null, null];
    this.refunded = [null, null, null, null];
    this.wallets = MEMBER_INDEXES.map(() => WALLET);
    this.circleSats = 0n;
    this.log = [];
  }

  // ---------------------------------------------------------------- derived state

  get deadline(): number {
    return Number(deadlineOf(PARAMS, this.state.round));
  }

  /** First block at which the current round may be cancelled: its deadline, plus `grace` idle blocks for the first refund. */
  get cancelFrom(): number {
    if (this.state.refunded !== 0) return this.deadline;
    return Math.max(this.deadline, this.lastChange + Number(PARAMS.grace));
  }

  get txCount(): number {
    return this.log.filter((e) => e.kind === 'tx').length;
  }

  get recipient(): string {
    return NAMES[this.state.round]!;
  }

  /** Which buttons make sense now. The covenant is still the judge: every action is checked by the VM. */
  get can() {
    const s = this.state;
    const open = this.phase === 'open';
    const collecting = open && s.refunded === 0;
    const full = s.paid === ALL_PAID;
    const pastDeadline = this.height >= this.deadline;
    const cancellable = open && !full && this.height >= this.cancelFrom;
    // Nobody paid round 1: the only refund left is member 1 sweeping the creation deposit, and 1,000 sat
    // would not cover that transaction's fee plus a relayable output. The demo does not offer it.
    const empty = s.round === 0 && s.paid === 0;
    const owed = (m: number) => !empty && hasBit(entitledMask(s), m) && !hasBit(s.refunded, m);
    const refund = (m: number) => cancellable && owed(m);
    return {
      create: this.phase === 'new',
      pay: (m: number) => collecting && !hasBit(s.paid, m),
      payAll: collecting && !full,
      payout: collecting && full,
      advance: open && !empty && this.height < this.cancelFrom,
      refund,
      refundAll: MEMBER_INDEXES.some(refund),
      // cheating attempts: offered only where they demonstrate the rule they are named after
      earlyPayout: collecting && !full,
      stealPot: collecting && full,
      underpay: collecting && !full,
      skipRound: collecting && full && s.round < 3,
      earlyRefund: open && !full && !pastDeadline && MEMBER_INDEXES.some(owed),
      refundDefaulter: cancellable && defaultersOf(s).length > 0,
    };
  }

  member(m: number): MemberView {
    const s = this.state;
    const defaulted = this.cancelState !== null && defaultersOf(this.cancelState).includes(m);
    let collateral: Collateral;
    if (this.phase === 'new') collateral = 'none';
    else if (this.closedBy === 'payout') collateral = 'returned';
    else if (s.round === 0 && !hasBit(s.paid, m)) collateral = 'none';
    else if (defaulted) collateral = 'forfeited';
    else if (this.refunded[m] !== null) collateral = 'returned';
    else collateral = 'locked';
    const refundable = this.can.refund(m) || (this.cancelState !== null && this.phase === 'open' && hasBit(entitledMask(s), m) && !hasBit(s.refunded, m));
    return {
      name: NAMES[m]!,
      address: MEMBER_ADDRESSES[m]!,
      wallet: this.wallets[m]!,
      net: this.wallets[m]! - WALLET,
      paid: this.phase === 'open' && hasBit(s.paid, m),
      received: this.received[m]!,
      refunded: this.refunded[m]!,
      collateral,
      owed: refundable ? owedTo(PARAMS, s, m) : null,
    };
  }

  /** Where the circle's money is while it collects (null once it is being refunded or closed). */
  get breakdown(): { thisRound: bigint; collateral: bigint; deposit: bigint } | null {
    if (this.phase !== 'open' || this.state.refunded !== 0) return null;
    const payers = BigInt(MEMBER_INDEXES.filter((m) => hasBit(this.state.paid, m)).length);
    const collateral = this.state.round === 0 ? payers * C : 4n * C;
    return { thisRound: payers * C, collateral, deposit: this.circleSats - payers * C - collateral };
  }

  // ---------------------------------------------------------------- plumbing

  private unlocker(m: number) {
    return new SignatureTemplate(keys[m]!.privateKey).unlockP2PKH();
  }

  private utxosOf(m: number): Promise<SpendableUtxo[]> {
    return this.provider.getUtxos(MEMBER_ADDRESSES[m]!);
  }

  private async circleUtxo(): Promise<SpendableUtxo> {
    const [utxo] = await this.circle.utxosAt(this.state);
    if (!utxo) throw new Error(`no circle UTXO in state ${JSON.stringify(this.state)}`);
    return utxo;
  }

  private check(allowed: boolean, what: string): void {
    if (!allowed) throw new Error(`not possible in this state: ${what}`);
  }

  /** Build, then broadcast to the mock node, which runs every input through the BCH VM like a real node. */
  private async send(build: () => Promise<TransactionBuilder>): Promise<Sent | { reason: string }> {
    let tb: TransactionBuilder | undefined;
    try {
      tb = await build();
      const hex = tb.build();
      const fee = sum(tb.inputs) - tb.outputs.reduce((t, o) => t + o.amount, 0n);
      const txid = await this.provider.sendRawTransaction(hex);
      this.lastChange = this.height;
      return { txid, bytes: hex.length / 2, fee };
    } catch (error) {
      return { reason: refusalReason(tb, error) };
    }
  }

  private async refresh(): Promise<void> {
    this.wallets = await Promise.all(MEMBER_INDEXES.map(async (m) => sum(await this.utxosOf(m))));
    this.circleSats = this.phase === 'open' ? (await this.circleUtxo()).satoshis : 0n;
  }

  private async add(entry: Omit<LogEntry, 'n'>): Promise<LogEntry> {
    const full: LogEntry = { n: this.log.length + 1, ...entry };
    this.log.push(full);
    await this.refresh();
    await this.onStep();
    return full;
  }

  private tx(label: string, text: string, sent: Sent): Promise<LogEntry> {
    return this.add({ kind: 'tx', label, text, ...sent });
  }

  private refused(label: string, text: string, reason: string): Promise<LogEntry> {
    return this.add({ kind: 'refused', label, text, reason });
  }

  note(label: string, text: string): Promise<LogEntry> {
    return this.add({ kind: 'note', label, text });
  }

  // ---------------------------------------------------------------- honest steps

  async create(): Promise<LogEntry> {
    this.check(this.can.create, 'create');
    const text = `${NAMES[0]} creates the circle: a ${sat(DEPOSIT)} sat deposit to the covenant's start address`;
    const sent = await this.send(async () =>
      this.circle.create({ utxos: await this.utxosOf(0), unlocker: this.unlocker(0), changeTo: MEMBER_ADDRESSES[0]!, deposit: DEPOSIT }),
    );
    if ('reason' in sent) return this.refused('create', text, sent.reason);
    this.phase = 'open';
    return this.tx('create', text, sent);
  }

  async contribute(m: number): Promise<LogEntry> {
    this.check(this.can.pay(m), `${NAMES[m]} pays`);
    const s = this.state;
    const due = amountDue(PARAMS, s);
    const text = `${NAMES[m]} pays ${sat(due)} sat into round ${s.round + 1}${s.round === 0 ? ` (${sat(C)} + ${sat(C)} collateral)` : ''}`;
    const sent = await this.send(async () =>
      this.circle.contribute({
        circle: await this.circleUtxo(),
        state: s,
        member: m,
        utxos: await this.utxosOf(m),
        unlocker: this.unlocker(m),
        changeTo: MEMBER_ADDRESSES[m]!,
      }),
    );
    if ('reason' in sent) return this.refused('pay', text, sent.reason);
    this.state = afterContribute(s, m);
    return this.tx('pay', text, sent);
  }

  async payAll(): Promise<void> {
    for (const m of MEMBER_INDEXES) if (this.can.pay(m)) await this.contribute(m);
  }

  async payout(): Promise<LogEntry> {
    this.check(this.can.payout, 'payout');
    const s = this.state;
    const r = s.round;
    const before = [...this.wallets];
    const sent = await this.send(async () => this.circle.payout({ circle: await this.circleUtxo(), state: s }));
    if ('reason' in sent) return this.refused('payout', `Pay out the round ${r + 1} pot to ${NAMES[r]}`, sent.reason);
    const next = afterPayout(s);
    if (next) this.state = next;
    else {
      this.phase = 'closed';
      this.closedBy = 'payout';
    }
    await this.refresh();
    const got = this.wallets.map((w, m) => w - before[m]!);
    this.received[r] = got[r]!;
    const text = next
      ? `Round ${r + 1} pot goes to ${NAMES[r]}: ${sat(got[r]!)} sat (${sat(4n * C)} minus the miner fee). Anyone may trigger this, no key needed. Round ${next.round + 1} opens`
      : `Last pot goes to ${NAMES[r]}: ${sat(got[r]!)} sat (pot + own collateral + the ${sat(DEPOSIT)} sat creation deposit, minus the fee); ${nameList([0, 1, 2])} get their ${sat(C)} sat collateral back`;
    const entry = await this.tx('payout', text, sent);
    if (!next) await this.closingNote();
    return entry;
  }

  /** Let blocks pass until the current round can be cancelled (its deadline, plus `grace` idle blocks). */
  async advance(): Promise<LogEntry> {
    this.check(this.can.advance, 'advance time');
    this.height = this.cancelFrom;
    this.provider.setBlockHeight(this.height);
    const r = this.state.round + 1;
    const tail =
      this.state.paid === ALL_PAID
        ? `Round ${r} is fully funded, so it cannot be cancelled: the pot can only be paid out.`
        : `Round ${r} is still short: anyone may now cancel the circle and refund the members.`;
    return this.note('time', `Blocks pass: now block ${sat(BigInt(this.height))}, past the round ${r} deadline (block ${sat(BigInt(this.deadline))}). ${tail}`);
  }

  async refund(m: number): Promise<LogEntry> {
    this.check(this.can.refund(m), `refund ${NAMES[m]}`);
    const s = this.state;
    const before = this.wallets[m]!;
    const sent = await this.send(async () => this.circle.refund({ circle: await this.circleUtxo(), state: s, member: m }));
    if ('reason' in sent) return this.refused('refund', `Refund ${NAMES[m]}`, sent.reason);
    this.cancelState ??= s;
    const next = afterRefund(s, m);
    if (next) this.state = next;
    else {
      this.phase = 'closed';
      this.closedBy = 'refund';
    }
    await this.refresh();
    this.refunded[m] = this.wallets[m]! - before;
    const first = s.refunded === 0 ? `Round ${s.round + 1} is cancelled. ` : '';
    const entry = await this.tx('refund', `${first}${NAMES[m]} gets ${sat(this.refunded[m]!)} sat back${next ? '' : ' (last refund: also the creation deposit)'}`, sent);
    if (!next) await this.closingNote();
    return entry;
  }

  async refundAll(): Promise<void> {
    for (let guard = 0; guard < 4; guard++) {
      const m = MEMBER_INDEXES.find((i) => this.can.refund(i));
      if (m === undefined) return;
      if ((await this.refund(m)).kind !== 'tx') return;
    }
  }

  private closingNote(): Promise<LogEntry> {
    if (this.closedBy === 'payout') {
      const nets = MEMBER_INDEXES.map((m) => `${NAMES[m]} ${signedSat(this.wallets[m]! - WALLET)}`).join(' · ');
      return this.note(
        'closed',
        `Circle complete after ${this.txCount} transactions. Each member paid in ${sat(5n * C)} sat and got ${sat(4n * C)} (one pot) + ${sat(C)} (collateral) back. ` +
          `Net per wallet, i.e. the miner fees: ${nets} sat (${NAMES[0]}'s creation deposit ended with ${NAMES[3]}).`,
      );
    }
    const c = this.cancelState ?? this.state;
    const defaulters = defaultersOf(c);
    const waiting = MEMBER_INDEXES.filter((m) => m >= c.round);
    let text: string;
    if (c.round === 0) {
      text = `Circle cancelled in round 1 and closed: nobody had received a pot, so whoever paid got their ${sat(2n * C)} sat back (minus the fee).`;
    } else if (defaulters.length > 0) {
      const share = (BigInt(defaulters.length) * C) / BigInt(waiting.length);
      text =
        `Circle cancelled in round ${c.round + 1} and closed. ${nameList(defaulters)} already received a pot and stopped paying, ` +
        `so ${defaulters.length > 1 ? 'their' : 'the'} ${sat(C)} sat collateral was split among ${nameList(waiting)}, who had not received yet (+${sat(share)} each). ` +
        `Everyone else got back this round's payment and their collateral.`;
    } else {
      text = `Circle cancelled in round ${c.round + 1} and closed: everyone got back this round's payment and their collateral.`;
    }
    return this.note('closed', text);
  }

  // ---------------------------------------------------------------- cheating attempts
  // Each one is broadcast like any other transaction; the covenant must refuse it.

  private async attempt(label: string, text: string, build: () => Promise<TransactionBuilder>): Promise<LogEntry> {
    const sent = await this.send(build);
    if ('reason' in sent) return this.refused(label, text, sent.reason);
    // Never expected: the circle state here no longer matches the chain.
    await this.tx(label, `${text}: NOT refused`, sent);
    throw new Error(`the covenant accepted a cheating attempt: ${text}`);
  }

  async tryEarlyPayout(): Promise<LogEntry> {
    this.check(this.can.earlyPayout, 'early payout');
    const s = this.state;
    const missing = MEMBER_INDEXES.filter((m) => !hasBit(s.paid, m));
    return this.attempt('cheat', `Pay out the pot to ${NAMES[s.round]} while ${nameList(missing)} ${missing.length > 1 ? 'have' : 'has'} not paid`, async () =>
      this.circle.payout({ circle: await this.circleUtxo(), state: s }),
    );
  }

  async tryStealPot(): Promise<LogEntry> {
    this.check(this.can.stealPot, 'steal the pot');
    const s = this.state;
    return this.attempt('cheat', `Send the round ${s.round + 1} pot to a stranger (${STRANGER}) instead of ${NAMES[s.round]}`, async () => {
      const u = await this.circleUtxo();
      return new TransactionBuilder({ provider: this.provider })
        .addInput(u, this.circle.contractAt(s).unlock.payout())
        .addOutput({ to: STRANGER_ADDRESS, amount: 4n * C - 1_500n })
        .addOutput({ to: this.circle.addressAt(afterPayout(s) ?? s), amount: u.satoshis - 4n * C });
    });
  }

  async tryUnderpay(): Promise<LogEntry> {
    this.check(this.can.underpay, 'underpay');
    const s = this.state;
    const m = MEMBER_INDEXES.find((i) => !hasBit(s.paid, i))!;
    const due = amountDue(PARAMS, s);
    return this.attempt('cheat', `${NAMES[m]} pays 1 sat less than the ${sat(due)} sat due`, async () =>
      this.circle.contribute({
        circle: await this.circleUtxo(),
        state: s,
        member: m,
        utxos: await this.utxosOf(m),
        unlocker: this.unlocker(m),
        changeTo: MEMBER_ADDRESSES[m]!,
        amount: due - 1n,
      }),
    );
  }

  async trySkipRound(): Promise<LogEntry> {
    this.check(this.can.skipRound, 'skip a round');
    const s = this.state;
    return this.attempt('cheat', `Pay ${NAMES[s.round]}, then skip ${NAMES[s.round + 1]}'s round (jump the circle to round ${s.round + 3})`, async () => {
      const u = await this.circleUtxo();
      return new TransactionBuilder({ provider: this.provider })
        .addInput(u, this.circle.contractAt(s).unlock.payout())
        .addOutput({ to: MEMBER_ADDRESSES[s.round]!, amount: 4n * C - 1_500n })
        .addOutput({ to: this.circle.addressAt({ round: s.round + 2, paid: 0, refunded: 0 }), amount: u.satoshis - 4n * C });
    });
  }

  async tryEarlyRefund(): Promise<LogEntry> {
    this.check(this.can.earlyRefund, 'early refund');
    const s = this.state;
    const m = MEMBER_INDEXES.find((i) => hasBit(entitledMask(s), i) && !hasBit(s.refunded, i))!;
    // A transaction that is final now (locktime = current block) so the node accepts it into the mempool:
    // it is the covenant's deadline check that refuses it.
    return this.attempt('cheat', `Cancel round ${s.round + 1} before its deadline (refund ${NAMES[m]} at block ${sat(BigInt(this.height))})`, async () =>
      this.circle.refund({ circle: await this.circleUtxo(), state: s, member: m, locktime: this.height }),
    );
  }

  async tryRefundDefaulter(): Promise<LogEntry> {
    this.check(this.can.refundDefaulter, 'refund a defaulter');
    const s = this.state;
    const d = defaultersOf(s)[0]!;
    return this.attempt('cheat', `${NAMES[d]} (already received a pot, did not pay round ${s.round + 1}) claims a refund of the collateral`, async () => {
      const u = await this.circleUtxo();
      return new TransactionBuilder({ provider: this.provider })
        .addInput(u, this.circle.contractAt(s).unlock.refund(BigInt(d)), { sequence: s.refunded === 0 ? Number(PARAMS.grace) : 0xfffffffe })
        .setLocktime(this.deadline)
        .addOutput({ to: MEMBER_ADDRESSES[d]!, amount: C })
        .addOutput({ to: this.circle.addressAt(afterRefund(s, d) ?? s), amount: u.satoshis - C - 1_500n });
    });
  }

  // ---------------------------------------------------------------- scenarios (start from a fresh simulation)

  async runFullCircle(): Promise<void> {
    await this.note('scenario', `▶ Full circle: 4 rounds, everyone pays, each member takes the pot once.`);
    await this.create();
    for (let r = 0; r < 4; r++) {
      await this.payAll();
      await this.payout();
    }
  }

  async runDefault(): Promise<void> {
    await this.note('scenario', `▶ ${NAMES[0]} takes the first pot, then stops paying.`);
    await this.create();
    await this.payAll();
    await this.payout();
    for (const m of [1, 2, 3]) await this.contribute(m);
    await this.tryEarlyRefund();
    await this.advance();
    await this.tryRefundDefaulter();
    await this.refundAll();
  }

  async runCheats(): Promise<void> {
    await this.note('scenario', `▶ Try to cheat: every attempt below is a real transaction, refused by the covenant.`);
    await this.create();
    for (const m of [0, 1, 2]) await this.contribute(m);
    await this.tryEarlyPayout();
    await this.tryUnderpay();
    await this.contribute(3);
    await this.tryStealPot();
    await this.trySkipRound();
    await this.payout();
  }
}
