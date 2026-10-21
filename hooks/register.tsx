import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'
import type { BranchCard, GraphSnapshot } from '../types'
import { forgetAppSession } from '../lib/app-store'
import { collectGraph, listSessionIds } from '../lib/collect'
import type { HostDeps } from '../lib/host'
import { layoutCardTree } from '../lib/tree'
import { buildLineGrid, glyphOf } from '../lib/lines'
import { buildConnectorSvg } from '../lib/svg'
import { exportHtml } from '../lib/export'
import { deleteAppSession, openSession } from '../lib/session-link'

const PANE = 'session-graph'

/**
 * The host, as closures bound here. `$` is followed by the plugin validator
 * only inside a function declared in this module, so the library receives
 * these plain functions and never `$` itself. Env names stay literals here so
 * the host can list what the plugin reads.
 */
async function depsOf($: EngineInterface): Promise<HostDeps> {
  return {
    env: {
      home: await $.env.get('HOME'),
      userProfile: await $.env.get('USERPROFILE'),
      appData: await $.env.get('APPDATA'),
      localAppData: await $.env.get('LOCALAPPDATA'),
      xdgConfigHome: await $.env.get('XDG_CONFIG_HOME'),
    },
    sessionId: () => $.session.id(),
    sessionCwd: () => $.session.cwd(),
    sessionMessages: () => $.session.messages(),
    fsExists: path => $.fs.exists(path),
    fsList: path => $.fs.list(path),
    fsRead: path => $.fs.read(path),
    fsWrite: (path, text) => $.fs.write(path, text),
    configList: () => $.config.list(),
    mcpCall: (server, tool, args) => $.mcp.call(server, tool, args),
    toolCall: (args: Parameters<EngineInterface['tool']['call']>[0]) => $.tool.call(args),
    processRun: (argv, init) => $.process.run(argv, init),
  }
}

const EMPTY: GraphSnapshot = {
  nodes: [],
  sessions: [],
  cards: [],
  source: 'transcript',
  scannedAt: 0,
  theme: 'dark',
  hiddenNodeCount: 0,
}

const snapshotAtom = atom({ plugin: 'session-graph', key: 'snapshot' } as const, EMPTY)

let pollTimer: Timer | undefined
let watchTimer: Timer | undefined
let knownIds: string | null = null
let watching = false
let activeScan: Promise<RefreshOutcome> | null = null
let lastScanAt = 0
let lastSignature = ''
let lastRenderContent = ''
let lastRenderViewport = ''
const deletingCards = new Set<string>()
let linePhase = 0
let lineTimer: Timer | undefined
let lastPaneRenderAt = 0

// Theme keys rather than raw hex: every level keeps the person's own contrast
// on both light and dark themes. Listed from level 1 down; deeper levels cycle.
const LEVEL_COLORS = [
  'suggestion',
  'success',
  'warning',
  'permission',
  'merged',
  'planMode',
  'ide',
  'autoAccept',
  'bashBorder',
  'diffAdded',
  'diffRemoved',
  'claude',
] as const
const PULSE_SPAN = 9
const PULSE_WIDTH = 2
const LINE_FRAME_MS = 160

type RefreshOutcome =
  | { status: 'ok'; snapshot: GraphSnapshot }
  | { status: 'skipped' }
  | { status: 'failed'; message: string }

async function refresh($: EngineInterface, force = false): Promise<RefreshOutcome> {
  // A scan already running is fresh enough for every caller; joining it also
  // gives a manual refresh a real success/failure answer instead of "busy".
  if (activeScan !== null) return activeScan
  if (!force && Date.now() - lastScanAt < 1200) return { status: 'skipped' }

  activeScan = scanOnce($)
  try {
    return await activeScan
  } finally {
    activeScan = null
  }
}

async function scanOnce($: EngineInterface): Promise<RefreshOutcome> {
  const now = Date.now()
  try {
    const snapshot = await collectGraph(await depsOf($))
    const signature = signatureOf(snapshot)
    if (signature !== lastSignature) {
      await update($, snapshotAtom, () => snapshot)
      lastSignature = signature
      void retitlePane($, snapshot)
    }
    lastScanAt = now
    return { status: 'ok', snapshot }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    $.ui.log(`session-graph: scan failed: ${message}`, { to: 'debug' })
    try {
      const current = await read($, snapshotAtom)
      await update($, snapshotAtom, () => ({
        ...current,
        notice: `扫描失败：${message}`,
        scannedAt: Date.now(),
      }))
    } catch {
      // The pane keeps its previous drawing.
    }
    return { status: 'failed', message }
  }
}

