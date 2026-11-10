/**
 * Hui CLI: chipnet only. Mainnet is deliberately not supported by this prototype.
 *
 *   npm run hui -- keygen     [--contribution 10000] [--round-length 6] [--first-in 12] [--grace 1] [--max-fee 2000]
 *   npm run hui -- address    [--member <pubkey hex | bchtest:addr> x4 --first-deadline <height> ...]
 *   npm run hui -- status
 *   npm run hui -- reschedule [--first-in 12]      move the deadlines (only before the circle exists)
 *   npm run hui -- create     [--deposit 1000]     member 1 creates the circle (plain payment)
 *   npm run hui -- contribute --member 1..4 [--payer 1..4]
 *   npm run hui -- payout                          anyone: pot -> this round's recipient
 *   npm run hui -- refund     --member 1..4        anyone, after a missed deadline
 *
 * Members are numbered 1..4 here (member 1 receives the pot in round 1). Every command except
 * `address --member ...` reads throwaway keys from .hui/chipnet.json (created by `keygen`,
 * gitignored). Override with --config <path>.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { binToHex, hexToBin } from '@bitauth/libauth';
import { compileFile } from 'cashc';
import { ElectrumNetworkProvider, SignatureTemplate, type TransactionBuilder } from 'cashscript';
import {
  ALL_PAID,
  amountDue,
  artifact,
  Circle,
  deadlineOf,
  entitledMask,
  hasBit,
  MEMBERS,
  owedTo,
  p2pkhAddress,
  START,
  type CircleParams,
  type CircleState,
} from '../hui.js';
import { ElectrumChainReader, followCircle, type CircleStatus } from '../chain.js';
import { randomKey, type KeyPair } from '../keys.js';

const NETWORK = 'chipnet';
const EXPLORER_TX = 'https://cbch.loping.net/tx/';
const FAUCET = 'https://tbch.googol.cash (choose chipnet)';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACT_SOURCE = resolve(ROOT, 'contracts/hui.cash');

const { positionals, values: args } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string', default: resolve(ROOT, '.hui/chipnet.json') },
    network: { type: 'string', default: NETWORK },
    member: { type: 'string', multiple: true },
    payer: { type: 'string' },
    contribution: { type: 'string' },
    'first-deadline': { type: 'string' },
    'first-in': { type: 'string' },
    'round-length': { type: 'string' },
    'max-fee': { type: 'string' },
    grace: { type: 'string' },
    deposit: { type: 'string' },
  },
});

if (args.network !== NETWORK) {
  fail(`Only --network ${NETWORK} is supported by this prototype (got "${args.network}"). No mainnet.`);
}

// ---------------------------------------------------------------- config

interface HexKey { privateKey: string; publicKey: string }
interface Config {
  network: typeof NETWORK;
  warning: string;
  members: HexKey[];
  circle: { contribution: string; firstDeadline: string; roundLength: string; maxFee: string; grace: string };
}

const toHexKey = (k: KeyPair): HexKey => ({ privateKey: binToHex(k.privateKey), publicKey: binToHex(k.publicKey) });
const fromHexKey = (k: HexKey): KeyPair => ({ privateKey: hexToBin(k.privateKey), publicKey: hexToBin(k.publicKey) });

function loadConfig(): Config {
  if (!existsSync(args.config)) fail(`No ${args.config}. Run: npm run hui -- keygen`);
  const config = JSON.parse(readFileSync(args.config, 'utf8')) as Config;
  if (config.network !== NETWORK) fail(`${args.config} is not a ${NETWORK} config.`);
  return config;
}

const saveConfig = (config: Config) => {
  mkdirSync(dirname(args.config), { recursive: true });
  writeFileSync(args.config, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
};

function paramsFromConfig(config: Config): CircleParams {
  return {
    members: config.members.map((k) => p2pkhAddress(hexToBin(k.publicKey), NETWORK)),
    contribution: BigInt(config.circle.contribution),
    firstDeadline: BigInt(config.circle.firstDeadline),
    roundLength: BigInt(config.circle.roundLength),
    maxFee: BigInt(config.circle.maxFee),
    grace: BigInt(config.circle.grace),
  };
}

// ---------------------------------------------------------------- helpers

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

// One Electrum connection for the whole command (opened in main, before any network command runs).
const electrum = new ElectrumNetworkProvider(NETWORK, { manualConnectionManagement: true });
const provider = (): ElectrumNetworkProvider => electrum;

/** "1".."4" -> 0..3 */
function memberIndex(value: string | undefined, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MEMBERS) fail(`--${flag} must be 1..${MEMBERS}`);
  return n - 1;
}

