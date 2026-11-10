/**
 * Chipnet helper: member 1 sends test coins to members 2..4 in one transaction, so the
 * whole circle can run from a single faucet payment. Chipnet only; prints no private key.
 *
 *   npx tsx scripts/fund-members.ts [--amount 60000] [--config .hui/chipnet.json] [--dry-run]
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { hexToBin } from '@bitauth/libauth';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { p2pkhAddress } from '../src/hui.js';

const NETWORK = 'chipnet';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    config: { type: 'string', default: resolve(ROOT, '.hui/chipnet.json') },
    amount: { type: 'string', default: '60000' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const config = JSON.parse(readFileSync(args.config, 'utf8')) as {
  network: string;
  members: { privateKey: string; publicKey: string }[];
};
if (config.network !== NETWORK) throw new Error(`${args.config} is not a ${NETWORK} config`);

const amount = BigInt(args.amount);
const members = config.members.map((k) => p2pkhAddress(hexToBin(k.publicKey), NETWORK));
const funder = members[0]!;
const provider = new ElectrumNetworkProvider(NETWORK, { manualConnectionManagement: true });
await provider.connect();
try {
  const utxos = (await provider.getUtxos(funder)).filter((u) => !u.token);
  const balance = utxos.reduce((t, u) => t + u.satoshis, 0n);
  console.log(`  member 1 ${funder}: ${balance} sat in ${utxos.length} UTXO(s)`);
  if (balance < amount * 3n + 2_000n) throw new Error('member 1 does not hold enough chipnet coins');

  const tb = new TransactionBuilder({ provider })
    .addInputs(utxos, new SignatureTemplate(hexToBin(config.members[0]!.privateKey)).unlockP2PKH());
  for (const to of members.slice(1)) tb.addOutput({ to, amount });
  tb.addBchChangeOutputIfNeeded({ to: funder, feeRate: 1.0 });

  members.slice(1).forEach((m, i) => console.log(`  -> member ${i + 2} ${m}: ${amount} sat`));
  if (args['dry-run']) {
    console.log(`  dry run: ${tb.build().length / 2} bytes, not sent`);
  } else {
    const tx = await tb.send();
    console.log(`  fund: ${tx.txid}\n  https://cbch.loping.net/tx/${tx.txid}`);
  }
} finally {
  await provider.disconnect();
}
