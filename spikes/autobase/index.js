// Syntrix — Phase 0, Spike A: Autobase multi-writer determinism.
//
// Goal: prove that two independent Autobase writers, replicating peer-to-peer,
// converge on an IDENTICAL linearized view — the "shared truth with no referee"
// that the whole Syntrix prediction game depends on.
//
// We run two Autobase instances in one process and pipe their Corestore
// replication streams together (stands in for a Hyperswarm connection — same
// replication protocol, just no network). Peer B is added as a writer by peer A,
// both append prediction ops, and we assert their views are byte-identical.
//
//   node index.js   (from spikes/autobase, after `npm install`)

import Corestore from 'corestore'
import Autobase from 'autobase'
import b4a from 'b4a'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Fresh temp dir per run (hypercore 11's storage layer is on-disk, not RAM).
const TMP = path.join(os.tmpdir(), 'syntrix-spike-a-' + process.pid)
fs.rmSync(TMP, { recursive: true, force: true })

// ---- shared reducer -------------------------------------------------------
// apply() MUST be a pure, deterministic reducer: mutate only `view`, no I/O,
// no globals. Any divergence here => peers disagree => the game breaks.
function open (store) {
  return store.get({ name: 'syntrix-view', valueEncoding: 'json' })
}

async function apply (nodes, view, host) {
  for (const node of nodes) {
    const op = node.value
    if (op && op.type === 'addWriter') {
      // An existing writer authorized a new one. Onboard them.
      await host.addWriter(b4a.from(op.key, 'hex'), { indexer: true })
      continue
    }
    // Everything else is game data -> append to the shared linearized log.
    await view.append(op)
  }
}

function makeBase (storage, bootstrap) {
  const store = new Corestore(storage)
  const base = new Autobase(store, bootstrap, {
    open,
    apply,
    valueEncoding: 'json'
  })
  return { store, base }
}

// ---- helpers --------------------------------------------------------------
function replicate (storeA, storeB) {
  const s1 = storeA.replicate(true)
  const s2 = storeB.replicate(false)
  s1.pipe(s2).pipe(s1)
  s1.on('error', () => {})
  s2.on('error', () => {})
  return () => { s1.destroy(); s2.destroy() }
}

async function waitFor (label, predicate, timeoutMs = 15000) {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${label}`)
    await new Promise(r => setTimeout(r, 100))
  }
}

async function readView (base) {
  await base.update()
  const view = base.view
  const out = []
  for (let i = 0; i < view.length; i++) out.push(await view.get(i))
  return out
}

// ---- the spike ------------------------------------------------------------
async function main () {
  console.log('[spike-A] booting two Autobase peers...')

  // Peer A is genesis (bootstrap = null). It is the first writer + indexer.
  const A = makeBase(path.join(TMP, 'A'), null)
  await A.base.ready()
  console.log('[spike-A] peer A base key:', b4a.toString(A.base.key, 'hex').slice(0, 16), '...')

  // Peer B bootstraps from A's key — same Autobase, different device.
  const B = makeBase(path.join(TMP, 'B'), A.base.key)
  await B.base.ready()

  const stop = replicate(A.store, B.store)

  // B announces its local writer key; A authorizes it (this is the multi-writer
  // onboarding — in the real app A does this after B joins the Hyperswarm room).
  const bWriterKey = b4a.toString(B.base.local.key, 'hex')
  console.log('[spike-A] peer A authorizing peer B as writer...')
  await A.base.append({ type: 'addWriter', key: bWriterKey })

  // Wait for B to actually become writable.
  await waitFor('peer B writable', async () => {
    await B.base.update()
    return B.base.writable
  })
  console.log('[spike-A] peer B is now a writer ✓')

  // Both peers submit predictions concurrently, out of order — the hard case.
  console.log('[spike-A] both peers appending prediction ops...')
  await Promise.all([
    A.base.append({ type: 'predict', peer: 'A', roundId: 1, pick: 'Messi', ts: 100 }),
    B.base.append({ type: 'predict', peer: 'B', roundId: 1, pick: 'Mbappe', ts: 101 }),
    A.base.append({ type: 'predict', peer: 'A', roundId: 1, pick: 'Messi', ts: 102 }),
    B.base.append({ type: 'chat', peer: 'B', text: 'GOOOAL', ts: 103 })
  ])

  // Let linearization settle across the replication link.
  await waitFor('views converge', async () => {
    const va = await readView(A.base)
    const vb = await readView(B.base)
    return va.length === vb.length && va.length === 4
  })

  const viewA = await readView(A.base)
  const viewB = await readView(B.base)
  stop()

  // ---- assertions ---------------------------------------------------------
  const jsonA = JSON.stringify(viewA)
  const jsonB = JSON.stringify(viewB)
  const identical = jsonA === jsonB

  console.log('\n[spike-A] peer A view (' + viewA.length + ' entries):')
  for (const e of viewA) console.log('   ', JSON.stringify(e))

  console.log('\n[spike-A] RESULT: views identical across peers =', identical)

  if (!identical) {
    console.error('[spike-A] ✗ FAIL — peers diverged. apply() is not deterministic.')
    process.exit(1)
  }
  console.log('[spike-A] ✓ PASS — serverless multi-writer consensus is real.')
  process.exit(0)
}

main().catch((err) => {
  console.error('[spike-A] ✗ ERROR:', err)
  process.exit(1)
})