async function watchSessionSet($: EngineInterface): Promise<void> {
  if (watching) return
  watching = true
  try {
    const ids = await listSessionIds(await depsOf($))
    if (ids === null) return
    const key = [...ids].sort().join('|')
    if (knownIds === null) {
      knownIds = key
      return
    }
    if (key === knownIds) return
    const outcome = await refresh($, true)
    if (outcome.status === 'ok') knownIds = key
  } finally {
    watching = false
  }
}

function startLineAnimation($: EngineInterface): void {
  lastPaneRenderAt = Date.now()
  if (lineTimer !== undefined) return
  lineTimer = $.clock.every(LINE_FRAME_MS, () => {
    // A closed pane stops rendering, so stop invalidating once the last draw
    // is old; opening it again starts a fresh timer.
    if (Date.now() - lastPaneRenderAt > 3000) {
      lineTimer?.cancel()
      lineTimer = undefined
      return
    }
    linePhase = (linePhase + 1) % (PULSE_SPAN * 12)
    $.ui.invalidate('ui.render')
  })
}

function stopLineAnimation(): void {
  lineTimer?.cancel()
  lineTimer = undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'session-graph',
      description: 'Show session branches as clickable cards in a side pane',
      argumentHint: '[open|close|refresh|export|focus]',
    })

    pollTimer?.cancel()
    pollTimer = $.clock.every(5000, () => {
      void refresh($)
    })
    knownIds = null
    watchTimer?.cancel()
    watchTimer = $.clock.every(1000, () => {
      void watchSessionSet($)
    })
    // Establish the baseline before the first full scan, so a deletion during
    // the scan is still detected by the next comparison.
    await watchSessionSet($)
    void refresh($, true)

    // A session opened in the app may start as interactive or be resumed by
    // the desktop client; the surface, not isInteractive, decides whether a
    // pane can be placed.
    scheduleDesktopOpen($)

    return next(e)
  })

  // Clicking a session in the desktop app attaches the desktop client to that
  // session again. Open the pane on every attach, so switching sessions never
  // needs a command.
  on('session.attach', { surface: 'desktop' }, async ($, e, next) => {
    scheduleDesktopOpen($, 250)
    return next(e)
  })

  on('session.end', ($, e, next) => {
    pollTimer?.cancel()
    pollTimer = undefined
    watchTimer?.cancel()
    watchTimer = undefined
    stopLineAnimation()
    knownIds = null
    return next(e)
  })

  on('command.run', { command: 'session-graph' }, async ($, e) => {
    const argument = e.args.trim().toLowerCase()

    if (argument === 'close') {
      await $.ui.close({ id: PANE })
      return { text: '会话分支图谱面板已关闭。' }
    }

    const outcome = await refresh($, true)
    if (argument === 'refresh') toastRefreshOutcome($, outcome)
    const snapshot = outcome.status === 'ok' ? outcome.snapshot : await read($, snapshotAtom)

    if (argument === 'export') {
      const result = await runExport($, snapshot, false)
      return { text: result.text }
    }

    const current = cardsOf(snapshot).find(card => card.isCurrent)
    const opened = await $.ui.open({
      id: PANE,
      title: current === undefined ? '会话分支图谱' : `分支树 · ${current.title}`,
      ...(argument === 'focus' ? { focus: true as const } : {}),
    })
    return {
      text: opened.isPlaced
        ? '会话分支图谱已打开。'
        : `面板暂未显示：${opened.reason}（可在更宽的窗口重试）`,
    }
  })

  on('prompt.submit', async ($, e, next) => {
    const command = e.command?.name
    if (command === 'fork' || command === 'branch' || command === 'clear') {
      $.clock.after(1200, () => {
        void refresh($, true)
      })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    $.clock.after(500, () => {
      void refresh($)
    })
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const snapshot = await read($, snapshotAtom)
    const cards = cardsOf(snapshot)
    const titleById = new Map(cards.map(card => [card.sessionId, card.title]))
    const cardById = new Map(cards.map(card => [card.sessionId, card]))
    const columns = typeof e.props?.bodyColumns === 'number' && e.props.bodyColumns > 0
      ? e.props.bodyColumns
      : (e.viewport?.columns ?? 80)
    const layout = layoutCardTree(cards, columns)
    const treeCards = cards.flatMap(card => {
      const position = layout.positions.get(card.sessionId)
      if (position === undefined) return []
      return [{
        sessionId: card.sessionId,
        title: (card.isCurrent ? '★ ' : '') + card.title,
        meta: cardMeta(card, titleById),
        body: card.firstUserMessage,
        isCurrent: card.isCurrent,
        x: position.x,
        y: position.y,
        width: position.width,
        height: position.height,
      }]
    })
    // Theme keys resolve in the person's current theme on every surface. The
    // desktop app does not expose its theme row through `$.config.list()`, so
    // snapshot.theme falls back to dark there; raw colors would then be wrong
    // on a light theme. `claude` is the theme's orange, `inactive` its border
    // gray (dark gray on light, medium gray on dark), and `text` its
    // foreground (white on dark, near-black on light).
    const accentColor = 'claude'
    const normalColor = 'text'
    const normalBorderColor = 'inactive'
    // Only tree-structure changes get a transcript line: a new branch, a
    // deletion, a rename, the current marker moving. Ordinary message growth
    // inside an existing branch is not a tree change. A redraw caused only by
    // the pane's width — a sidebar resize, a window change — stays in the
    // debug log, and a redraw with neither change writes nothing.
    const contentKey = `${e.surface}|${cards.map(card =>
      `${card.sessionId}:${card.title}:${card.parentSessionId ?? '-'}:${card.isCurrent ? '1' : '0'}`,
    ).join('|')}|${layout.connectors.length}`
    const viewportKey = `${layout.width}x${layout.height}:${columns}`
    if (contentKey !== lastRenderContent) {
      const first = lastRenderContent === ''
      lastRenderContent = contentKey
      lastRenderViewport = viewportKey
      $.ui.log(
        `session-graph: ${first ? '面板已绘制' : '面板已更新'}（${treeCards.length} 个分支 · ${layout.connectors.length} 条连线 · ${layout.width}x${layout.height} 格）`,
      )
    } else if (viewportKey !== lastRenderViewport) {
      lastRenderViewport = viewportKey
      $.ui.log(`session-graph: 视口变化 ${columns} 列 · 树 ${layout.width}x${layout.height} 格`, { to: 'debug' })
    }

    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Svg = 'Svg' in elements ? elements.Svg : undefined
    const connectorOverlay = Svg === undefined || layout.connectors.length === 0 ? null : (
      <Box key="connectors" position="absolute" top={0} left={0} width={layout.width} height={layout.height}>
        <Svg source={buildConnectorSvg(layout)} alt="会话分支连接线" isInteractive />
      </Box>
    )
    const useConnectorSvg = connectorOverlay !== null
    const lineGrid = useConnectorSvg ? undefined : buildLineGrid(layout)
    if (useConnectorSvg) stopLineAnimation()
    else if (layout.connectors.length > 0) startLineAnimation($)
    const byRow = new Map<number, typeof treeCards>()
    for (const card of treeCards) {
      const row = Math.max(0, Math.floor(card.y))
      const list = byRow.get(row)
      if (list === undefined) byRow.set(row, [card])
      else list.push(card)
    }
    const lineColor = (level: number): string =>
      LEVEL_COLORS[(Math.max(1, level) - 1) % LEVEL_COLORS.length]!
    const pulseAt = (flow: number): boolean =>
      ((flow - linePhase) % PULSE_SPAN + PULSE_SPAN) % PULSE_SPAN < PULSE_WIDTH
    const open = (sessionId: string): void => {
      const card = cardById.get(sessionId)
      if (card !== undefined) void openCard($, card)
    }
    const remove = (sessionId: string): void => {
      const card = cardById.get(sessionId)
      if (card !== undefined) {
        $.clock.after(1, () => { void deleteCard($, card) })
      }
    }

    const rows: RenderElement[] = []
    let row = 0
    while (row < layout.height) {
      const rowCards = byRow.get(row)
      if (rowCards !== undefined && rowCards.length > 0) {
        const children: RenderElement[] = []
        let cursor = 0
        for (const card of rowCards) {
          const left = Math.max(0, Math.min(Math.floor(card.x), Math.max(0, layout.width - 1)))
          const width = Math.max(1, Math.min(Math.floor(card.width), layout.width - left))
          if (left > cursor) {
            children.push(<Box key={`space:${row}:${card.sessionId}`} width={left - cursor} />)
          }
          const inner = Math.max(6, width - 4)
          const hasChildren = cards.some(candidate => candidate.parentSessionId === card.sessionId)
          children.push(
            <Box
              key={card.sessionId}
              width={width}
              height={9}
              flexShrink={0}
              paddingX={1}
              borderStyle={card.isCurrent ? 'double' : 'round'}
              borderColor={card.isCurrent ? accentColor : normalBorderColor}
              flexDirection="column"
              overflow="hidden"
            >
              <Button key={`${card.sessionId}:title`} plain onPress={() => open(card.sessionId)}>
                <Text weight="semibold" color={card.isCurrent ? accentColor : normalColor}>
                  {fitText(card.title, inner)}
                </Text>
              </Button>
              <Text color={card.isCurrent ? accentColor : normalColor} dimColor={!card.isCurrent}>
                {fitText(card.meta, inner)}
              </Text>
              <Button key={`${card.sessionId}:body`} plain onPress={() => open(card.sessionId)}>
                <Text color={card.isCurrent ? accentColor : normalColor}>
                  {fitText(card.body, inner * 4)}
                </Text>
              </Button>
              <Box flexDirection="row" gap={1}>
                {card.isCurrent ? (
                  <Text color={accentColor}>当前</Text>
                ) : (
                  <Button key={`${card.sessionId}:open`} plain onPress={() => open(card.sessionId)}>
                    <Text color={normalColor}>打开</Text>
                  </Button>
                )}
                <Button key={`${card.sessionId}:delete`} plain dimColor={card.isCurrent || hasChildren} onPress={() => remove(card.sessionId)}>删除</Button>
              </Box>
            </Box>,
          )
          cursor = left + width
        }
        if (cursor < layout.width) {
          children.push(<Box key={`space:end:${row}`} width={layout.width - cursor} />)
        }
        rows.push(
          <Box key={`row:${row}`} flexDirection="row" width={layout.width} height={9}>{children}</Box>,
        )
        row += 9
        continue
      }

      if (useConnectorSvg) {
        rows.push(<Box key={`gap:${row}`} width={layout.width} height={1} />)
        row += 1
        continue
      }

      const grid = lineGrid!
      const children: RenderElement[] = []
      let cursor = 0
      let x = 0
      const pushSpace = (to: number): void => {
        if (to > cursor) {
          children.push(<Box key={`space:${row}:${cursor}`} width={to - cursor} />)
        }
      }
      while (x < layout.width) {
        const cell = grid.cells.get(`${row}:${x}`)
        if (cell === undefined) {
          x += 1
          continue
        }
        const glyph = glyphOf(cell)
        const pulse = pulseAt(cell.flow)
        let run = ''
        const start = x
        while (x < layout.width) {
          const next = grid.cells.get(`${row}:${x}`)
          if (
            next === undefined ||
            next.level !== cell.level ||
            glyphOf(next) !== glyph ||
            pulseAt(next.flow) !== pulse
          ) break
          run += glyphOf(next)
          x += 1
        }
        pushSpace(start)
        children.push(
          pulse
            ? <Text key={`line:${row}:${start}`} color={normalColor} weight="bold">{run}</Text>
            : <Text key={`line:${row}:${start}`} color={lineColor(cell.level)}>{run}</Text>,
        )
        cursor = x
      }
      pushSpace(layout.width)
      rows.push(
        <Box key={`line-row:${row}`} flexDirection="row" width={layout.width} height={1}>{children}</Box>,
      )
      row += 1
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="view-cards" variant="primary" onPress={() => { void manualRefresh($) }}>卡片</Button>
          <Button key="refresh" onPress={() => { void manualRefresh($) }}>刷新</Button>
          <Button
            key="export"
            onPress={() => {
              void runExport($, snapshot, true)
            }}
          >
            导出 HTML
          </Button>
          <Button
            key="copy"
            onPress={() => {
              void $.ui.copy({ text: currentSessionId(snapshot), surface: e.surface })
            }}
          >
            复制会话 ID
          </Button>
        </Box>

        {snapshot.notice === undefined ? null : <Text dimColor>⚠ {snapshot.notice}</Text>}

        {treeCards.length === 0 ? (
          <Text dimColor>{snapshot.scannedAt === 0 ? '正在扫描会话转录…' : '暂无可显示的会话分支。'}</Text>
        ) : (
          <>
            <Box flexDirection="column" width={layout.width} height={layout.height}>
              {connectorOverlay}
              {rows}
            </Box>
            <Text dimColor>{summaryLine(snapshot)} · 点击卡片标题或正文进入会话；删除按钮在卡片底部</Text>
          </>
        )}
      </Box>
    )
  })
}

