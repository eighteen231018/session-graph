import type { FsEntry, SessionMessage } from 'claude-code'
import type { BranchCard, GraphNode, GraphSnapshot, SessionInfo } from '../types'
import { listDeletedTranscriptIds, scanAppSessions, type AppSessionRecord } from './app-store'
import { buildGraph, type SessionFile } from './graph'
import type { HostDeps } from './host'
import { mcpResultText, parseJson } from './mcp-text'
import { parseTranscript, previewOf, type ParsedTranscript } from './parse'
import { listAppSessions, type AppSessionRow } from './session-link'
import { isTerminalOnly } from './surface'

export type CollectDeps = HostDeps

type Cached = {
  mtimeMs: number
  parsed: ParsedTranscript
}

const cache = new Map<string, Cached>()
let projectDirCache: { sessionId: string; dir: string } | undefined

export async function collectGraph(deps: CollectDeps): Promise<GraphSnapshot> {
  const scannedAt = Date.now()
  const theme = await readTheme(deps)

  let sessionId = ''
  try {
    sessionId = await deps.sessionId()
  } catch {
    return emptySnapshot(theme, scannedAt, '无法读取当前会话 ID。')
  }
  if (sessionId === '') return emptySnapshot(theme, scannedAt, '无法读取当前会话 ID。')

  const projectsRoot = await findProjectsRoot(deps)
  if (projectsRoot === null) {
    return linearFallback(deps, sessionId, theme, scannedAt, '找不到 ~/.claude/projects；已降级为官方会话消息的线性视图。')
  }

  const projectDir = await findProjectDir(deps, projectsRoot, sessionId)
  if (projectDir === null) {
    return linearFallback(deps, sessionId, theme, scannedAt, '找不到当前会话的转录文件；已降级为官方会话消息的线性视图。')
  }

  const files = await readSessionFiles(deps, projectDir, sessionId)
  if (files.length === 0) {
    return linearFallback(deps, sessionId, theme, scannedAt, '转录文件不可读；已降级为官方会话消息的线性视图。')
  }

  const appScan = await scanAppSessions(deps)
  // A deleted session's transcript file can outlive its app record; the
  // tombstone says the branch is gone, so it must not come back as a card.
  const visible = files.filter(file =>
    file.id === sessionId || !appScan.deletedTranscriptIds.has(file.id),
  )
  if (visible.length === 0) {
    return linearFallback(deps, sessionId, theme, scannedAt, '转录已删除；已降级为官方会话消息的线性视图。')
  }
  const capabilities = await deps.surfaces().then(
    surfaces => {
      const cliOnly = isTerminalOnly(surfaces)
      return { hasAppManager: surfaces.includes('desktop'), cliForkOrigins: cliOnly, cliContinuations: cliOnly }
    },
    () => ({ hasAppManager: false, cliForkOrigins: false, cliContinuations: false }),
  )
  await applyCreationTimes(deps, visible, appScan.records, capabilities.hasAppManager)
  const snapshot = buildGraph(visible, sessionId, theme, scannedAt, undefined, appScan.records, capabilities)
  if (!snapshot.cards.some(card => card.isCurrent)) {
    return linearFallback(
      deps,
      sessionId,
      theme,
      scannedAt,
      '当前会话的转录不在本次扫描范围内；已降级为官方会话消息的线性视图。',
    )
  }
  if (snapshot.nodes.length === 0) {
    return linearFallback(deps, sessionId, theme, scannedAt, '转录中没有可显示的消息；已降级为官方会话消息的线性视图。')
  }
  return snapshot
}

export async function listSessionIds(deps: CollectDeps): Promise<string[] | null> {
  let sessionId = ''
  try {
    sessionId = await deps.sessionId()
  } catch {
    return null
  }
  if (sessionId === '') return null

  const root = await findProjectsRoot(deps)
  if (root === null) return null
  const dir = await findProjectDir(deps, root, sessionId)
  if (dir === null) return null

  try {
    const entries = await deps.fsList(dir)
    const releasedSuffix = '.desktop-released.json'
    const ids = entries
      .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl'))
      .map(entry => entry.name.slice(0, -6))
    for (const entry of entries) {
      if (entry.kind === 'file' && entry.name.endsWith(releasedSuffix)) {
        ids.push(`released:${entry.name.slice(0, -releasedSuffix.length)}`)
      }
    }
    // A deleted session's transcript can stay on disk; its tombstone is the
    // only change the watch can notice. Prefix it so it never collides with a
    // live transcript id and can only appear or disappear.
    const deleted = await listDeletedTranscriptIds(deps)
    for (const id of deleted) ids.push(`deleted:${id}`)
    return ids
  } catch {
    return null
  }
}

