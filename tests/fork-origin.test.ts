import { expect, test } from 'claude-code/testing'
import { parseTranscript } from '../lib/parse'
import { buildGraph, type SessionFile } from '../lib/graph'
import type { AppSessionRecord } from '../lib/app-store'

const BASE = Date.parse('2026-10-21T04:08:00Z')
const iso = (offset: number): string => new Date(BASE + offset).toISOString()

function row(uuid: string, owner: string, offset: number, parentUuid: string | null) {
  return { type: 'user', uuid, sessionId: owner, parentUuid, timestamp: iso(offset), message: { content: uuid } }
}

function marker(uuid: string, owner: string, offset = 7000, cutoff = 6000, anchor = 'boundary') {
  return {
    ...row(uuid, owner, offset, anchor),
    origin: { kind: 'task-notification' },
    promptSource: 'system',
    sessionKind: 'bg',
    message: { content: `<task-notification>\n<fork-source>\nThis session began as a fork (copy) of another session that is still running. The conversation up to ${iso(cutoff)} is shared history with it; the two sessions have since diverged.\n</fork-source>\n</task-notification>` },
  }
}

function file(id: string, rows: unknown[]): SessionFile {
  const parsed = parseTranscript(rows.map(value => JSON.stringify(value)).join('\n'), id)
  return { id, path: `/tmp/${id}.jsonl`, mtimeMs: 1, createdAt: 0, messages: parsed.messages, forkOrigins: parsed.forkOrigins }
}

function fixture() {
  const shared = Array.from({ length: 6 }, (_, index) => row(`shared-${index}`, 'parent', index * 1000, index === 0 ? null : `shared-${index - 1}`))
  const boundary = { type: 'system', subtype: 'turn_duration', uuid: 'boundary', parentUuid: 'shared-5', timestamp: iso(6000), sessionId: 'parent' }
  const copied = [...shared, boundary]
  const notification = marker('fork-marker', 'child')
  const parent = file('parent', [...copied, row('parent-only', 'parent', 8000, 'boundary')])
  const childRows = [...copied.map(value => ({ ...value, sessionId: 'child' })), notification]
  const child = file('child', childRows)
  return { copied, parent, child, notification, childRows }
}

test('CLI fork notifications preserve the shared anchor even through a system row', () => {
  const { child } = fixture()
  expect(child.forkOrigins).toEqual([{
    markerUuid: 'fork-marker', anchorUuid: 'shared-5', sharedThrough: BASE + 6000, timestamp: BASE + 7000,
  }])
  expect(child.messages.every(message => message.sessionId === 'child')).toBe(true)
})

test('rewritten CLI fork histories with 7 messages each still form a root and child', () => {
  const { parent, child } = fixture()
  for (const files of [[parent, child], [child, parent]]) {
    for (const current of ['parent', 'child']) {
      const graph = buildGraph(files, current, 'dark', 1, undefined, [], { cliForkOrigins: true })
      expect(graph.cards).toHaveLength(2)
      expect(graph.cards.find(card => card.sessionId === 'parent')?.parentSessionId).toBeNull()
      expect(graph.cards.find(card => card.sessionId === 'child')?.parentSessionId).toBe('parent')
      expect(graph.nodes.some(node => node.type === 'fork' && node.sessionId === 'child')).toBe(true)
    }
  }
})

test('CLI notification inference is opt-in so the Desktop default stays unchanged', () => {
  const { parent, child } = fixture()
  const graph = buildGraph([parent, child], 'parent', 'dark', 1)
  expect(graph.cards).toHaveLength(1)
  expect(graph.cards[0]?.sessionId).toBe('parent')
})

test('App parent links stay authoritative over a conflicting CLI fork notification', () => {
  const { parent, child } = fixture()
  const other = file('app-parent', [row('other', 'app-parent', 1000, null)])
  const records: AppSessionRecord[] = [
    { id: 'local_parent', transcriptIds: ['parent'], detached: false },
    { id: 'local_other', transcriptIds: ['app-parent'], parentId: 'local_parent', detached: false },
    { id: 'local_child', transcriptIds: ['child'], parentId: 'local_other', detached: false },
  ]
  const graph = buildGraph([parent, child, other], 'child', 'dark', 1, undefined, records, { cliForkOrigins: true })
  expect(graph.cards.find(card => card.sessionId === 'local_child')?.parentSessionId).toBe('local_other')
})

test('the newest fork marker resolves a rewritten multi-generation chain', () => {
  const { parent, child, childRows } = fixture()
  const grandchild = file('grandchild', [
    ...childRows.map(value => ({ ...value, sessionId: 'grandchild' })),
    marker('grandchild-marker', 'grandchild', 10000, 7000, 'fork-marker'),
  ])
  const graph = buildGraph([grandchild, child, parent], 'grandchild', 'dark', 1, undefined, [], { cliForkOrigins: true })
  expect(graph.cards).toHaveLength(3)
  expect(graph.cards.find(card => card.sessionId === 'child')?.parentSessionId).toBe('parent')
  expect(graph.cards.find(card => card.sessionId === 'grandchild')?.parentSessionId).toBe('child')
})

test('ambiguous source copies are not chosen by message counts', () => {
  const { parent, child, copied } = fixture()
  const duplicate = file('duplicate', [
    ...copied.map(value => ({ ...value, sessionId: 'duplicate' })),
    row('duplicate-only-1', 'duplicate', 8000, 'boundary'),
    row('duplicate-only-2', 'duplicate', 9000, 'duplicate-only-1'),
  ])
  const graph = buildGraph([parent, child, duplicate], 'child', 'dark', 1, undefined, [], { cliForkOrigins: true })
  expect(graph.cards).toHaveLength(1)
  expect(graph.cards[0]?.parentSessionId).toBeNull()
})

test('ordinary prompts, malformed cutoffs and missing anchors cannot invent a fork', () => {
  const { notification, copied } = fixture()
  const variants = [
    { ...notification, origin: { kind: 'composer' } },
    { ...notification, promptSource: 'user' },
    { ...notification, timestamp: iso(5000) },
    { ...notification, parentUuid: null },
    { ...notification, message: { content: notification.message.content.replace(iso(6000), 'invalid-time') } },
  ]
  for (const value of variants) {
    const parsed = parseTranscript([...copied, value].map(row => JSON.stringify(row)).join('\n'), 'child')
    expect(parsed.forkOrigins).toHaveLength(0)
  }
})

test('a fork whose source transcript is unavailable remains an independent root', () => {
  const { child } = fixture()
  const graph = buildGraph([child], 'child', 'dark', 1, undefined, [], { cliForkOrigins: true })
  expect(graph.cards).toHaveLength(1)
  expect(graph.cards[0]?.parentSessionId).toBeNull()
})
