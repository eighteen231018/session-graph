import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'
import type { BranchCard, GraphSnapshot } from '../types'

const ROOT = 'local_root'
const BRANCH = 'local_branch'
const LIVE = '22222222-2222-2222-2222-222222222222'
const LINK = 'claude://claude.ai/epitaxy/local_branch'

function snapshotFixture(): GraphSnapshot {
  const card = (id: string, isCurrent: boolean): BranchCard => ({
    sessionId: id,
    cliSessionId: isCurrent ? '11111111-1111-1111-1111-111111111111' : LIVE,
    title: isCurrent ? 'Root' : 'Branch',
    matchTitle: isCurrent ? 'Root' : 'Branch',
    firstUserMessage: isCurrent ? 'root prompt' : 'fork prompt',
    parentSessionId: isCurrent ? null : ROOT,
    forkAtPreview: isCurrent ? null : 'root prompt',
    ownMessageCount: 2,
    messageCount: 4,
    lastTimestamp: isCurrent ? 1 : 2,
    isCurrent,
    color: 0,
    depth: isCurrent ? 0 : 1,
  })
  return {
    cards: [card(ROOT, true), card(BRANCH, false)],
    nodes: [],
    sessions: [{ id: ROOT, branchName: 'Root', color: 0, isCurrent: true, messageCount: 2, lastTimestamp: 1 }],
    source: 'transcript', scannedAt: 1, theme: 'dark', hiddenNodeCount: 0,
  }
}

