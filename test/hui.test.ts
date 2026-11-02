/**
 * Hui covenant tests. Offline: CashScript's MockNetworkProvider evaluates every transaction in
 * the BCH VM (BCH_2026_05) against the real locking bytecode, and refuses non-final locktimes
 * like a node. All keys are deterministic throwaway TEST keys.
 */
import { MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo, type SpendableUtxo, type Utxo } from 'cashscript';
import { compileFile } from 'cashc';
import { binToHex } from '@bitauth/libauth';
import {
  afterContribute,
  afterPayout,
  afterRefund,
  amountDue,
  artifact,
  Circle,
  deadlineOf,
  encodeState,
  entitledMask,
  owedTo,
  p2pkhAddress,
  START,
  type CircleParams,
  type CircleState,
} from '../src/hui.js';
import { followCircle, MemoryChainReader } from '../src/chain.js';
import { testKey } from '../src/keys.js';

const NET = 'mocknet';
const keys = [0, 1, 2, 3].map((i) => testKey(`member-${i}`));
const members = keys.map((k) => p2pkhAddress(k.publicKey, NET));
const stranger = testKey('stranger');
const strangerAddress = p2pkhAddress(stranger.publicKey, NET);

const C = 10_000n; // contribution per round
const DEPOSIT = 1_000n; // creation deposit
const params: CircleParams = {
  members,
  contribution: C,
  firstDeadline: 133_710n, // the mock chain starts at height 133_700
  roundLength: 10n,
  maxFee: 2_000n,
  grace: 2n,
};

type Payer = number | 'stranger';
const keyOf = (p: Payer) => (p === 'stranger' ? stranger : keys[p]!);
const addressOfPayer = (p: Payer) => (p === 'stranger' ? strangerAddress : members[p]!);
const unlockerOf = (p: Payer) => new SignatureTemplate(keyOf(p).privateKey).unlockP2PKH();
const sum = (utxos: Utxo[]) => utxos.reduce((total, u) => total + u.satoshis, 0n);

function setup(overrides: Partial<CircleParams> = {}) {
  const provider = new MockNetworkProvider();
  const reader = new MemoryChainReader(provider);
  const circle = new Circle({ ...params, ...overrides }, provider);
  for (const address of [...members, strangerAddress]) provider.addUtxo(address, randomUtxo({ satoshis: 200_000n }));
  const balance = async (address: string) => sum(await provider.getUtxos(address));
  // Broadcast through the mock node: full BCH VM validation + locktime finality, without the 500 ms
  // polling delay of TransactionBuilder.send(). Rejections are tested with send() / toFailRequireWith.
  const broadcast = (tb: TransactionBuilder) => provider.sendRawTransaction(tb.build());

  const utxoAt = async (state: CircleState): Promise<SpendableUtxo> => {
    const [utxo] = await circle.utxosAt(state);
    if (!utxo) throw new Error(`no circle UTXO in state ${JSON.stringify(state)}`);
    return utxo;
  };

  const create = async (deposit = DEPOSIT) => {
    await broadcast(
      circle.create({ utxos: await provider.getUtxos(members[0]!), unlocker: unlockerOf(0), changeTo: members[0]!, deposit }),
    );
    return START;
  };

  const contributeTx = async (state: CircleState, member: number, payer: Payer = member, amount?: bigint) =>
    circle.contribute({
      circle: await utxoAt(state),
      state,
      member,
      utxos: await provider.getUtxos(addressOfPayer(payer)),
      unlocker: unlockerOf(payer),
      changeTo: addressOfPayer(payer),
      amount,
    });

  const pay = async (state: CircleState, member: number, payer: Payer = member) => {
    await broadcast(await contributeTx(state, member, payer));
    return afterContribute(state, member);
  };

  const payAll = async (state: CircleState, who = [0, 1, 2, 3]) => {
    let s = state;
    for (const m of who) s = await pay(s, m);
    return s;
  };

  const payout = async (state: CircleState) => {
    const txid = await broadcast(circle.payout({ circle: await utxoAt(state), state }));
    return { txid, next: afterPayout(state) };
  };

  const refund = async (state: CircleState, member: number) => {
    const txid = await broadcast(circle.refund({ circle: await utxoAt(state), state, member }));
    return { txid, next: afterRefund(state, member) };
  };

  /** Hand-built circle spend, for transactions the SDK would never build. */
  const raw = (utxo: SpendableUtxo, unlocker: ReturnType<ReturnType<Circle['contractAt']>['unlock']['payout']>, sequence?: number) =>
    new TransactionBuilder({ provider }).addInput(utxo, unlocker, sequence === undefined ? undefined : { sequence });

  /** Hand-built refund paying `toMember` sat to `member` (the SDK refuses members who are owed nothing). */
  const rawRefund = async (state: CircleState, member: number, toMember = C) => {
    const u = await utxoAt(state);
    const next = afterRefund(state, member);
    const sequence = state.refunded === 0 ? Number(circle.params.grace) : 0xfffffffe;
    const tb = new TransactionBuilder({ provider })
      .addInput(u, circle.contractAt(state).unlock.refund(BigInt(member)), { sequence })
      .setLocktime(Number(deadlineOf(circle.params, state.round)))
      .addOutput({ to: members[member]!, amount: toMember });
    if (next) tb.addOutput({ to: circle.addressAt(next), amount: u.satoshis - toMember - 1_500n });
    return tb;
  };

  const passDeadline = (round: number) => provider.setBlockHeight(Number(deadlineOf(circle.params, round)));

  return { provider, reader, circle, balance, broadcast, utxoAt, rawRefund, create, contributeTx, pay, payAll, payout, refund, raw, passDeadline };
}

