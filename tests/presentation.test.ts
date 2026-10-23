import { expect, test } from 'claude-code/testing'
import type { BranchCard } from '../types'
import { cardsForSurface } from '../lib/presentation'
import { layoutTerminalTree } from '../lib/terminal-layout'
import { layoutCardTree } from '../lib/tree'
import { revealCurrent } from '../lib/navigation'
import type { UiScrollArgs } from 'claude-code'

function card(id: string, parent: string | null = null, time = 1): BranchCard {
  return {
    sessionId: id, title: `会话 ${id.slice(0, 8)}`, matchTitle: '', firstUserMessage: '实现 CLI 支持',
    parentSessionId: parent, forkAtPreview: null, ownMessageCount: 1, messageCount: 1,
    lastTimestamp: time, isCurrent: false, color: 0, depth: 0,
  }
}

test('terminal derives readable placeholder titles without changing graph data', () => {
  const original = [card('11111111-root'), card('22222222-child', '11111111-root')]
  const displayed = cardsForSurface(original, 'terminal')
  expect(displayed[0]?.title).toBe('实现 CLI 支持 · 11111111')
  expect(displayed[1]?.title).toBe('实现 CLI 支持 · 22222222')
  expect(original[0]?.title).toBe('会话 11111111')
  expect(original[0]?.matchTitle).toBe('')
  expect(displayed[1]?.parentSessionId).toBe('11111111-root')
})

test('explicit App, transcript and legacy snapshot titles survive terminal formatting', () => {
  const app = { ...card('local_11111111'), title: 'App title', matchTitle: 'App title' }
  const transcript = { ...card('22222222'), title: 'Transcript title', matchTitle: 'Transcript title' }
  const legacy = { ...card('33333333'), title: 'Legacy title' }
  expect(cardsForSurface([app, transcript, legacy], 'terminal').map(item => item.title))
    .toEqual(['App title', 'Transcript title', 'Legacy title'])
})

test('Desktop and other surfaces keep their original titles and objects', () => {
  const cards = [card('11111111-root')]
  for (const surface of ['desktop', 'mobile', 'vscode', undefined]) {
    expect(cardsForSurface(cards, surface)).toBe(cards)
    expect(cardsForSurface(cards, surface)[0]?.title).toBe('会话 11111111')
  }
})

test('terminal placeholders remain when a branch has no user prompt', () => {
  for (const preview of ['', '   ', '（该分支没有用户消息）', '（没有用户消息）']) {
    const item = { ...card('11111111-root'), firstUserMessage: preview }
    expect(cardsForSurface([item], 'terminal')[0]?.title).toBe(item.title)
  }
})

test('terminal title previews normalize whitespace and truncate Unicode at whole characters', () => {
  const item = { ...card('11111111-root'), firstUserMessage: `\n  ${'🧪'.repeat(40)}\t` }
  expect(cardsForSurface([item], 'terminal')[0]?.title).toBe(`${'🧪'.repeat(36)}… · 11111111`)
})

function branches(): BranchCard[] {
  return [card('root'), ...Array.from({ length: 5 }, (_, index) => card(`child-${index}`, 'root', index + 2))]
}

test('terminal cards stay compact while the default Desktop geometry is unchanged', () => {
  const cards = branches()
  const desktop = layoutCardTree(cards, 200)
  const terminal = layoutTerminalTree(cards, 200)
  expect(terminal.mode).toBe('tree')
  for (const item of cards) {
    expect(terminal.positions.get(item.sessionId)?.x).toBe(desktop.positions.get(item.sessionId)?.x)
    expect(terminal.positions.get(item.sessionId)?.width).toBe(desktop.positions.get(item.sessionId)?.width)
    expect(terminal.positions.get(item.sessionId)?.height).toBe(5)
    expect(desktop.positions.get(item.sessionId)?.height).toBe(9)
  }
  expect(terminal.positions.get('child-0')?.y).toBe(6)
  expect(desktop.positions.get('child-0')?.y).toBe(14)
  expect(terminal.connectors.map(connector => [connector.key, connector.level]))
    .toEqual(desktop.connectors.map(connector => [connector.key, connector.level]))
})

test('the first child title appears within a small terminal pane without scrolling', () => {
  const cards = [card('root'), card('left', 'root', 2), card('right', 'root', 3)]
  const layout = layoutTerminalTree(cards, 76)
  const headerRows = 3
  const bodyRows = 12
  for (const id of ['left', 'right']) {
    const position = layout.positions.get(id)!
    expect(headerRows + position.y + 1 < bodyRows).toBe(true)
  }
  expect(layout.connectors).toHaveLength(2)
})

test('narrow terminal layouts keep every sibling inside the available columns', () => {
  const cards = branches()
  for (const columns of [10, 20, 40, 80]) {
    const layout = layoutTerminalTree(cards, columns)
    expect(layout.mode).toBe('outline')
    expect(layout.width).toBe(columns)
    expect(layout.positions.size).toBe(cards.length)
    let lastBottom = 0
    for (const position of layout.positions.values()) {
      expect(position.x + position.width <= columns).toBe(true)
      expect(position.y >= lastBottom).toBe(true)
      lastBottom = position.y + position.height
    }
    expect(layout.height >= lastBottom).toBe(true)
  }
  const outlined = layoutTerminalTree(cards, 40)
  expect(outlined.prefixes.get('child-0')).toBe('├─')
  expect(outlined.prefixes.get('child-4')).toBe('└─')
})

test('deep terminal branches cap indentation and retain room for readable cards', () => {
  const cards = Array.from({ length: 25 }, (_, index) => card(`node-${index}`, index === 0 ? null : `node-${index - 1}`, index))
  // The regular layout is already narrow for a single child. Add siblings to
  // require an outline, then check indentation for the deep part of the tree.
  cards.push(...branches().slice(1).map(item => ({ ...item, parentSessionId: 'node-0' })))
  const layout = layoutTerminalTree(cards, 40)
  expect(layout.mode).toBe('outline')
  for (const position of layout.positions.values()) {
    expect(position.width >= 20).toBe(true)
    expect(position.x + position.width <= 40).toBe(true)
  }
  expect(layout.prefixes.get('node-24')?.startsWith('…')).toBe(true)
})

test('current-card navigation reveals its title in this plugin pane', async () => {
  const requests: UiScrollArgs[] = []
  const result = await revealCurrent(async args => { requests.push(args); return {} }, 'deep-current')
  expect(result).toEqual({ ok: true })
  expect(requests).toEqual([{ in: 'session-graph', to: { key: 'deep-current:title' }, block: 'start' }])
})

test('current-card navigation preserves host refusals and handles unavailable scroll APIs', async () => {
  expect(await revealCurrent(async () => ({ deny: 'no-surface' }), 'current'))
    .toEqual({ ok: false, reason: 'no-surface' })
  expect(await revealCurrent(async () => { throw new Error('scroll unavailable') }, 'current'))
    .toEqual({ ok: false, reason: 'scroll unavailable' })
})