async function findProjectsRoot(deps: CollectDeps): Promise<string | null> {
  const home = deps.env.home ?? deps.env.userProfile
  if (home === undefined || home === '') return null
  const root = `${home.replace(/[\\/]+$/, '')}/.claude/projects`
  try {
    return (await deps.fsExists(root)) ? root : null
  } catch {
    return null
  }
}

async function findProjectDir(deps: CollectDeps, root: string, sessionId: string): Promise<string | null> {
  if (projectDirCache !== undefined && projectDirCache.sessionId === sessionId) {
    try {
      if (await deps.fsExists(`${projectDirCache.dir}/${sessionId}.jsonl`)) return projectDirCache.dir
    } catch {
      // fall through to a fresh scan
    }
  }

  let dirs: FsEntry[] = []
  try {
    dirs = await deps.fsList(root)
  } catch {
    return null
  }

  for (const entry of dirs) {
    if (entry.kind !== 'dir') continue
    const dir = `${root}/${entry.name}`
    try {
      const inner = await deps.fsList(dir)
      if (inner.some(candidate => candidate.name === `${sessionId}.jsonl`)) {
        projectDirCache = { sessionId, dir }
        return dir
      }
    } catch {
      continue
    }
  }

  // Project folders are named by replacing non-alphanumerics in the cwd with "-".
  try {
    const cwd = await deps.sessionCwd()
    const encoded = cwd.replace(/[^A-Za-z0-9]/g, '-')
    const dir = `${root}/${encoded}`
    if (await deps.fsExists(`${dir}/${sessionId}.jsonl`)) {
      projectDirCache = { sessionId, dir }
      return dir
    }
  } catch {
    // no fallback
  }
  return null
}

async function readSessionFiles(deps: CollectDeps, dir: string, currentSessionId: string): Promise<SessionFile[]> {
  let entries: FsEntry[] = []
  try {
    entries = await deps.fsList(dir)
  } catch {
    return []
  }

  // The app marks a transcript it removed with <id>.desktop-released.json;
  // some app versions leave the .jsonl behind, so skip it explicitly.
  const releasedSuffix = '.desktop-released.json'
  const released = new Set(
    entries
      .filter(entry => entry.kind === 'file' && entry.name.endsWith(releasedSuffix))
      .map(entry => entry.name.slice(0, -releasedSuffix.length)),
  )

  const candidates = entries
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.jsonl'))
  const transcripts = candidates
    .filter(entry => !released.has(entry.name.slice(0, -6)))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 32)

  // The current session may not be among the newest files (an old session
  // reopened after other projects were used); its card and highlight must
  // still exist, so read it even outside the window.
  if (!transcripts.some(entry => entry.name === `${currentSessionId}.jsonl`)) {
    const current = candidates.find(entry => entry.name === `${currentSessionId}.jsonl`)
    if (current !== undefined) transcripts.push(current)
  }
  transcripts.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const files: SessionFile[] = []
  for (const entry of transcripts) {
    const path = `${dir}/${entry.name}`
    const id = entry.name.slice(0, -6)
    const cached = cache.get(path)
    let parsed: ParsedTranscript
    if (cached !== undefined && cached.mtimeMs === entry.mtimeMs) {
      parsed = cached.parsed
    } else {
      const text = await readTranscript(deps, path)
      if (text === null) continue
      parsed = parseTranscript(text, id)
      cache.set(path, { mtimeMs: entry.mtimeMs, parsed })
    }
    files.push({
      id,
      path,
      mtimeMs: entry.mtimeMs,
      // Forks copy message timestamps; only App metadata can supply an
      // actual creation time. Never infer it from the first copied message.
      createdAt: 0,
      title: parsed.title,
      messages: parsed.messages,
      forkOrigins: parsed.forkOrigins,
      continuedInSessionId: parsed.continuedInSessionId,
      branchOrigin: parsed.branchOrigin,
    })
  }

  // A deleted transcript must not keep its parsed copy, and the scan only
  // returns the newest 32 files plus the current one, so drop every cache
  // entry not in this scan.
  const present = new Set(files.map(file => file.path))
  for (const key of cache.keys()) {
    if (!present.has(key)) cache.delete(key)
  }
  return files
}

