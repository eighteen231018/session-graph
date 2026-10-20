import { expect, test } from 'claude-code/testing'
import type { EngineInterface, FsEntry } from 'claude-code'
import {
  forgetAppSession,
  scanAppSessions,
  type AppSessionRecord,
  type AppStoreDeps,
} from '../lib/app-store'
import { exportHtml } from '../lib/export'
import { buildGraph, type SessionFile } from '../lib/graph'
import { mcpResultText, parseJson } from '../lib/mcp-text'
import type { ParsedMessage } from '../lib/parse'
import { listAppSessions, type AppSessionDeps } from '../lib/session-link'

function message(uuid: string, parentUuid: string | null, timestamp: number, role: 'user' | 'assistant', text: string): ParsedMessage {
  return {
    uuid,
    parentUuid,
    timestamp,
    role,
    preview: `${role === 'user' ? 'You' : 'Claude'}: ${text}`,
    sessionId: 'cli',
    isSidechain: false,
  }
}

function transcript(id: string, messages: ParsedMessage[]): SessionFile {
  return {
    id,
    path: `/tmp/${id}.jsonl`,
    mtimeMs: messages.length > 0 ? messages[messages.length - 1]!.timestamp : 0,
    createdAt: messages[0]?.timestamp ?? 0,
    title: id,
    messages,
  }
}

function record(partial: Partial<AppSessionRecord> & Pick<AppSessionRecord, 'id' | 'transcriptIds'>): AppSessionRecord {
  return {
    detached: false,
    ...partial,
  }
}

const rootMessages = [
  message('m1', null, 1, 'user', 'root question'),
  message('m2', 'm1', 2, 'assistant', 'root answer'),
]
const branchMessages = [
  ...rootMessages,
  message('m3', 'm2', 3, 'user', 'first follow-up'),
  message('m4', 'm3', 4, 'assistant', 'first answer'),
  message('m5', 'm4', 5, 'user', 'second follow-up'),
]

test('one rewind creates one card, not one per CLI transcript', () => {
  const files = [
    transcript('root-cli', rootMessages),
    transcript('branch-cli-1', branchMessages.slice(0, 4)),
    transcript('branch-cli-2', branchMessages),
  ]
  const records = [
    record({ id: 'local_root', transcriptIds: ['root-cli'], cliSessionId: 'root-cli', title: 'Root', createdAt: 1 }),
    record({
      id: 'local_branch',
      transcriptIds: ['branch-cli-1', 'branch-cli-2'],
      cliSessionId: 'branch-cli-2',
      title: 'Branch',
      createdAt: 3,
      parentId: 'local_root',
    }),
  ]

  const snapshot = buildGraph(files, 'branch-cli-2', 'dark', 100, undefined, records)

  expect(snapshot.cards).toHaveLength(2)
  const branch = snapshot.cards.find(card => card.sessionId === 'local_branch')
  expect(branch).toBeDefined()
  expect(branch?.parentSessionId).toBe('local_root')
  expect(branch?.isCurrent).toBe(true)
  expect(branch?.title).toBe('Branch')
  expect(branch?.messageCount).toBe(5)
  expect(branch?.ownMessageCount).toBe(3)
  expect(branch?.firstUserMessage).toBe('first follow-up')
  expect(snapshot.cards.find(card => card.sessionId === 'local_root')?.ownMessageCount).toBe(2)
})

test('an app session without a fork link falls back to shared history', () => {
  const files = [
    transcript('root-cli', rootMessages),
    transcript('branch-cli', branchMessages),
  ]
  const records = [
    record({ id: 'local_root', transcriptIds: ['root-cli'], cliSessionId: 'root-cli', title: 'Root', createdAt: 1 }),
    record({ id: 'local_branch', transcriptIds: ['branch-cli'], cliSessionId: 'branch-cli', title: 'Branch', createdAt: 3 }),
  ]

  const snapshot = buildGraph(files, 'branch-cli', 'dark', 100, undefined, records)

  expect(snapshot.cards).toHaveLength(2)
  const branch = snapshot.cards.find(card => card.sessionId === 'local_branch')
  // Without an app fork link, the older transcript that holds the copied
  // history is the parent.
  expect(branch?.parentSessionId).toBe('local_root')
  expect(branch?.ownMessageCount).toBe(3)
})

