# Vòng Hụi: a savings circle with no organiser to run away

A **ROSCA** (hụi in Vietnam, paluwagan in the Philippines, tontine, susu, tanda, arisan…) is a group of
people who each pay a fixed amount every round; each round the whole pot goes to one member, in a fixed
order, until everyone has received once. It works on trust in the organiser who holds the money, and
organisers do run away ("vỡ hụi").

Here the pot is held by a **CashScript covenant on Bitcoin Cash**. Money can only go to that round's
recipient, or back to the members who paid. No organiser and no server key. Every member's
**collateral** makes it costly to take the pot early and then stop paying.

> Status: **prototype (2 Nov 2026), pre-hackathon baseline for BCH BLAZE 2026**. Covenant + SDK +
> 31 offline tests + chipnet CLI + offline demo + a browser simulation of the covenant (`demo/`).
> BCH (satoshis) only; PUSD is designed for, not built yet. No wallet UI, no WizardConnect yet.
> Ran on chipnet on 10 Nov 2026 (one full 4-round circle and one broken circle, see "Run on chipnet").
> Nothing has run on mainnet yet.

## Rules (v0)

- 4 members, payout order fixed at creation (member 1 receives in round 1, …, member 4 in round 4).
- Fixed contribution `C` per member per round. Round 1 costs `2C`: the contribution plus the
  **collateral** (one contribution).
- When all 4 have paid a round, **anyone** can trigger the payout: `4C` (minus the miner fee) goes to
  that round's recipient. The final payout also returns every member's collateral.
- Each round has a deadline (a block height). If the round is still not fully funded after it, **anyone**
  can cancel the circle and push refunds. Each member gets back what they paid in that round, plus
  their collateral, **except a member who already received a pot and did not pay this round**. That
  defaulter's collateral is split equally among the members who have not received a pot yet.
- No spend needs a signature. Members' wallets only ever sign ordinary payments (their own inputs).

## Design

### One UTXO per circle, state kept in the covenant itself

```
create ──► [r1 · paid {} ] ──contribute(1)──► [r1 · paid {1}] ── … ──► [r1 · paid {1,2,3,4}]
                                                                              │ payout() → member 1
           [r2 · paid {} ] ◄──────────────────────────────────────────────────┘
               │ … round 4 … payout() → member 4 + collateral back to everyone → closed
               │
               └─ deadline passed, round not full: refund(m) → [r2 · paid {..} · refunded {m}] → … → closed
```

The whole circle is **one UTXO**: everyone's collateral plus this round's contributions. Its state
`[round, paidMask, refundedMask]` is the **last constructor parameter**, so CashScript pushes it as the
first 4 bytes of the redeem script (`03 rr pp ff`). Every function rebuilds `this.activeBytecode` with
the next state, hashes it, and requires the continuation output to pay exactly that P2SH32 address with
exactly the right value. So a state change cannot be skipped, invented or merged, and the circle
cannot "leave" the covenant.

| Option | For | Against | Verdict |
|---|---|---|---|
| **State in the redeem script** (chosen) | One UTXO holds the money **and** the state, so it works unchanged when the money is a fungible token (PUSD). No token genesis (XO cannot do genesis yet). Fully stateless app. | Every state has its own address, so status is found by following the chain of spends (`src/chain.ts`, 2 Electrum calls per step). Redeem script is big (817 B). | **v0** |
| State in an NFT commitment | Fixed address, wallets show the NFT, classic CashScript pattern | A UTXO carries **one** token category: the PUSD pot cannot sit next to the state NFT, so PUSD needs a second "sidecar" UTXO in every transaction. Needs a genesis tx, and members must check the genesis minted only one NFT | Good for v2 "seat NFTs", not for state |
| Per-round / per-member pots (`Pot(k, i)`) | Simplest covenants, contributions never conflict | A covenant can prove that a payment exists, never that one is **missing**, so "member X defaulted, take their collateral" is not expressible | Rejected: cannot do the collateral rule |

### Covenant functions (`contracts/hui.cash`)

| Function | Who | Checks |
|---|---|---|
| `contribute(member)` | anyone (credited to `member`) | circle is input 0; not cancelled; `member` has not paid this round; output 0 = next state with exactly `+C` (round 1: `+2C`), no tokens |
| `payout()` | anyone, no key | circle spent alone; all 4 paid; output 0 = this round's recipient, ≥ `4C − maxFee`; output 1 = next round with exactly `−4C` (exactly 2 outputs). Last round: 4 outputs, members 1–3 get exactly `C` back, member 4 the rest |
| `refund(member)` | anyone, after the deadline | circle spent alone; round not fully funded; `tx.time ≥ deadline(round)` (CLTV); the **first** refund also needs the circle idle for `grace` blocks (`this.age`, BIP68); `member` is owed something and not yet refunded; output 0 = that member; output 1 = next state with exactly `−owed`. The last refund closes the circle and takes the rest |

