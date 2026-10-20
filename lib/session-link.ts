import type { EngineInterface } from 'claude-code'
import { mcpResultText } from './mcp-text'

export type SessionTarget = {
  sessionId: string
  title: string
  isCurrent: boolean
  lastTimestamp?: number
}

export type OpenSessionResult = {
  opened: boolean
  reason: 'current' | 'link' | 'constructed' | 'no-link' | 'open-failed'
}

export type DeleteSessionResult = {
  ok: boolean
  message: string
  /** `not-found`: the app has no session behind this card. */
  reason?: 'not-found' | 'refused' | 'unavailable'
}

export type AppSessionRow = {
  sessionId?: unknown
  title?: unknown
  cwd?: unknown
  link?: unknown
  lastActivityAt?: unknown
}

type ResolvedLink = {
  link: string
  kind: 'link' | 'constructed'
}

let cached: { at: number; rows: AppSessionRow[] } | undefined

/**
 * Best-effort jump: the app's session manager returns a `claude://` link for
 * every local session. Cards carry the app's own session id (`local_...`), so
 * the row is matched exactly; older cards that carry a transcript id still try
 * the local id, then a title + cwd match. When that server is unavailable the
 * only fallback is the CLI-style link, which is not valid for app-created ids.
 */
export async function openSession(
  $: EngineInterface,
  target: SessionTarget,
): Promise<OpenSessionResult> {
  if (target.isCurrent) return { opened: false, reason: 'current' }

  const resolved = await resolveLink($, target)
  if (resolved === null) return { opened: false, reason: 'no-link' }
  if (await openUrl($, resolved.link)) return { opened: true, reason: resolved.kind }
  return { opened: false, reason: 'open-failed' }
}

async function resolveLink($: EngineInterface, target: SessionTarget): Promise<ResolvedLink | null> {
  const cwd = await safeCwd($)
  const rows = await listSessions($)

  if (rows !== null) {
    const match = matchRow(rows, target, cwd)
    const link = typeof match?.link === 'string' ? match.link : null
    if (link !== null && isClaudeLink(link)) return { link, kind: 'link' }
    return null
  }

  // App session ids only have a link that the app itself reports; a bare
  // transcript UUID can still use the CLI-style link.
  if (!target.sessionId.startsWith('local_') && /^[0-9a-f-]{36}$/i.test(target.sessionId)) {
    return { link: `claude://claude.ai/epitaxy/local_${target.sessionId}`, kind: 'constructed' }
  }
  return null
}

function matchRow(
  rows: AppSessionRow[],
  target: SessionTarget,
  cwd: string | null,
): AppSessionRow | undefined {
  const appId = target.sessionId.startsWith('local_') ? target.sessionId : `local_${target.sessionId}`
  const exact = rows.find(row => row.sessionId === appId || row.sessionId === target.sessionId)
  const byId = rows.find(row =>
    typeof row.sessionId === 'string' && row.sessionId.includes(target.sessionId),
  )
  const sameTitle = target.title === ''
    ? []
    : rows.filter(row => row.title === target.title && (cwd === null || row.cwd === cwd))
  const activityDistance = (row: AppSessionRow): number => {
    if (target.lastTimestamp === undefined) return 0
    const activity = typeof row.lastActivityAt === 'string' ? Date.parse(row.lastActivityAt) : Number.NaN
    return Number.isFinite(activity) ? Math.abs(activity - target.lastTimestamp) : Number.POSITIVE_INFINITY
  }
  const byTitle = sameTitle.sort((a, b) => activityDistance(a) - activityDistance(b))[0]
  return exact ?? byId ?? byTitle
}

export async function resolveAppSessionId(
  $: EngineInterface,
  target: SessionTarget,
): Promise<string | null> {
  if (target.sessionId.startsWith('local_')) return target.sessionId
  const rows = await listSessions($)
  if (rows !== null) {
    const appId = `local_${target.sessionId}`
    const exact = rows.find(row => row.sessionId === appId)
    if (exact !== undefined) return appId
    const byId = rows.find(row =>
      typeof row.sessionId === 'string' && row.sessionId.includes(target.sessionId),
    )
    if (byId !== undefined && typeof byId.sessionId === 'string') return byId.sessionId
    return null
  }
  // Desktop-created sessions carry `local_<transcript id>` as their host id,
  // so a transcript id with no session list is the only guess left.
  if (/^[0-9a-f-]{36}$/i.test(target.sessionId)) return `local_${target.sessionId}`
  return null
}

/**
 * Deletes through the app's session manager, not by removing files. That keeps
 * the app's own rules (running/open/pinned sessions are refused, worktrees are
 * reported) and asks the person before anything is removed. When the manager is
 * not reachable, nothing is deleted.
 */
