/**
 * The v0 browser demo's simulation engine (demo/src/sim.ts), driven headlessly: the same calls the
 * page's buttons make. Each scenario is cross-checked against the (mock) chain with followCircle().
 */
import { followCircle, MemoryChainReader } from '../src/chain.js';
import { C, DEPOSIT, HuiSim, NAMES, PARAMS, WALLET } from '../demo/src/sim.js';

function fresh() {
  const sim = new HuiSim();
  const reader = new MemoryChainReader(sim.provider);
  const reasons = () => sim.log.filter((e) => e.kind === 'refused').map((e) => e.reason);
  const chain = () => followCircle(sim.circle, reader);
  return { sim, reasons, chain };
}

describe('browser demo engine', () => {
  it('offers only "create" (and the scenarios) before the circle exists', () => {
    const { sim } = fresh();
    const can = sim.can;
    expect(can.create).toBe(true);
    expect([can.payAll, can.payout, can.advance, can.refundAll, can.earlyPayout, can.stealPot, can.earlyRefund]).toEqual(
      Array(7).fill(false),
    );
    expect([0, 1, 2, 3].some((m) => can.pay(m) || can.refund(m))).toBe(false);
  });

  it('full circle: 21 accepted transactions, every member takes one pot, the circle closes', async () => {
    const { sim, reasons, chain } = fresh();
    await sim.runFullCircle();

    expect(reasons()).toEqual([]);
    expect(sim.txCount).toBe(21);
    expect(sim.phase).toBe('closed');
    expect(sim.closedBy).toBe('payout');
    expect(sim.circleSats).toBe(0n);
    for (let m = 0; m < 4; m++) {
      const v = sim.member(m);
      expect(v.received).not.toBeNull();
      expect(v.collateral).toBe('returned');
      // each member paid 5C and got 5C back: the wallet only lost miner fees (+/- the creation deposit)
      expect(-v.net).toBeGreaterThan(0n);
      expect(-v.net).toBeLessThan(10_000n);
    }
    // the pot of rounds 1-3 minus the fee; round 4 also carries Tuan's collateral and the deposit
    for (const m of [0, 1, 2]) expect(sim.member(m).received!).toBeGreaterThan(4n * C - PARAMS.maxFee);
    expect(sim.member(3).received!).toBeGreaterThan(5n * C + DEPOSIT - PARAMS.maxFee);

    // every logged transaction is on the mock chain, in order, and the chain agrees the circle closed
    const status = await chain();
    expect(status.closed).toBe(true);
    expect(status.steps.map((s) => s.txid)).toEqual(sim.log.filter((e) => e.kind === 'tx').map((e) => e.txid));
    for (const e of sim.log.filter((x) => x.kind === 'tx')) {
      expect(e.bytes).toBeGreaterThan(200);
      expect(e.fee).toBeGreaterThan(0n);
      expect(e.fee).toBeLessThanOrEqual(BigInt(e.bytes!)); // 1 sat/byte
    }
    expect(sim.log.at(-1)!.text).toContain('Circle complete after 21 transactions');
  });

  it('Lan takes the pot and stops paying: refused early cancel and defaulter refund, collateral split 3 ways', async () => {
    const { sim, reasons, chain } = fresh();
    await sim.runDefault();

    expect(reasons()).toEqual(['Hui: the round deadline has not passed', 'Hui: nothing to refund for this member']);
    expect(sim.phase).toBe('closed');
    expect(sim.closedBy).toBe('refund');
    const lan = sim.member(0);
    expect(lan.collateral).toBe('forfeited');
    expect(lan.refunded).toBeNull();
    // Minh and Hoa: this round's payment + collateral + a third of Lan's collateral, minus the fee
    for (const m of [1, 2]) {
      const got = sim.member(m).refunded!;
      expect(got).toBeLessThanOrEqual(2n * C + C / 3n);
      expect(got).toBeGreaterThan(2n * C + C / 3n - PARAMS.maxFee);
    }
    // Tuan, refunded last, also takes the creation deposit and the rounding dust
    expect(sim.member(3).refunded!).toBeGreaterThan(2n * C + C / 3n + DEPOSIT - PARAMS.maxFee);
    expect(sim.log.at(-1)!.text).toContain('split among Minh, Hoa and Tuan');

    const status = await chain();
    expect(status.closed).toBe(true);
    expect(status.steps.map((s) => s.action)).toEqual([
      'create', 'contribute', 'contribute', 'contribute', 'contribute', 'payout',
      'contribute', 'contribute', 'contribute', 'refund', 'refund', 'refund',
    ]);
  });

  it('try to cheat: each attempt is refused by the covenant and leaves the circle untouched', async () => {
    const { sim, reasons, chain } = fresh();
    await sim.runCheats();

    expect(reasons()).toEqual([
      'Hui: the round is not fully funded',
      'Hui: wrong contribution amount',
      "Hui: the pot must go to this round's recipient",
      'Hui: next state mismatch',
    ]);
    // the honest payout after the attempts still works: round 2 is open, Lan got the pot
    expect(sim.state).toEqual({ round: 1, paid: 0, refunded: 0 });
    expect(sim.member(0).received!).toBeGreaterThan(4n * C - PARAMS.maxFee);
    const status = await chain();
    expect(status.state).toEqual(sim.state);
    expect(status.steps).toHaveLength(sim.txCount);
  });

  it('manual play: a late payment restarts the grace period before anyone can cancel', async () => {
    const { sim, chain } = fresh();
    await sim.create();
    await sim.payAll();
    await sim.payout();
    // round 2: nobody pays; time passes
    expect(sim.can.earlyRefund).toBe(true);
    await sim.advance();
    expect(sim.can.refund(1)).toBe(true);
    expect(sim.can.refund(0)).toBe(false); // Lan received a pot and has not paid
    expect(sim.can.refundDefaulter).toBe(true);
    expect(sim.member(1).owed).toBe(C + C / 3n);

    // Minh pays late (allowed until someone cancels): the circle moved, so it must sit idle for `grace` blocks again
    await sim.contribute(1);
    expect(sim.can.refundAll).toBe(false);
    expect(sim.can.advance).toBe(true);
    await sim.advance();
    expect(sim.can.refundAll).toBe(true);
    await sim.refundAll();

    expect(sim.phase).toBe('closed');
    expect(sim.member(0).collateral).toBe('forfeited');
    // Minh paid this round, so gets that back too
    expect(sim.member(1).refunded!).toBeGreaterThan(2n * C + C / 3n - PARAMS.maxFee);
    expect(sim.member(2).refunded!).toBeGreaterThan(C + C / 3n - PARAMS.maxFee);
    expect((await chain()).closed).toBe(true);
  });

  it('round 1 with one payer: after the deadline that payer gets everything back and the circle closes', async () => {
    const { sim } = fresh();
    await sim.create();
    // nobody paid yet: sweeping the 1,000 sat deposit would not cover its own fee, so nothing to cancel
    expect([sim.can.advance, sim.can.earlyRefund, sim.can.refundAll]).toEqual([false, false, false]);
    await sim.contribute(2);
    await sim.advance();
    expect([0, 1, 2, 3].map((m) => sim.can.refund(m))).toEqual([false, false, true, false]);
    await sim.refund(2);
    expect(sim.phase).toBe('closed');
    // Hoa paid 2C (+ the fee) and got 2C + the deposit back, minus the refund fee
    expect(sim.member(2).refunded!).toBeGreaterThan(2n * C + DEPOSIT - PARAMS.maxFee);
    expect(sim.member(2).wallet).toBeLessThan(WALLET);
    expect(sim.member(2).collateral).toBe('returned');
  });

  it('reset starts a clean simulation', async () => {
    const { sim } = fresh();
    await sim.create();
    sim.reset();
    expect(sim.phase).toBe('new');
    expect(sim.log).toEqual([]);
    expect(sim.wallets).toEqual([WALLET, WALLET, WALLET, WALLET]);
    expect(NAMES).toHaveLength(4);
  });
});
