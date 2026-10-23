import { expect, test } from 'claude-code/testing'
import { buildGraph, type SessionFile } from '../lib/graph'
import type { AppSessionRecord } from '../lib/app-store'
import type { ParsedMessage } from '../lib/parse'
import { resumeCommand } from '../lib/session-link'
import { isTerminalSurface } from '../lib/surface'

function messages(owner: string, count: number, start = 0): ParsedMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    uuid: `${owner}:${start + index}`,
    parentUuid: start + index === 0 ? null : `${owner}:${start + index - 1}`,
    timestamp: start + index + 1,
    role: 'user',
    preview: `You: ${owner} ${start + index}`,
    sessionId: owner,
    isSidechain: false,
  }))
}

function file(id: string, rows: ParsedMessage[]): SessionFile {
  return { id, path: `/tmp/${id}.jsonl`, mtimeMs: 1, createdAt: 0, messages: rows }
}

test('surface detection changes only terminal behavior', () => {
  expect(isTerminalSurface('terminal')).toBe(true)
  for (const surface of ['desktop', 'mobile', 'vscode', undefined, 'future-surface']) {
    expect(isTerminalSurface(surface)).toBe(false)
  }
})

test('resume commands accept transcript ids, app prefixes and empty ids', () => {
  const id = '3cda145c-1111-2222-3333-444455556666'
  expect(resumeCommand(id)).toBe(`claude --resume ${id}`)
  expect(resumeCommand(`local_${id}`)).toBe(`claude --resume ${id}`)
  expect(resumeCommand('')).toBe('')
  expect(resumeCommand('local_')).toBe('')
})

test('resume commands quote unexpected filename characters', () => {
  expect(resumeCommand('id; echo bad')).toBe("claude --resume 'id; echo bad'")
  expect(resumeCommand("id'quoted")).toBe("claude --resume 'id'\\''quoted'")
})

test('CLI provenance joins a fork after both histories grow without creation times', () => {
  const parent = messages('parent', 125)
  const child = [...parent.slice(0, 77), ...messages('child', 12, 77)]
  const snapshot = buildGraph([file('parent', parent), file('child', child)], 'child', 'dark', 1)

  expect(snapshot.cards).toHaveLength(2)
  expect(snapshot.cards.find(card => card.sessionId === 'parent')?.parentSessionId).toBeNull()
  const branch = snapshot.cards.find(card => card.sessionId === 'child')
  expect(branch?.parentSessionId).toBe('parent')
  expect(branch?.ownMessageCount).toBe(12)
  expect(branch?.cliSessionId).toBe('child')
  expect(snapshot.nodes.some(node => node.nodeId.startsWith('fork:session:child:'))).toBe(true)
})

test('five complete CLI copies remain children of the longer original in any scan order', () => {
  const parent = file('parent', messages('parent', 829))
  const copies = Array.from({ length: 5 }, (_, index) => file(`copy-${index}`, parent.messages.slice(0, 523)))
  for (const files of [[parent, ...copies], [...copies].reverse().concat(parent)]) {
    const snapshot = buildGraph(files, 'parent', 'dark', 1)
    expect(snapshot.cards).toHaveLength(6)
    expect(snapshot.cards.find(card => card.sessionId === 'parent')?.parentSessionId).toBeNull()
    for (const copy of copies) {
      expect(snapshot.cards.find(card => card.sessionId === copy.id)?.parentSessionId).toBe('parent')
    }
  }
})

test('interleaved foreign messages do not provide provenance direction', () => {
  const parent = messages('parent', 5)
  const child = [parent[0]!, ...messages('child', 1, 1), parent[2]!]
  const snapshot = buildGraph([file('parent', parent), file('child', child)], 'child', 'dark', 1)
  expect(snapshot.cards).toHaveLength(1)
  expect(snapshot.cards[0]?.parentSessionId).toBeNull()
})

test('equal or missing timestamps use transcript order for provenance', () => {
  for (const timestamp of [0, 1]) {
    const parent = messages('z-parent', 4).map(row => ({ ...row, timestamp }))
    const own = messages('a-child', 1).map(row => ({ ...row, timestamp }))
    const copied = file('a-child', [...parent.slice(0, 2), ...own])
    const snapshot = buildGraph([file('z-parent', parent), copied], 'a-child', 'dark', 1)
    expect(snapshot.cards.find(card => card.sessionId === 'a-child')?.parentSessionId).toBe('z-parent')

    const interleaved = file('a-child', [parent[0]!, ...own, parent[1]!])
    const unknown = buildGraph([file('z-parent', parent), interleaved], 'a-child', 'dark', 1)
    expect(unknown.cards[0]?.parentSessionId).toBeNull()
    expect(unknown.cards).toHaveLength(1)
  }
})

