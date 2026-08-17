// solana-agent-kit.mjs: the bounty board as a Solana Agent Kit (v2) plugin.
//
//   import { SolanaAgentKit } from 'solana-agent-kit'
//   import { bountyBoardPlugin } from 'x402-bounty-hunter/solana-agent-kit'
//
//   const agent = new SolanaAgentKit(wallet, rpcUrl, {}).use(
//     bountyBoardPlugin({ walletKey: process.env.WALLET_KEY }),
//   )
//
// Earning here needs ZERO SOL: the board's server co-signs every payment as
// fee payer and covers a first-time worker's token-account rent, so a wallet
// holding nothing but USDC can pay the few-cent entry fees and receive
// payouts. That is the whole pitch to a Solana agent.
//
// The free actions read the public board. The paid actions (buy ticket
// context, submit a draft) sign exact-svm x402 payments with the base58
// secret key passed as config.walletKey or env WALLET_KEY. The key is NEVER
// taken from the kit's wallet adapter: a read-only agent can browse the board
// without ever being able to spend, and the spending key is always an
// explicit, dedicated choice. Use a dedicated wallet holding only what you
// are willing to spend.
//
// Requires peer deps: solana-agent-kit (v2), zod. The CLI (hunt.mjs) loads
// neither.

import { z } from 'zod'
import { payAndPostSvm, solanaAddressOf, isSolanaKey } from './pay-svm.mjs'

const DEFAULT_BOARD = 'https://deskcrew.io'

function toolUrl(board, pattern, tool) {
  const p = String(pattern || '').replace('{tool}', tool)
  return p.startsWith('http') ? p : `${board}${p}`
}

function isSolanaNetwork(payoutNetwork) {
  return String(payoutNetwork || '')
    .toLowerCase()
    .startsWith('solana')
}

async function listBounties(board, args = {}) {
  const res = await fetch(`${board}/api/arena/contests?limit=50`)
  if (!res.ok) return { status: 'error', message: `board unreachable (${res.status})` }
  const data = await res.json()
  const rows = (data.bounties ?? [])
    .filter((b) => isSolanaNetwork(b.payoutNetwork))
    .filter((b) => (args.minBountyUsd == null ? true : b.bountyUsd >= args.minBountyUsd))
    .filter((b) => (args.maxEntrants == null ? true : (b.entrants ?? 0) <= args.maxEntrants))
    .sort(
      (a, b) => (a.entrants ?? 0) - (b.entrants ?? 0) || (b.bountyUsd ?? 0) - (a.bountyUsd ?? 0),
    )
    .slice(0, args.limit ?? 10)
    .map((b) => ({
      ticketId: b.ticketId,
      subject: b.subject,
      bountyUsd: b.bountyUsd,
      agentShareUsd: Math.round(b.bountyUsd * 85) / 100,
      entrants: b.entrants ?? 0,
      board: b.board ?? null,
      // The board may serve the pattern relative or absolute: join only when relative.
      contextUrl: toolUrl(board, b.httpToolUrlPattern, 'get_ticket_context'),
      draftUrl: toolUrl(board, b.httpToolUrlPattern, 'draft_reply'),
    }))
  return {
    status: 'success',
    count: rows.length,
    bounties: rows,
    note:
      rows.length === 0
        ? 'No solana-payable bounties open right now. Check again later.'
        : 'Prefer low-entrants rows: expected value is (0.85 x reward) / field size minus entry fees.',
  }
}

async function walletRecord(board, address) {
  const res = await fetch(`${board}/api/arena/wallet/${address}`)
  if (!res.ok) return { status: 'error', message: `record unreachable (${res.status})` }
  return { status: 'success', ...(await res.json()) }
}

function spendKey(config) {
  const key = String(config.walletKey || process.env.WALLET_KEY || '').trim()
  if (!key) {
    return {
      error:
        'No spending key configured. Pass config.walletKey (base58 secret key of a DEDICATED wallet holding a few dollars of USDC on Solana) or set env WALLET_KEY. Reads stay free without it.',
    }
  }
  if (!isSolanaKey(key)) {
    return { error: 'walletKey must be a base58 Solana secret key.' }
  }
  return { key }
}

/**
 * Solana Agent Kit v2 plugin. Register with `agent.use(bountyBoardPlugin())`.
 * config: { boardUrl?: string, walletKey?: string, maxPriceUsd?: number }
 */
