import { expect, test } from 'claude-code/testing'
import { exportHtml, type ExportDeps } from '../lib/export'
import { buildLineGrid, connectorPath, glyphOf } from '../lib/lines'
import { buildConnectorSvg, SVG_LEVEL_COLORS } from '../lib/svg'
import { layoutCardTree } from '../lib/tree'
import type { BranchCard, GraphSnapshot } from '../types'

function card(sessionId: string, parentSessionId: string | null, timestamp: number): BranchCard {
  return {
    sessionId,
    title: sessionId,
    matchTitle: '',
    firstUserMessage: `message ${sessionId}`,
    parentSessionId,
    forkAtPreview: null,
    ownMessageCount: 1,
    messageCount: 1,
    lastTimestamp: timestamp,
    isCurrent: false,
    color: 0,
    depth: 0,
  }
}

function fixture(): ReturnType<typeof layoutCardTree> {
  return layoutCardTree([
    card('root', null, 1),
    card('left', 'root', 2),
    card('right', 'root', 3),
    card('grand', 'left', 4),
  ], 80)
}

test('connectors carry the depth of the branch they lead to', () => {
  const layout = fixture()
  expect(layout.connectors.find(connector => connector.key === 'left')?.level).toBe(1)
  expect(layout.connectors.find(connector => connector.key === 'right')?.level).toBe(1)
  expect(layout.connectors.find(connector => connector.key === 'grand')?.level).toBe(2)
})

test('a shared stem joins both children on one bus row', () => {
  const layout = fixture()
  const grid = buildLineGrid(layout)
  const left = layout.connectors.find(connector => connector.key === 'left')!
  const junction = grid.cells.get(`${left.busY}:${left.parentCenter}`)!
  expect(junction.up).toBe(true)
  expect(junction.left).toBe(true)
  expect(junction.right).toBe(true)
  expect(glyphOf(junction)).toBe('┴')
})

test('a child corner turns from the bus down into the card', () => {
  const layout = fixture()
  const grid = buildLineGrid(layout)
  const left = layout.connectors.find(connector => connector.key === 'left')!
  const corner = grid.cells.get(`${left.busY}:${left.childCenter}`)!
  expect(corner.down).toBe(true)
  expect(glyphOf(corner)).toBe(left.childCenter < left.parentCenter ? '╭' : '╮')
})

test('a single child straight below its parent stays one vertical line', () => {
  const layout = fixture()
  const grid = buildLineGrid(layout)
  const grand = layout.connectors.find(connector => connector.key === 'grand')!
  expect(grand.parentCenter).toBe(grand.childCenter)
  expect(glyphOf(grid.cells.get(`${grand.busY}:${grand.childCenter}`)!)).toBe('│')
  for (let y = grand.parentBottom; y < grand.childTop; y += 1) {
    expect(glyphOf(grid.cells.get(`${y}:${grand.childCenter}`)!)).toBe('│')
  }
})

test('every line cell belongs to exactly one level', () => {
  const layout = fixture()
  const grid = buildLineGrid(layout)
  for (const cell of grid.cells.values()) {
    const connector = layout.connectors.find(item =>
      (cell.y >= item.parentBottom && cell.y <= item.childTop) &&
      (cell.x === item.parentCenter || cell.x === item.childCenter ||
        (cell.y === item.busY && cell.x >= Math.min(item.parentCenter, item.childCenter) &&
          cell.x <= Math.max(item.parentCenter, item.childCenter))),
    )
    expect(connector).toBeDefined()
    expect(cell.level).toBe(connector!.level)
  }
})

test('the static export draws thin connectors in one colour per level', async () => {
  const cards = [
    card('root', null, 1),
    card('left', 'root', 2),
    card('right', 'root', 3),
    card('grand', 'left', 4),
  ]
  const snapshot: GraphSnapshot = {
    nodes: [],
    sessions: [],
    cards,
    source: 'transcript',
    scannedAt: 1,
    theme: 'dark',
    hiddenNodeCount: 0,
  }
  let html = ''
  const deps = {
    sessionId: async () => 'session',
    sessionCwd: async () => '/tmp',
    fsWrite: async (_path: string, text: string) => {
      html = text
    },
  } as unknown as ExportDeps

  await exportHtml(deps, snapshot)

  expect(html).toContain('<svg class="lines"')
  expect(html).toContain('class="connector"')
  expect(html).toContain('class="flow"')
  // Level 1 and level 2 use different palette entries.
  expect(html).toContain('#79c0ff')
  expect(html).toContain('#56d364')
  // The export no longer repeats message and fork counts.
  expect(html).not.toContain('本分支')
  expect(html).not.toContain('会话共')
  expect(html).toContain('4 个分支')
})

test('a connector path is one down-across-down polyline', () => {
  const layout = fixture()
  const left = layout.connectors.find(connector => connector.key === 'left')!
  expect(connectorPath(left)).toBe(
    `M ${left.parentCenter + 0.5} ${left.parentBottom} V ${left.busY + 0.5} H ${left.childCenter + 0.5} V ${left.childTop}`,
  )
})

test('the desktop SVG layer uses cell units and one colour per level', () => {
  const layout = fixture()
  const svg = buildConnectorSvg(layout)
  expect(svg).toContain(`viewBox="0 0 ${layout.width} ${layout.height}"`)
  expect(svg).toContain('preserveAspectRatio="none"')
  expect(svg).toContain('vector-effect="non-scaling-stroke"')
  expect(svg).toContain('<animate')
  expect(svg).toContain(SVG_LEVEL_COLORS[0])
  expect(svg).toContain(SVG_LEVEL_COLORS[1])
  expect(svg.split('<path').length - 1).toBe(layout.connectors.length * 2)
})