function setup(on: On, surface: RenderSurface, options: {
  snapshot?: GraphSnapshot
  manager?: 'mcp' | 'tool' | 'missing'
  clipboard?: 'copied' | 'unavailable' | 'denied'
  confirmation?: '取消' | '删除'
  placed?: boolean
  placementReason?: string
  surfaces?: readonly RenderSurface[]
} = {}) {
  const snapshot = options.snapshot ?? snapshotFixture()
  mock.env(on, {})
  const calls = {
    copies: [] as { text: string; surface?: RenderSurface }[],
    toasts: [] as string[],
    logs: [] as { text: string; to: string }[],
    mcp: [] as string[],
    tools: [] as string[],
    processes: [] as readonly string[][],
    invalidations: 0,
    frames: 0,
    html: '',
    opens: [] as { id: string; title?: string; focus?: true; rows?: number }[],
  }
  const rows = options.manager === 'missing' ? [] : [{
    sessionId: BRANCH, title: 'Branch', cwd: '/fake/project', link: LINK,
  }]
  on('state.get', { plugin: 'session-graph', key: 'snapshot' }, () => ({ value: { value: snapshot, version: 1 } }))
  on('session.surfaces', () => ({ value: options.surfaces ?? [surface] }))
  on('session.cwd', () => ({ value: '/fake/project' }))
  on('session.id', () => ({ value: '11111111-1111-1111-1111-111111111111' }))
  on('session.messages', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', (_$, e) => { calls.html = e.text; return { value: undefined } })
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', (_$, e) => {
    calls.opens.push(e)
    return { value: options.placed === false
      ? { isPlaced: false as const, reason: options.placementReason ?? 'no-surface' }
      : { isPlaced: true as const } }
  })
  on('ui.log', (_$, e) => { calls.logs.push(e); return { value: undefined } })
  on('ui.toast', (_$, e) => { calls.toasts.push(e.text); return { value: undefined } })
  on('ui.copy', (_$, e) => {
    calls.copies.push(e)
    if (options.clipboard === 'denied') return { deny: 'clipboard unavailable' }
    return { value: options.clipboard === 'unavailable'
      ? { isCopied: false as const, reason: 'no-clipboard' as const }
      : { isCopied: true as const } }
  })
  on('mcp.call', (_$, e) => {
    calls.mcp.push(e.tool)
    return { value: options.manager === 'tool'
      ? { isError: true, content: [] }
      : { isError: false, content: [{ type: 'text', text: JSON.stringify(rows) }] } }
  })
  on('tool.call', (_$, e) => {
    calls.tools.push(e.tool)
    if (e.tool === 'AskUserQuestion') {
      const question = e.questions[0]?.question ?? ''
      return { result: { questions: e.questions, answers: { [question]: options.confirmation ?? '取消' } } }
    }
    if (e.tool === 'mcp__ccd_session_mgmt__delete_session') return { result: { deleted: 1 } }
    return { result: { content: [{ type: 'text', text: JSON.stringify(rows) }] } }
  })
  on('process.run', (_$, e) => {
    calls.processes = [...calls.processes, [...e.argv]]
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('clock.every', { ms: 160 }, (_$, e, next) => { calls.frames += 1; return next(e) })
  on('ui.invalidate', (_$, e, next) => { calls.invalidations += 1; return next(e) })
  const clock = mock.clock(on)
  return { calls, clock }
}

function mount<P extends RenderSurface>($: Engine, surface: P, columns = 100): Promise<Mounted<P, 'Pane'>> {
  return $.ui.mount({
    plugin: 'session-graph', surface, component: 'Pane', requestId: 'session-graph',
    props: {
      title: '会话分支图谱', isFocused: true, bodyColumns: columns, placement: 'inline',
      scroll: { offset: 0, bodyRows: 38 }, view: {},
    },
    viewport: { columns, rows: 40, isFullscreen: false },
  })
}

test('terminal mounts the full card tree without delete controls, animation or transcript logs', async ($, on) => {
  const { calls, clock } = setup(on, 'terminal')
  const ui = await mount($, 'terminal')
  expect(await ui.find({ key: `${ROOT}:title` })).toBeDefined()
  expect(await ui.find({ key: `${BRANCH}:open` })).toBeDefined()
  expect((await ui.findAll({ type: 'Button' })).some(button => button.key?.endsWith(':delete'))).toBe(false)
  expect((await ui.find({ key: 'refresh' }))?.props.hotkey).toBe('r')
  expect((await ui.find({ key: 'export' }))?.props.hotkey).toBe('e')
  expect((await ui.find({ key: 'copy' }))?.props.hotkey).toBe('c')
  expect((await ui.find({ key: 'locate-current' }))?.props.hotkey).toBe('g')
  expect(await ui.find({ type: 'Text', text: '当前：Root' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Tab/Shift+Tab' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '│' }), 'terminal connector glyph').toBeDefined()
  await clock.advance(480)
  expect(calls.frames).toBe(0)
  expect(calls.invalidations).toBe(0)
  expect(calls.logs.length).toBe(1)
  expect(calls.logs.every(log => log.to === 'debug')).toBe(true)
  await ui.unmount()
})

for (const key of ['title', 'body', 'open']) {
  test(`terminal ${key} copies the live resume command without Desktop calls`, async ($, on) => {
    const { calls } = setup(on, 'terminal')
    const ui = await mount($, 'terminal')
    await ui.press({ key: `${BRANCH}:${key}` })
    expect(calls.copies).toEqual([{ text: `claude --resume ${LIVE}`, surface: 'terminal' }])
    expect(calls.toasts).toContain(`已复制：claude --resume ${LIVE}`)
    expect(calls.mcp).toHaveLength(0)
    expect(calls.tools).toHaveLength(0)
    expect(calls.processes).toHaveLength(0)
  })
}

for (const clipboard of ['unavailable', 'denied'] as const) {
  test(`terminal shows the full resume command when clipboard is ${clipboard}`, async ($, on) => {
    const { calls } = setup(on, 'terminal', { clipboard })
    const ui = await mount($, 'terminal')
    await ui.press({ key: `${BRANCH}:title` })
    expect(calls.toasts).toContain(`请在终端运行：claude --resume ${LIVE}`)
    expect(calls.processes).toHaveLength(0)
  })
}

test('terminal current card does not copy a resume command', async ($, on) => {
  const { calls } = setup(on, 'terminal')
  const ui = await mount($, 'terminal')
  await ui.press({ key: `${ROOT}:title` })
  expect(calls.toasts).toContain('这是当前会话')
  expect(calls.copies).toHaveLength(0)
})

test('terminal copy debounce prevents repeated activations', async ($, on) => {
  const { calls } = setup(on, 'terminal')
  const ui = await mount($, 'terminal')
  await ui.press({ key: `${BRANCH}:title` })
  await ui.press({ key: `${BRANCH}:body` })
  expect(calls.copies).toHaveLength(1)
})

test('terminal mounts a narrow card tree and exports CLI instructions', async ($, on) => {
  const { calls } = setup(on, 'terminal')
  const ui = await mount($, 'terminal', 40)
  expect(await ui.find({ key: `${BRANCH}:title` })).toBeDefined()
  await ui.press({ key: 'export' })
  expect(calls.html).toContain(`claude --resume ${LIVE}`)
  expect(calls.html).toContain('同一项目目录')
  expect(calls.logs.every(log => log.to === 'debug')).toBe(true)
})

test('desktop retains delete controls, default shortcuts, transcript logs and 160ms animation', async ($, on) => {
  const { calls, clock } = setup(on, 'desktop')
  const ui = await mount($, 'desktop')
  expect(await ui.find({ key: `${ROOT}:delete` })).toBeDefined()
  expect(await ui.find({ key: `${BRANCH}:delete` })).toBeDefined()
  expect(await ui.find({ key: `${BRANCH}:open` })).toBeDefined()
  expect((await ui.find({ key: 'refresh' }))?.props.hotkey).toBeUndefined()
  expect((await ui.find({ key: 'export' }))?.props.hotkey).toBeUndefined()
  expect((await ui.find({ key: 'copy' }))?.props.hotkey).toBeUndefined()
  expect(await ui.find({ key: 'locate-current' })).toBeUndefined()
  expect(await ui.find({ key: 'current-session' })).toBeUndefined()
  expect(calls.logs[0]?.to).toBe('transcript')
  await clock.advance(160)
  expect(calls.frames > 0, 'desktop schedules line frames').toBe(true)
  expect(calls.invalidations > 0, 'desktop invalidates the pane').toBe(true)
})

for (const manager of ['mcp', 'tool'] as const) {
  test(`desktop opens a card through its ${manager} session manager and deep link`, async ($, on) => {
    const { calls } = setup(on, 'desktop', { manager })
    const ui = await mount($, 'desktop')
    await ui.press({ key: `${BRANCH}:title` })
    expect(calls.mcp).toContain('list_sessions')
    expect(calls.processes).toEqual([['open', LINK]])
    expect(calls.copies).toHaveLength(0)
    if (manager === 'tool') expect(calls.tools).toContain('mcp__ccd_session_mgmt__list_sessions')
  })
}

test('desktop missing link still falls back to copying the App session id', async ($, on) => {
  const { calls } = setup(on, 'desktop', { manager: 'missing' })
  const ui = await mount($, 'desktop')
  await ui.press({ key: `${BRANCH}:title` })
  expect(calls.copies[0]?.text).toBe(BRANCH)
  expect(calls.processes).toHaveLength(0)
  expect(calls.toasts).toContain('未能定位会话链接，已复制会话 ID')
  expect(calls.toasts.some(text => text.includes('已打开'))).toBe(false)
})

test('desktop deletion still asks for confirmation and uses the session manager', async ($, on) => {
  const { calls, clock } = setup(on, 'desktop', { confirmation: '删除' })
  const ui = await mount($, 'desktop')
  await ui.press({ key: `${BRANCH}:delete` })
  await clock.advance(1)
  expect(calls.tools).toContain('AskUserQuestion')
  expect(calls.tools).toContain('mcp__ccd_session_mgmt__delete_session')
  expect(calls.toasts).toContain('已删除「Branch」')
})

test('desktop cancellation and current-session protection never delete', async ($, on) => {
  const { calls, clock } = setup(on, 'desktop', { confirmation: '取消' })
  const ui = await mount($, 'desktop')
  await ui.press({ key: `${ROOT}:delete` })
  await clock.advance(1)
  expect(calls.toasts).toContain('不能删除当前正在运行的会话')
  await ui.press({ key: `${BRANCH}:delete` })
  await clock.advance(1)
  expect(calls.tools).toEqual(['AskUserQuestion'])
})

test('desktop parent protection still refuses deletion before confirmation', async ($, on) => {
  const snapshot = snapshotFixture()
  snapshot.cards[0]!.isCurrent = false
  snapshot.cards[1]!.isCurrent = true
  const { calls, clock } = setup(on, 'desktop', { snapshot })
  const ui = await mount($, 'desktop')
  await ui.press({ key: `${ROOT}:delete` })
  await clock.advance(1)
  expect(calls.toasts.some(text => text.includes('请先删除子分支'))).toBe(true)
  expect(calls.tools).toHaveLength(0)
})

test('desktop still opens automatically at startup and on every attach', async ($, on) => {
  const { calls, clock } = setup(on, 'desktop')
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  await $.session.start({ cwd: '/fake/project', surface: 'desktop', isInteractive: true })
  await clock.advance(800)
  expect(calls.opens).toHaveLength(1)
  expect(calls.opens[0]?.title).toBe('分支树 · Root')
  for (const clientId of ['resume', 'switch']) {
    await $.session.attach({ surface: 'desktop', clientId })
    await clock.advance(250)
  }
  expect(calls.opens).toHaveLength(3)
})

test('terminal startup does not automatically open a pane', async ($, on) => {
  const { calls, clock } = setup(on, 'terminal')
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/fake/project', surface: 'terminal', isInteractive: true })
  await clock.advance(1700)
  expect(calls.opens).toHaveLength(0)
  expect(calls.mcp).toHaveLength(0)
  expect(calls.tools).toHaveLength(0)
})

test('the focus command still requests pane focus', async ($, on) => {
  const { calls } = setup(on, 'terminal')
  await $.command.run({ command: 'session-graph', args: 'focus', origin: { kind: 'composer' }, presentation: { columns: 100, isFullscreen: false } })
  expect(calls.opens[0]?.focus).toBe(true)
})

test('the export command chooses CLI instructions from the attached surface', async ($, on) => {
  const { calls } = setup(on, 'terminal')
  await $.command.run({ command: 'session-graph', args: 'export', origin: { kind: 'composer' }, presentation: { columns: 100, isFullscreen: false } })
  expect(calls.html).toContain('claude --resume')
  expect(calls.logs.every(log => log.to === 'debug')).toBe(true)
})

for (const placementReason of ['no-surface', 'no-surface: no surface is attached ($.session.surfaces() is empty)']) {
  test(`headless placement explains a missing surface: ${placementReason}`, async ($, on) => {
    setup(on, 'terminal', { placed: false, placementReason })
    const result = await $.command.run({ command: 'session-graph', args: '', origin: { kind: 'sdk' }, presentation: { columns: 80, isFullscreen: false } })
    expect(result.text).toContain('当前运行没有可绘制界面')
  })
}

test('terminal title previews apply to card labels, current indicator and HTML only', async ($, on) => {
  const snapshot = snapshotFixture()
  snapshot.cards[0]!.title = '会话 root'
  snapshot.cards[0]!.matchTitle = ''
  snapshot.cards[1]!.title = '会话 branch'
  snapshot.cards[1]!.matchTitle = ''
  const { calls } = setup(on, 'terminal', { snapshot, surfaces: ['desktop', 'terminal'] })
  const terminal = await mount($, 'terminal')
  expect(await terminal.find({ type: 'Text', text: '当前：root prompt · root' })).toBeDefined()
  expect((await terminal.find({ key: `${BRANCH}:title` }))?.text).toContain('fork prompt')
  await terminal.press({ key: 'export' })
  expect(calls.html).toContain('fork prompt · branch')
  expect(snapshot.cards[0]?.title).toBe('会话 root')
  const desktop = await mount($, 'desktop')
  expect((await desktop.find({ key: `${BRANCH}:title` }))?.text).toBe('会话 branch')
  await desktop.press({ key: 'export' })
  expect(calls.html).toContain('<h2>会话 branch</h2>')
  expect(calls.html).not.toContain('fork prompt · branch')
})

test('terminal names the current card above a long branch tree', async ($, on) => {
  const snapshot = snapshotFixture()
  snapshot.cards[0]!.isCurrent = false
  snapshot.cards[1]!.isCurrent = false
  const template = snapshot.cards[1]!
  for (let index = 0; index < 5; index += 1) {
    snapshot.cards.push({ ...template, sessionId: `deep-${index}`, parentSessionId: index === 0 ? BRANCH : `deep-${index - 1}`, isCurrent: index === 4 })
  }
  setup(on, 'terminal', { snapshot })
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: '当前：Branch' })).toBeDefined()
  expect((await ui.find({ key: 'locate-current' }))?.props.hotkey).toBe('g')
  expect(await ui.find({ key: 'deep-4:title' })).toBeDefined()
})

test('a wide branch family stacks inside a narrow terminal while Desktop keeps its layout', async ($, on) => {
  const snapshot = snapshotFixture()
  for (let index = 0; index < 5; index += 1) {
    snapshot.cards.push({ ...snapshot.cards[1]!, sessionId: `sibling-${index}`, title: `Sibling ${index}` })
  }
  setup(on, 'terminal', { snapshot, surfaces: ['terminal', 'desktop'] })
  const terminal = await mount($, 'terminal', 40)
  expect(await terminal.find({ type: 'Text', text: '分支已纵向排列' })).toBeDefined()
  for (const card of snapshot.cards) {
    expect(await terminal.find({ key: `${card.sessionId}:title` })).toBeDefined()
  }
  const desktop = await mount($, 'desktop', 40)
  expect(await desktop.find({ type: 'Text', text: '分支已纵向排列' })).toBeUndefined()
  expect(await desktop.find({ type: 'Text', text: '│' })).toBeDefined()
  expect(await desktop.find({ key: `${BRANCH}:delete` })).toBeDefined()
})

test('alternating CLI and Desktop renders do not repeat Desktop transcript logs', async ($, on) => {
  const { calls, clock } = setup(on, 'desktop', { surfaces: ['desktop', 'terminal'] })
  const desktop = await mount($, 'desktop')
  const terminal = await mount($, 'terminal')
  for (let index = 0; index < 3; index += 1) {
    await desktop.redraw()
    await terminal.redraw()
  }
  await clock.advance(480)
  expect(calls.logs.filter(log => log.to === 'transcript')).toHaveLength(1)
  expect(calls.logs.filter(log => log.to === 'debug')).toHaveLength(1)
  await terminal.press({ key: `${BRANCH}:title` })
  expect(calls.copies[0]?.text).toBe(`claude --resume ${LIVE}`)
  expect(calls.mcp).toHaveLength(0)
  await desktop.press({ key: `${BRANCH}:title` })
  expect(calls.processes).toEqual([['open', LINK]])
})

test('opening a terminal pane requests useful height and keyboard focus by default', async ($, on) => {
  const { calls } = setup(on, 'terminal')
  await $.command.run({ command: 'session-graph', args: '', origin: { kind: 'composer' }, presentation: { columns: 80, isFullscreen: false } })
  expect(calls.opens[0]?.rows).toBe(24)
  expect(calls.opens[0]?.focus).toBe(true)
})

for (const surfaces of [['desktop'], ['desktop', 'terminal']] as const) {
  test(`default Desktop pane sizing and focus survive ${surfaces.join('+')} attachment`, async ($, on) => {
    const { calls } = setup(on, 'desktop', { surfaces })
    await $.command.run({ command: 'session-graph', args: '', origin: { kind: 'composer' }, presentation: { columns: 80, isFullscreen: false } })
    expect(calls.opens[0]?.rows).toBeUndefined()
    expect(calls.opens[0]?.focus).toBeUndefined()
  })
}
