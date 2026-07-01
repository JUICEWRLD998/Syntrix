# Syntrix — Implementation Plan

**The serverless fan mesh.** A peer-to-peer fan network for live football, built on the
Pears (Holepunch) stack. Fans form a direct mesh, play a live prediction game reconciled
peer-to-peer via Autobase, chat, and settle a self-custodial USD₮ pot via WDK — with **no
server, no backend, no central database, and no login.** It keeps working after the
internet uplink is cut on camera.

> Hackathon: Tether Developers Cup — **Pears (P2P) track**. Prize target: 🥇 1,000 USD₮.

---

## 0. Ground truth (verified against current docs, 2026-07-01)

These are confirmed, not assumed. The plan is built only on what the APIs actually support.

- **Autobase** — API is marked **stable**. Model: `new Autobase(store, bootstrap, { open, apply })`,
  then `await base.ready()`. Write with `await base.append(op)`. Add writers from inside
  `apply` via `await host.addWriter(key, { indexer: true })`. Read the materialized state
  from `base.view`. Replicate with `base.replicate(stream)` over a Corestore.
  Reference implementation: [`holepunchto/autobee`](https://github.com/holepunchto/autobee).
  **Hard rule:** `apply` is a *pure reducer* — mutate only the passed `view`, no side
  effects, no network, fully deterministic, or peers diverge.
- **Pear desktop** — runs on Electron (renderer + Bare worker + preload bridge). Scaffold
  with `hello-pear-electron` / `pear-electron`. **The renderer is Chromium**, so React +
  React Three Fiber + GSAP run natively as the frontend. Backend/P2P logic runs in the Bare
  worker; UI talks to it over the preload bridge.
- **WDK** — packages `@tetherto/wdk` + `@tetherto/wdk-wallet-evm`. Self-custodial and
  stateless (keys never leave the app). `WDK.getRandomSeedPhrase(24)` → `new WDK(seed)` →
  `registerWallet('ethereum', WalletManagerEvm, { provider })` → `getAccount('ethereum', 0)`.
  Balance via `getBalance()`, token transfer via `transfer(...)`, native send via
  `sendTransaction(...)`. **Sepolia testnet is listed as supported.** Runs on Node.js and Bare.

---

## 1. Locked decisions

| Area | Decision | Why |
|---|---|---|
| **Auth** | **None.** Identity = Hypercore public key + WDK wallet key. Optional cosmetic display name. | No server to log into; reinforces the thesis. Zero auth code. |
| **Database** | **None central.** Hypercore (per-peer logs) + Autobase (shared ledger) + optional Hyperbee (index). | The distributed store *is* the product. |
| **Match events** | **Manual referee button.** One peer drives round open / "Goal!" / resolve. | Full stage control, no external dependency, keeps the "cut the internet" story clean. |
| **Money** | **Real WDK on Sepolia testnet.** Self-custodial USD₮-style test token; settles when a peer reconnects. | Strongest credibility. Highest integration risk — de-risked in Phase 0 with a hard fallback. |
| **UI** | **React + R3F + GSAP** in the Pear renderer; Magic UI for components. | Renderer is Chromium; unlocks the 3D live-mesh hero visual. |

---

## 2. Scope — what we build vs. what we cut

### In scope (real, functional)
1. Hyperswarm mesh: peers auto-discover and connect per match topic, no backend.
2. Autobase shared ledger: every peer is a writer; one deterministic linearized game state.
3. Live prediction game with **commit-reveal** anti-cheat, resolved from the Autobase view.
4. Chat + **synced reactions + shared match clock** over the mesh.
5. Self-custodial **USD₮ pot on Sepolia** via WDK; real transfer to the winner.
6. R3F **live-mesh visualizer** as the demo hero + celebratory GSAP win moment.
7. Third peer joins mid-game and back-fills history (near-free with replication).

### Cut / out of scope (stated for maturity)
- ❌ **True synchronized video streaming / lockstep watch-party.** Hard research problem,
  demos poorly, high risk. **Replaced** by synced reactions + shared match clock (same impact).
- ❌ **Custom E2E chat crypto.** Unnecessary — Hyperswarm connections are already
  Noise-encrypted. We inherit transport encryption and say so honestly.
- ❌ **True radio/BLE offline mesh** (needs local DHT/BLE bootstrap) — **roadmap.**
- ❌ Production anti-collusion / Sybil economics — acknowledged, roadmap.
- ❌ Mobile packaging (Bare/React Native) — roadmap.
- ❌ Official match-data feeds — the referee button stands in.

---

## 3. Architecture

```
┌─────────────────────────── One Peer (a fan's device) ───────────────────────────┐
│  Renderer (Chromium)                         Bare worker (P2P + money)           │
│  ┌───────────────────────────┐   preload    ┌──────────────────────────────┐    │
│  │ React UI                  │  bridge/IPC   │ Hyperswarm  (peer discovery) │    │
│  │  • R3F mesh visualizer    │ ◄──────────►  │ Corestore + Hypercore (logs) │    │
│  │  • Prediction / chat UI   │               │ Autobase (shared ledger/view)│    │
│  │  • GSAP win choreography  │               │ WDK wallet (Sepolia USD₮)    │    │
│  └───────────────────────────┘               └──────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────────┘
        ▲ direct P2P connections (Noise-encrypted) to other peers' Bare workers ▼
```

- **One match/venue = one Hyperswarm topic.** Peers join, discover, connect directly.
- **Each peer owns an append-only Hypercore** of its actions (predictions, chat, stakes).
- **Autobase merges all peer cores** into one deterministic view = canonical game state.
- **`apply` is a pure reducer** over ops: it advances the round state machine, validates
  commit-reveal, tallies winners — identically on every device.

### Op schema (single append-only event type, discriminated by `type`)
```js
{ type: 'round_open',  roundId, prompt, closesAtSeq }      // referee only
{ type: 'commit',      roundId, commitHash }                // hash(pick + nonce)
{ type: 'reveal',      roundId, pick, nonce }               // must match prior commit
{ type: 'round_close', roundId, outcome }                   // referee only → resolve
{ type: 'stake',       roundId, walletAddress, amount }     // pot entry
{ type: 'chat',        text, ts }                           // ephemeral in view
{ type: 'reaction',    emoji, ts }
```
Anti-cheat is enforced *in `apply`*, deterministically: a `reveal` whose hash ≠ its
`commit` is ignored; a second `commit`/`reveal` for the same round+peer is ignored; a
`commit` after `closesAtSeq` is ignored. No referee server needed — the rules are the code
every peer runs.

---

## 4. Build phases

Each phase has a **goal**, **tasks**, and a **Definition of Done (DoD)**. Phase 0 exists to
kill the two biggest risks before we build UI on top of them. Phases 1→5 are the real
product; 6→7 are polish and demo hardening.

### Phase 0 — Foundations & risk-kill spikes  *(do first, two spikes in parallel)*
**Goal:** prove the two hardest, most independent pieces work before committing further.

- Scaffold the Pear desktop app from `hello-pear-electron`; run with `pear run --dev`.
- Confirm **React + R3F** renders inside the Pear renderer (spin a trivial spinning cube).
- Wire the **preload bridge**: renderer ⇄ Bare worker message passing.
- **Spike A — Autobase determinism:** two writers, one linearized view; append ops from
  both; assert both peers derive the *identical* view. Follow the `autobee` pattern.
- **Spike B — WDK on Sepolia:** create two wallets, point provider at a Sepolia RPC, fund
  with test ETH, do **one real test-token transfer** wallet→wallet, read balances back.

**DoD:** Cube renders in Pear. Two Autobase writers converge to identical state. One real
Sepolia token transfer confirmed on-chain. **If Spike B fails**, fall back to
*"real WDK wallets + keys shown on screen, transfer recorded in Autobase, on-chain settle
deferred"* — decided here, before any UI depends on it.

### Phase 1 — Mesh & rooms (Hyperswarm)
**Goal:** peers find each other and connect with no backend.
- Join a Hyperswarm topic derived from a match id.
- Manage connections; maintain a live peer/presence list.
- Replicate the Corestore over each connection.

**DoD:** 2+ peers on different processes/machines auto-connect and show each other's presence.

### Phase 2 — Autobase shared ledger (core)
**Goal:** the canonical, deterministic game state, multi-writer, no referee server.
- Corestore + local Hypercore per peer; `Autobase({ open, apply })`.
- `open` returns a Hyperbee (or JSON view); `apply` is the pure reducer over the op schema.
- Writer onboarding: first peer is genesis; new peers added via `host.addWriter` in `apply`.
- Round-state machine (`idle → open → closed → resolved`) derived purely from the view.

**DoD:** two peers show identical state and identical resolved winner with no coordinator; a
**third peer joins and back-fills** the full prior history.

### Phase 3 — Prediction game + commit-reveal
**Goal:** the hero loop, cheat-resistant, resolved from the view.
- Referee button emits `round_open` / `round_close(outcome)`.
- Players `commit` (hash of pick+nonce), then `reveal` after close.
- `apply` validates: hash match, no double-commit, within window; resolves winners.

**DoD:** a normal round resolves a correct winner on all peers; a **late/duplicate/invalid
reveal is visibly rejected** by the reducer (the anti-cheat proof).

### Phase 4 — Chat + synced reactions
**Goal:** the social layer, serverless, survives the uplink cut.
- Chat + reaction ops flow through the same mesh (transport encrypted by Hyperswarm).
- Shared match clock / round-state so reactions land in lockstep. (No video.)
- Ephemeral: rendered from the live view, not persisted as durable history beyond the round.

**DoD:** messages and reactions appear on all peers and **keep working after the uplink is cut.**

### Phase 5 — WDK Pot
**Goal:** real self-custodial money, end to end.
- Each player creates/holds a WDK wallet (self-custody; keys never leave the device).
- `stake` ops recorded in Autobase form the pot; entry is trust-minimized bookkeeping.
- On resolve, the winning address from the view receives a real Sepolia USD₮-style transfer
  via `transfer()`; show settlement when a peer has connectivity.

**DoD:** the pot moves to the winner as a **real testnet transaction**, keys held by the
user. (Or the Phase-0 fallback if Spike B was cut.)

### Phase 6 — UI: R3F mesh visualizer + polish
**Goal:** the visual that wins the room.
- **Live mesh graph:** nodes = fans, edges = live peer connections, driven by *real*
  connection state from the Bare worker. A "cloud/uplink" node is visibly present while
  online.
- **On uplink cut:** the cloud node dies; fan-to-fan edges stay lit and pulsing. This is the
  hero frame.
- GSAP goal/win choreography; commit→reveal card flips; pot-release animation.
- Magic UI components + football theme; the explicit **"cut the internet"** affordance.

**DoD:** the visualizer reacts to real connection changes; the win moment is celebratory and
reads as "product," not "hack."

### Phase 7 — Demo hardening & pitch assets
**Goal:** a flawless 90 seconds.
- Rehearsed flow: **peers connect while online first, *then* cut the uplink** (Hyperswarm
  DHT discovery needs the internet; established LAN connections persist after the cut — this
  ordering is mandatory and baked into the script).
- Pre-fund demo wallets with Sepolia ETH (gas) + test tokens.
- Record a **flawless backup demo video**. Build the 3-min deck + one-line thesis.
- Prep the honest-risk answers (discovery vs. "no server", fairness, collusion) for Q&A.

**DoD:** the full demo runs twice, back to back, without a hitch; backup video exists.

---

## 5. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **WDK token transfer on testnet fights Bare / needs unlisted config** | High | Killed first in Phase 0 Spike B. Hard fallback: real wallets shown, transfer recorded in Autobase, on-chain deferred. |
| **Autobase determinism bugs → peers diverge** | High | `apply` is a strict pure reducer; build & assert convergence in Phase 0/2 before UI. Follow `autobee`. |
| **"No server" vs. Hyperswarm DHT needing internet for discovery** | Medium | Honest framing: no *app* backend. Demo connects while online, then cuts uplink; LAN connections persist. Full radio-offline is roadmap. |
| **Gas/funding on Sepolia** | Low | Pre-fund all demo wallets in Phase 7 setup; document the faucet step. |
| **WDK runs in Bare vs. renderer ambiguity** | Low | Run WDK in whichever of {Bare worker, renderer} the Phase 0 spike proves cleanest; decide there. |
| **Time overrun** | Medium | Phases 1→5 are the graded product; 6 polish and 7 hardening are compressible. Cut stretch (mid-game join) before core. |

---

## 6. Stack summary

- **Runtime:** Pear CLI + `pear-electron` (desktop). Backend logic in a **Bare** worker.
- **Networking:** Hyperswarm (discovery + direct Noise-encrypted connections).
- **State:** Corestore + Hypercore (per-peer logs), **Autobase** (shared ledger/view),
  optional Hyperbee (index).
- **Money:** `@tetherto/wdk` + `@tetherto/wdk-wallet-evm` (self-custodial USD₮ on Sepolia).
- **UI:** React + React Three Fiber + GSAP + Magic UI, in the Pear renderer.

## 7. What makes it real (verification checklist)
- [ ] **No-server proof:** no backend process/URL; cut the uplink on camera, game/chat/mesh keep running.
- [ ] **P2P consensus proof:** two devices derive the same Autobase winner with no coordinator; a third back-fills identical history.
- [ ] **Anti-cheat proof:** a late/duplicate/invalid prediction is rejected by the reducer.
- [ ] **Money proof:** real Sepolia USD₮ transfer to the winner; user holds the keys.