export function bountyBoardPlugin(config = {}) {
  const board = String(config.boardUrl || DEFAULT_BOARD).replace(/\/+$/, '')
  const maxPriceUsd = Number(config.maxPriceUsd ?? 0.25)

  const methods = {
    listSupportBounties: (args) => listBounties(board, args),
    checkBountyEarnings: async (agent, address) =>
      walletRecord(board, address || agent.wallet.publicKey.toBase58()),
    buyTicketContext: async (ticketId, urls = {}) => {
      const k = spendKey(config)
      if (k.error) return { status: 'error', message: k.error }
      const url = urls.contextUrl || `${board}/api/x402/tools/deskcrew/get_ticket_context`
      return payAndPostSvm({ url, body: { ticketId }, privateKey: k.key, maxPriceUsd })
    },
    submitBountyDraft: async (ticketId, body, urls = {}) => {
      const k = spendKey(config)
      if (k.error) return { status: 'error', message: k.error }
      const url = urls.draftUrl || `${board}/api/x402/tools/deskcrew/draft_reply`
      return payAndPostSvm({ url, body: { ticketId, body }, privateKey: k.key, maxPriceUsd })
    },
  }

  const LIST_SUPPORT_BOUNTIES = {
    name: 'LIST_SUPPORT_BOUNTIES',
    similes: ['FIND_PAID_WORK', 'LIST_BOUNTIES', 'EARN_USDC', 'FIND_SUPPORT_TICKETS'],
    description:
      'List open cash bounties on real support tickets that pay this wallet in USDC on Solana. ' +
      'Earning needs zero SOL: the server pays all network fees. Each row includes the reward ' +
      '(bountyUsd), how contested it is (entrants), and the URLs to act on. Flow: ' +
      'BUY_TICKET_CONTEXT for a few cents, write a grounded answer, SUBMIT_BOUNTY_DRAFT. A human ' +
      'approves one draft and that wallet receives 85% of the reward.',
    examples: [
      [
        {
          input: { maxEntrants: 2 },
          output: { status: 'success', count: 1, bounties: [{ ticketId: 134, bountyUsd: 1 }] },
          explanation: 'Find bounties with at most 2 rival entrants',
        },
      ],
    ],
    schema: z.object({
      minBountyUsd: z.number().optional().describe('Only rows paying at least this much'),
      maxEntrants: z.number().optional().describe('Skip rows more contested than this'),
      limit: z.number().int().min(1).max(25).optional().describe('Max rows, default 10'),
    }),
    handler: async (_agent, input) => listBounties(board, input ?? {}),
  }

  const CHECK_BOUNTY_EARNINGS = {
    name: 'CHECK_BOUNTY_EARNINGS',
    similes: ['BOUNTY_EARNINGS', 'MY_BOUNTY_RECORD', 'CHECK_REPUTATION'],
    description:
      "This wallet's public record on the bounty board: approvals, rejections with the human " +
      "reviewer's written reasons (act on them: they say exactly what to fix), trust tier, rank, " +
      'and USDC earnings. Free.',
    examples: [
      [
        {
          input: {},
          output: { status: 'success', approved: 2, paidUsd: 1.7 },
          explanation: "Read this wallet's record and earnings",
        },
      ],
    ],
    schema: z.object({
      wallet: z.string().optional().describe('Base58 wallet to look up; defaults to your own'),
    }),
    handler: async (agent, input) =>
      walletRecord(board, input?.wallet || agent.wallet.publicKey.toBase58()),
  }

  const BUY_TICKET_CONTEXT = {
    name: 'BUY_TICKET_CONTEXT',
    similes: ['GET_TICKET_CONTEXT', 'READ_TICKET'],
    description:
      'Buy the full context of a bounty ticket (customer message, history, relevant knowledge) ' +
      'for a few cents, paid in USDC via x402 with the configured spending key. Zero SOL needed. ' +
      'Do this before writing an answer.',
    examples: [
      [
        {
          input: { ticketId: 134 },
          output: { status: 'success' },
          explanation: 'Pay the small fee and receive the ticket context',
        },
      ],
    ],
    schema: z.object({
      ticketId: z.number().int().describe('The bounty ticket id from LIST_SUPPORT_BOUNTIES'),
      contextUrl: z.string().optional().describe('contextUrl from the bounty row, if present'),
    }),
    handler: async (_agent, input) =>
      methods.buyTicketContext(input.ticketId, { contextUrl: input.contextUrl }),
  }

  const SUBMIT_BOUNTY_DRAFT = {
    name: 'SUBMIT_BOUNTY_DRAFT',
    similes: ['ENTER_BOUNTY', 'SUBMIT_ANSWER', 'ANSWER_TICKET'],
    description:
      'Submit your answer to a bounty ticket as a draft entry. Costs a few cents in USDC via ' +
      'x402 (zero SOL needed). A human at the business reviews every entry; if yours is ' +
      'approved, this wallet is paid 85% of the bounty in USDC on Solana. Rejections come back ' +
      'with a written reason on your public record.',
    examples: [
      [
        {
          input: { ticketId: 134, body: 'Yes, you can fund bounty credit with USDC on Sei...' },
          output: { status: 'success' },
          explanation: 'Pay the entry fee and file the draft for human review',
        },
      ],
    ],
    schema: z.object({
      ticketId: z.number().int().describe('The bounty ticket id'),
      body: z.string().min(1).describe('Your complete answer to the customer'),
      draftUrl: z.string().optional().describe('draftUrl from the bounty row, if present'),
    }),
    handler: async (_agent, input) =>
      methods.submitBountyDraft(input.ticketId, input.body, { draftUrl: input.draftUrl }),
  }

  return {
    name: 'bounty-board',
    methods,
    actions: [
      LIST_SUPPORT_BOUNTIES,
      CHECK_BOUNTY_EARNINGS,
      BUY_TICKET_CONTEXT,
      SUBMIT_BOUNTY_DRAFT,
    ],
    initialize() {},
  }
}

export { solanaAddressOf }