test('without app records every transcript keeps its own card', () => {
  const files = [
    transcript('root-cli', rootMessages),
    transcript('branch-cli-1', branchMessages.slice(0, 4)),
    transcript('branch-cli-2', branchMessages),
  ]

  const snapshot = buildGraph(files, 'branch-cli-2', 'dark', 100)

  expect(snapshot.cards).toHaveLength(3)
  expect(snapshot.cards.find(card => card.isCurrent)?.sessionId).toBe('branch-cli-2')
})

test('a clear transcript still belongs to the same card', () => {
  const cleared = [
    message('c1', null, 6, 'user', 'after clear'),
    message('c2', 'c1', 7, 'assistant', 'clean answer'),
  ]
  const files = [
    transcript('root-cli', rootMessages),
    transcript('branch-cli', branchMessages),
    transcript('cleared-cli', cleared),
  ]
  const records = [
    record({ id: 'local_root', transcriptIds: ['root-cli'], cliSessionId: 'root-cli', title: 'Root', createdAt: 1 }),
    record({
      id: 'local_branch',
      transcriptIds: ['branch-cli', 'cleared-cli'],
      cliSessionId: 'cleared-cli',
      title: 'Branch',
      createdAt: 3,
      parentId: 'local_root',
    }),
  ]

  const snapshot = buildGraph(files, 'cleared-cli', 'dark', 100, undefined, records)

  expect(snapshot.cards).toHaveLength(2)
  const branch = snapshot.cards.find(card => card.sessionId === 'local_branch')
  expect(branch?.messageCount).toBe(7)
  expect(branch?.ownMessageCount).toBe(5)
  expect(branch?.isCurrent).toBe(true)
})

test('a detached session is a root even with an app parent id', () => {
  const files = [
    transcript('root-cli', rootMessages),
    transcript('branch-cli', branchMessages),
  ]
  const records = [
    record({ id: 'local_root', transcriptIds: ['root-cli'], cliSessionId: 'root-cli', title: 'Root', createdAt: 1 }),
    record({
      id: 'local_branch',
      transcriptIds: ['branch-cli'],
      cliSessionId: 'branch-cli',
      title: 'Branch',
      createdAt: 3,
      parentId: 'local_root',
      detached: true,
    }),
  ]

  const snapshot = buildGraph(files, 'branch-cli', 'dark', 100, undefined, records)

  const branch = snapshot.cards.find(card => card.sessionId === 'local_branch')
  expect(branch?.parentSessionId).toBeNull()
})

function entry(name: string, kind: FsEntry['kind'], mtimeMs = 0): FsEntry {
  return { name, kind, size: 0, mtimeMs, isLink: false }
}