/** A member given as a 33-byte public key (hex) or a chipnet CashAddress. Mainnet addresses are refused. */
function memberAddress(value: string): string {
  if (/^0[23][0-9a-f]{64}$/i.test(value)) return p2pkhAddress(hexToBin(value), NETWORK);
  if (value.startsWith('bitcoincash:')) fail(`${value} is a mainnet address. This prototype is chipnet only.`);
  if (!value.startsWith('bchtest:')) fail(`--member must be a compressed public key (hex) or a bchtest: address, got "${value}"`);
  return value;
}

const describeState = (s: CircleState): string => {
  const paid = [0, 1, 2, 3].filter((m) => hasBit(s.paid, m)).map((m) => m + 1);
  const refunded = [0, 1, 2, 3].filter((m) => hasBit(s.refunded, m)).map((m) => m + 1);
  return `round ${s.round + 1}, paid: [${paid.join(', ')}]` + (s.refunded ? `, CANCELLED, refunded: [${refunded.join(', ')}]` : '');
};

function printCircle(circle: Circle, height?: number): void {
  const p = circle.params;
  console.log(`  network        ${NETWORK}`);
  console.log(`  start address  ${circle.startAddress}   (create the circle here)`);
  p.members.forEach((m, i) => console.log(`  member ${i + 1}       ${m}   receives the pot in round ${i + 1}`));
  console.log(`  contribution   ${p.contribution} sat per round (round 1 also locks ${p.contribution} sat collateral)`);
  for (let r = 0; r < MEMBERS; r++) {
    const d = deadlineOf(p, r);
    const note = height === undefined ? '' : height >= Number(d) ? '  (passed)' : `  (in ${Number(d) - height} blocks)`;
    console.log(`  deadline r${r + 1}    block ${d}${note}`);
  }
  console.log(`  maxFee / grace ${p.maxFee} sat / ${p.grace} block(s)`);
}

