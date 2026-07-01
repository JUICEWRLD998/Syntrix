// Syntrix — Phase 0, Spike B: WDK self-custodial USD-token transfer on Sepolia.
//
// Goal: prove the money layer end to end with the REAL WDK SDK, no mocks —
//   1. derive self-custodial accounts from a seed (keys never leave this process),
//   2. connect to the Sepolia testnet over a public RPC,
//   3. read live native + ERC-20 balances (proves RPC + contract reads),
//   4. quote and then EXECUTE a real on-chain token transfer to the winner.
//
// Steps 1-3 run with zero funds. Step 4 needs the sender account funded with a
// little Sepolia ETH (gas) + some test token. The spike derives a STABLE address
// (seed persisted to .seed), prints it, and you fund it once from a faucet; the
// next run performs the real transfer and prints the Etherscan link.
//
//   node index.js                 # derive, connect, read balances, quote
//   (fund the printed sender address, then)
//   node index.js                 # auto-detects funds -> real transfer
//
// Env overrides:
//   SYNTRIX_RPC    Sepolia RPC url        (default https://sepolia.drpc.org)
//   SYNTRIX_TOKEN  ERC-20 contract        (default Sepolia USDC test token)
//   SYNTRIX_SEED   BIP-39 mnemonic        (default: generated + saved to .seed)
//   SYNTRIX_AMOUNT transfer base units    (default 1000000)

import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import * as bip39 from 'bip39'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SEED_FILE = path.join(HERE, '.seed')

const RPC = process.env.SYNTRIX_RPC || 'https://sepolia.drpc.org'
// Sepolia test stablecoin (Circle USDC faucet token). Any ERC-20 works; swap for
// a test USD₮ contract when one is provisioned for the demo.
const TOKEN = process.env.SYNTRIX_TOKEN || '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
const AMOUNT = BigInt(process.env.SYNTRIX_AMOUNT || '1000000') // 1 unit @ 6 decimals

function loadOrCreateSeed () {
  if (process.env.SYNTRIX_SEED) return process.env.SYNTRIX_SEED.trim()
  if (fs.existsSync(SEED_FILE)) return fs.readFileSync(SEED_FILE, 'utf8').trim()
  const seed = bip39.generateMnemonic()
  fs.writeFileSync(SEED_FILE, seed + '\n')
  console.log('[spike-B] generated a new dev seed -> .seed (gitignored)')
  return seed
}

async function main () {
  const seed = loadOrCreateSeed()
  if (!bip39.validateMnemonic(seed)) throw new Error('invalid BIP-39 seed phrase')

  console.log('[spike-B] connecting to Sepolia:', RPC)
  const wallet = new WalletManagerEvm(seed, {
    provider: RPC,
    transferMaxFee: 100000000000000 // cap gas cost, per WDK example
  })

  try {
    // Self-custodial accounts derived locally (BIP-44 m/44'/60'). index 0 = the
    // "fan / pot payer", index 1 = the "winner". Both from one seed for the spike.
    const sender = await wallet.getAccount(0)
    const winner = await wallet.getAccount(1)
    const senderAddr = await sender.getAddress()
    const winnerAddr = await winner.getAddress()

    console.log('[spike-B] sender (pot):', senderAddr)
    console.log('[spike-B] winner       :', winnerAddr)

    // --- live reads (no funds required) --------------------------------------
    const nativeWei = await sender.getBalance()
    let tokenBal = 0n
    try {
      tokenBal = BigInt(await sender.getTokenBalance(TOKEN))
    } catch (e) {
      console.log('[spike-B] token balance read failed (token/RPC):', e.message)
    }
    console.log('[spike-B] sender native balance (wei):', nativeWei.toString())
    console.log('[spike-B] sender token  balance (base):', tokenBal.toString())
    console.log('[spike-B] ✓ RPC connection + self-custodial derivation + reads work')

    // --- transfer path -------------------------------------------------------
    const hasGas = BigInt(nativeWei) > 0n
    const hasToken = tokenBal >= AMOUNT

    if (!hasGas || !hasToken) {
      console.log('\n[spike-B] ▶ integration proven up to the funded step.')
      console.log('[spike-B]   To execute the REAL transfer, fund the sender:')
      console.log('[spike-B]   1) Sepolia ETH (gas): https://sepoliafaucet.com  -> ' + senderAddr)
      console.log('[spike-B]   2) test token       : faucet for ' + TOKEN + ' -> ' + senderAddr)
      console.log('[spike-B]   then re-run: node index.js')
      console.log('[spike-B] ✓ PASS (read-only) — money layer wired, awaiting testnet funds.')
      return
    }

    const params = { token: TOKEN, recipient: winnerAddr, amount: AMOUNT }
    const quote = await sender.quoteTransfer(params)
    console.log('[spike-B] quoted transfer fee:', quote.fee?.toString?.() ?? quote.fee)

    console.log('[spike-B] executing REAL on-chain transfer of', AMOUNT.toString(), 'base units...')
    const result = await sender.transfer(params)
    console.log('[spike-B] ✓ tx hash:', result.hash)
    console.log('[spike-B]   explorer: https://sepolia.etherscan.io/tx/' + result.hash)
    console.log('[spike-B] ✓ PASS — real self-custodial USD-token transfer on Sepolia.')
  } finally {
    wallet.dispose() // clear private keys from memory
  }
}

main().catch((err) => {
  console.error('[spike-B] ✗ ERROR:', err)
  process.exit(1)
})