export async function deleteAppSession(
  $: EngineInterface,
  target: SessionTarget,
): Promise<DeleteSessionResult> {
  if (target.isCurrent) return { ok: false, reason: 'refused', message: '不能删除当前正在运行的会话' }

  const appSessionId = await resolveAppSessionId($, target)
  if (appSessionId === null) {
    return {
      ok: false,
      reason: 'not-found',
      message: '应用会话管理器中已没有这个分支，未删除任何文件',
    }
  }

  try {
    const result = await $.tool.call({
      tool: 'mcp__ccd_session_mgmt__delete_session',
      session_ids: [appSessionId],
      reason: 'Deleted from the session-graph pane',
    }) as { text?: unknown; result?: unknown; content?: unknown; isError?: unknown }

    cached = undefined
    const text = mcpResultText(result)
    const nestedError = result.result !== null && typeof result.result === 'object'
      && (result.result as { isError?: unknown }).isError === true
    if (result.isError === true || nestedError) {
      if (/not found|no longer available|does not exist|不存在/i.test(text)) {
        return { ok: false, reason: 'not-found', message: text }
      }
      return { ok: false, reason: 'refused', message: text === '' ? '应用拒绝删除该会话' : text }
    }
    if (/(skipped|refused|not deleted|not found|未删除|跳过|不存在|0 (sessions? )?deleted|no sessions? (were )?deleted)/i.test(text)) {
      const missing = /not found|不存在/i.test(text)
      return { ok: false, ...(missing ? { reason: 'not-found' as const } : { reason: 'refused' as const }), message: text }
    }
    return { ok: true, message: text === '' ? '已删除' : text }
  } catch (error) {
    cached = undefined
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      reason: 'unavailable',
      message: `无法调用应用会话管理器，未删除任何文件：${message}`,
    }
  }
}

export function invalidateSessionListCache(): void {
  cached = undefined
}

export type AppSessionDeps = Pick<EngineInterface, 'mcp' | 'tool'>

export async function listAppSessions(
  $: AppSessionDeps,
  allowToolFallback = true,
): Promise<AppSessionRow[] | null> {
  return listSessions($, allowToolFallback)
}

async function listSessions(
  $: AppSessionDeps,
  allowToolFallback = true,
): Promise<AppSessionRow[] | null> {
  const now = Date.now()
  if (cached !== undefined && now - cached.at < 15000) return cached.rows

  try {
    const result = await $.mcp.call('ccd_session_mgmt', 'list_sessions', { limit: 200 })
    // An error answer still leaves the tool door usable; only a well-formed
    // answer ends the search here.
    if (result.isError !== true) {
      const content = result.content as Array<{ type?: unknown; text?: unknown }>
      const text = content
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => String(block.text ?? ''))
        .join('')
      if (text !== '') {
        const rows = parseRows(text)
        if (rows !== null) {
          cached = { at: now, rows }
          return rows
        }
      }
    }
  } catch {
    // Fall through to the tool door.
  }

  // The tool door may ask the person's permission, so background scans opt
  // out of it; only a click the person started uses this fallback.
  if (!allowToolFallback) return null
  try {
    const result = await $.tool.call({
      tool: 'mcp__ccd_session_mgmt__list_sessions',
      limit: 200,
    }) as { text?: unknown; result?: unknown }
    const text = typeof result.text === 'string' ? result.text : JSON.stringify(result.result ?? '')
    const rows = parseRows(text)
    if (rows === null) return null
    cached = { at: now, rows }
    return rows
  } catch {
    return null
  }
}

function parseRows(text: string): AppSessionRow[] | null {
  if (text === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { content?: unknown }).content)) {
    const blocks = (parsed as { content: Array<{ type?: unknown; text?: unknown }> }).content
    return parseRows(
      blocks
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => String(block.text ?? ''))
        .join(''),
    )
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { sessions?: unknown }).sessions)
      ? (parsed as { sessions: unknown[] }).sessions
      : null
  if (rows === null) return null
  return rows.filter(
    (row): row is AppSessionRow => row !== null && typeof row === 'object',
  )
}

async function openUrl($: EngineInterface, url: string): Promise<boolean> {
  if (!isClaudeLink(url)) return false

  const attempts: string[][] = [
    ['open', url],
    ['xdg-open', url],
    ['cmd', '/c', 'start', '', url],
  ]
  for (const argv of attempts) {
    try {
      const result = await $.process.run(argv, { timeoutMs: 5000 })
      if (result.exitCode === 0) return true
    } catch {
      // The opener does not exist here; try the next one.
    }
  }
  return false
}

async function safeCwd($: EngineInterface): Promise<string | null> {
  try {
    return await $.session.cwd()
  } catch {
    return null
  }
}

function isClaudeLink(url: string): boolean {
  return url.startsWith('claude://')
}
