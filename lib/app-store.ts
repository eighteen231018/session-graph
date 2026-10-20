import type { FsEntry } from 'claude-code'
import type { HostDeps } from './host'

/**
 * One session as the desktop app stores it. The app keeps a session's
 * conversation in place while a rewind, edit-and-resend or clear moves it to a
 * new CLI transcript, so `transcriptIds` is every `.jsonl` name that belongs to
 * this one session. Cards are built per session, not per transcript file.
 */
export type AppSessionRecord = {
  id: string
  transcriptIds: string[]
  cliSessionId?: string
  title?: string
  cwd?: string
  createdAt?: number
  lastActivityAt?: number
  parentId?: string
  detached: boolean
}

export type AppSessionScan = {
  records: AppSessionRecord[]
  /** Transcripts the app deleted; their `.jsonl` may still be on disk. */
  deletedTranscriptIds: Set<string>
}

export type AppStoreDeps = Pick<HostDeps, 'env' | 'fsExists' | 'fsList' | 'fsRead'>

type CachedRecord = {
  mtimeMs: number
  record: AppSessionRecord
}

const cache = new Map<string, CachedRecord>()
let rootsCache: { at: number; roots: string[] } | undefined
/** Tombstones observed at least once stay honored for this process. */
const seenTombstones = new Set<string>()
/** Sessions deleted from this pane, kept hidden if the app leaves files behind. */
const forgottenSessions = new Map<string, Set<string>>()
let knownRecords: AppSessionRecord[] = []
const MAX_RECORDS = 800

/**
 * The app deletes a session's record but not always its transcript files. The
 * card is gone from the app, so its transcripts must stop producing a card
 * even while the `.jsonl` remains.
 */
export function forgetAppSession(appId: string, transcriptIds?: Iterable<string>): void {
  const record = knownRecords.find(candidate => candidate.id === appId)
  const ids = new Set(record?.transcriptIds ?? [])
  if (transcriptIds !== undefined) {
    for (const id of transcriptIds) ids.add(id)
  }
  // A card without an app record carries the transcript id itself.
  if (!appId.startsWith('local_')) ids.add(appId)
  forgottenSessions.set(appId, ids)
}

/**
 * Reads the app's own session records. The transcript store alone cannot tell
 * a rewind (one session, several transcripts) from a fork (two sessions), but
 * the app records can: they list a session's earlier CLI ids and its fork
 * parent. Every failure is non-fatal; the caller then keeps the old
 * transcript-only view.
 */
/** Tombstone ids only, for the 1s change watch (no record reads). */
export async function listDeletedTranscriptIds(deps: AppStoreDeps): Promise<string[]> {
  let stores: string[] = []
  try {
    stores = await findStoreRoots(deps)
  } catch {
    return []
  }
  const ids: string[] = []
  for (const store of stores) {
    const found = await findStoreEntries(deps, store)
    ids.push(...found.tombstones)
  }
  return [...new Set(ids)]
}

export async function scanAppSessions(deps: AppStoreDeps): Promise<AppSessionScan> {
  let stores: string[] = []
  try {
    stores = await findStoreRoots(deps)
  } catch {
    return { records: [], deletedTranscriptIds: new Set() }
  }
  const records: AppSessionRecord[] = []
  const deletedTranscriptIds = new Set<string>()
  const seenPaths = new Set<string>()
  const seenIds = new Set<string>()
  const freshTombstones = new Set<string>()

  for (const store of stores) {
    const found = await findStoreEntries(deps, store)
    for (const tombstone of found.tombstones) freshTombstones.add(tombstone)
    for (const file of found.records) {
      if (seenPaths.has(file.path)) continue
      seenPaths.add(file.path)
      const record = await readRecord(deps, file.path, file.entry)
      if (record === null || seenIds.has(record.id)) continue
      seenIds.add(record.id)
      records.push(record)
    }
  }

  // A tombstone names one id, but the app record it belonged to may own
  // several CLI transcripts. Expand through the records the previous scan
  // knew before they are replaced; an id the host deleted can then never come
  // back as a card through a transcript the record also listed.
  const expanded = expandTombstones(freshTombstones, knownRecords)
  for (const id of expanded) {
    deletedTranscriptIds.add(id)
    seenTombstones.add(id)
  }

  for (const key of cache.keys()) {
    if (!seenPaths.has(key)) cache.delete(key)
  }
  knownRecords = records

  for (const id of seenTombstones) deletedTranscriptIds.add(id)
  for (const ids of forgottenSessions.values()) {
    for (const id of ids) deletedTranscriptIds.add(id)
  }
  return { records, deletedTranscriptIds }
}

function expandTombstones(ids: Iterable<string>, known: AppSessionRecord[]): Set<string> {
  const out = new Set<string>()
  for (const id of ids) {
    out.add(id)
    const record = known.find(candidate =>
      candidate.id === id || candidate.transcriptIds.includes(id),
    )
    if (record === undefined) continue
    out.add(record.id)
    for (const transcriptId of record.transcriptIds) out.add(transcriptId)
  }
  return out
}

type RecordFile = {
  path: string
  entry: FsEntry
}

type StoreEntries = {
  records: RecordFile[]
  tombstones: string[]
}

