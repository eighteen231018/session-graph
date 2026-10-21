import type { BranchCard } from '../types'

export const CARD_HEIGHT = 9
export const LEVEL_GAP = 5
export const SIBLING_GAP = 3
const MIN_CARD_WIDTH = 14
const MAX_CARD_WIDTH = 30

export type TreePosition = {
  sessionId: string
  x: number
  y: number
  width: number
  height: number
}

export type TreeConnector = {
  key: string
  parentCenter: number
  childCenter: number
  parentBottom: number
  busY: number
  childTop: number
  level: number
}

export type CardTreeLayout = {
  positions: Map<string, TreePosition>
  connectors: TreeConnector[]
  width: number
  height: number
  cardWidth: number
  cardHeight: number
}

/**
 * A 2-D tree of cards: a parent is centred over its children, every level is
 * one CARD_HEIGHT + LEVEL_GAP below the previous one, and each parent-child
 * pair gets an orthogonal connector (down, across, down). Widths are measured
 * in terminal cells; the largest card width that fits the pane is chosen.
 */
export function layoutCardTree(cards: BranchCard[], columns: number): CardTreeLayout {
  const usableColumns = Math.max(24, Math.floor(columns))
  const byId = new Map(cards.map(card => [card.sessionId, card]))
  const children = new Map<string, BranchCard[]>()
  const roots: BranchCard[] = []

  for (const card of cards) {
    const parent = card.parentSessionId !== null ? byId.get(card.parentSessionId) : undefined
    if (parent !== undefined) {
      const list = children.get(parent.sessionId)
      if (list === undefined) children.set(parent.sessionId, [card])
      else list.push(card)
    } else {
      roots.push(card)
    }
  }

  const byTime = (a: BranchCard, b: BranchCard): number =>
    a.lastTimestamp - b.lastTimestamp || (a.sessionId < b.sessionId ? -1 : 1)
  for (const list of children.values()) list.sort(byTime)
  roots.sort(byTime)

  const measure = (cardWidth: number): number => {
    const cache = new Map<string, number>()
    const widthOf = (card: BranchCard): number => {
      const cached = cache.get(card.sessionId)
      if (cached !== undefined) return cached
      const kids = children.get(card.sessionId) ?? []
      const width = kids.length === 0
        ? cardWidth
        : Math.max(
          cardWidth,
          kids.reduce((sum, kid) => sum + widthOf(kid), 0) + SIBLING_GAP * (kids.length - 1),
        )
      cache.set(card.sessionId, width)
      return width
    }
    return roots.reduce((sum, root) => sum + widthOf(root), 0)
      + SIBLING_GAP * Math.max(0, roots.length - 1)
  }

  let cardWidth = MIN_CARD_WIDTH
  for (let candidate = MAX_CARD_WIDTH; candidate >= MIN_CARD_WIDTH; candidate -= 1) {
    if (measure(candidate) + 2 <= usableColumns) {
      cardWidth = candidate
      break
    }
  }

  const treeWidth = measure(cardWidth)
  const canvasWidth = Math.max(usableColumns, treeWidth + 2)
  const offset = Math.max(1, Math.floor((canvasWidth - treeWidth) / 2))

  const widthCache = new Map<string, number>()
  const widthOf = (card: BranchCard): number => {
    const cached = widthCache.get(card.sessionId)
    if (cached !== undefined) return cached
    const kids = children.get(card.sessionId) ?? []
    const width = kids.length === 0
      ? cardWidth
      : Math.max(
        cardWidth,
        kids.reduce((sum, kid) => sum + widthOf(kid), 0) + SIBLING_GAP * (kids.length - 1),
      )
    widthCache.set(card.sessionId, width)
    return width
  }

  const positions = new Map<string, TreePosition>()

  const place = (card: BranchCard, left: number, depth: number): void => {
    const kids = children.get(card.sessionId) ?? []
    const total = widthOf(card)
    const y = depth * (CARD_HEIGHT + LEVEL_GAP)

    if (kids.length === 0) {
      positions.set(card.sessionId, {
        sessionId: card.sessionId,
        x: left,
        y,
        width: cardWidth,
        height: CARD_HEIGHT,
      })
      return
    }

    let cursor = left
    for (const kid of kids) {
      place(kid, cursor, depth + 1)
      cursor += widthOf(kid) + SIBLING_GAP
    }

    const first = positions.get(kids[0]!.sessionId)
    const last = positions.get(kids[kids.length - 1]!.sessionId)
    const firstCenter = first !== undefined ? first.x + first.width / 2 : left + cardWidth / 2
    const lastCenter = last !== undefined ? last.x + last.width / 2 : left + total - cardWidth / 2
    const centered = Math.round((firstCenter + lastCenter) / 2 - cardWidth / 2)
    const x = Math.max(left, Math.min(centered, left + total - cardWidth))
    positions.set(card.sessionId, {
      sessionId: card.sessionId,
      x,
      y,
      width: cardWidth,
      height: CARD_HEIGHT,
    })
  }

  let cursor = offset
  for (const root of roots) {
    place(root, cursor, 0)
    cursor += widthOf(root) + SIBLING_GAP
  }

  const connectors: TreeConnector[] = []
  for (const card of cards) {
    if (card.parentSessionId === null) continue
    const parent = positions.get(card.parentSessionId)
    const child = positions.get(card.sessionId)
    if (parent === undefined || child === undefined) continue

    const parentCenter = parent.x + Math.floor(parent.width / 2)
    const childCenter = child.x + Math.floor(child.width / 2)
    const parentBottom = parent.y + parent.height
    const busY = parentBottom + Math.floor(LEVEL_GAP / 2)
    const level = Math.round(child.y / (CARD_HEIGHT + LEVEL_GAP))

    connectors.push({
      key: card.sessionId,
      parentCenter,
      childCenter,
      parentBottom,
      busY,
      childTop: child.y,
      level,
    })
  }

  let maxX = 0
  let maxY = 0
  for (const position of positions.values()) {
    if (position.x + position.width > maxX) maxX = position.x + position.width
    if (position.y + position.height > maxY) maxY = position.y + position.height
  }

  return {
    positions,
    connectors,
    width: Math.max(canvasWidth, maxX + 1),
    height: Math.max(1, maxY + 2),
    cardWidth,
    cardHeight: CARD_HEIGHT,
  }
}
