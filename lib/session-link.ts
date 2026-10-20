import type { HostDeps } from './host'
import { mcpResultText, parseJson, textBlocks } from './mcp-text'

export type SessionTarget = {
  sessionId: string
  title: string
  isCurrent: boolean
}

export type OpenSessionResult = {
  opened: boolean
  reason: 'current' | 'link' | 'constructed' | 'no-link' | 'open-failed'
}

export type DeleteSessionResult = {
  ok: boolean
  message: string
  /** `unknown`: the manager answered in a shape this plugin cannot judge. */
  reason?: 'not-found' | 'refused' | 'unavailable' | 'unknown'
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

export type AppSessionDeps = Pick<HostDeps, 'sessionCwd' | 'mcpCall' | 'toolCall' | 'processRun'>

let cached: { at: number; rows: AppSessionRow[] } | undefined

/**
 * Best-effort jump: the app's session manager returns a `claude://` link for
 * every local session. Cards carry the app's own session id (`local_...`), so
 * that id is matched exactly and nothing else is opened in its place. Older
 * cards that carry a transcript id may fall back to a unique title match.
 * When the manager is unavailable the only fallback is the CLI-style link,
 * which is not valid for app-created ids.
 */
export async function openSession(
  deps: AppSessionDeps,
  target: SessionTarget,
): Promise<OpenSessionResult> {
  if (target.isCurrent) return { opened: false, reason: 'current' }

  const resolved = await resolveLink(deps, target)
  if (resolved === null) return { opened: false, reason: 'no-link' }
  if (await openUrl(deps, resolved.link)) return { opened: true, reason: resolved.kind }
  return { opened: false, reason: 'open-failed' }
}

async function resolveLink(deps: AppSessionDeps, target: SessionTarget): Promise<ResolvedLink | null> {
  const cwd = await safeCwd(deps)
  const rows = await listSessions(deps)

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
  if (target.sessionId === '') return undefined
  const isAppId = target.sessionId.startsWith('local_')
  const ids = isAppId
    ? [target.sessionId]
    : [target.sessionId, `local_${target.sessionId}`]
  const exact = rows.find(row =>
    typeof row.sessionId === 'string' && ids.includes(row.sessionId),
  )
  if (exact !== undefined) return exact

  // An explicit app id is an identity claim: if it is absent from the list,
  // the session is gone or the list is stale. Opening a same-titled session
  // would silently jump to the wrong conversation, so do not try.
  if (isAppId) return undefined

  // A legacy transcript id may still be part of the app's id. Keep this
  // directional (the row's id contains the transcript id), never a title.
  const byId = rows.find(row =>
    typeof row.sessionId === 'string' && row.sessionId.includes(target.sessionId),
  )
  if (byId !== undefined) return byId

  if (target.title === '') return undefined
  const sameTitle = rows.filter(row =>
    row.title === target.title && (cwd === null || row.cwd === cwd),
  )
  // A title is not an identity. Only a single candidate in this directory is
  // unambiguous enough to open; two or more could be a different branch.
  return sameTitle.length === 1 ? sameTitle[0] : undefined
}

export async function resolveAppSessionId(
  deps: AppSessionDeps,
  target: SessionTarget,
): Promise<string | null> {
  if (target.sessionId === '') return null
  if (target.sessionId.startsWith('local_')) return target.sessionId
  const rows = await listSessions(deps)
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
  deps: AppSessionDeps,
  target: SessionTarget,
): Promise<DeleteSessionResult> {
  if (target.isCurrent) return { ok: false, reason: 'refused', message: '不能删除当前正在运行的会话' }

  const appSessionId = await resolveAppSessionId(deps, target)
  if (appSessionId === null) {
    return {
      ok: false,
      reason: 'not-found',
      message: '应用会话管理器中已没有这个分支，未删除任何文件',
    }
  }

  try {
    const result = await deps.toolCall({
      tool: 'mcp__ccd_session_mgmt__delete_session',
      session_ids: [appSessionId],
      reason: 'Deleted from the session-graph pane',
    })

    cached = undefined
    return judgeDeleteResult(result, appSessionId)
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

function judgeDeleteResult(result: unknown, appSessionId: string): DeleteSessionResult {
  const record = isRecord(result) ? result : {}
  const text = (typeof result === 'string' ? result : mcpResultText(result)).trim()

  if (hasErrorFlag(result)) {
    return {
      ok: false,
      reason: isNotFoundText(text) ? 'not-found' : 'refused',
      message: text === '' ? '应用拒绝删除该会话' : text,
    }
  }

  const structured = judgeStructuredDelete(record, appSessionId, text)
  if (structured !== null) return structured

  const deleted = countFor(text, /deleted\s+(\d+)/i)
    ?? countFor(text, /(\d+)\s+(?:sessions?\s+)?deleted\b/i)
  const skipped = countFor(text, /skipped\s+(\d+)/i)
    ?? countFor(text, /(\d+)\s+(?:sessions?\s+)?skipped\b/i)

  if (deleted !== null) {
    // We ask for one session, so one deletion is this one even if another
    // entry in the same answer was skipped.
    if (deleted > 0) return { ok: true, message: text }
    return {
      ok: false,
      reason: isNotFoundText(text) ? 'not-found' : 'refused',
      message: text === '' ? '没有会话被删除' : text,
    }
  }
  if (skipped !== null && skipped > 0) {
    return {
      ok: false,
      reason: isNotFoundText(text) ? 'not-found' : 'refused',
      message: text === '' ? '应用跳过了该会话' : text,
    }
  }
  if (/success(?:fully)?\s+deleted|已删除/i.test(text)) {
    return { ok: true, message: text }
  }
  if (isNotFoundText(text)) {
    return { ok: false, reason: 'not-found', message: text }
  }
  if (/refused|not deleted|denied|failed|未删除|失败|拒绝/i.test(text)) {
    return { ok: false, reason: 'refused', message: text }
  }
  return {
    ok: false,
    reason: 'unknown',
    message: text === '' ? '会话管理器返回了空结果，未确认是否删除' : `无法判断删除结果：${text}`,
  }
}

function judgeStructuredDelete(
  record: Record<string, unknown>,
  appSessionId: string,
  text: string,
): DeleteSessionResult | null {
  const payloads: Record<string, unknown>[] = [record]
  if (isRecord(record.result)) payloads.push(record.result)

  for (const payload of payloads) {
    const ids = payload.deletedSessionIds ?? payload.deleted_session_ids
    if (Array.isArray(ids)) {
      const values = ids.filter((id): id is string => typeof id === 'string')
      if (values.includes(appSessionId)) {
        return { ok: true, message: text === '' ? '已删除' : text }
      }
      return {
        ok: false,
        reason: 'refused',
        message: text === '' ? '目标会话未被删除' : text,
      }
    }

    const deleted = numberField(payload, ['deleted', 'deletedCount', 'deleted_count'])
    const skipped = numberField(payload, ['skipped', 'skippedCount', 'skipped_count'])
    if (deleted !== null) {
      if (deleted > 0) return { ok: true, message: text === '' ? '已删除' : text }
      return {
        ok: false,
        reason: isNotFoundText(text) ? 'not-found' : skipped !== null && skipped > 0 ? 'refused' : 'unknown',
        message: text === '' ? '没有会话被删除' : text,
      }
    }
    if (payload.success === true) return { ok: true, message: text === '' ? '已删除' : text }
    if (payload.success === false) {
      return {
        ok: false,
        reason: isNotFoundText(text) ? 'not-found' : 'refused',
        message: text === '' ? '应用拒绝删除该会话' : text,
      }
    }
  }
  return null
}

function numberField(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function countFor(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text)
  if (match === null) return null
  const value = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(value) ? value : null
}

function isNotFoundText(text: string): boolean {
  return /not found|no longer available|does not exist|不存在/i.test(text)
}

function hasErrorFlag(result: unknown): boolean {
  if (!isRecord(result)) return false
  if (result.isError === true) return true
  return isRecord(result.result) && result.result.isError === true
}

export function invalidateSessionListCache(): void {
  cached = undefined
}

export async function listAppSessions(
  deps: AppSessionDeps,
  allowToolFallback = true,
): Promise<AppSessionRow[] | null> {
  return listSessions(deps, allowToolFallback)
}

async function listSessions(
  deps: AppSessionDeps,
  allowToolFallback = true,
): Promise<AppSessionRow[] | null> {
  const now = Date.now()
  if (cached !== undefined && now - cached.at < 15000) return cached.rows

  try {
    const result = await deps.mcpCall('ccd_session_mgmt', 'list_sessions', { limit: 200 })
    // An error answer still leaves the tool door usable; only a well-formed
    // answer ends the search here.
    if (result.isError !== true) {
      const rows = rowsOf(result)
      if (rows !== null) {
        cached = { at: now, rows }
        return rows
      }
    }
  } catch {
    // Fall through to the tool door.
  }

  // The tool door may ask the person's permission, so background scans opt
  // out of it; only a click the person started uses this fallback.
  if (!allowToolFallback) return null
  try {
    const result = await deps.toolCall({
      tool: 'mcp__ccd_session_mgmt__list_sessions',
      limit: 200,
    })
    if (hasErrorFlag(result)) return null
    const text = mcpResultText(result)
    let rows = text === '' ? null : rowsOf(text)
    if (rows === null && isRecord(result)) rows = rowsOf(result.result)
    if (rows === null) return null
    cached = { at: now, rows }
    return rows
  } catch {
    return null
  }
}

/**
 * Reads a session list from any of the wrappers the two doors use: a JSON
 * string, `{ content: [{ type: "text", text }] }`, a nested `result`, or an
 * array / `{ sessions }` object already parsed.
 */
function rowsOf(payload: unknown): AppSessionRow[] | null {
  if (typeof payload === 'string') {
    const parsed = parseJson(payload)
    return parsed === null ? null : rowsOf(parsed)
  }
  if (Array.isArray(payload)) return payload.filter(isRecord)
  if (!isRecord(payload)) return null
  if (Array.isArray(payload.sessions)) return payload.sessions.filter(isRecord)
  if (Array.isArray(payload.content)) {
    const text = textBlocks(payload.content)
    return text === '' ? null : rowsOf(text)
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function openUrl(deps: AppSessionDeps, url: string): Promise<boolean> {
  if (!isClaudeLink(url)) return false

  const attempts: string[][] = [
    ['open', url],
    ['xdg-open', url],
    ['cmd', '/c', 'start', '', url],
  ]
  for (const argv of attempts) {
    try {
      const result = await deps.processRun(argv, { timeoutMs: 5000 })
      if (result.exitCode === 0) return true
    } catch {
      // The opener does not exist here; try the next one.
    }
  }
  return false
}

async function safeCwd(deps: AppSessionDeps): Promise<string | null> {
  try {
    return await deps.sessionCwd()
  } catch {
    return null
  }
}

function isClaudeLink(url: string): boolean {
  return url.startsWith('claude://')
}
