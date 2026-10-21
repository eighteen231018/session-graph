import type { CardTreeLayout, TreeConnector } from './tree'

export type LineCell = {
  x: number
  y: number
  up: boolean
  down: boolean
  left: boolean
  right: boolean
  /** Depth of the branch the line leads to; a root's children are level 1. */
  level: number
  /** Position along the connector, from the parent down to the child. */
  flow: number
}

export type LineGrid = {
  cells: Map<string, LineCell>
  width: number
  height: number
}

const GLYPHS: Record<string, string> = {
  // up down left right
  '0000': ' ',
  '1000': '│',
  '0100': '│',
  '0010': '─',
  '0001': '─',
  '1100': '│',
  '0011': '─',
  '0101': '╭',
  '0110': '╮',
  '1001': '╰',
  '1010': '╯',
  '0111': '┬',
  '1011': '┴',
  '1101': '├',
  '1110': '┤',
  '1111': '┼',
}

/**
 * Turns every parent-child connector into single cells with the directions
 * they connect, so overlapping spans (a parent's shared stem, a bus between
 * siblings) merge into one glyph instead of stacking rectangles. `flow` runs
 * from the parent down to the child and drives the travelling highlight.
 */
export function buildLineGrid(layout: CardTreeLayout): LineGrid {
  const cells = new Map<string, LineCell>()

  const touch = (
    x: number,
    y: number,
    dirs: { up?: boolean; down?: boolean; left?: boolean; right?: boolean },
    level: number,
    flow: number,
  ): void => {
    const key = `${y}:${x}`
    const cell = cells.get(key)
    if (cell === undefined) {
      cells.set(key, {
        x,
        y,
        up: dirs.up === true,
        down: dirs.down === true,
        left: dirs.left === true,
        right: dirs.right === true,
        level,
        flow,
      })
      return
    }
    cell.up = cell.up || dirs.up === true
    cell.down = cell.down || dirs.down === true
    cell.left = cell.left || dirs.left === true
    cell.right = cell.right || dirs.right === true
    if (flow < cell.flow) cell.flow = flow
    if (level < cell.level) cell.level = level
  }

  layout.connectors.forEach((connector, index) => {
    const { parentCenter, childCenter, parentBottom, busY, childTop, level } = connector
    const straight = parentCenter === childCenter
    let flow = index * 5

    // Parent stem: the line leaves the card's bottom edge and meets the bus.
    for (let y = parentBottom; y < busY; y += 1) {
      touch(parentCenter, y, { up: true, down: true }, level, flow)
      flow += 1
    }

    touch(
      parentCenter,
      busY,
      {
        up: true,
        down: straight,
        left: !straight && childCenter < parentCenter,
        right: !straight && childCenter > parentCenter,
      },
      level,
      flow,
    )
    flow += 1

    if (!straight) {
      const step = childCenter > parentCenter ? 1 : -1
      for (let x = parentCenter + step; x !== childCenter; x += step) {
        touch(x, busY, { left: true, right: true }, level, flow)
        flow += 1
      }
      touch(
        childCenter,
        busY,
        {
          down: true,
          left: childCenter > parentCenter,
          right: childCenter < parentCenter,
        },
        level,
        flow,
      )
      flow += 1
    }

    // Child stem: from the bus down to the card's top edge.
    for (let y = busY + 1; y < childTop; y += 1) {
      touch(childCenter, y, { up: true, down: true }, level, flow)
      flow += 1
    }
  })

  return { cells, width: layout.width, height: layout.height }
}

export function glyphOf(cell: LineCell): string {
  const mask = `${cell.up ? 1 : 0}${cell.down ? 1 : 0}${cell.left ? 1 : 0}${cell.right ? 1 : 0}`
  return GLYPHS[mask] ?? '│'
}

/**
 * The down-across-down path of one connector in the given unit, shared by the
 * static export (pixels) and the desktop SVG overlay (cells).
 */
export function connectorPath(connector: TreeConnector, cellWidth = 1, cellHeight = 1): string {
  const parentX = connector.parentCenter * cellWidth + cellWidth / 2
  const childX = connector.childCenter * cellWidth + cellWidth / 2
  const parentY = connector.parentBottom * cellHeight
  const busY = connector.busY * cellHeight + cellHeight / 2
  const childY = connector.childTop * cellHeight
  return `M ${parentX} ${parentY} V ${busY} H ${childX} V ${childY}`
}