test('App parent links override conflicting provenance and use the live CLI id', () => {
  const a = messages('a', 5)
  const files = [file('a', a), file('b', messages('b', 2)), file('child', a.slice(0, 3))]
  const records: AppSessionRecord[] = [
    { id: 'local_a', transcriptIds: ['a'], detached: false },
    { id: 'local_b', transcriptIds: ['b'], detached: false, parentId: 'local_a' },
    { id: 'local_child', transcriptIds: ['child', 'live'], cliSessionId: 'live', detached: false, parentId: 'local_b' },
  ]
  const snapshot = buildGraph(files, 'child', 'dark', 1, undefined, records)
  expect(snapshot.cards.find(card => card.sessionId === 'local_child')?.parentSessionId).toBe('local_b')
  expect(snapshot.cards.find(card => card.sessionId === 'local_child')?.cliSessionId).toBe('live')
})

test('detached and missing App parents are not replaced by provenance', () => {
  const parent = file('parent', messages('parent', 5))
  const child = file('child', parent.messages.slice(0, 3))
  for (const detached of [false, true]) {
    const records: AppSessionRecord[] = [{
      id: 'local_child', transcriptIds: ['child'], detached, parentId: 'local_missing',
    }]
    const snapshot = buildGraph([parent, child], 'child', 'dark', 1, undefined, records)
    expect(snapshot.cards.find(card => card.sessionId === 'local_child')?.parentSessionId).toBeNull()
  }
})

test('known App descendants cannot become ancestors through provenance', () => {
  const shared = messages('grandchild', 3)
  const files = [file('root', shared), file('child', shared), file('grandchild', shared)]
  const records: AppSessionRecord[] = [
    { id: 'local_root', transcriptIds: ['root'], detached: false },
    { id: 'local_child', transcriptIds: ['child'], detached: false, parentId: 'local_root' },
    { id: 'local_grandchild', transcriptIds: ['grandchild'], detached: false, parentId: 'local_child' },
  ]
  const snapshot = buildGraph(files, 'root', 'dark', 1, undefined, records)
  expect(snapshot.cards).toHaveLength(3)
  expect(snapshot.cards.find(card => card.sessionId === 'local_root')?.parentSessionId).toBeNull()
  expect(snapshot.cards.find(card => card.sessionId === 'local_child')?.parentSessionId).toBe('local_root')
  expect(snapshot.cards.find(card => card.sessionId === 'local_grandchild')?.parentSessionId).toBe('local_child')
})

test('a missing copied source is skipped in favor of the next known prefix source', () => {
  const parent = file('parent', messages('parent', 2, 10))
  const child = file('child', [...messages('missing', 5), ...parent.messages, ...messages('child', 2, 20)])
  const snapshot = buildGraph([parent, child], 'child', 'dark', 1)
  expect(snapshot.cards.find(card => card.sessionId === 'child')?.parentSessionId).toBe('parent')
})

test('an earlier own message in a merged App transcript prevents later provenance', () => {
  const parent = file('parent', messages('parent', 5, 5))
  const recent = file('recent', [...parent.messages.slice(0, 2), ...messages('recent', 1, 10)])
  const earlier = file('earlier', messages('earlier', 1))
  const records: AppSessionRecord[] = [{
    id: 'local_merged', transcriptIds: ['earlier', 'recent'], cliSessionId: 'recent', detached: false,
  }]
  const snapshot = buildGraph([parent, recent, earlier], 'recent', 'dark', 1, undefined, records)
  expect(snapshot.cards).toHaveLength(1)
  expect(snapshot.cards[0]?.sessionId).toBe('local_merged')
  expect(snapshot.cards[0]?.parentSessionId).toBeNull()
})

test('unrelated CLI histories stay separate roots', () => {
  const files = [file('a', messages('a', 3)), file('b', messages('b', 5))]
  for (const current of ['a', 'b']) {
    const snapshot = buildGraph(files, current, 'dark', 1)
    expect(snapshot.cards).toHaveLength(1)
    expect(snapshot.cards[0]?.sessionId).toBe(current)
    expect(snapshot.cards[0]?.parentSessionId).toBeNull()
  }
})
