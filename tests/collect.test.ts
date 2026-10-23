import { expect, test } from 'claude-code/testing'
import type { FsEntry, RenderSurface } from 'claude-code'
import { collectGraph } from '../lib/collect'
import type { HostDeps } from '../lib/host'
import { invalidateSessionListCache } from '../lib/session-link'

function fixture(withAppRecord = false, rewrittenFork = false) {
  invalidateSessionListCache()
  const home = '/Users/me'
  const root = `${home}/.claude/projects`
  const project = `${root}/-fake-project`
  const base = `${home}/Library/Application Support`
  const store = `${base}/Claude-3p/claude-code-sessions`
  const current = rewrittenFork ? 'collect-rewritten' : withAppRecord ? 'collect-app' : 'collect-cli'
  const parent = `${current}-parent`
  const entry = (name: string, kind: FsEntry['kind']): FsEntry => ({ name, kind, size: 100, mtimeMs: 1, isLink: false })
  const baseTime = rewrittenFork ? Date.parse('2026-10-21T04:08:00Z') : 0
  const message = (uuid: string, sessionId: string, timestamp: number) => ({
    type: 'user', uuid, sessionId, timestamp: baseTime + timestamp, parentUuid: null, message: { content: uuid },
  })
  const shared = [message('shared-1', parent, 1), message('shared-2', parent, 2)]
  const listing = new Map<string, FsEntry[]>([
    [root, [entry('-fake-project', 'dir')]],
    [project, [entry(`${current}.jsonl`, 'file'), entry(`${parent}.jsonl`, 'file')]],
    [base, [entry('Claude-3p', 'dir')]],
    [store, withAppRecord ? [entry(`local_${current}.json`, 'file')] : []],
  ])
  const childRows = rewrittenFork ? [
    ...shared.map(row => ({ ...row, sessionId: current })),
    {
      ...message('fork-marker', current, 3), parentUuid: 'shared-2',
      origin: { kind: 'task-notification' }, promptSource: 'system',
      message: { content: `<task-notification><fork-source>This session began as a fork (copy) of another session that is still running. The conversation up to ${new Date(baseTime + 2).toISOString()} is shared history with it.</fork-source></task-notification>` },
    },
  ] : [...shared, message('child-only', current, 3)]
  const files = new Map<string, string>([
    [`${project}/${current}.jsonl`, childRows.map(row => JSON.stringify(row)).join('\n')],
    [`${project}/${parent}.jsonl`, [...shared, message('parent-only', parent, 4)].map(row => JSON.stringify(row)).join('\n')],
    [`${store}/local_${current}.json`, JSON.stringify({
      sessionId: `local_${current}`, cliSessionId: current, priorCliSessionIds: [`${current}-old`],
      title: 'App title', createdAt: 1,
    })],
  ])
  const calls = { manager: [] as string[], tools: 0, surfaces: 0, reads: [] as string[] }
  let surfaces: readonly RenderSurface[] = ['terminal']
  const deps: HostDeps = {
    env: { home, userProfile: undefined, appData: undefined, localAppData: undefined, xdgConfigHome: undefined },
    sessionId: async () => current,
    sessionCwd: async () => '/fake/project',
    surfaces: async () => { calls.surfaces += 1; return surfaces },
    sessionMessages: async () => [],
    fsExists: async path => path === root || path === store,
    fsList: async path => listing.get(path ?? '') ?? [],
    fsRead: async path => {
      calls.reads.push(path)
      const text = files.get(path)
      if (text === undefined) throw new Error(`missing ${path}`)
      return text
    },
    fsWrite: async () => {},
    configList: async () => [],
    mcpCall: async (_server, tool) => {
      calls.manager.push(tool)
      return { isError: false, content: [{ type: 'text', text: JSON.stringify(tool === 'get_session'
        ? { createdAt: '2026-01-01T00:00:00Z' }
        : [{ sessionId: `local_${current}` }, { sessionId: `local_${parent}` }]) }] }
    },
    toolCall: async () => { calls.tools += 1; return { result: {} } },
    processRun: async () => ({ exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }),
  }
  return { deps, current, parent, calls, attach: (value: readonly RenderSurface[]) => { surfaces = value } }
}

test('CLI collection parses provenance and never queries the Desktop manager', async () => {
  const { deps, current, parent, calls } = fixture()
  const snapshot = await collectGraph(deps)
  expect(snapshot.source).toBe('transcript')
  expect(snapshot.cards.find(card => card.sessionId === current)?.parentSessionId).toBe(parent)
  expect(calls.surfaces).toBe(1)
  expect(calls.manager).toHaveLength(0)
  expect(calls.tools).toBe(0)
})

test('CLI collection still reads local App titles and live transcript ids', async () => {
  const { deps, current, calls } = fixture(true)
  const snapshot = await collectGraph(deps)
  const currentCard = snapshot.cards.find(card => card.isCurrent)
  expect(currentCard?.sessionId).toBe(`local_${current}`)
  expect(currentCard?.title).toBe('App title')
  expect(currentCard?.cliSessionId).toBe(current)
  expect(calls.reads.some(path => path.endsWith(`local_${current}.json`))).toBe(true)
  expect(calls.manager).toHaveLength(0)
})

test('a newly attached Desktop restores manager fallback on the next scan', async () => {
  const { deps, calls, attach } = fixture()
  await collectGraph(deps)
  expect(calls.manager).toHaveLength(0)
  attach(['terminal', 'desktop'])
  await collectGraph(deps)
  expect(calls.surfaces).toBe(2)
  expect(calls.manager).toContain('list_sessions')
  expect(calls.manager).toContain('get_session')
  expect(calls.tools).toBe(0)
})

test('a failed surface lookup skips only the remote creation-time fallback', async () => {
  const { deps, current, calls } = fixture()
  const snapshot = await collectGraph({ ...deps, surfaces: async () => { throw new Error('unavailable') } })
  expect(snapshot.cards.some(card => card.sessionId === current)).toBe(true)
  expect(calls.manager).toHaveLength(0)
})

test('CLI collection retains rewritten fork metadata through fresh and cached scans', async () => {
  const { deps, current, parent, calls } = fixture(false, true)
  for (let scan = 0; scan < 2; scan += 1) {
    const snapshot = await collectGraph(deps)
    expect(snapshot.cards).toHaveLength(2)
    expect(snapshot.cards.find(card => card.sessionId === current)?.parentSessionId).toBe(parent)
    expect(snapshot.cards.find(card => card.sessionId === parent)?.parentSessionId).toBeNull()
  }
  expect(calls.manager).toHaveLength(0)
  expect(calls.tools).toBe(0)
})

for (const surfaces of [['desktop'], ['terminal', 'desktop']] as const) {
  test(`CLI-only notification inference leaves the ${surfaces.join('+')} scan path unchanged`, async () => {
    const { deps, current, attach } = fixture(false, true)
    attach(surfaces)
    const snapshot = await collectGraph(deps)
    expect(snapshot.cards).toHaveLength(1)
    expect(snapshot.cards[0]?.sessionId).toBe(current)
    expect(snapshot.cards[0]?.parentSessionId).toBeNull()
  })
}
