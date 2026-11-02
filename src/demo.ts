/**
 * Offline demo: three short stories of a 4-member circle, every transaction evaluated by the
 * BCH VM (MockNetworkProvider). No network, throwaway test keys.  Run: npm run demo
 */
import { MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo, type SpendableUtxo } from 'cashscript';
import {
  afterContribute,
  afterPayout,
  afterRefund,
  amountDue,
  Circle,
  deadlineOf,
  p2pkhAddress,
  START,
  type CircleParams,
  type CircleState,
} from './hui.js';
import { followCircle, MemoryChainReader } from './chain.js';
import { testKey } from './keys.js';

const NAMES = ['Lan', 'Minh', 'Hoa', 'Tuan'];
const keys = NAMES.map((n) => testKey(`demo-${n}`));
const outsider = testKey('demo-outsider');
const NET = 'mocknet';
const members = keys.map((k) => p2pkhAddress(k.publicKey, NET));
const outsiderAddress = p2pkhAddress(outsider.publicKey, NET);
const C = 10_000n;

const fmt = (sat: bigint) => sat.toLocaleString('en-US');
const ok = (label: string, text: string) => console.log(`  OK       ${label.padEnd(9)} ${text}`);
function blocked(label: string, attempt: () => TransactionBuilder): void {
  try {
    attempt().debug();
    console.log(`  !!       ${label.padEnd(9)} NOT blocked`);
    process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = (message.match(/Hui: [^\n"]*/)?.[0] ?? message.split('\n')[0]!).replace(/\.$/, '');
    console.log(`  BLOCKED  ${label.padEnd(9)} ${reason}`);
  }
}

function world() {
  const provider = new MockNetworkProvider();
  const reader = new MemoryChainReader(provider);
  const params: CircleParams = { members, contribution: C, firstDeadline: 133_706n, roundLength: 6n, maxFee: 2_000n, grace: 1n };
  const circle = new Circle(params, provider);
  for (const m of [...members, outsiderAddress]) provider.addUtxo(m, randomUtxo({ satoshis: 100_000n }));
  const send = (tb: TransactionBuilder) => provider.sendRawTransaction(tb.build());
  const wallet = async (m: number) => (await provider.getUtxos(members[m]!)).reduce((t, u) => t + u.satoshis, 0n);
  const at = async (s: CircleState): Promise<SpendableUtxo> => (await circle.utxosAt(s))[0]!;
  const unlocker = (m: number) => new SignatureTemplate(keys[m]!.privateKey).unlockP2PKH();

  const create = async () => {
    await send(circle.create({ utxos: await provider.getUtxos(members[0]!), unlocker: unlocker(0), changeTo: members[0]! }));
    ok('create', `${NAMES[0]} creates the circle with a 1,000 sat deposit at ${circle.startAddress.slice(0, 24)}...`);
    return START;
  };
  const contributeTx = async (s: CircleState, m: number, amount?: bigint) =>
    circle.contribute({ circle: await at(s), state: s, member: m, utxos: await provider.getUtxos(members[m]!), unlocker: unlocker(m), changeTo: members[m]!, amount });
  const payRound = async (s: CircleState, who: number[]) => {
    for (const m of who) {
      await send(await contributeTx(s, m));
      s = afterContribute(s, m);
    }
    const extra = s.round === 0 ? ` (${fmt(C)} + ${fmt(C)} collateral)` : '';
    ok(`round ${s.round + 1}`, `${who.map((m) => NAMES[m]).join(', ')} pay ${fmt(amountDue(params, { ...s, paid: 0 }))} sat each${extra}`);
    return s;
  };
  const payout = async (s: CircleState) => {
    const before = await Promise.all([0, 1, 2, 3].map(wallet));
    await send(circle.payout({ circle: await at(s), state: s }));
    const got = await Promise.all([0, 1, 2, 3].map(async (m) => (await wallet(m)) - before[m]!));
    const extra = s.round === 3 ? `; collateral back to ${NAMES.slice(0, 3).join(', ')}: ${got.slice(0, 3).map(fmt).join(' / ')} sat` : '';
    ok('payout', `${NAMES[s.round]} receives ${fmt(got[s.round]!)} sat (anyone can trigger it, no key needed)${extra}`);
    return afterPayout(s);
  };
  const refund = async (s: CircleState, m: number) => {
    const before = await wallet(m);
    await send(circle.refund({ circle: await at(s), state: s, member: m }));
    ok('refund', `${NAMES[m]} gets ${fmt((await wallet(m)) - before)} sat back`);
    return afterRefund(s, m);
  };
  return { provider, reader, circle, params, wallet, at, create, contributeTx, payRound, payout, refund };
}

console.log('\nVong Hui: a savings circle whose pot is held by a Bitcoin Cash covenant, not by an organiser.');
console.log(`4 members (${NAMES.join(', ')}), ${fmt(C)} sat per round, collateral = one round. Offline: every`);
console.log('transaction below is evaluated by the BCH virtual machine against the real covenant.\n');

// ------------------------------------------------------------------ story 1
{
  console.log('1. A full circle');
  const w = world();
  const start = await Promise.all([0, 1, 2, 3].map(w.wallet));
  let s: CircleState | null = await w.create();
  for (let r = 0; r < 4; r++) {
    s = await w.payRound(s!, [0, 1, 2, 3]);
    s = await w.payout(s);
  }
  const end = await Promise.all([0, 1, 2, 3].map(w.wallet));
  const status = await followCircle(w.circle, w.reader);
  console.log(`  -> closed after ${status.steps.length} transactions. Each member paid 50,000 and got 50,000 back; fees paid: ${
    end.map((e, m) => fmt(start[m]! - e + (m === 0 ? -1_000n : m === 3 ? 1_000n : 0n))).join(' / ')} sat\n`);
}

// ------------------------------------------------------------------ story 2
{
  console.log(`2. ${NAMES[0]} takes the first pot and stops paying`);
  const w = world();
  let s: CircleState | null = await w.create();
  s = await w.payRound(s!, [0, 1, 2, 3]);
  s = await w.payout(s);
  s = await w.payRound(s!, [1, 2, 3]);
  const state = s;
  const u = await w.at(s);
  blocked('cancel', () => w.circle.refund({ circle: u, state, member: 1, locktime: Number(deadlineOf(w.params, 1)) - 1 }));
  w.provider.setBlockHeight(Number(deadlineOf(w.params, 1)));
  console.log(`  ...      deadline of round 2 passes (block ${deadlineOf(w.params, 1)}), round still short of ${NAMES[0]}'s share`);
  blocked('refund', () => new TransactionBuilder({ provider: w.provider })
    .addInput(u, w.circle.contractAt(state).unlock.refund(0n), { sequence: 1 })
    .setLocktime(Number(deadlineOf(w.params, 1)))
    .addOutput({ to: members[0]!, amount: 20_000n })
    .addOutput({ to: w.circle.addressAt(afterRefund(state, 0)!), amount: u.satoshis - 21_500n }));
  for (const m of [1, 2, 3]) s = (await w.refund(s!, m)) ?? s;
  console.log(`  -> ${NAMES[0]}'s 10,000 sat collateral was split between ${NAMES.slice(1).join(', ')} (3,333 each; ${NAMES[3]}, refunded last, also gets the deposit)\n`);
}

// ------------------------------------------------------------------ story 3
{
  console.log('3. What the covenant refuses');
  const w = world();
  let s = await w.create();
  s = await w.payRound(s, [0, 1, 2]);
  const partial = s;
  const pu = await w.at(partial);
  blocked('payout', () => w.circle.payout({ circle: pu, state: partial }));
  const shortTx = await w.contributeTx(s, 3, 2n * C - 1n);
  blocked('underpay', () => shortTx);
  await w.provider.sendRawTransaction((await w.contributeTx(s, 3)).build());
  s = afterContribute(s, 3);
  const full = s;
  const u = await w.at(full);
  blocked('steal', () => new TransactionBuilder({ provider: w.provider })
    .addInput(u, w.circle.contractAt(full).unlock.payout())
    .addOutput({ to: outsiderAddress, amount: 4n * C - 1_500n })
    .addOutput({ to: w.circle.addressAt(afterPayout(full)!), amount: u.satoshis - 4n * C }));
  blocked('skip', () => new TransactionBuilder({ provider: w.provider })
    .addInput(u, w.circle.contractAt(full).unlock.payout())
    .addOutput({ to: members[0]!, amount: 4n * C - 1_500n })
    .addOutput({ to: w.circle.addressAt({ round: 2, paid: 0, refunded: 0 }), amount: u.satoshis - 4n * C }));
  blocked('cancel', () => w.circle.refund({ circle: u, state: { ...full, paid: 15 }, member: 0 }));
  console.log('');
}