/** Run rounds 0..n-1 to completion (everyone pays, the pot is paid out). */
async function completeRounds(t: ReturnType<typeof setup>, n: number): Promise<CircleState> {
  let s = await t.create();
  for (let r = 0; r < n; r++) {
    s = await t.payAll(s);
    s = (await t.payout(s)).next!;
  }
  return s;
}

describe('contract and state model', () => {
  it('the committed artifact matches a fresh compile of contracts/hui.cash', () => {
    const fresh = compileFile(new URL('../contracts/hui.cash', import.meta.url));
    expect(fresh.bytecode).toBe(artifact.bytecode);
  });

  it('keeps the state as the first push of the redeem script, so every state has its own address', () => {
    const { circle } = setup();
    const s: CircleState = { round: 2, paid: 5, refunded: 0 };
    expect(circle.contractAt(s).bytecode.slice(0, 8)).toBe('03' + binToHex(encodeState(s)));
    const addresses = new Set([START, s, afterContribute(s, 1), afterPayout(START)!].map((x) => circle.addressAt(x)));
    expect(addresses.size).toBe(4);
  });

  it('rejects invalid circle parameters', () => {
    const provider = new MockNetworkProvider();
    expect(() => new Circle({ ...params, members: members.slice(0, 3) }, provider)).toThrow('exactly 4 members');
    expect(() => new Circle({ ...params, members: [members[0]!, members[0]!, members[2]!, members[3]!] }, provider)).toThrow('different');
    expect(() => new Circle({ ...params, contribution: 2_500n }, provider)).toThrow('contribution must be at least');
    expect(() => new Circle({ ...params, firstDeadline: 1_700_000_000n }, provider)).toThrow('block height');
    expect(() => new Circle({ ...params, grace: 0n }, provider)).toThrow('grace');
  });
});

