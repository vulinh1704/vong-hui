/**
 * Reading a circle back from the chain.
 *
 * The circle moves to a new address at every state change (the state is part of the covenant),
 * so status is found by following the chain of spends from the start address: at each step the
 * candidate next states are computed locally (at most 9), and the spending transaction tells
 * which one happened. That is 2 Electrum requests per step, whatever the circle's history.
 */
import { binToHex, decodeTransaction, hexToBin, sha256, type TransactionCommon } from '@bitauth/libauth';
import type { ElectrumNetworkProvider, MockNetworkProvider, SpendableUtxo } from 'cashscript';
import { lockingBytecodeOf, START, transitionsFrom, type Circle, type CircleState } from './hui.js';

export interface ChainReader {
  getUtxos(address: string): Promise<SpendableUtxo[]>;
  /** txids that pay to or spend from `address`, oldest first where known */
  getHistory(address: string): Promise<string[]>;
  getRawTransaction(txid: string): Promise<string>;
}

export interface CircleStep {
  txid: string;
  action: 'create' | 'contribute' | 'payout' | 'refund';
  /** member paid for / paid out to / refunded (0-based) */
  member: number | null;
  round: number;
  /** state after this step (null = circle closed) */
  state: CircleState | null;
}

export interface CircleStatus {
  created: boolean;
  closed: boolean;
  /** current state while the circle is open */
  state: CircleState | null;
  utxo: SpendableUtxo | null;
  steps: CircleStep[];
}

const decode = (hex: string): TransactionCommon => {
  const tx = decodeTransaction(hexToBin(hex));
  if (typeof tx === 'string') throw new Error(`cannot decode transaction: ${tx}`);
  return tx;
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => binToHex(a) === binToHex(b);

/** Follow a circle from its creation to its current state (or its closing transaction). */
export async function followCircle(circle: Circle, reader: ChainReader, maxSteps = 100): Promise<CircleStatus> {
  const steps: CircleStep[] = [];
  let state: CircleState = START;

  // 1. creation: the first transaction paying the start address
  let outpoint: { txid: string; vout: number } | null = null;
  const startLock = circle.lockingBytecodeAt(START);
  for (const txid of await reader.getHistory(circle.startAddress)) {
    const vout = decode(await reader.getRawTransaction(txid)).outputs.findIndex((o) => sameBytes(o.lockingBytecode, startLock));
    if (vout >= 0) {
      outpoint = { txid, vout };
      steps.push({ txid, action: 'create', member: null, round: 0, state: START });
      break;
    }
  }
  if (!outpoint) return { created: false, closed: false, state: null, utxo: null, steps };

  for (let i = 0; i < maxSteps; i++) {
    const address = circle.addressAt(state);
    const at: { txid: string; vout: number } = outpoint;
    const live = (await reader.getUtxos(address)).find((u) => u.txid === at.txid && u.vout === at.vout);
    if (live) return { created: true, closed: false, state, utxo: live, steps };

    // 2. find the transaction that spent the circle outpoint
    let spender: { txid: string; tx: TransactionCommon } | null = null;
    for (const txid of await reader.getHistory(address)) {
      if (txid === at.txid) continue;
      const tx = decode(await reader.getRawTransaction(txid));
      const spends = tx.inputs.some(
        (input) => binToHex(input.outpointTransactionHash) === at.txid && input.outpointIndex === at.vout,
      );
      if (spends) {
        spender = { txid, tx };
        break;
      }
    }
    if (!spender) throw new Error(`circle outpoint ${outpoint.txid}:${outpoint.vout} is spent but its spender was not found`);

    // 3. which transition was it?
    const candidates = transitionsFrom(state);
    let moved = false;
    for (const t of candidates) {
      if (!t.next) continue;
      const lock = circle.lockingBytecodeAt(t.next);
      const vout = spender.tx.outputs.findIndex((o) => sameBytes(o.lockingBytecode, lock));
      if (vout >= 0) {
        steps.push({ txid: spender.txid, action: t.action as CircleStep['action'], member: t.member, round: state.round, state: t.next });
        state = t.next;
        outpoint = { txid: spender.txid, vout };
        moved = true;
        break;
      }
    }
    if (moved) continue;

    // 4. no continuation: final payout or last refund, recognised by its first output
    const first = spender.tx.outputs[0];
    const closing = candidates.find(
      (t) => t.next === null && t.member !== null && first !== undefined && sameBytes(first.lockingBytecode, circle.memberLocks[t.member]!),
    );
    if (!closing) throw new Error(`transaction ${spender.txid} spent the circle in an unknown way`);
    steps.push({ txid: spender.txid, action: closing.action as CircleStep['action'], member: closing.member, round: state.round, state: null });
    return { created: true, closed: true, state: null, utxo: null, steps };
  }
  throw new Error(`gave up after ${maxSteps} steps`);
}

/** Reader backed by an Electrum (Fulcrum) server, through CashScript's provider. */
export class ElectrumChainReader implements ChainReader {
  constructor(readonly provider: ElectrumNetworkProvider) {}

  getUtxos(address: string): Promise<SpendableUtxo[]> {
    return this.provider.getUtxos(address);
  }

  async getHistory(address: string): Promise<string[]> {
    const scripthash = binToHex(sha256.hash(lockingBytecodeOf(address)).reverse());
    const result = await this.provider.performRequest('blockchain.scripthash.get_history', scripthash);
    if (result instanceof Error) throw result;
    const rows = result as unknown as { tx_hash: string; height: number }[];
    // confirmed first (by height), then mempool (height <= 0)
    const rank = (h: number) => (h > 0 ? h : Number.MAX_SAFE_INTEGER);
    return [...rows].sort((a, b) => rank(a.height) - rank(b.height)).map((r) => r.tx_hash);
  }

  getRawTransaction(txid: string): Promise<string> {
    return this.provider.getRawTransaction(txid);
  }
}

/**
 * In-memory reader for MockNetworkProvider: remembers every transaction sent through `send()`.
 * Used by the tests and by the offline demo.
 */
export class MemoryChainReader implements ChainReader {
  readonly log: { txid: string; hex: string }[] = [];

  constructor(readonly provider: MockNetworkProvider) {
    const send = provider.sendRawTransaction.bind(provider);
    provider.sendRawTransaction = async (hex: string) => {
      const txid = await send(hex);
      if (!this.log.some((t) => t.txid === txid)) this.log.push({ txid, hex });
      return txid;
    };
  }

  getUtxos(address: string): Promise<SpendableUtxo[]> {
    return this.provider.getUtxos(address);
  }

  async getHistory(address: string): Promise<string[]> {
    const lock = lockingBytecodeOf(address);
    const touches = (tx: TransactionCommon): boolean =>
      tx.outputs.some((o) => sameBytes(o.lockingBytecode, lock)) ||
      tx.inputs.some((input) => {
        const source = this.log.find((t) => t.txid === binToHex(input.outpointTransactionHash));
        const output = source && decode(source.hex).outputs[input.outpointIndex];
        return output !== undefined && sameBytes(output.lockingBytecode, lock);
      });
    return this.log.filter((t) => touches(decode(t.hex))).map((t) => t.txid);
  }

  async getRawTransaction(txid: string): Promise<string> {
    const found = this.log.find((t) => t.txid === txid);
    if (!found) throw new Error(`unknown transaction ${txid}`);
    return found.hex;
  }
}