The `grace` check closes one real hole. If a round is paid out so late that the next round's deadline
has already passed, members who have not received yet could cancel immediately and take the past
recipients' collateral before those could pay. With `grace`, every state change gives payers at least
`grace` blocks.

### Money flow example (C = 10,000 sat)

| | round 1 | round 2 | round 3 | round 4 | end |
|---|---|---|---|---|---|
| each member pays | 20,000 (incl. 10,000 collateral) | 10,000 | 10,000 | 10,000 | |
| pot (minus ~950 sat fee) | member 1 | member 2 | member 3 | member 4 | collateral 10,000 back to each |

If member 1 takes round 1's pot and does not pay round 2: after the deadline, members 2, 3 and 4 each
get `10,000 + 10,000 + 3,333` back. Member 1 gets nothing more and has lost the collateral.

### Known limits (v0)

- **Collateral = 1 contribution covers one missed round, not the whole risk.** Member 1 who takes the
  first pot and leaves still nets `+2C` (`+3C` without collateral). To make defaulting never pay,
  collateral would have to be graduated: `(4 − position) × C` (3C, 2C, C, 0). Open design choice.
- A cancelled circle ends. The rounds already paid out are not unwound (that is how a broken hụi works
  too). Alternative for v2: use the defaulter's collateral to fill the gap and keep the circle going.
- Whoever triggers a payout or refund picks the fee, up to `maxFee` (2,000 sat by default).
  Front-running can therefore burn up to `maxFee` of the recipient's money per step.
- The deadline means "after this, anyone **may** cancel". A late payment still completes the round as
  long as nobody cancelled first (tested).
- Coins sent to a circle address by mistake (not through `contribute`) are stuck. They never mix with
  the real circle (it must be input 0 and spent alone).
- If nobody joins round 1, member 1 can sweep the creation deposit after the deadline. That only
  pays with a deposit of a few thousand sat: at the default 1,000 sat, the refund's fee (~900 byte
  transaction) leaves less than the dust limit, so the SDK cannot build it.
- Round-length timing uses block heights. Relative age (`grace`) is enforced by nodes (BIP68).
  MockNetworkProvider only checks the declared age.

### PUSD (designed for, not built)

The state model does not change; only the amount checks do:

- add `bytes32 tokenCategory` (PUSD `2469acc5…2544`). Watch the byte order: introspection returns
  the category in **internal** order, so pass the txid-order hex reversed;
- `contribute`: `outputs[0].tokenCategory == tokenCategory` and
  `tokenAmount == inputs[0].tokenAmount + C`, and the BCH value may not decrease;
- payout and refund move `tokenAmount` exactly (no fee in tokens). The BCH fee and the ~800 sat
  dust carried by every token output come from a BCH reserve in the circle (bigger creation deposit,
  or a few hundred sat added per contribution). Each output's BCH must be capped, or a griefer could
  drain the reserve into one output and leave the circle unable to pay for later outputs;
- the token-aware member addresses (`z…`) have the same locking bytecode, so nothing else changes.

## Commands

Requires Node ≥ 22.

```bash
npm install
npm test            # 31 offline tests (MockNetworkProvider, BCH_2026_05 VM), ~5 s
npm run demo        # three stories: full circle, a defaulter, attacks the covenant refuses
npm run demo:build  # browser simulation -> dist/demo/index.html, then a headless check of that page
npm run typecheck
npm run compile     # after editing contracts/hui.cash (a test checks the artifact is fresh)
```

Print the circle addresses for any 4 public keys (offline, chipnet prefix):

```bash
npm run address -- \
  --member 033400fd9c75a7212369587f02d6fc89b313e977662f2df55ca91a1cc4bf961d83 \
  --member 0230a656feb0c4934442a473c2b68ca6709d51f06717dfcc411d21690e9b698d1a \
  --member 02386c0aaf643b76a6df0ff25ec146f49a5474487ed91b488c686301f4d037f2a6 \
  --member 02f770d8c20755071db0d174727751804247cec315a277e5da92e4ad4038288a24 \
  --first-deadline 330600 --contribution 10000 --round-length 6
```

(These are the deterministic TEST keys `testKey('member-0..3')` used by the test suite.)

## Browser demo (v0 simulation)