describe('happy path: 4 rounds, everyone pays', () => {
  it('pays each member the pot in order, returns the collateral at the end and closes the circle', async () => {
    const t = setup();
    const start = await Promise.all(members.map(t.balance));
    let s = await t.create();
    const received: bigint[][] = [];

    for (let round = 0; round < 4; round++) {
      s = await t.payAll(s);
      expect(s).toEqual({ round, paid: 15, refunded: 0 });
      const before = await Promise.all(members.map(t.balance));
      const { next } = await t.payout(s);
      const after = await Promise.all(members.map(t.balance));
      received.push(after.map((b, m) => b - before[m]!));
      if (round < 3) {
        // the circle carries every member's collateral into the next round
        expect(sum(await t.circle.utxosAt(next!))).toBe(DEPOSIT + 4n * C);
        s = next!;
      } else {
        expect(next).toBeNull();
      }
    }

    const maxFee = params.maxFee;
    for (const r of [0, 1, 2]) {
      // rounds 0..2: only the recipient gets something, the pot minus the miner fee
      expect(received[r]![r]!).toBeGreaterThanOrEqual(4n * C - maxFee);
      expect(received[r]![r]!).toBeLessThan(4n * C);
      expect(received[r]!.filter((x) => x !== 0n)).toHaveLength(1);
    }
    // round 3: members 0..2 get exactly their collateral, member 3 the pot + own collateral + deposit - fee
    expect(received[3]!.slice(0, 3)).toEqual([C, C, C]);
    expect(received[3]![3]!).toBeGreaterThanOrEqual(5n * C + DEPOSIT - maxFee);
    expect(received[3]![3]!).toBeLessThan(5n * C + DEPOSIT);

    // every member paid 2C + 3 x C = 5C and got 4C + C back: only fees were spent
    const end = await Promise.all(members.map(t.balance));
    members.forEach((_, m) => {
      const spent = start[m]! - end[m]!;
      const deposit = m === 0 ? DEPOSIT : m === 3 ? -DEPOSIT : 0n;
      expect(spent - deposit).toBeGreaterThan(0n);
      expect(spent - deposit).toBeLessThan(10_000n); // 4 contributions + 1 payout fee at ~1 sat/byte
    });

    // the chain follower reads the whole story back: create, 16 contributions, 4 payouts
    const status = await followCircle(t.circle, t.reader);
    expect(status.closed).toBe(true);
    expect(status.steps).toHaveLength(21);
    expect(status.steps.filter((x) => x.action === 'payout').map((x) => x.member)).toEqual([0, 1, 2, 3]);
  });

  it('anyone may pay a member\'s share (it is credited to that member), and a stranger can trigger the payout', async () => {
    const t = setup();
    let s = await t.create();
    s = await t.pay(s, 0, 'stranger'); // a friend pays member 0's share, collateral included
    s = await t.payAll(s, [1, 2, 3]);
    const before = await t.balance(members[0]!);
    // the payout needs no key at all: it is built and sent without any signature
    const payout = t.circle.payout({ circle: await t.utxoAt(s), state: s });
    await t.broadcast(payout);
    expect(payout.inputs).toHaveLength(1);
    expect((await t.balance(members[0]!)) - before).toBeGreaterThan(4n * C - params.maxFee);
    expect(await t.balance(strangerAddress)).toBeLessThan(200_000n - 2n * C);
  });

  it('follows an open circle to its current state', async () => {
    const t = setup();
    let s = await completeRounds(t, 1);
    s = await t.payAll(s, [2, 0]);
    const status = await followCircle(t.circle, t.reader);
    expect(status.closed).toBe(false);
    expect(status.state).toEqual({ round: 1, paid: 5, refunded: 0 });
    expect(status.utxo?.satoshis).toBe(DEPOSIT + 4n * C + 2n * C);
  });

  it('reports a circle that was never created', async () => {
    const t = setup();
    expect(await followCircle(t.circle, t.reader)).toMatchObject({ created: false, steps: [] });
  });
});