test('the app session record maps every CLI transcript and the fork parent', async () => {
  const base = '/Users/me/Library/Application Support'
  const store = `${base}/Claude-3p/claude-code-sessions`
  const profile = `${store}/profile`
  const org = `${profile}/org`
  const recordPath = `${org}/local_app-session.json`
  const recordJson = JSON.stringify({
    sessionId: 'local_app-session',
    cliSessionId: 'cli-live',
    priorCliSessionIds: ['cli-old'],
    preClearCliSessionId: 'cli-cleared',
    title: 'My branch',
    createdAt: 1000,
    lastActivityAt: 2000,
    forkedFromSessionId: 'local_parent',
  })

  const listing = new Map<string, FsEntry[]>([
    [base, [entry('Claude-3p', 'dir')]],
    [store, [entry('profile', 'dir')]],
    [profile, [entry('org', 'dir')]],
    [org, [entry('local_app-session.json', 'file', 7), entry('deleted_old-cli', 'file', 8)]],
  ])
  const files = new Map<string, string>([[recordPath, recordJson]])

  const fake = {
    env: { get: async (name: string) => (name === 'HOME' ? '/Users/me' : undefined) },
    fs: {
      exists: async (path: string) => path === store,
      list: async (path: string) => listing.get(path) ?? [],
      read: async (path: string) => {
        const text = files.get(path)
        if (text === undefined) throw new Error(`missing ${path}`)
        return text
      },
    },
  } as unknown as AppStoreDeps

  const scan = await scanAppSessions(fake)
  const records = scan.records

  expect(records).toHaveLength(1)
  const found = records[0]
  expect(found?.id).toBe('local_app-session')
  expect(found?.title).toBe('My branch')
  expect(found?.parentId).toBe('local_parent')
  expect(found?.transcriptIds).toContain('cli-live')
  expect(found?.transcriptIds).toContain('cli-old')
  expect(found?.transcriptIds).toContain('cli-cleared')
  expect(found?.transcriptIds).toContain('app-session')
  expect(scan.deletedTranscriptIds.has('old-cli')).toBe(true)

  // Deleting through the pane forgets every transcript of the session even
  // if the app removes the record before writing a tombstone.
  forgetAppSession('local_app-session')
  files.delete(recordPath)
  listing.set(org, [entry('deleted_app-session', 'file', 9)])

  const after = await scanAppSessions(fake)
  expect(after.records).toHaveLength(0)
  for (const id of ['cli-live', 'cli-old', 'cli-cleared', 'app-session']) {
    expect(after.deletedTranscriptIds.has(id)).toBe(true)
  }
})

test('a current transcript outside the scan shows no unrelated branch tree', () => {
  const files = [
    transcript('root-cli', rootMessages),
    transcript('branch-cli', branchMessages),
  ]

  const snapshot = buildGraph(files, 'not-scanned', 'dark', 100)

  expect(snapshot.cards).toHaveLength(0)
})

test('exports are named by the full session id', async () => {
  const snapshot = buildGraph([transcript('root-cli', rootMessages)], 'root-cli', 'dark', 1)
  let writtenPath = ''
  const fake = {
    session: {
      id: async () => 'abcdef12-3456-7890-abcd-ef1234567890',
      cwd: async () => '/tmp/project',
    },
    fs: {
      write: async (path: string) => {
        writtenPath = path
      },
    },
  } as unknown as EngineInterface

  await exportHtml(fake, snapshot)

  expect(writtenPath).toBe('/tmp/project/session-graph-abcdef12-3456-7890-abcd-ef1234567890.html')
})

test('the tool door is tried when the MCP list_sessions answer is an error', async () => {
  let toolCalled = false
  const fake = {
    mcp: {
      call: async () => ({ isError: true, content: [] }),
    },
    tool: {
      call: async () => {
        toolCalled = true
        return { text: JSON.stringify([{ sessionId: 'local_x', title: 'X', cwd: '/p' }]) }
      },
    },
  } as unknown as AppSessionDeps

  const rows = await listAppSessions(fake)

  expect(toolCalled).toBe(true)
  expect(rows?.[0]?.sessionId).toBe('local_x')
})

test('mcp text is read from content, text and nested result shapes', () => {
  const blocks = [{ type: 'text', text: '{"createdAt":"2026-01-01T00:00:00Z"}' }]
  expect(mcpResultText({ content: blocks })).toBe('{"createdAt":"2026-01-01T00:00:00Z"}')
  expect(mcpResultText({ text: 'plain' })).toBe('plain')
  expect(mcpResultText({ result: { content: [{ type: 'text', text: 'nested' }] } })).toBe('nested')
  expect(mcpResultText({ result: 'string-result' })).toBe('string-result')
  expect(mcpResultText(null)).toBe('')
  expect(parseJson('not json')).toBeNull()
})