`npm run demo:build` writes **one self-contained file**, `dist/demo/index.html` (script and styles
inlined, ~640 KB). Open it straight from disk or host it on any static host (GitHub Pages). It runs
a 4-member circle against CashScript's `MockNetworkProvider` inside the page, through the same SDK
(`demo/src/sim.ts` drives `src/hui.ts`), so every button broadcasts a real transaction that the BCH VM
checks against the real covenant. No wallet, no network.

- Scenarios: **Full circle** (21 transactions), **Lan takes the pot, then stops paying** (her
  collateral goes to the members who have not received yet), **Try to cheat**.
- Step by step: create, pay (per member or everyone), pay out, advance past the deadline, refund.
- Cheating attempts, each refused with the covenant's own `require` message: early payout, underpay,
  pot to a stranger, skipping a round, cancelling before the deadline, refunding a defaulter.
- A log of every transaction: mock txid, size, fee, or the refusal reason.

`test/demo.test.ts` drives the same engine headlessly; `npm run demo:check` re-runs the built page in
happy-dom (no browser, no server).

## Run on chipnet

The CLI is **chipnet only**: `--network mainnet` and `bitcoincash:` addresses are refused. Keys are
throwaway test keys written to `.hui/chipnet.json` (gitignored).

```bash
npm run hui -- keygen          # 4 member keys; deadlines = current chipnet height + 12, then every 6 blocks
# Get chipnet coins for EACH member address at https://tbch.googol.cash (choose chipnet):
# about 60,000 sat each (2C + 3C + fees), member 1 another 1,000 for the creation deposit.
# Or fund only member 1 and let it pay the others (one transaction, no key printed):
npx tsx scripts/fund-members.ts --amount 60000
npm run hui -- status          # follows the circle on chain; shows wallets, deadlines, who paid
npm run hui -- reschedule      # if the first deadline is too close (only before the circle exists)
npm run hui -- create          # member 1 pays the 1,000 sat creation deposit to the start address

npm run hui -- contribute --member 1      # repeat for 2, 3, 4  (--payer N pays for someone else)
npm run hui -- payout                     # pot -> member 1, round 2 opens
# ... rounds 2-4 the same; the last payout returns everyone's collateral

# Default path: in some round let member 1 NOT pay, wait for the deadline (status shows it), then
npm run hui -- refund --member 2          # 3 and 4 the same; member 1 gets nothing back
```

Explorer links are printed for each transaction (`https://cbch.loping.net/tx/<txid>`).

A second circle with the same keys only needs another config with different deadlines, e.g. a copy
of `.hui/chipnet.json` passed as `--config .hui/chipnet-broken.json` after `reschedule --config ...`.

The 10 Nov 2026 chipnet run, end to end:
- full circle: [create](https://cbch.loping.net/tx/3dd26a04a2c05ef854eb46dcdf38357c96ca8b866020b3514d9b4a185b6eb35f),
  16 contributions and 4 payouts, ending with the
  [final payout](https://cbch.loping.net/tx/d86395dad14494c9aebf005b8cb888f33cfabadd6ff732cc8c77581d4cf8e76f)
  (member 4 gets 49,990 sat, members 1-3 get their 10,000 sat collateral back);
- broken circle: member 1 takes the round-1 pot, skips round 2; after the deadline members 2, 3, 4 are refunded
  [22,380](https://cbch.loping.net/tx/3b401b092136687cd66e7ac04045db373d03f62e89829e53b887869b29c9e30d),
  [22,380](https://cbch.loping.net/tx/474d1522c7d2665fba37e73a06ac728567dd3fc4127537b9eca4daa9c3844918) and
  [23,425](https://cbch.loping.net/tx/be5f945edbd5bdd9d13a1447c1c5b1edc8783b9ef56f78e8853d2efee0dc8e59) sat
  (member 1's collateral split between them); an early refund is rejected by the node as `non-final`.

## Files

| Path | What |
|---|---|
| `contracts/hui.cash` | The covenant |
| `src/hui.ts` | SDK: parameters, state model, covenant mirror (`owedTo`, `entitledMask`), transaction builders |
| `src/chain.ts` | Follow a circle on chain (Electrum or in-memory) |
| `src/cli/hui.ts` | Chipnet CLI |
| `src/demo.ts` | Offline demo |
| `demo/` | Browser simulation: `src/sim.ts` (engine), `src/main.ts` (page), `vite.config.ts` (single-file build), `check-built.mjs` |
| `test/hui.test.ts` | Covenant tests |
| `test/demo.test.ts` | Browser demo engine tests |

## License

MIT, see `LICENSE`.