describe('missed deadline: short or late payment leads to refunds', () => {
  it('rejects a short or excessive payment; after the deadline the payers get their money back', async () => {
    const t = setup();
    let s = await t.create();
    s = await t.payAll(s, [0, 1]);

    expect(await t.contributeTx(s, 2, 2, 2n * C - 1n)).toFailRequireWith('Hui: wrong contribution amount');
    expect(await t.contributeTx(s, 2, 2, C)).toFailRequireWith('Hui: wrong contribution amount'); // forgot the collateral
    expect(await t.contributeTx(s, 2, 2, 2n * C + 1n)).toFailRequireWith('Hui: wrong contribution amount');

    // before the deadline nobody can cancel
    expect(t.circle.refund({ circle: await t.utxoAt(s), state: s, member: 0, locktime: Number(deadlineOf(params, 0)) - 1 }))
      .toFailRequireWith('Hui: the round deadline has not passed');
    // a locktime at the deadline is valid for the covenant but the node refuses it until the chain gets there
    await expect(t.circle.refund({ circle: await t.utxoAt(s), state: s, member: 0 }).send()).rejects.toThrow('non-final');

    t.passDeadline(0);
    expect(await t.rawRefund(s, 2)).toFailRequireWith('Hui: nothing to refund for this member');
    const circleUtxo = await t.utxoAt(s);
    expect(() => t.circle.refund({ circle: circleUtxo, state: s, member: 2 })).toThrow('nothing to refund'); // the SDK refuses too

    const before = await Promise.all([0, 1].map((m) => t.balance(members[m]!)));
    const first = await t.refund(s, 0);
    expect(first.next).toEqual({ round: 0, paid: 3, refunded: 1 });
    const last = await t.refund(first.next!, 1);
    expect(last.next).toBeNull(); // the last refund closes the circle
    expect((await t.balance(members[0]!)) - before[0]!).toBeGreaterThan(2n * C - params.maxFee);
    expect((await t.balance(members[1]!)) - before[1]!).toBeGreaterThan(2n * C + DEPOSIT - params.maxFee);
    expect((await followCircle(t.circle, t.reader)).closed).toBe(true);
  });

  it('a late payment before anyone cancels still completes the round (then only the payout is possible)', async () => {
    const t = setup();
    let s = await completeRounds(t, 1);
    s = await t.payAll(s, [0, 1, 2]);
    t.passDeadline(1);
    s = await t.pay(s, 3); // late, but nobody had cancelled yet
    expect(t.circle.refund({ circle: await t.utxoAt(s), state: s, member: 0 })).toFailRequireWith('Hui: the round is fully funded, pay it out');
    const { next } = await t.payout(s);
    expect(next).toEqual({ round: 2, paid: 0, refunded: 0 });
  });

  it('once a refund has happened, a late payment is rejected', async () => {
    const t = setup();
    let s = await completeRounds(t, 1);
    s = await t.payAll(s, [0, 1, 2]);
    t.passDeadline(1);
    s = (await t.refund(s, 1)).next!;
    expect(s).toEqual({ round: 1, paid: 7, refunded: 2 });
    expect(await t.contributeTx(s, 3)).toFailRequireWith('Hui: the circle was cancelled');
  });

  it('if nobody joins, member 0 can sweep the creation deposit after the deadline', async () => {
    const t = setup();
    const s = await t.create(5_000n);
    t.passDeadline(0);
    expect(await t.rawRefund(s, 1, 1_000n)).toFailRequireWith('Hui: nothing to refund for this member');
    const { next } = await t.refund(s, 0);
    expect(next).toBeNull();
  });

  it('a round that opens late cannot be cancelled until the circle has been idle for the grace period', async () => {
    const t = setup();
    let s = await completeRounds(t, 1);
    s = await t.payAll(s, [0, 1, 2]);
    t.passDeadline(2); // round 1 is paid very late: round 2's deadline has already passed
    s = await t.pay(s, 3);
    s = (await t.payout(s)).next!;
    expect(s).toEqual({ round: 2, paid: 0, refunded: 0 });

    // Members 2 and 3 would gain the collateral of members 0 and 1 by cancelling right now.
    // The covenant demands the first refund declare a `grace`-block age for the circle UTXO, and a
    // node (BIP68) only accepts that once it is true, so members 0 and 1 get `grace` blocks to pay.
    // (The mock checks the declared age against the covenant; real UTXO age is enforced by nodes.)
    const u = await t.utxoAt(s);
    for (const sequence of [0, 1]) {
      expect(t.circle.refund({ circle: u, state: s, member: 3, sequence }))
        .toFailRequireWith('Hui: the circle has not been idle for the grace period');
    }
    // the next refunds of an already cancelled round do not wait again
    s = (await t.refund(s, 3)).next!;
    expect(t.circle.refund({ circle: await t.utxoAt(s), state: s, member: 2 }).inputs[0]!.options?.sequence).toBe(0xfffffffe);
    expect((await t.refund(s, 2)).next).toBeNull();
  });
});