const createdAtCache = new Map<string, { at: number; value: number | null }>()

/**
 * Creation time keeps a newer, short fork from being mistaken for the parent
 * of the original root. The app's own session record knows it exactly; only
 * transcripts without one (CLI/VS Code sessions) ask the app session manager.
 */
async function applyCreationTimes(
  deps: CollectDeps,
  files: SessionFile[],
  appSessions: AppSessionRecord[],
  hasAppManager: boolean,
): Promise<void> {
  const recordOfTranscript = new Map<string, AppSessionRecord>()
  for (const record of appSessions) {
    for (const transcriptId of record.transcriptIds) {
      if (!recordOfTranscript.has(transcriptId)) recordOfTranscript.set(transcriptId, record)
    }
  }

  const unmatched: SessionFile[] = []
  for (const file of files) {
    const record = recordOfTranscript.get(file.id)
    if (record?.createdAt !== undefined && record.createdAt > 0) {
      file.createdAt = record.createdAt
    } else {
      unmatched.push(file)
    }
  }
  if (unmatched.length === 0) return

  // Local app records remain useful on every surface. Only the remote
  // manager fallback requires an attached desktop; recheck on each scan.
  if (!hasAppManager) return

  let rows: AppSessionRow[] | null = null
  try {
    rows = await listAppSessions(deps, false)
  } catch {
    rows = null
  }
  if (rows === null || rows.length === 0) return

  let cwd: string | null = null
  try {
    cwd = await deps.sessionCwd()
  } catch {
    cwd = null
  }

  const exactIds = new Set(files.map(file => `local_${file.id}`))
  for (const file of unmatched) {
    const row = matchAppRow(rows, file, cwd, exactIds)
    if (row === undefined || typeof row.sessionId !== 'string' || row.sessionId === '') continue
    const createdAt = await fetchCreatedAt(deps, row.sessionId)
    if (createdAt !== null) file.createdAt = createdAt
  }
}

function matchAppRow(
  rows: AppSessionRow[],
  file: SessionFile,
  cwd: string | null,
  exactIds: Set<string>,
): AppSessionRow | undefined {
  const exact = rows.find(row => row.sessionId === `local_${file.id}`)
  if (exact !== undefined) return exact

  const title = file.title?.trim()
  if (title === undefined || title === '') return undefined
  const sameTitle = rows.filter(row =>
    row.title === title
    && (cwd === null || row.cwd === cwd)
    && !(typeof row.sessionId === 'string' && exactIds.has(row.sessionId)),
  )
  // A title is not an identity. With two same-titled sessions in the same
  // directory the nearest-by-activity pick may belong to another branch, and
  // a wrong createdAt would order the fork tree backwards; leave it unknown.
  if (sameTitle.length !== 1) return undefined
  return sameTitle[0]
}

async function fetchCreatedAt(deps: CollectDeps, appSessionId: string): Promise<number | null> {
  const now = Date.now()
  const cached = createdAtCache.get(appSessionId)
  if (cached !== undefined && (cached.value !== null || now - cached.at < 60_000)) return cached.value

  const read = (result: unknown): number | null => {
    const text = mcpResultText(result)
    const payload = text === '' ? result : parseJson(text)
    const candidates = [payload, (payload as { result?: unknown } | null)?.result]
    for (const candidate of candidates) {
      if (candidate === null || typeof candidate !== 'object') continue
      const value = (candidate as { createdAt?: unknown }).createdAt
      if (typeof value === 'string') {
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed)) return parsed
      }
    }
    return null
  }

  let value: number | null = null
  try {
    value = read(await deps.mcpCall('ccd_session_mgmt', 'get_session', { session_id: appSessionId }))
  } catch {
    value = null
  }
  createdAtCache.set(appSessionId, { at: now, value })
  return value
}