function toastRefreshOutcome($: EngineInterface, outcome: RefreshOutcome): void {
  switch (outcome.status) {
    case 'ok':
      $.ui.toast(`刷新完成：${summaryLine(outcome.snapshot)}`)
      return
    case 'failed':
      $.ui.toast(`刷新失败：${truncate(outcome.message, 120)}`)
      return
    case 'skipped':
      $.ui.toast('刚刚已刷新，请稍后再试')
      return
  }
}

async function manualRefresh($: EngineInterface): Promise<void> {
  toastRefreshOutcome($, await refresh($, true))
}

function scheduleDesktopOpen($: EngineInterface, delayMs = 800): void {
  $.clock.after(delayMs, () => {
    void openOnDesktop($)
  })
}

async function openOnDesktop($: EngineInterface, attempt = 0): Promise<void> {
  try {
    const surfaces = await $.session.surfaces()
    if (!surfaces.includes('desktop')) return
  } catch {
    return
  }
  const placed = await openPane($)
  // A session that was just resumed may not draw its pane site yet; one retry
  // covers that without reopening a pane the person deliberately closed later.
  if (!placed && attempt === 0) {
    $.clock.after(900, () => {
      void openOnDesktop($, attempt + 1)
    })
  }
}

async function openPane($: EngineInterface): Promise<boolean> {
  try {
    const panes = await $.ui.panes()
    if (panes.some(pane => pane.id === PANE)) return true
  } catch {
    // Cannot list panes; try opening anyway.
  }
  const snapshot = await read($, snapshotAtom)
  const current = cardsOf(snapshot).find(card => card.isCurrent)
  try {
    const opened = await $.ui.open({
      id: PANE,
      title: current === undefined ? '会话分支图谱' : `分支树 · ${current.title}`,
    })
    return opened.isPlaced
  } catch {
    // No surface places panes; the command still opens it later.
    return false
  }
}