describe('default after receiving: the defaulter loses the collateral', () => {
  it('member 0 takes the round-0 pot then stops paying: its collateral is split among members 1..3', async () => {
    const t = setup();
    let s = await completeRounds(t, 1); // member 0 received 4C
    s = await t.payAll(s, [1, 2, 3]); // member 0 does not pay round 1
    t.passDeadline(1);

    expect(await t.rawRefund(s, 0)).toFailRequireWith('Hui: nothing to refund for this member');
    expect(entitledMask(s)).toBe(0b1110);
    const share = C / 3n; // 1 forfeited collateral split 3 ways
    for (const m of [1, 2, 3]) expect(owedTo(params, s, m)).toBe(C + C + share);

    const gained: bigint[] = [];
    for (const m of [1, 2, 3]) {
      const before = await t.balance(members[m]!);
      s = (await t.refund(s, m)).next ?? s;
      gained.push((await t.balance(members[m]!)) - before);
    }
    // members 1, 2: contribution + collateral + share, minus the fee; member 3 (last) also the deposit and rounding dust
    for (const g of gained.slice(0, 2)) expect(g).toBeGreaterThan(2n * C + share - params.maxFee);
    expect(gained[2]!).toBeGreaterThan(2n * C + share + DEPOSIT - params.maxFee);
    const status = await followCircle(t.circle, t.reader);
    expect(status.closed).toBe(true);
    expect(status.steps.filter((x) => x.action === 'refund').map((x) => x.member)).toEqual([1, 2, 3]);
  });

  it('two past recipients default in round 2: both collaterals go to members 2 and 3', async () => {
    const t = setup();
    let s = await completeRounds(t, 2);
    s = await t.payAll(s, [2, 3]);
    t.passDeadline(2);
    expect(entitledMask(s)).toBe(0b1100);
    expect(owedTo(params, s, 2)).toBe(3n * C); // own contribution + own collateral + half of 2 forfeited collaterals
    for (const m of [0, 1]) {
      expect(await t.rawRefund(s, m)).toFailRequireWith('Hui: nothing to refund for this member');
    }
    const before = await t.balance(members[2]!);
    s = (await t.refund(s, 2)).next!;
    expect((await t.balance(members[2]!)) - before).toBeGreaterThan(3n * C - params.maxFee);
    expect((await t.refund(s, 3)).next).toBeNull();
  });

  it('a past recipient who keeps paying gets its collateral back when someone else stops', async () => {
    const t = setup();
    let s = await completeRounds(t, 2);
    s = await t.payAll(s, [0, 2, 3]); // member 1 (paid out in round 1) stops paying
    t.passDeadline(2);
    expect(owedTo(params, s, 0)).toBe(2n * C); // contribution + collateral, no share
    expect(owedTo(params, s, 2)).toBe(2n * C + C / 2n);
    expect(owedTo(params, s, 1)).toBe(0n);
    s = (await t.refund(s, 0)).next!;
    expect(s.refunded).toBe(1);
  });
});

