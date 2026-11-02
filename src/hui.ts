/**
 * Hui SDK: the circle covenant, its state model and builders for every kind of spend.
 *
 * The covenant is the only rule that matters. The helpers below that compute who is owed
 * what (`owedTo`, `entitledMask`, ...) mirror the covenant so apps can show numbers and build
 * valid transactions; they never replace it. A wrong transaction built by hand is rejected when
 * CashScript evaluates it (`debug()` / `send()`) or by any BCH node.
 */
import {
  Contract,
  TransactionBuilder,
  type NetworkProvider,
  type SpendableUtxo,
  type Unlocker,
} from 'cashscript';
import {
  binToHex,
  cashAddressToLockingBytecode,
  encodeCashAddress,
  hash160,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';
import artifact from './artifacts/hui.artifact.js';

export { artifact };
export type HuiContract = Contract<typeof artifact>;

/** v0 circles have exactly 4 members. Member i receives the pot in round i. */
export const MEMBERS = 4;
/** paid bitmask when every member has paid the current round */
export const ALL_PAID = 15;

export interface CircleParams {
  /** 4 CashAddresses (P2PKH or P2SH), in payout order. */
  members: string[];
  /** Satoshis each member pays per round. Collateral = one contribution, locked in round 0. */
  contribution: bigint;
  /** Block height after which round 0 can be cancelled (if not fully funded). */
  firstDeadline: bigint;
  /** Blocks between round deadlines: deadline(r) = firstDeadline + r * roundLength. */
  roundLength: bigint;
  /** Max satoshis a payout or refund transaction may leave as miner fee. */
  maxFee: bigint;
  /**
   * Blocks the circle UTXO must be idle (unchanged) before the first refund of a round (BIP68).
   * Stops a cancellation right after a late payout, before members could pay the new round.
   */
  grace: bigint;
}

/** Circle state, carried in the covenant's redeem script (so every state has its own address). */
export interface CircleState {
  /** 0..3: the round being collected (round r pays member r). */
  round: number;
  /** bitmask of members who paid this round */
  paid: number;
  /** bitmask of members refunded after a missed deadline (non-zero = circle cancelled) */
  refunded: number;
}

export const START: CircleState = Object.freeze({ round: 0, paid: 0, refunded: 0 });

export const bitOf = (member: number): number => 1 << member;
export const hasBit = (mask: number, member: number): boolean => (mask & bitOf(member)) !== 0;
export const stateKey = (s: CircleState): string => `${s.round}/${s.paid}/${s.refunded}`;

export function encodeState(s: CircleState): Uint8Array {
  return Uint8Array.of(s.round, s.paid, s.refunded);
}

export function decodeState(bytes: Uint8Array): CircleState {
  if (bytes.length !== 3) throw new Error(`state must be 3 bytes, got ${bytes.length}`);
  return { round: bytes[0]!, paid: bytes[1]!, refunded: bytes[2]! };
}

export function networkPrefix(network: string): 'bitcoincash' | 'bchtest' | 'bchreg' {
  if (network === 'mainnet') return 'bitcoincash';
  if (network === 'regtest') return 'bchreg';
  return 'bchtest';
}

/** Locking bytecode of a CashAddress, throwing on a malformed address. */
export function lockingBytecodeOf(address: string): Uint8Array {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') throw new Error(`Invalid CashAddress "${address}": ${decoded}`);
  return decoded.bytecode;
}

export function addressOf(lockingBytecode: Uint8Array, network: string): string {
  const result = lockingBytecodeToCashAddress({ bytecode: lockingBytecode, prefix: networkPrefix(network) });
  if (typeof result === 'string') throw new Error(result);
  return result.address;
}

/** P2PKH CashAddress of a public key on the given network. */
export function p2pkhAddress(publicKey: Uint8Array, network: string, tokenAware = false): string {
  return encodeCashAddress({
    prefix: networkPrefix(network),
    type: tokenAware ? 'p2pkhWithTokens' : 'p2pkh',
    payload: hash160(publicKey),
  }).address;
}

/**
 * BCHN dust threshold for a plain BCH output with this locking bytecode:
 * 3 * (serialized output size + 148) at the default 1 sat/byte relay fee.
 * P2PKH = 546 sat, P2SH32 = 576 sat.
 */
export function dustLimit(lockingBytecode: Uint8Array): bigint {
  return BigInt(3 * (8 + 1 + lockingBytecode.length + 148));
}

export function validateParams(p: CircleParams): void {
  if (p.members.length !== MEMBERS) throw new Error(`a v0 circle has exactly ${MEMBERS} members, got ${p.members.length}`);
  const locks = p.members.map(lockingBytecodeOf).map(binToHex);
  if (new Set(locks).size !== MEMBERS) throw new Error('members must be 4 different addresses');
  if (p.maxFee < 0n) throw new Error('maxFee must be >= 0');
  // Every refund or payout must still leave the member a relayable output after the fee.
  if (p.contribution < p.maxFee + 1_000n) throw new Error('contribution must be at least maxFee + 1000 sat');
  if (p.firstDeadline <= 0n || p.firstDeadline >= 500_000_000n) {
    throw new Error('firstDeadline must be a block height (1..499999999)');
  }
  if (p.roundLength <= 0n) throw new Error('roundLength must be > 0 blocks');
  // CSV block-based relative locks use the low 16 bits of the sequence number.
  if (p.grace < 1n || p.grace > 65_535n) throw new Error('grace must be 1..65535 blocks');
  if (p.firstDeadline + 3n * p.roundLength >= 500_000_000n) throw new Error('the last deadline must stay a block height');
}

export function deadlineOf(p: CircleParams, round: number): bigint {
  return p.firstDeadline + BigInt(round) * p.roundLength;
}

// ------------------------------------------------------------------ covenant mirror

/** Members who already received a pot (index < round) and did not pay the current round. */
export function defaultersOf(s: CircleState): number[] {
  const out: number[] = [];
  for (let m = 0; m < s.round; m++) if (!hasBit(s.paid, m)) out.push(m);
  return out;
}

/** Bitmask of members a cancelled circle still owes money to. */
export function entitledMask(s: CircleState): number {
  if (s.round === 0) return s.paid === 0 ? 1 : s.paid;
  return defaultersOf(s).reduce((mask, m) => mask & ~bitOf(m), ALL_PAID);
}

/**
 * What `member` is owed if the current round is cancelled (before the miner fee).
 * The last member refunded also takes whatever is left (creation deposit + rounding dust).
 */
export function owedTo(p: CircleParams, s: CircleState, member: number): bigint {
  const paid = hasBit(s.paid, member);
  const c = p.contribution;
  if (s.round === 0) return paid ? 2n * c : 0n;
  let owed = paid ? c : 0n;
  if (member >= s.round) {
    const forfeited = BigInt(defaultersOf(s).length) * c;
    owed += c + forfeited / BigInt(MEMBERS - s.round);
  } else if (paid) {
    owed += c;
  }
  return owed;
}

/** Amount `member` must pay into the current round (round 0 includes the collateral). */
export function amountDue(p: CircleParams, s: CircleState): bigint {
  return s.round === 0 ? 2n * p.contribution : p.contribution;
}

export const afterContribute = (s: CircleState, member: number): CircleState => ({
  round: s.round,
  paid: s.paid | bitOf(member),
  refunded: 0,
});

/** null = the circle closes (final payout) */
export const afterPayout = (s: CircleState): CircleState | null =>
  s.round === MEMBERS - 1 ? null : { round: s.round + 1, paid: 0, refunded: 0 };

/** null = the circle closes (last refund) */
export function afterRefund(s: CircleState, member: number): CircleState | null {
  const refunded = s.refunded | bitOf(member);
  return refunded === entitledMask(s) ? null : { round: s.round, paid: s.paid, refunded };
}

/** Every transition the covenant could accept from `s` (used to follow a circle on chain). */
export function transitionsFrom(s: CircleState): { action: string; member: number | null; next: CircleState | null }[] {
  const out: { action: string; member: number | null; next: CircleState | null }[] = [];
  if (s.refunded === 0) {
    for (let m = 0; m < MEMBERS; m++) {
      if (!hasBit(s.paid, m)) out.push({ action: 'contribute', member: m, next: afterContribute(s, m) });
    }
    if (s.paid === ALL_PAID) out.push({ action: 'payout', member: s.round, next: afterPayout(s) });
  }
  if (s.paid !== ALL_PAID) {
    const entitled = entitledMask(s);
    for (let m = 0; m < MEMBERS; m++) {
      if (hasBit(entitled, m) && !hasBit(s.refunded, m)) out.push({ action: 'refund', member: m, next: afterRefund(s, m) });
    }
  }
  return out;
}

// ------------------------------------------------------------------ builders

const feeFor = (bytes: bigint, feeRate: number): bigint => BigInt(Math.ceil(Number(bytes) * feeRate));

export interface CreateOptions {
  /** Plain BCH UTXOs of the creator (no tokens). */
  utxos: SpendableUtxo[];
  /** Unlocker for those UTXOs: SignatureTemplate(...).unlockP2PKH() or a WizardConnect placeholder. */
  unlocker: Unlocker;
  /** Satoshis the circle UTXO starts with (>= dust). It ends with the last payout / refund. Default 1000. */
  deposit?: bigint;
  changeTo: string;
  feeRate?: number;
}

export interface ContributeOptions {
  /** The circle UTXO in state `state`. */
  circle: SpendableUtxo;
  state: CircleState;
  /** Whose share is being paid (0..3). Anyone may pay it; the money is credited to this member. */
  member: number;
  /** Payer's plain BCH UTXOs. */
  utxos: SpendableUtxo[];
  unlocker: Unlocker;
  changeTo: string;
  /** Override the amount (only tests use this, to show the covenant rejecting it). */
  amount?: bigint;
  feeRate?: number;
}

export interface SpendOptions {
  circle: SpendableUtxo;
  state: CircleState;
  feeRate?: number;
}

export class Circle {
  private readonly contracts = new Map<string, HuiContract>();
  readonly memberLocks: Uint8Array[];

  constructor(
    readonly params: CircleParams,
    readonly provider: NetworkProvider,
  ) {
    validateParams(params);
    this.memberLocks = params.members.map(lockingBytecodeOf);
  }

  contractAt(state: CircleState): HuiContract {
    const key = stateKey(state);
    let contract = this.contracts.get(key);
    if (!contract) {
      const p = this.params;
      const [m0, m1, m2, m3] = this.memberLocks as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
      contract = new Contract(
        artifact,
        [m0, m1, m2, m3, p.contribution, p.firstDeadline, p.roundLength, p.maxFee, p.grace, encodeState(state)],
        { provider: this.provider, contractType: 'p2sh32' },
      );
      this.contracts.set(key, contract);
    }
    return contract;
  }

  addressAt(state: CircleState): string {
    return this.contractAt(state).address;
  }

  lockingBytecodeAt(state: CircleState): Uint8Array {
    return lockingBytecodeOf(this.addressAt(state));
  }

  /** Where the circle is created (round 0, nobody paid yet). Share this with the members. */
  get startAddress(): string {
    return this.addressAt(START);
  }

  member(i: number): string {
    const address = this.params.members[i];
    if (address === undefined) throw new Error(`no member ${i}`);
    return address;
  }

  /** Circle UTXOs currently at the address of `state` (normally exactly one). */
  async utxosAt(state: CircleState): Promise<SpendableUtxo[]> {
    return (await this.provider.getUtxos(this.addressAt(state))).filter((u) => !u.token);
  }

  /** Create the circle: a plain payment of `deposit` sat to the start address. */
  create(o: CreateOptions): TransactionBuilder {
    const deposit = o.deposit ?? 1_000n;
    if (deposit < dustLimit(this.lockingBytecodeAt(START))) throw new Error('deposit is below the dust limit');
    return new TransactionBuilder({ provider: this.provider })
      .addInputs(o.utxos.filter((u) => !u.token), o.unlocker)
      .addOutput({ to: this.startAddress, amount: deposit })
      .addBchChangeOutputIfNeeded({ to: o.changeTo, feeRate: o.feeRate ?? 1.0 });
  }

  /** Pay `member`'s share of the current round. The payer covers the miner fee. */
  contribute(o: ContributeOptions): TransactionBuilder {
    const amount = o.amount ?? amountDue(this.params, o.state);
    const next = afterContribute(o.state, o.member);
    return new TransactionBuilder({ provider: this.provider })
      .addInput(o.circle, this.contractAt(o.state).unlock.contribute(BigInt(o.member)))
      .addInputs(o.utxos.filter((u) => !u.token), o.unlocker)
      .addOutput({ to: this.addressAt(next), amount: o.circle.satoshis + amount })
      .addBchChangeOutputIfNeeded({ to: o.changeTo, feeRate: o.feeRate ?? 1.0 });
  }

  /** Send the pot to this round's recipient. Anyone may build and broadcast it. The pot pays the fee. */
  payout(o: SpendOptions): TransactionBuilder {
    const { round } = o.state;
    const c = this.params.contribution;
    const pot = 4n * c;
    const unlock = () => this.contractAt(o.state).unlock.payout();
    const draft = (fee: bigint): TransactionBuilder => {
      const tb = new TransactionBuilder({ provider: this.provider }).addInput(o.circle, unlock());
      const next = afterPayout(o.state);
      if (next) {
        tb.addOutput({ to: this.member(round), amount: pot - fee });
        tb.addOutput({ to: this.addressAt(next), amount: o.circle.satoshis - pot });
      } else {
        tb.addOutput({ to: this.member(round), amount: o.circle.satoshis - 3n * c - fee });
        for (let m = 0; m < MEMBERS - 1; m++) tb.addOutput({ to: this.member(m), amount: c });
      }
      return tb;
    };
    return draft(this.feeOf(draft(0n), o.feeRate));
  }

  /**
   * After the round deadline, refund `member` (cancels the circle). Anyone may build and broadcast it;
   * the money can only go to that member. The refund pays its own fee.
   */
  refund(o: SpendOptions & { member: number; locktime?: number; sequence?: number }): TransactionBuilder {
    if (!hasBit(entitledMask(o.state), o.member) || hasBit(o.state.refunded, o.member)) {
      throw new Error(`member ${o.member} has nothing to refund in this state (defaulted, never paid, or already refunded)`);
    }
    const owed = owedTo(this.params, o.state, o.member);
    const next = afterRefund(o.state, o.member);
    const locktime = o.locktime ?? Number(deadlineOf(this.params, o.state.round));
    // The first refund claims the circle UTXO is `grace` blocks old; a node only relays it once that is true.
    const sequence = o.sequence ?? (o.state.refunded === 0 ? Number(this.params.grace) : 0xfffffffe);
    const draft = (fee: bigint): TransactionBuilder => {
      const tb = new TransactionBuilder({ provider: this.provider })
        .addInput(o.circle, this.contractAt(o.state).unlock.refund(BigInt(o.member)), { sequence })
        .setLocktime(locktime);
      if (next) {
        tb.addOutput({ to: this.member(o.member), amount: owed - fee });
        tb.addOutput({ to: this.addressAt(next), amount: o.circle.satoshis - owed });
      } else {
        tb.addOutput({ to: this.member(o.member), amount: o.circle.satoshis - fee });
      }
      return tb;
    };
    return draft(this.feeOf(draft(0n), o.feeRate));
  }

  private feeOf(draft: TransactionBuilder, feeRate = 1.0): bigint {
    const fee = feeFor(draft.getTransactionSize(), feeRate);
    if (fee > this.params.maxFee) throw new Error(`fee ${fee} sat is above maxFee ${this.params.maxFee}`);
    return fee;
  }
}
