import type { BranchCard } from '../types'
import { layoutCardTree, type CardTreeLayout, type TreePosition } from './tree'

export const TERMINAL_CARD_HEIGHT = 6
const TERMINAL_LEVEL_GAP = 1

export type TerminalTreeLayout = CardTreeLayout & {
  mode: 'tree' | 'outline'
  prefixes: Map<string, string>
}

/** A terminal scrolls vertically. Stack branches if the 2-D tree is too wide. */
export function layoutTerminalTree(cards: BranchCard[], columns: number): TerminalTreeLayout {
  const width = Math.max(1, Math.floor(columns))
  const tree = layoutCardTree(cards, width, {
    cardHeight: TERMINAL_CARD_HEIGHT, levelGap: TERMINAL_LEVEL_GAP, minCardWidth: 44, maxCardWidth: 52,
  })
  if (tree.width <= width) return { ...tree, mode: 'tree', prefixes: new Map() }

  const byId = new Map(cards.map(card => [card.sessionId, card]))
  const children = new Map<string, BranchCard[]>()
  const roots: BranchCard[] = []
  for (const card of cards) {
    if (card.parentSessionId === null || !byId.has(card.parentSessionId)) {
      roots.push(card)
      continue
    }
    const list = children.get(card.parentSessionId) ?? []
    list.push(card)
    children.set(card.parentSessionId, list)
  }
  const byTime = (a: BranchCard, b: BranchCard): number =>
    a.lastTimestamp - b.lastTimestamp || (a.sessionId < b.sessionId ? -1 : 1)
  roots.sort(byTime)
  for (const list of children.values()) list.sort(byTime)

  const positions = new Map<string, TreePosition>()
  const prefixes = new Map<string, string>()
  const margin = width >= 16 ? 1 : 0
  const maxIndent = Math.max(0, width - margin * 2 - 44)
  const visit = (card: BranchCard, ancestors: boolean[], hasNext: boolean, isRoot: boolean): void => {
    if (positions.has(card.sessionId)) return
    let prefix = isRoot ? '' : ancestors.map(next => next ? '│ ' : '  ').join('') + (hasNext ? '├─' : '└─')
    if (prefix.length > maxIndent) {
      prefix = maxIndent === 0 ? '' : maxIndent === 1 ? '…' : `…${prefix.slice(1 - maxIndent)}`
    }
    const x = margin + prefix.length
    positions.set(card.sessionId, {
      sessionId: card.sessionId,
      x,
      y: positions.size * (TERMINAL_CARD_HEIGHT + 1),
      width: Math.max(1, width - x - margin),
      height: TERMINAL_CARD_HEIGHT,
    })
    prefixes.set(card.sessionId, prefix)
    const kids = children.get(card.sessionId) ?? []
    for (const [index, child] of kids.entries()) {
      visit(child, isRoot ? [] : [...ancestors, hasNext], index < kids.length - 1, false)
    }
  }
  for (const root of roots) visit(root, [], false, true)
  return {
    positions,
    prefixes,
    connectors: [],
    width,
    height: Math.max(1, positions.size * (TERMINAL_CARD_HEIGHT + 1)),
    mode: 'outline',
  }
}