async function retitlePane($: EngineInterface, snapshot: GraphSnapshot): Promise<void> {
  const current = cardsOf(snapshot).find(card => card.isCurrent)
  if (current === undefined) return
  try {
    const panes = await $.ui.panes()
    if (!panes.some(pane => pane.id === PANE)) return
    await $.ui.open({ id: PANE, title: `分支树 · ${current.title}` })
  } catch {
    // The pane is gone or the title was refused; keep the old one.
  }
}

async function runExport(
  $: EngineInterface,
  snapshot: GraphSnapshot,
  notify: boolean,
): Promise<{ ok: boolean; text: string }> {
  try {
    const path = await exportHtml(await depsOf($), snapshot)
    $.ui.log(`session-graph: exported ${path}`)
    if (notify) $.ui.toast('已导出静态视图')
    return { ok: true, text: `已导出静态视图：${path}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    $.ui.log(`session-graph: export failed: ${message}`, { to: 'debug' })
    if (notify) $.ui.toast('导出失败')
    return { ok: false, text: `导出失败：${message}` }
  }
}

function fitText(value: string, cells: number): string {
  let used = 0
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    const step = code >= 0x2e80 ? 2 : 1
    if (used + step > cells) return `${out}…`
    out += char
    used += step
  }
  return out
}

function signatureOf(snapshot: GraphSnapshot): string {
  const last = snapshot.nodes[snapshot.nodes.length - 1]
  return [
    snapshot.source,
    snapshot.nodes.length,
    last?.nodeId ?? '',
    last?.timestamp ?? 0,
    snapshot.sessions.map(session => `${session.id}:${session.lastTimestamp}:${session.branchName}`).join(','),
    cardsOf(snapshot).map(card => `${card.sessionId}:${card.title}:${card.ownMessageCount}:${card.lastTimestamp}`).join(','),
    snapshot.hiddenNodeCount,
    snapshot.notice ?? '',
    snapshot.theme,
  ].join('|')
}

let lastOpen: { sessionId: string; at: number } | undefined

async function openCard($: EngineInterface, card: BranchCard): Promise<void> {
  const now = Date.now()
  if (lastOpen !== undefined && lastOpen.sessionId === card.sessionId && now - lastOpen.at < 600) return
  lastOpen = { sessionId: card.sessionId, at: now }

  if (card.isCurrent) {
    $.ui.toast('这是当前会话')
    return
  }

  const result = await openSession(await depsOf($), {
    sessionId: card.sessionId,
    title: card.matchTitle !== '' ? card.matchTitle : card.title,
    isCurrent: card.isCurrent,
  })
  if (result.opened) {
    $.ui.toast(result.reason === 'constructed' ? `已尝试打开「${card.title}」` : `正在打开「${card.title}」`)
    return
  }
  if (result.reason === 'current') {
    $.ui.toast('这是当前会话')
    return
  }

  try {
    await $.ui.copy({ text: card.sessionId })
    $.ui.toast(result.reason === 'no-link' ? '未能定位会话链接，已复制会话 ID' : '打开失败，已复制会话 ID')
  } catch {
    $.ui.toast(`无法打开，会话 ID：${card.sessionId.slice(0, 8)}`)
  }
}

async function deleteCard($: EngineInterface, card: BranchCard): Promise<void> {
  if (card.isCurrent) {
    $.ui.toast('不能删除当前正在运行的会话')
    return
  }

  // A parent cannot be removed while branches still hang from it: the app
  // would leave those children pointing at a missing parent. Ask the person
  // to remove the children first instead of opening the delete dialog.
  let children: BranchCard[] = []
  try {
    const snapshot = await read($, snapshotAtom)
    children = cardsOf(snapshot).filter(candidate => candidate.parentSessionId === card.sessionId)
  } catch {
    children = []
  }
  if (children.length > 0) {
    const names = children.slice(0, 3).map(child => `「${truncate(child.title, 18)}」`).join('、')
    const more = children.length > 3 ? ' 等' : ''
    $.ui.toast(`「${truncate(card.title, 18)}」还有 ${children.length} 个子分支（${names}${more}），无法删除；请先删除子分支`)
    return
  }

  if (deletingCards.has(card.sessionId)) return
  deletingCards.add(card.sessionId)

  try {
    let answer = ''
    try {
      answer = await $.ui.ask(
        `删除会话「${card.title}」？该操作不可恢复；若该会话有 worktree，应用会另行提示。确定继续吗？`,
        ['取消', '删除'],
      )
    } catch {
      return
    }
    if (answer !== '删除') return

    const result = await deleteAppSession(await depsOf($), {
      sessionId: card.sessionId,
      title: card.matchTitle !== '' ? card.matchTitle : card.title,
      isCurrent: false,
    })
    if (!result.ok) {
      // The card may outlive the app session (a transcript whose record is
      // gone). Treat "already gone" as removed instead of leaving a card that
      // errors on every click.
      if (result.reason === 'not-found') {
        hideDeletedCard($, card)
        $.ui.toast(`会话「${card.title}」已不存在，已从树中移除`)
        return
      }
      $.ui.toast(truncate(result.message, 180))
      return
    }

    hideDeletedCard($, card)
    $.ui.toast(`已删除「${card.title}」`)
  } finally {
    deletingCards.delete(card.sessionId)
  }
}

function hideDeletedCard($: EngineInterface, card: BranchCard): void {
  forgetAppSession(card.sessionId)
  knownIds = null
  void refresh($, true)
  $.clock.after(700, () => {
    void refresh($, true)
  })
  $.clock.after(2000, () => {
    void refresh($, true)
  })
}

function cardMeta(card: BranchCard, titles: Map<string, string>): string {
  const time = formatTime(card.lastTimestamp)
  const lead = card.isCurrent ? '当前分支 · ' : ''
  if (card.parentSessionId === null) return `${lead}根会话 · ${time}`
  const parent = titles.get(card.parentSessionId) ?? `会话 ${card.parentSessionId.slice(0, 8)}`
  const fork = card.forkAtPreview === null ? '' : ` · 分叉点：${truncate(card.forkAtPreview, 34)}`
  return `${lead}从「${parent}」分出${fork} · ${time}`
}

function formatTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
  try {
    return new Date(timestamp).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  } catch {
    return '—'
  }
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, Math.max(1, limit - 1))}…` : value
}

function cardsOf(snapshot: GraphSnapshot): BranchCard[] {
  return Array.isArray(snapshot.cards) ? snapshot.cards : []
}

function currentSessionId(snapshot: GraphSnapshot): string {
  return snapshot.sessions.find(session => session.isCurrent)?.id ?? ''
}

function summaryLine(snapshot: GraphSnapshot): string {
  return `${cardsOf(snapshot).length} 个分支`
}
