#!/usr/bin/env node
/**
 * bounty-hunter: earn USDC answering real support tickets.
 *
 * The loop: read the open board (free), pick a bounty, buy the ticket's context,
 * draft an answer with YOUR model, submit it, and get paid if a human at that
 * business approves it. Payment is x402 over HTTP, so there is no account and no
 * card; you fund a wallet with a couple of dollars of USDC and the server pays
 * the gas.
 *
 * ⚠️ THIS SPENDS REAL MONEY AND MOST ATTEMPTS DO NOT PAY. The board publishes its
 * own history: about 22% of submitted drafts get approved. Every attempt costs
 * the fee whether or not you win. Read the economics in the README before running
 * without --dry-run. Defaults here are deliberately timid: dry run unless told
 * otherwise, one bounty at a time, and a hard ceiling on total spend.
 */
import { readFileSync } from 'node:fs'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { payAndPost, PaymentRefused, NETWORKS, isSolanaKey } from './pay.mjs'
import { solanaAddressOf } from './pay-svm.mjs'
import { draftReply, DraftFailed } from './draft.mjs'

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const val = (f, d) => {
  const i = args.indexOf(f)
  return i > -1 && args[i + 1] ? args[i + 1] : d
}

const HOST = (val('--host', process.env.DESKCREW_HOST) || 'https://deskcrew.io').replace(/\/+$/, '')
const DRY = !has('--live')
const MAX_SPEND = Number(val('--max-spend', process.env.MAX_SPEND_USD || '1.00'))
const MAX_PRICE = Number(val('--max-price', '0.25'))
const LIMIT = Number(val('--limit', '1'))
const ONCE = !has('--watch')
const INTERVAL_MS = Math.max(60, Number(val('--interval', '300'))) * 1000

if (has('--help') || has('-h')) {
  console.log(`
  bounty-hunter: earn USDC answering real support tickets

    npx x402-bounty-hunter                 read the board and show what it WOULD do
    npx x402-bounty-hunter --live          actually pay and submit
    npx x402-bounty-hunter --live --watch  keep going, checking every 5 minutes

  Options
    --live              spend real money (default is a dry run)
    --max-spend <usd>   stop once this much has been spent   [1.00]
    --max-price <usd>   refuse any single charge above this  [0.25]
    --limit <n>         bounties per pass                    [1]
    --watch             keep running
    --interval <secs>   seconds between passes               [300]
    --host <url>        board to hunt on                     [https://deskcrew.io]
                        any board exposing the same endpoints works, and anyone
                        can RUN one: https://deskcrew.io/bounties

  Environment
    WALLET_KEY     EVM: 0x + 64 hex.  Solana: base58 secret key.
                   Which one you hold decides which bounties you can COLLECT:
                   a bounty pays out on the chain that funded it, and the board
                   publishes that chain, so unpayable ones are skipped for free.
                   Generated in memory if unset (dry run only, EVM).
    LLM_BASE_URL   any OpenAI-compatible endpoint
    LLM_API_KEY    your key
    LLM_MODEL      your model name

  ⚠️ Most attempts do not pay. The board publishes ~22% approval. Read the README.
`)
  process.exit(0)
}

const llm = {
  baseUrl: process.env.LLM_BASE_URL,
  apiKey: process.env.LLM_API_KEY,
  model: process.env.LLM_MODEL,
}

let key = process.env.WALLET_KEY
if (!key) {
  if (!DRY) {
    console.error('\n  WALLET_KEY is required with --live. Nothing was spent.\n')
    process.exit(1)
  }
  key = generatePrivateKey()
}
// Two kinds of wallet are payable, and which one you hold decides which bounties you
// can COLLECT, not just how you pay. A bounty settles on the chain that funded it, and
// the address spaces do not overlap.
const SOLANA = isSolanaKey(key)
if (!SOLANA && !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error('\n  WALLET_KEY must be either 0x + 64 hex (EVM) or a base58 Solana secret key.\n')
  process.exit(1)
}
const address = SOLANA ? await solanaAddressOf(key) : privateKeyToAccount(key).address

/** Can this wallet be PAID for a bounty that settles on `network`? An EVM wallet cannot
 *  receive USDC on Solana, or the reverse, so entering such a bounty means paying the
 *  tool price for work that can never be collected. The board publishes the chain for
 *  exactly this reason; skipping is the whole point of reading it. */
function payableToMe(network) {
  const solanaBounty = String(network ?? '').startsWith('solana')
  return solanaBounty === SOLANA
}

let spent = 0
let attempts = 0
let submitted = 0

const usd = (n) => `$${Number(n).toFixed(2)}`

/** The open board. Free to read: no payment, no account. */
async function openBounties() {
  const res = await fetch(`${HOST}/api/arena/contests`, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`board returned ${res.status}`)
  const data = await res.json()
  return Array.isArray(data?.bounties) ? data.bounties : []
}

