import type { BranchCard } from '../types'
import { isTerminalSurface } from './surface'

/** Surface-specific labels stay out of the shared graph and App identities. */
export function cardsForSurface(cards: BranchCard[], surface?: string): BranchCard[] {
  if (!isTerminalSurface(surface)) return cards
  return cards.map(card => ({
    ...card,
    title: card.cliSessionId || card.sessionId.replace(/^local_/, ''),
    firstUserMessage: card.branchFirstUserMessage ?? card.firstUserMessage,
  }))
}

export function branchTypeLabel(card: BranchCard): string {
  const kind = card.branchType ?? (card.parentSessionId === null ? 'root' : 'branch')
  return kind === 'root' ? '根分支' : kind === 'fork' ? 'fork 分支' : 'branch 分支'
}