describe('the covenant rejects', () => {
  it('an early payout (round not fully funded)', async () => {
    const t = setup();
    let s = await t.create();
    s = await t.payAll(s, [0, 1, 2]);
    expect(t.circle.payout({ circle: await t.utxoAt(s), state: s })).toFailRequireWith('Hui: the round is not fully funded');
  });

  it('a payout to the wrong recipient', async () => {
    const t = setup();
    const s = await t.payAll(await t.create());
    const u = await t.utxoAt(s);
    for (const wrong of [members[1]!, strangerAddress]) {
      const tx = t.raw(u, t.circle.contractAt(s).unlock.payout())
        .addOutput({ to: wrong, amount: 4n * C - 1_500n })
        .addOutput({ to: t.circle.addressAt(afterPayout(s)!), amount: u.satoshis - 4n * C });
      expect(tx).toFailRequireWith("Hui: the pot must go to this round's recipient");
    }
  });

  it('a payout that skims: too large a fee, an extra output, or a short carry-over', async () => {
    const t = setup();
    const s = await t.payAll(await t.create());
    const u = await t.utxoAt(s);
    const next = t.circle.addressAt(afterPayout(s)!);
    const unlock = () => t.circle.contractAt(s).unlock.payout();

    const bigFee = t.raw(u, unlock()).addOutput({ to: members[0]!, amount: 4n * C - 2_001n }).addOutput({ to: next, amount: u.satoshis - 4n * C });
    expect(bigFee).toFailRequireWith('Hui: payout fee above maxFee');

    const extra = t.raw(u, unlock())
      .addOutput({ to: members[0]!, amount: 4n * C - 2_000n })
      .addOutput({ to: next, amount: u.satoshis - 4n * C })
      .addOutput({ to: strangerAddress, amount: 600n });
    expect(extra).toFailRequireWith('Hui: a payout has exactly 2 outputs');

    const short = t.raw(u, unlock()).addOutput({ to: members[0]!, amount: 4n * C }).addOutput({ to: next, amount: u.satoshis - 4n * C - 1_500n });
    expect(short).toFailRequireWith('Hui: the circle balance must carry over');
  });

  it('a final payout that does not return every collateral', async () => {
    const t = setup();
    const s = await t.payAll(await completeRounds(t, 3));
    const u = await t.utxoAt(s);
    const unlock = () => t.circle.contractAt(s).unlock.payout();
    const toLast = u.satoshis - 3n * C - 1_500n;

    const keepsCollateral = t.raw(u, unlock())
      .addOutput({ to: members[3]!, amount: toLast + C })
      .addOutput({ to: members[0]!, amount: C })
      .addOutput({ to: members[1]!, amount: C });
    expect(keepsCollateral).toFailRequireWith('Hui: the final payout has exactly 4 outputs');

    const wrongMember = t.raw(u, unlock())
      .addOutput({ to: members[3]!, amount: toLast })
      .addOutput({ to: members[0]!, amount: C })
      .addOutput({ to: strangerAddress, amount: C })
      .addOutput({ to: members[2]!, amount: C });
    expect(wrongMember).toFailRequireWith('Hui: collateral must return to its member');

    const shortChanged = t.raw(u, unlock())
      .addOutput({ to: members[3]!, amount: toLast + 600n })
      .addOutput({ to: members[0]!, amount: C - 600n })
      .addOutput({ to: members[1]!, amount: C })
      .addOutput({ to: members[2]!, amount: C });
    expect(shortChanged).toFailRequireWith('Hui: collateral must be returned in full');
  });

  it('a tampered next state (paying for two, skipping or rewinding a round, faking refunds, leaving the covenant)', async () => {
    const t = setup();
    let s = await t.create();
    s = await t.pay(s, 0);
    const u = await t.utxoAt(s);
    const due = amountDue(params, s);
    const payerUtxos = await t.provider.getUtxos(members[1]!);
    const tampered: CircleState[] = [
      { round: 0, paid: 0b0111, refunded: 0 }, // claims members 1 and 2 paid
      { round: 1, paid: 0b0011, refunded: 0 }, // jumps to the next round
      { round: 0, paid: 0b0011, refunded: 1 }, // marks a refund
    ];
    for (const bad of tampered) {
      const tx = t.raw(u, t.circle.contractAt(s).unlock.contribute(1n))
        .addInputs(payerUtxos, unlockerOf(1))
        .addOutput({ to: t.circle.addressAt(bad), amount: u.satoshis + due })
        .addBchChangeOutputIfNeeded({ to: members[1]!, feeRate: 1 });
      expect(tx).toFailRequireWith('Hui: next state mismatch');
    }
    const escape = t.raw(u, t.circle.contractAt(s).unlock.contribute(1n))
      .addInputs(payerUtxos, unlockerOf(1))
      .addOutput({ to: strangerAddress, amount: u.satoshis + due })
      .addBchChangeOutputIfNeeded({ to: members[1]!, feeRate: 1 });
    expect(escape).toFailRequireWith('Hui: next state mismatch');

    // payout that skips round 1 or rewinds to round 0
    const full = await t.payAll(s, [1, 2, 3]);
    const fu = await t.utxoAt(full);
    for (const bad of [{ round: 2, paid: 0, refunded: 0 }, { round: 0, paid: 0, refunded: 0 }]) {
      const tx = t.raw(fu, t.circle.contractAt(full).unlock.payout())
        .addOutput({ to: members[0]!, amount: 4n * C - 1_500n })
        .addOutput({ to: t.circle.addressAt(bad), amount: fu.satoshis - 4n * C });
      expect(tx).toFailRequireWith('Hui: next state mismatch');
    }
  });

  it('paying the same member twice in a round, or an unknown member', async () => {
    const t = setup();
    const s = await t.pay(await t.create(), 2);
    expect(await t.contributeTx(s, 2)).toFailRequireWith('Hui: this member already paid this round');
    expect(await t.contributeTx(s, 4, 1)).toFailRequireWith('Hui: member must be 0..3');
  });

  it('a refund to someone else, a refund that takes too much, a second refund', async () => {
    const t = setup();
    let s = await t.payAll(await t.create(), [0, 1, 2]);
    t.passDeadline(0);
    const u = await t.utxoAt(s);
    const locktime = Number(deadlineOf(params, 0));
    const owed = owedTo(params, s, 0);
    const next = t.circle.addressAt(afterRefund(s, 0)!);
    const unlock = () => t.circle.contractAt(s).unlock.refund(0n);
    const grace = Number(params.grace); // first refund of the round: claims the circle is `grace` blocks old

    const stolen = t.raw(u, unlock(), grace).setLocktime(locktime)
      .addOutput({ to: strangerAddress, amount: owed - 1_500n })
      .addOutput({ to: next, amount: u.satoshis - owed });
    expect(stolen).toFailRequireWith('Hui: a refund must go to its member');

    const greedy = t.raw(u, unlock(), grace).setLocktime(locktime)
      .addOutput({ to: members[0]!, amount: owed + C - 1_500n })
      .addOutput({ to: next, amount: u.satoshis - owed - C });
    expect(greedy).toFailRequireWith('Hui: the circle balance must carry over');

    const tooManyRefunded = t.raw(u, unlock(), grace).setLocktime(locktime)
      .addOutput({ to: members[0]!, amount: owed - 1_500n })
      .addOutput({ to: t.circle.addressAt({ ...s, refunded: 0b0011 }), amount: u.satoshis - owed });
    expect(tooManyRefunded).toFailRequireWith('Hui: next state mismatch');

    s = (await t.refund(s, 0)).next!;
    expect(await t.rawRefund(s, 0)).toFailRequireWith('Hui: this member was already refunded');
  });

  it('spending the circle together with other inputs where it is not allowed', async () => {
    const t = setup();
    const s = await t.payAll(await t.create());
    const u = await t.utxoAt(s);
    const [coin] = await t.provider.getUtxos(strangerAddress);
    const withExtraInput = t.raw(u, t.circle.contractAt(s).unlock.payout())
      .addInput(coin!, unlockerOf('stranger'))
      .addOutput({ to: members[0]!, amount: 4n * C - 1_500n })
      .addOutput({ to: t.circle.addressAt(afterPayout(s)!), amount: u.satoshis - 4n * C });
    expect(withExtraInput).toFailRequireWith('Hui: the circle must be spent alone');

    const notFirst = new TransactionBuilder({ provider: t.provider })
      .addInput(coin!, unlockerOf('stranger'))
      .addInput(u, t.circle.contractAt(s).unlock.payout())
      .addOutput({ to: members[0]!, amount: 4n * C - 1_500n })
      .addOutput({ to: t.circle.addressAt(afterPayout(s)!), amount: u.satoshis - 4n * C });
    expect(notFirst).toFailRequireWith('Hui: the circle must be input 0');
  });

  it('a rejected transaction leaves the circle untouched on the (mock) chain', async () => {
    const t = setup();
    const s = await t.payAll(await t.create(), [0, 1, 2]);
    await expect(t.circle.payout({ circle: await t.utxoAt(s), state: s }).send()).rejects.toThrow('Hui: the round is not fully funded');
    expect((await followCircle(t.circle, t.reader)).state).toEqual(s);
  });
});