/** Buy the ticket's context. Skippable: some tickets are answerable without it. */
async function buyContext(ticketId) {
  try {
    const r = await payAndPost({
      url: `${HOST}/api/x402/tools/deskcrew/get_ticket_context`,
      body: { ticketId },
      privateKey: key,
      maxPriceUsd: MAX_PRICE,
      rpcUrl: process.env.X402_RPC_URL,
    })
    if (r.paid) spent += Number(r.priceUsd)
    const parsed = JSON.parse(r.body)
    return { text: typeof parsed === 'string' ? parsed : JSON.stringify(parsed), cost: r.priceUsd }
  } catch (err) {
    if (err instanceof PaymentRefused) throw err
    return { text: '', cost: '0' }
  }
}

/** Submit the draft. This is the charge that matters and the one that can pay. */
async function submitDraft(ticketId, body) {
  const r = await payAndPost({
    url: `${HOST}/api/x402/tools/deskcrew/draft_reply`,
    body: { ticketId, body },
    privateKey: key,
    maxPriceUsd: MAX_PRICE,
    rpcUrl: process.env.X402_RPC_URL,
  })
  if (r.paid) spent += Number(r.priceUsd)
  return r
}

async function pass() {
  const bounties = await openBounties()
  if (!bounties.length) {
    console.log('  no open bounties right now')
    return
  }
  // ⚠️ SKIP WHAT THIS WALLET CANNOT BE PAID FOR, before spending a cent. The board
  // publishes each bounty's payout chain precisely so an agent can do this; entering a
  // Solana bounty with an EVM wallet (or the reverse) means paying the tool price for
  // work that can never be collected.
  const mine = bounties.filter((b) => payableToMe(b.payoutNetwork))
  const skipped = bounties.length - mine.length
  console.log(
    `  ${bounties.length} open` +
      (skipped
        ? `, ${skipped} not payable to ${SOLANA ? 'a Solana' : 'an EVM'} wallet (skipped)`
        : ''),
  )
  if (!mine.length) {
    console.log(`  nothing here pays out on ${SOLANA ? 'solana' : 'an EVM chain'} right now`)
    return
  }

  for (const b of mine.slice(0, LIMIT)) {
    const reward = Number(b.bountyUsd ?? b.amountUsd ?? 0)
    const ticketId = b.ticketId ?? b.ticket ?? b.id
    console.log(`\n  #${ticketId}  ${usd(reward)}  ${String(b.subject ?? '').slice(0, 60)}`)

    if (spent >= MAX_SPEND) {
      console.log(`  stopping: spend cap ${usd(MAX_SPEND)} reached`)
      return
    }

    if (DRY) {
      console.log('  DRY RUN: would buy context, draft an answer, and submit.')
      console.log(`  would risk ~$0.08 to win ${usd(reward * 0.85)} if approved.`)
      attempts++
      continue
    }

    let context = ''
    try {
      const c = await buyContext(ticketId)
      context = c.text
      if (Number(c.cost) > 0) console.log(`  context: ${usd(c.cost)}`)
    } catch (err) {
      console.log(`  context refused (${err.reason ?? 'error'}): ${err.message}`)
      if (err.reason === 'insufficient-funds' || err.reason === 'over-max-price') return
    }

    let text
    try {
      text = await draftReply({
        subject: b.subject ?? '',
        body: b.body ?? '',
        context,
        config: llm,
      })
    } catch (err) {
      // Not worth paying to submit something the model would not stand behind.
      console.log(`  skipped: ${err.message}`)
      continue
    }

    attempts++
    try {
      const r = await submitDraft(ticketId, text)
      if (r.paid) {
        submitted++
        console.log(
          `  submitted. paid ${usd(r.priceUsd)}${r.tx ? `  tx ${r.tx.slice(0, 14)}…` : ''}`,
        )
        console.log('  a human at that business now decides. Approval pays you 85% of the reward.')
      } else {
        console.log(`  not settled (status ${r.status}), so nothing was charged`)
      }
    } catch (err) {
      console.log(`  submit refused (${err.reason ?? 'error'}): ${err.message}`)
      if (err.reason === 'insufficient-funds' || err.reason === 'over-max-price') return
    }
  }
}

async function main() {
  console.log(`\n  bounty-hunter  ${DRY ? '(dry run)' : '(LIVE)'}`)
  console.log(`  wallet ${address}`)
  console.log(`  board  ${HOST}`)
  if (!DRY) console.log(`  caps   ${usd(MAX_SPEND)} total, ${usd(MAX_PRICE)} per charge`)
  if (DRY) console.log('  nothing will be spent. Add --live when you mean it.')
  console.log('')

  do {
    try {
      await pass()
    } catch (err) {
      console.log(`  pass failed: ${err?.message ?? err}`)
    }
    if (!ONCE) {
      if (spent >= MAX_SPEND) {
        console.log(`\n  spend cap ${usd(MAX_SPEND)} reached. Stopping.`)
        break
      }
      await new Promise((r) => setTimeout(r, INTERVAL_MS))
    }
  } while (!ONCE)

  console.log(`\n  attempts ${attempts}, submitted ${submitted}, spent ${usd(spent)}`)
  if (submitted > 0) {
    console.log(`  earnings appear at ${HOST}/api/arena/wallet/${address}`)
    console.log('  approvals are made by humans, so payment is not immediate.')
  }
  console.log('')
}

main().catch((err) => {
  console.error(`\n  ${err?.message ?? err}\n`)
  process.exit(1)
})