async function readTranscript(deps: CollectDeps, path: string): Promise<string | null> {
  try {
    return await deps.fsRead(path)
  } catch {
    // A long transcript is over $.fs.read's 4 MiB cap; read its tail and drop
    // the first partial line. Without a host process, degrade to linear.
    try {
      const tail = await deps.processRun(['tail', '-c', '3900000', path], { timeoutMs: 10000 })
      if (tail.exitCode !== 0) return null
      const newline = tail.stdout.indexOf('\n')
      return newline >= 0 ? tail.stdout.slice(newline + 1) : tail.stdout
    } catch {
      return null
    }
  }
}

async function readTheme(deps: CollectDeps): Promise<'light' | 'dark'> {
  try {
    const rows = await deps.configList()
    const row = rows.find(candidate => candidate.key === 'theme')
    const value = String(row?.value ?? '').toLowerCase()
    return value.includes('light') ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

async function linearFallback(
  deps: CollectDeps,
  sessionId: string,
  theme: 'light' | 'dark',
  scannedAt: number,
  notice: string,
): Promise<GraphSnapshot> {
  let rows: readonly SessionMessage[] = []
  try {
    const result = await deps.sessionMessages()
    if (Array.isArray(result)) rows = result
  } catch {
    rows = []
  }

  const slice = rows.slice(-500)
  const nodes: GraphNode[] = slice.map((message, index) => {
    const tools = Array.isArray(message.toolUses)
      ? message.toolUses.map(use => use.tool).filter(tool => tool !== '')
      : []
    const text = previewOf(message.text)
    const body = text !== '' ? text : tools.length > 0 ? `[${tools.slice(0, 3).join(', ')}]` : '(empty)'
    return {
      nodeId: `linear:${index}`,
      type: 'message',
      parentNodeId: index === 0 ? null : `linear:${index - 1}`,
      sessionId,
      messagePreview: `${message.role === 'user' ? 'You' : 'Claude'}: ${body}`,
      timestamp: scannedAt + index,
    }
  })

  const lastTimestamp = scannedAt + Math.max(0, slice.length - 1)
  const session: SessionInfo = {
    id: sessionId,
    branchName: `会话 ${sessionId.slice(0, 8)}（当前）`,
    color: 0,
    isCurrent: true,
    messageCount: rows.length,
    lastTimestamp,
  }
  const firstUser = rows.find(message => message.role === 'user' && previewOf(message.text) !== '')
  const cliFirstUser = rows.find(message => message.role === 'user' && previewOf(message.text) !== ''
    && !/^\s*<(?:command-name|local-command-|task-notification|system-reminder|teammate-message|bash-)/i.test(message.text))
  const card: BranchCard = {
    sessionId,
    cliSessionId: sessionId,
    branchType: 'root',
    branchFirstUserMessage: cliFirstUser === undefined ? '（尚未输入提示词）' : previewOf(cliFirstUser.text),
    title: `会话 ${sessionId.slice(0, 8)}`,
    matchTitle: '',
    firstUserMessage: firstUser === undefined ? '（没有用户消息）' : previewOf(firstUser.text),
    parentSessionId: null,
    forkAtPreview: null,
    ownMessageCount: rows.length,
    messageCount: rows.length,
    lastTimestamp,
    isCurrent: true,
    color: 0,
    depth: 0,
  }

  return {
    nodes,
    sessions: [session],
    cards: [card],
    source: 'linear',
    notice,
    scannedAt,
    theme,
    hiddenNodeCount: Math.max(0, rows.length - 500),
  }
}

function emptySnapshot(theme: 'light' | 'dark', scannedAt: number, notice: string): GraphSnapshot {
  return {
    nodes: [],
    sessions: [],
    cards: [],
    source: 'linear',
    notice,
    scannedAt,
    theme,
    hiddenNodeCount: 0,
  }
}