async function findStoreEntries(deps: AppStoreDeps, store: string): Promise<StoreEntries> {
  const records: RecordFile[] = []
  const tombstones: string[] = []
  let frontier = [store]
  let visited = 0
  for (let depth = 0; depth < 4 && frontier.length > 0 && records.length < MAX_RECORDS; depth += 1) {
    const next: string[] = []
    for (const dir of frontier) {
      if (visited >= MAX_RECORDS || records.length >= MAX_RECORDS) break
      visited += 1
      const entries = await listEntries(deps, dir)
      for (const entry of entries) {
        if (entry.kind === 'dir') {
          next.push(`${dir}/${entry.name}`)
        } else if (entry.kind !== 'file') {
          continue
        } else if (entry.name.startsWith('local_') && entry.name.endsWith('.json')) {
          records.push({ path: `${dir}/${entry.name}`, entry })
        } else if (entry.name.startsWith('deleted_')) {
          const id = entry.name.slice(8)
          if (id !== '') tombstones.push(id)
        }
      }
    }
    frontier = next
  }
  return { records, tombstones }
}

async function findStoreRoots(deps: AppStoreDeps): Promise<string[]> {
  const now = Date.now()
  if (rootsCache !== undefined && now - rootsCache.at < 60_000) return rootsCache.roots

  const bases = new Set<string>()
  const home = deps.env.home ?? deps.env.userProfile
  if (home !== undefined && home !== '') {
    bases.add(`${trimSlash(home)}/Library/Application Support`)
    bases.add(`${trimSlash(home)}/.config`)
  }
  for (const value of [
    deps.env.appData,
    deps.env.localAppData,
    deps.env.xdgConfigHome,
  ]) {
    if (value !== undefined && value !== '') bases.add(trimSlash(value))
  }

  const roots: string[] = []
  for (const base of bases) {
    const entries = await listEntries(deps, base)
    for (const entry of entries) {
      if (entry.kind !== 'dir') continue
      if (!/^claude(?:$|[- ._].*)/i.test(entry.name)) continue
      const candidate = `${base}/${entry.name}/claude-code-sessions`
      try {
        if (await deps.fsExists(candidate)) roots.push(candidate)
      } catch {
        // Not a profile with a session store.
      }
    }
  }
  const unique = [...new Set(roots)]
  rootsCache = { at: now, roots: unique }
  return unique
}

async function listEntries(deps: AppStoreDeps, path: string): Promise<FsEntry[]> {
  try {
    return await deps.fsList(path)
  } catch {
    return []
  }
}

async function readRecord(
  deps: AppStoreDeps,
  path: string,
  entry: FsEntry,
): Promise<AppSessionRecord | null> {
  const cached = cache.get(path)
  if (cached !== undefined && cached.mtimeMs === entry.mtimeMs) return cached.record

  let text = ''
  try {
    text = await deps.fsRead(path)
  } catch {
    return null
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const record = parseRecord(raw, entry.name)
  if (record !== null) cache.set(path, { mtimeMs: entry.mtimeMs, record })
  return record
}

function parseRecord(raw: unknown, fileName: string): AppSessionRecord | null {
  if (raw === null || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  const stem = fileName.startsWith('local_') ? fileName.slice(6, -5) : ''
  const declared = typeof data.sessionId === 'string' && data.sessionId.startsWith('local_')
    ? data.sessionId
    : stem === '' ? '' : `local_${stem}`
  if (!declared.startsWith('local_') || declared === 'local_') return null

  const ids = new Set<string>()
  if (stem !== '') ids.add(stem)
  if (declared.length > 6) ids.add(declared.slice(6))
  for (const key of ['cliSessionId', 'unarchivedCliSessionId', 'preClearCliSessionId', 'historyOnlyCliSessionId']) {
    const value = data[key]
    if (typeof value === 'string' && value !== '') ids.add(value)
  }
  const prior = data.priorCliSessionIds
  if (Array.isArray(prior)) {
    for (const value of prior) {
      if (typeof value === 'string' && value !== '') ids.add(value)
    }
  }

  const record: AppSessionRecord = {
    id: declared,
    transcriptIds: [...ids],
    detached: data.lineageDetached === true,
  }
  if (typeof data.cliSessionId === 'string' && data.cliSessionId !== '') record.cliSessionId = data.cliSessionId
  if (typeof data.title === 'string' && data.title.trim() !== '') record.title = data.title.trim()
  if (typeof data.cwd === 'string' && data.cwd !== '') record.cwd = data.cwd
  if (typeof data.createdAt === 'number' && Number.isFinite(data.createdAt)) record.createdAt = data.createdAt
  if (typeof data.lastActivityAt === 'number' && Number.isFinite(data.lastActivityAt)) {
    record.lastActivityAt = data.lastActivityAt
  }

  if (!record.detached) {
    const forkParent = data.forkedFromSessionId
    if (typeof forkParent === 'string' && forkParent.startsWith('local_') && forkParent !== declared) {
      record.parentId = forkParent
    } else {
      const spawned = data.spawnedFrom
      if (spawned !== null && typeof spawned === 'object') {
        const parent = (spawned as { sessionId?: unknown }).sessionId
        if (typeof parent === 'string' && parent.startsWith('local_') && parent !== declared) {
          record.parentId = parent
        }
      }
    }
  }

  return record
}

function trimSlash(value: string): string {
  return value.replace(/[\\/]+$/, '')
}