async function sendAndReport(label: string, tb: TransactionBuilder): Promise<void> {
  try {
    const tx = await tb.send();
    console.log(`  ${label}: ${tx.txid}\n  ${EXPLORER_TX}${tx.txid}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/non-final|non-BIP68-final/i.test(message)) {
      fail(`${label} rejected by the node: ${message.match(/non-[A-Za-z0-9-]*final/i)?.[0]}.\n  ` +
        'The round deadline (or the grace period after the last change) has not passed yet.');
    }
    fail(`${label} failed:\n${message.split('\n').slice(0, 6).join('\n')}`);
  }
}

async function openCircle(): Promise<{ config: Config; circle: Circle; status: CircleStatus }> {
  const config = loadConfig();
  const circle = new Circle(paramsFromConfig(config), provider());
  const status = await followCircle(circle, new ElectrumChainReader(provider()));
  return { config, circle, status };
}

function requireOpen(status: CircleStatus): { state: CircleState; utxo: NonNullable<CircleStatus['utxo']> } {
  if (!status.created) fail('The circle does not exist yet. Run: npm run hui -- create');
  if (status.closed || !status.state || !status.utxo) fail('The circle is closed.');
  return { state: status.state, utxo: status.utxo };
}

// ---------------------------------------------------------------- commands

async function keygen(): Promise<void> {
  if (existsSync(args.config)) fail(`${args.config} already exists (it may hold chipnet coins). Refusing to overwrite.`);
  const height = args['first-deadline'] ? undefined : await provider().getBlockHeight();
  const config: Config = {
    network: NETWORK,
    warning: 'THROWAWAY CHIPNET TEST KEYS. Never send mainnet BCH to any address derived from them.',
    members: [0, 1, 2, 3].map(() => toHexKey(randomKey())),
    circle: {
      contribution: args.contribution ?? '10000',
      firstDeadline: args['first-deadline'] ?? String(height! + Number(args['first-in'] ?? '12')),
      roundLength: args['round-length'] ?? '6',
      maxFee: args['max-fee'] ?? '2000',
      grace: args.grace ?? '1',
    },
  };
  const circle = new Circle(paramsFromConfig(config), provider()); // validates the parameters
  saveConfig(config);
  console.log(`\n  Wrote ${args.config} (chipnet test keys, gitignored)\n`);
  printCircle(circle, height);
  // each member pays 2C in round 1 and C in rounds 2..4; member 1 also pays the creation deposit
  const need = 5n * circle.params.contribution + 10_000n;
  console.log(`\n  Next: get chipnet coins for each member address from ${FAUCET}`);
  console.log(`  (about ${need} sat each, member 1 another 1000 for the creation deposit),`);
  console.log('  then: npm run hui -- create\n');
}

function address(): void {
  // Compile the source now and make sure the committed artifact is not stale.
  const fresh = compileFile(CONTRACT_SOURCE);
  if (fresh.bytecode !== artifact.bytecode) fail('src/artifacts/hui.artifact.ts is stale. Run: npm run compile');

  let params: CircleParams;
  if (args.member?.length) {
    if (args.member.length !== MEMBERS) fail(`Give --member exactly ${MEMBERS} times (payout order).`);
    if (!args['first-deadline']) fail('Give --first-deadline <chipnet block height> (offline mode does not read the chain).');
    params = {
      members: args.member.map(memberAddress),
      contribution: BigInt(args.contribution ?? '10000'),
      firstDeadline: BigInt(args['first-deadline']),
      roundLength: BigInt(args['round-length'] ?? '6'),
      maxFee: BigInt(args['max-fee'] ?? '2000'),
      grace: BigInt(args.grace ?? '1'),
    };
  } else {
    params = paramsFromConfig(loadConfig());
  }

  const circle = new Circle(params, provider());
  const contract = circle.contractAt(START);
  console.log(`\n  Compiled ${fresh.contractName} with cashc ${fresh.compiler.version}: ${contract.bytesize} bytes redeem script, ${contract.opcount} opcodes\n`);
  printCircle(circle);
  console.log('\n  The circle moves to a new address at every step (the state is part of the covenant).');
  console.log('  Start address of each round, before anyone pays:');
  for (let r = 0; r < MEMBERS; r++) console.log(`    round ${r + 1}  ${circle.addressAt({ round: r, paid: 0, refunded: 0 })}`);
  console.log('');
}

async function status(): Promise<void> {
  const { circle, status } = await openCircle();
  const height = await provider().getBlockHeight();
  console.log('');
  printCircle(circle, height);
  console.log(`\n  block height   ${height}`);
  for (const [i, m] of circle.params.members.entries()) {
    const balance = (await provider().getUtxos(m)).filter((u) => !u.token).reduce((t, u) => t + u.satoshis, 0n);
    console.log(`  member ${i + 1} wallet ${balance} sat`);
  }
  if (!status.created) {
    console.log('\n  The circle does not exist yet (no payment to the start address).');
    console.log('  Next: npm run hui -- create\n');
    return;
  }
  console.log('\n  history');
  for (const step of status.steps) {
    const who = step.member === null ? '' : ` member ${step.member + 1}`;
    console.log(`    ${step.action.padEnd(10)}${who.padEnd(10)} round ${step.round + 1}  ${EXPLORER_TX}${step.txid}`);
  }
  if (status.closed) {
    console.log('\n  The circle is closed.\n');
    return;
  }
  const s = status.state!;
  console.log(`\n  state          ${describeState(s)}`);
  console.log(`  circle UTXO    ${status.utxo!.txid}:${status.utxo!.vout}  ${status.utxo!.satoshis} sat`);
  console.log(`  at address     ${circle.addressAt(s)}`);
  if (s.paid === ALL_PAID) {
    console.log(`\n  Round ${s.round + 1} is fully funded. Next: npm run hui -- payout\n`);
    return;
  }
  const deadline = deadlineOf(circle.params, s.round);
  console.log(`  each member owes ${amountDue(circle.params, s)} sat this round; deadline block ${deadline}`);
  console.log('  if cancelled   ' + [0, 1, 2, 3]
    .map((m) => `member ${m + 1}: ${hasBit(entitledMask(s), m) ? owedTo(circle.params, s, m) : 0n} sat`)
    .join(', '));
  console.log('');
}

async function reschedule(): Promise<void> {
  const config = loadConfig();
  const before = new Circle(paramsFromConfig(config), provider());
  const status = await followCircle(before, new ElectrumChainReader(provider()));
  if (status.created) fail('The circle already exists: its deadlines are part of its address and cannot change.');
  const height = await provider().getBlockHeight();
  config.circle.firstDeadline = String(height + Number(args['first-in'] ?? '12'));
  saveConfig(config);
  console.log('');
  printCircle(new Circle(paramsFromConfig(config), provider()), height);
  console.log('');
}

async function create(): Promise<void> {
  const { config, circle, status } = await openCircle();
  if (status.created) fail(`The circle already exists (${describeState(status.state ?? START)}).`);
  const height = await provider().getBlockHeight();
  if (height + 2 >= Number(circle.params.firstDeadline)) {
    fail(`Round 1's deadline (block ${circle.params.firstDeadline}) is too close. Run: npm run hui -- reschedule`);
  }
  const creator = fromHexKey(config.members[0]!);
  const from = circle.member(0);
  const utxos = (await provider().getUtxos(from)).filter((u) => !u.token);
  if (utxos.length === 0) fail(`Member 1 has no chipnet coins. Get some at ${FAUCET}:\n    ${from}`);
  const deposit = BigInt(args.deposit ?? '1000');
  console.log(`\n  Creating the circle with a ${deposit} sat deposit from member 1`);
  await sendAndReport('create', circle.create({ utxos, unlocker: new SignatureTemplate(creator.privateKey).unlockP2PKH(), changeTo: from, deposit }));
}

async function contribute(): Promise<void> {
  const { config, circle, status } = await openCircle();
  const { state, utxo } = requireOpen(status);
  const member = memberIndex(args.member?.[0], 'member');
  const payer = args.payer ? memberIndex(args.payer, 'payer') : member;
  const key = fromHexKey(config.members[payer]!);
  const from = circle.member(payer);
  const coins = (await provider().getUtxos(from)).filter((u) => !u.token);
  if (coins.length === 0) fail(`Member ${payer + 1} has no chipnet coins. Get some at ${FAUCET}:\n    ${from}`);
  console.log(`\n  ${describeState(state)}: member ${payer + 1} pays ${amountDue(circle.params, state)} sat for member ${member + 1}`);
  await sendAndReport('contribute', circle.contribute({
    circle: utxo, state, member, utxos: coins, unlocker: new SignatureTemplate(key.privateKey).unlockP2PKH(), changeTo: from,
  }));
}

async function payout(): Promise<void> {
  const { circle, status } = await openCircle();
  const { state, utxo } = requireOpen(status);
  console.log(`\n  ${describeState(state)}: paying the pot to member ${state.round + 1} (no signature needed)`);
  await sendAndReport('payout', circle.payout({ circle: utxo, state }));
}

async function refund(): Promise<void> {
  const { circle, status } = await openCircle();
  const { state, utxo } = requireOpen(status);
  const member = memberIndex(args.member?.[0], 'member');
  // checked here so the message uses the CLI's 1-based member numbers (the SDK's error is 0-based)
  if (!hasBit(entitledMask(state), member) || hasBit(state.refunded, member)) {
    fail(`${describeState(state)}: member ${member + 1} has nothing to refund ` +
      '(stopped paying after receiving a pot, never paid this round, or already refunded).');
  }
  console.log(`\n  ${describeState(state)}: refunding member ${member + 1} (${owedTo(circle.params, state, member)} sat before fee)`);
  let tb: TransactionBuilder;
  try {
    tb = circle.refund({ circle: utxo, state, member });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  await sendAndReport('refund', tb);
}

const commands: Record<string, () => void | Promise<void>> = { keygen, address, status, reschedule, create, contribute, payout, refund };
const command = commands[positionals[0] ?? ''];
if (!command) fail(`Usage: npm run hui -- <${Object.keys(commands).join('|')}> [options]`);
const offline = positionals[0] === 'address' || (positionals[0] === 'keygen' && args['first-deadline'] !== undefined);
try {
  if (!offline) await electrum.connect();
  await command();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
process.exit(0); // also drops the Electrum connection
