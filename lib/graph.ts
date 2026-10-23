import type { BranchCard, GraphNode, GraphSnapshot, SessionInfo } from '../types'
import type { AppSessionRecord } from './app-store'
import type { ParsedMessage, TranscriptForkOrigin, TranscriptBranchOrigin } from './parse'

export type SessionFile = {
  id: string
  path: string
  mtimeMs: number
  createdAt: number
  title?: string | undefined
  messages: ParsedMessage[]
  forkOrigins?: TranscriptForkOrigin[]
  continuedInSessionId?: string | undefined
  branchOrigin?: TranscriptBranchOrigin | undefined
}

/**
 * All transcript files that belong to one app session. A rewind or clear moves
 * the session to a new CLI transcript while staying the same session in the
 * app, so a branch can own several files; the card represents them together.
 */
type BranchUnit = {
  id: string
  app?: AppSessionRecord | undefined
  files: SessionFile[]
  messages: ParsedMessage[]
  byUuid: Map<string, ParsedMessage>
  fileOfUuid: Map<string, string>
  uuidSet: Set<string>
  foreignSessionIds: Map<string, number>
  foreignIsPrefix: boolean
  forkOrigins: TranscriptForkOrigin[]
  branchOrigins: TranscriptBranchOrigin[]
  primary: SessionFile
  createdAt: number
  lastTimestamp: number
}

export function buildGraph(
  files: SessionFile[],
  currentSessionId: string,
  theme: 'light' | 'dark',
  scannedAt: number,
  notice?: string,
  appSessions: AppSessionRecord[] = [],
  options: { cliForkOrigins?: boolean; cliContinuations?: boolean } = {},
): GraphSnapshot {
  const units = buildUnits(files, appSessions, options.cliContinuations === true)
  const unitById = new Map(units.map(unit => [unit.id, unit]))
  const parentOf = resolveUnitParents(units, unitById, options.cliForkOrigins === true)
  const used = selectUnits(units, parentOf, currentSessionId)
  const ordered = orderUnits(used, parentOf)

  const nodes = buildNodes(ordered, parentOf, unitById)
  const titles = titleCounts(ordered)
  const cards: BranchCard[] = ordered.map((unit, index) => {
    const card = buildCard(unit, parentOf, unitById, currentSessionId)
    card.color = index % 8
    card.title = cardTitle(unit, titles)
    card.depth = depthOf(unit.id, parentOf)
    return card
  })

  const sessions: SessionInfo[] = cards.map((card, index) => {
    const info: SessionInfo = {
      id: card.sessionId,
      branchName: `${card.title}${card.isCurrent ? '（当前）' : ''}`,
      color: index % 8,
      isCurrent: card.isCurrent,
      messageCount: card.messageCount,
      lastTimestamp: card.lastTimestamp,
    }
    if (card.matchTitle !== '') info.title = card.matchTitle
    return info
  })

  const snapshot: GraphSnapshot = {
    nodes,
    sessions,
    cards,
    source: 'transcript',
    scannedAt,
    theme,
    hiddenNodeCount: 0,
  }
  if (notice !== undefined && notice !== '') snapshot.notice = notice
  return snapshot
}

function buildUnits(files: SessionFile[], appSessions: AppSessionRecord[], cliContinuations: boolean): BranchUnit[] {
  const recordOfTranscript = new Map<string, AppSessionRecord>()
  for (const record of appSessions) {
    for (const transcriptId of record.transcriptIds) {
      const existing = recordOfTranscript.get(transcriptId)
      if (existing === undefined) {
        recordOfTranscript.set(transcriptId, record)
        continue
      }
      if (existing.id === record.id) continue
      recordOfTranscript.set(transcriptId, preferRecord(existing, record, transcriptId))
    }
  }

  // CLI resume/continuation can replace a transcript without creating a
  // branch. Collapse only explicit links, never identical message histories.
  // App ownership remains authoritative and cannot be merged by CLI metadata.
  const cliFiles = new Map(files.filter(file => !recordOfTranscript.has(file.id)).map(file => [file.id, file]))
  const continuationId = (file: SessionFile): string => {
    if (!cliContinuations || !cliFiles.has(file.id)) return file.id
    const seen = new Set<string>()
    let current = file
    for (;;) {
      if (seen.has(current.id)) return file.id
      seen.add(current.id)
      const next = current.continuedInSessionId === undefined ? undefined : cliFiles.get(current.continuedInSessionId)
      if (next === undefined) return current.id
      current = next
    }
  }

  const units = new Map<string, BranchUnit>()
  for (const file of files) {
    const record = recordOfTranscript.get(file.id)
    const id = record !== undefined ? record.id : continuationId(file)
    let unit = units.get(id)
    if (unit === undefined) {
      unit = {
        id,
        app: record,
        files: [],
        messages: [],
        byUuid: new Map(),
        fileOfUuid: new Map(),
        uuidSet: new Set(),
        foreignSessionIds: new Map(),
        foreignIsPrefix: false,
        forkOrigins: [],
        branchOrigins: [],
        primary: file,
        createdAt: record?.createdAt ?? file.createdAt,
        lastTimestamp: 0,
      }
      units.set(id, unit)
    }
    unit.files.push(file)
    for (const origin of file.forkOrigins ?? []) {
      if (!unit.forkOrigins.some(existing => existing.markerUuid === origin.markerUuid)) unit.forkOrigins.push(origin)
    }
    if (file.branchOrigin !== undefined) unit.branchOrigins.push(file.branchOrigin)
    if (record?.createdAt !== undefined && record.createdAt > 0) unit.createdAt = record.createdAt
  }

  for (const unit of units.values()) {
    const liveId = unit.app?.cliSessionId ?? (cliContinuations ? unit.id : undefined)
    const liveFile = liveId === undefined ? undefined : unit.files.find(file => file.id === liveId)
    unit.primary = liveFile ?? unit.files.reduce(
      (best, file) => (file.mtimeMs > best.mtimeMs ? file : best),
      unit.files[0]!,
    )

    const merged: ParsedMessage[] = []
    for (const file of unit.files) {
      for (const message of file.messages) {
        if (unit.byUuid.has(message.uuid)) continue
        unit.byUuid.set(message.uuid, message)
        unit.fileOfUuid.set(message.uuid, file.id)
        unit.uuidSet.add(message.uuid)
        merged.push(message)
      }
    }
    // Inspect provenance before sorting: equal/missing timestamps must use
    // transcript order, not the lexical order of randomly generated UUIDs.
    const ownIds = new Set([
      unit.id,
      unit.app?.cliSessionId ?? '',
      ...unit.files.map(file => file.id),
      ...(unit.app?.transcriptIds ?? []),
    ])
    let firstOwnIndex = -1
    for (const [index, message] of merged.entries()) {
      if (message.sessionId === '' || !ownIds.has(message.sessionId)) continue
      const first = merged[firstOwnIndex]
      if (first === undefined || (message.timestamp > 0 && first.timestamp > 0 && message.timestamp < first.timestamp)) {
        firstOwnIndex = index
      }
    }
    const firstOwn = merged[firstOwnIndex]
    unit.foreignIsPrefix = true
    for (const [index, message] of merged.entries()) {
      const owner = message.sessionId
      if (owner === '' || ownIds.has(owner)) continue
      unit.foreignSessionIds.set(owner, (unit.foreignSessionIds.get(owner) ?? 0) + 1)
      if (firstOwn === undefined) continue
      const orderedTimes = message.timestamp > 0 && firstOwn.timestamp > 0 && message.timestamp !== firstOwn.timestamp
      if (orderedTimes ? message.timestamp > firstOwn.timestamp : index > firstOwnIndex) {
        unit.foreignIsPrefix = false
      }
    }

    merged.sort((a, b) => a.timestamp - b.timestamp || (a.uuid < b.uuid ? -1 : 1))
    unit.messages = merged

    let last = 0
    for (const message of merged) {
      if (message.timestamp > last) last = message.timestamp
    }
    unit.lastTimestamp = Math.max(last, unit.app?.lastActivityAt ?? 0)
    if (unit.app?.createdAt === undefined) {
      for (const file of unit.files) {
        if (file.createdAt > 0 && (unit.createdAt === 0 || file.createdAt < unit.createdAt)) {
          unit.createdAt = file.createdAt
        }
      }
    }
  }

  return [...units.values()]
}

function preferRecord(current: AppSessionRecord, candidate: AppSessionRecord, transcriptId: string): AppSessionRecord {
  if (current.cliSessionId === transcriptId) return current
  if (candidate.cliSessionId === transcriptId) return candidate
  return (candidate.createdAt ?? 0) > (current.createdAt ?? 0) ? candidate : current
}

function resolveUnitParents(units: BranchUnit[], byId: Map<string, BranchUnit>, cliForkOrigins: boolean): Map<string, string | null> {
  const parentOf = new Map<string, string | null>()
  const byTranscriptId = new Map<string, BranchUnit>()
  for (const unit of units) {
    for (const file of unit.files) byTranscriptId.set(file.id, unit)
  }
  for (const unit of units) {
    // Prefer the ownership already resolved by buildUnits if records overlap.
    for (const id of unit.app?.transcriptIds ?? []) {
      if (!byTranscriptId.has(id)) byTranscriptId.set(id, unit)
    }
  }

  // The app's own fork links are exact. An app session without one is left to
  // history inference (older app builds did not always record the parent), and
  // a session the user detached to the top level stays a root.
  for (const unit of units) {
    if (unit.app === undefined) continue
    const appParent = unit.app.parentId
    if (unit.app.detached) {
      parentOf.set(unit.id, null)
    } else if (appParent !== undefined && appParent !== unit.id && byId.has(appParent)) {
      parentOf.set(unit.id, appParent)
    } else if (appParent !== undefined && appParent !== unit.id) {
      parentOf.set(unit.id, null)
    }
  }
  for (const unit of units) {
    if (parentOf.has(unit.id)) continue
    if (cliForkOrigins) {
      const origin = cliOrigin(unit)
      if (origin?.kind === 'branch') {
        const parent = byTranscriptId.get(origin.parentSessionId)
        parentOf.set(unit.id, parent !== undefined && !wouldCreateCycle(unit.id, parent.id, parentOf) ? parent.id : null)
        continue
      }
    }
    const parent = provenanceParent(unit, byTranscriptId, parentOf)
    if (parent !== null) parentOf.set(unit.id, parent)
  }

  if (cliForkOrigins) {
    for (const unit of units) {
      if (parentOf.has(unit.id)) continue
      const parent = notificationParent(unit, units, parentOf)
      // A valid notification with ambiguous/missing sources stays unknown;
      // message counts must not choose one of several identical candidates.
      if (parent !== undefined) parentOf.set(unit.id, parent)
    }
  }

  // Existing links establish direction before containment. Cycle detection
  // excludes both direct children and deeper descendants as parent candidates.
  for (const unit of units) {
    if (parentOf.has(unit.id)) continue
    const candidates = units.filter(candidate =>
      !wouldCreateCycle(unit.id, candidate.id, parentOf),
    )
    parentOf.set(unit.id, inferParent(unit, candidates))
  }

  breakCycles(parentOf)
  return parentOf
}

function notificationParent(
  unit: BranchUnit,
  units: BranchUnit[],
  parentOf: Map<string, string | null>,
): string | null | undefined {
  const origin = [...unit.forkOrigins].sort((a, b) => b.timestamp - a.timestamp)[0]
  if (origin === undefined) return undefined
  const inherited = unit.messages.filter(message => message.timestamp <= origin.sharedThrough)
  if (inherited.length === 0 || !inherited.some(message => message.uuid === origin.anchorUuid)) return null
  const candidates = units.filter(candidate => {
    const sourceOrigin = cliOrigin(candidate)
    const sourceBorn = sourceOrigin === undefined ? 0
      : sourceOrigin.kind === 'fork' ? sourceOrigin.timestamp : sourceOrigin.createdAt ?? sourceOrigin.sharedThrough
    // A later branch may copy all of the original source's history too. Its
    // own creation boundary proves it did not exist at this fork's cutoff.
    return sourceBorn <= origin.sharedThrough
      && !wouldCreateCycle(unit.id, candidate.id, parentOf)
      && !candidate.uuidSet.has(origin.markerUuid)
      && inherited.every(message => candidate.uuidSet.has(message.uuid))
  })
  if (candidates.length === 1) return candidates[0]!.id
  return null
}

function cliOrigin(unit: BranchUnit):
  | (TranscriptBranchOrigin & { kind: 'branch' })
  | (TranscriptForkOrigin & { kind: 'fork' })
  | undefined {
  const fork = [...unit.forkOrigins].sort((a, b) => b.timestamp - a.timestamp)[0]
  const branch = [...unit.branchOrigins].sort((a, b) => b.sharedThrough - a.sharedThrough)[0]
  // /branch rewrites copied records' forkedFrom to its immediate source.
  // A later /fork notification belongs to the new fork; older copied
  // notifications belong to its ancestor and cannot change its type.
  if (branch !== undefined && (fork === undefined || (branch.createdAt ?? branch.sharedThrough) >= fork.timestamp)) return { ...branch, kind: 'branch' }
  return fork === undefined ? undefined : { ...fork, kind: 'fork' }
}

function provenanceParent(
  unit: BranchUnit,
  byTranscriptId: Map<string, BranchUnit>,
  parentOf: Map<string, string | null>,
): string | null {
  if (!unit.foreignIsPrefix) return null
  const sources = [...unit.foreignSessionIds].sort((a, b) => b[1] - a[1])
  for (const [id] of sources) {
    const source = byTranscriptId.get(id)
    if (source === undefined || wouldCreateCycle(unit.id, source.id, parentOf)) continue
    return source.id
  }
  return null
}

function wouldCreateCycle(child: string, parent: string, parentOf: Map<string, string | null>): boolean {
  const seen = new Set<string>()
  let current: string | null = parent
  while (current !== null && !seen.has(current)) {
    if (current === child) return true
    seen.add(current)
    current = parentOf.get(current) ?? null
  }
  return false
}

/**
 * A parent is always older. Without this, a newly forked transcript with fewer
 * messages can look like the parent of the original root, which flips the root
 * whenever another branch is added.
 *
 * Direction comes from an explicit creation time when both sides have one.
 * Otherwise only a history wholly contained in the other proves direction: a
 * fork copies its parent's history, so the contained side is the descendant.
 * Message counts alone never decide, and a divergence with no creation time
 * stays unknown rather than guessing a parent.
 */
function inferParent(unit: BranchUnit, units: BranchUnit[]): string | null {
  if (unit.uuidSet.size === 0) return null

  let best: string | null = null
  let bestScore = -Infinity
  let bestCreated = -Infinity
  for (const other of units) {
    if (other.id === unit.id || other.uuidSet.size === 0) continue

    const shared = sharedCount(unit.uuidSet, other.uuidSet)
    if (shared === 0) continue

    if (unit.createdAt > 0 && other.createdAt > 0 && unit.createdAt !== other.createdAt) {
      // Copied messages keep their timestamps, so only an explicit creation
      // time may order the two; a parent is created no later than its fork.
      if (other.createdAt > unit.createdAt) continue
    } else if (shared !== other.uuidSet.size || other.uuidSet.size === unit.uuidSet.size) {
      // No creation time: the candidate's whole history must be a proper part
      // of this unit, as it is when a fork copied its parent and then grew.
      // Identical copies and the reverse case (this unit still a prefix of the
      // other) are ambiguous: either side may have grown, so they are left
      // unknown rather than guessed, which also keeps growth from flipping an
      // established direction.
      continue
    }

    // Prefer a full containment (one history was copied from the other), then
    // the most shared messages, then the most recent earlier branch.
    const containment = shared / Math.max(1, Math.min(unit.uuidSet.size, other.uuidSet.size))
    const score = containment * 1_000_000 + shared
    if (score > bestScore || (score === bestScore && other.createdAt > bestCreated)) {
      best = other.id
      bestScore = score
      bestCreated = other.createdAt
    }
  }
  return best
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  const smaller = a.size <= b.size ? a : b
  const larger = a.size <= b.size ? b : a
  let shared = 0
  for (const uuid of smaller) if (larger.has(uuid)) shared += 1
  return shared
}

function breakCycles(parentOf: Map<string, string | null>): void {
  for (const start of parentOf.keys()) {
    const seen = new Set<string>([start])
    let current = start
    for (;;) {
      const parent = parentOf.get(current) ?? null
      if (parent === null) break
      if (seen.has(parent)) {
        parentOf.set(current, null)
        break
      }
      seen.add(parent)
      current = parent
    }
  }
}

function selectUnits(
  units: BranchUnit[],
  parentOf: Map<string, string | null>,
  currentSessionId: string,
): BranchUnit[] {
  const current = units.find(unit => unit.files.some(file => file.id === currentSessionId))
  if (current === undefined) return []
  const root = rootOf(current.id, parentOf)
  return units.filter(unit => rootOf(unit.id, parentOf) === root)
}

function rootOf(id: string, parentOf: Map<string, string | null>): string {
  let current = id
  const seen = new Set<string>()
  while (!seen.has(current)) {
    seen.add(current)
    const parent = parentOf.get(current) ?? null
    if (parent === null) break
    current = parent
  }
  return current
}

function depthOf(id: string, parentOf: Map<string, string | null>): number {
  let depth = 0
  let current = parentOf.get(id) ?? null
  const guard = new Set<string>()
  while (current !== null && !guard.has(current)) {
    guard.add(current)
    depth += 1
    current = parentOf.get(current) ?? null
  }
  return depth
}

function orderUnits(
  units: BranchUnit[],
  parentOf: Map<string, string | null>,
): BranchUnit[] {
  const byId = new Map(units.map(unit => [unit.id, unit]))
  const children = new Map<string, BranchUnit[]>()
  const roots: BranchUnit[] = []

  for (const unit of units) {
    const parent = parentOf.get(unit.id) ?? null
    if (parent !== null && byId.has(parent)) {
      const list = children.get(parent)
      if (list === undefined) children.set(parent, [unit])
      else list.push(unit)
    } else {
      roots.push(unit)
    }
  }

  const byTime = (a: BranchUnit, b: BranchUnit): number =>
    a.lastTimestamp - b.lastTimestamp || (a.id < b.id ? -1 : 1)
  roots.sort(byTime)
  for (const list of children.values()) list.sort(byTime)

  const out: BranchUnit[] = []
  const seen = new Set<string>()
  const visit = (unit: BranchUnit): void => {
    if (seen.has(unit.id)) return
    seen.add(unit.id)
    out.push(unit)
    for (const child of children.get(unit.id) ?? []) visit(child)
  }
  for (const root of roots) visit(root)
  for (const unit of units) visit(unit)
  return out
}

function buildNodes(
  units: BranchUnit[],
  parentOf: Map<string, string | null>,
  byId: Map<string, BranchUnit>,
): GraphNode[] {
  const nodes: GraphNode[] = []
  const nodeById = new Map<string, GraphNode>()
  const messageByUuid = new Map<string, ParsedMessage>()
  const unitOfUuid = new Map<string, BranchUnit>()

  for (const unit of units) {
    for (const message of unit.messages) {
      if (!messageByUuid.has(message.uuid)) {
        messageByUuid.set(message.uuid, message)
        unitOfUuid.set(message.uuid, unit)
      }
      if (nodeById.has(message.uuid)) continue
      const node: GraphNode = {
        nodeId: message.uuid,
        type: 'message',
        parentNodeId: null,
        sessionId: unit.fileOfUuid.get(message.uuid) ?? unit.primary.id,
        messagePreview: message.preview,
        timestamp: message.timestamp,
      }
      nodes.push(node)
      nodeById.set(node.nodeId, node)
    }
  }

  for (const node of nodes) {
    const parent = messageByUuid.get(node.nodeId)?.parentUuid ?? null
    node.parentNodeId = parent !== null && nodeById.has(parent) ? parent : null
  }

  // One fork node per branch unit: the first message the parent does not hold
  // is where this branch leaves the parent's history.
  const extras: GraphNode[] = []
  for (const unit of units) {
    const parentId = parentOf.get(unit.id) ?? null
    const parent = parentId === null ? undefined : byId.get(parentId)
    if (parent === undefined) continue

    const firstOwn = unit.messages.find(message => !parent.uuidSet.has(message.uuid))
    if (firstOwn === undefined) continue
    const anchor = forkAnchor(unit, parent.uuidSet)
    if (anchor === null || !nodeById.has(anchor)) continue

    const forkId = `fork:session:${unit.id}:${anchor}`
    if (nodeById.has(forkId)) continue
    const fork: GraphNode = {
      nodeId: forkId,
      type: 'fork',
      parentNodeId: anchor,
      sessionId: unit.id,
      branchName: unit.app?.title ?? unit.primary.title ?? `会话 ${shortId(unit.id)}`,
      messagePreview: `Fork → ${unit.app?.title ?? shortId(unit.id)}`,
      timestamp: firstOwn.timestamp,
    }
    extras.push(fork)
    nodeById.set(forkId, fork)
    const firstNode = nodeById.get(firstOwn.uuid)
    if (firstNode !== undefined) firstNode.parentNodeId = forkId
  }

  // A rewind or edit that leaves two messages under one parent is a branch
  // point inside the same transcript; wrap those children in a fork node.
  const children = new Map<string, GraphNode[]>()
  for (const node of nodes) {
    if (node.parentNodeId === null) continue
    const list = children.get(node.parentNodeId)
    if (list === undefined) children.set(node.parentNodeId, [node])
    else list.push(node)
  }
  const branchCounters = new Map<string, number>()
  for (const [parentId, kids] of children) {
    const messageKids = kids.filter(kid => kid.type === 'message')
    if (messageKids.length < 2) continue
    const parent = nodeById.get(parentId)
    if (parent === undefined) continue

    const branchUnit = unitOfUuid.get(parentId)
    const forkId = `fork:branch:${parent.sessionId}:${parentId}`
    if (nodeById.has(forkId)) continue

    const branchNumber = (branchCounters.get(parent.sessionId) ?? 0) + 1
    branchCounters.set(parent.sessionId, branchNumber)

    const fork: GraphNode = {
      nodeId: forkId,
      type: 'fork',
      parentNodeId: parentId,
      sessionId: parent.sessionId,
      branchName: branchUnit?.app?.title ?? `branch ${branchNumber}`,
      messagePreview: `Branch point (${messageKids.length} paths)`,
      timestamp: Math.min(...messageKids.map(kid => kid.timestamp)),
    }
    extras.push(fork)
    nodeById.set(forkId, fork)
    for (const kid of messageKids) kid.parentNodeId = forkId
  }

  return [...nodes, ...extras]
}

function buildCard(
  unit: BranchUnit,
  parentOf: Map<string, string | null>,
  byId: Map<string, BranchUnit>,
  currentSessionId: string,
): BranchCard {
  const parentId = parentOf.get(unit.id) ?? null
  const parent = parentId === null ? undefined : byId.get(parentId)
  const parentUuids = parent?.uuidSet
  const own = parentUuids === undefined
    ? unit.messages
    : unit.messages.filter(message => !parentUuids.has(message.uuid))
  const firstUser = own.find(isUserPrompt) ?? unit.messages.find(isUserPrompt)
  const last = unit.messages.length > 0 ? unit.messages[unit.messages.length - 1] : undefined
  const origin = cliOrigin(unit)
  const branchType = origin?.kind ?? (parent === undefined ? 'root' : unit.app === undefined ? 'branch' : 'fork')
  const prompt = unit.messages.find(message =>
    (message.isUserPrompt ?? isUserPrompt(message))
    && (origin === undefined || message.timestamp > origin.sharedThrough)
    && (parentUuids === undefined || !parentUuids.has(message.uuid)),
  )

  return {
    sessionId: unit.id,
    cliSessionId: unit.app?.cliSessionId || unit.primary.id,
    branchType,
    branchFirstUserMessage: prompt === undefined
      ? branchType === 'root' ? '（尚未输入提示词）' : '（分支后尚未输入提示词）'
      : shorten(prompt.preview.replace(/^You:\s*/, ''), 240),
    title: unit.app?.title ?? unit.primary.title ?? `会话 ${shortId(unit.id)}`,
    matchTitle: unit.app?.title ?? unit.primary.title?.trim() ?? '',
    firstUserMessage: firstUser === undefined
      ? '（该分支没有用户消息）'
      : shorten(firstUser.preview.replace(/^You:\s*/, ''), 240),
    parentSessionId: parent !== undefined ? parent.id : null,
    forkAtPreview: forkPreview(unit, parentUuids),
    ownMessageCount: own.length,
    messageCount: unit.messages.length,
    lastTimestamp: last?.timestamp ?? unit.app?.lastActivityAt ?? 0,
    isCurrent: unit.files.some(file => file.id === currentSessionId),
    color: 0,
    depth: 0,
  }
}

function forkAnchor(unit: BranchUnit, parentUuids: Set<string>): string | null {
  const firstOwn = unit.messages.find(message => !parentUuids.has(message.uuid))
  if (firstOwn !== undefined && firstOwn.parentUuid !== null && parentUuids.has(firstOwn.parentUuid)) {
    return firstOwn.parentUuid
  }
  let lastShared: string | null = null
  for (const message of unit.messages) {
    if (parentUuids.has(message.uuid)) lastShared = message.uuid
  }
  return lastShared
}

function forkPreview(unit: BranchUnit, parentUuids: Set<string> | undefined): string | null {
  if (parentUuids === undefined) return null
  const anchor = forkAnchor(unit, parentUuids)
  if (anchor === null) return null
  const parentMessage = unit.byUuid.get(anchor)
  return parentMessage?.preview ?? null
}

function isUserPrompt(message: ParsedMessage): boolean {
  if (message.role !== 'user') return false
  return !/^You: (?:\(empty\)|\[tool result\])$/.test(message.preview)
}

function titleCounts(units: BranchUnit[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const unit of units) {
    const title = baseTitle(unit)
    counts.set(title, (counts.get(title) ?? 0) + 1)
  }
  return counts
}

function baseTitle(unit: BranchUnit): string {
  const app = unit.app?.title?.trim()
  if (app !== undefined && app !== '') return app
  const transcript = unit.primary.title?.trim()
  if (transcript !== undefined && transcript !== '') return transcript
  return `会话 ${shortId(unit.id)}`
}

function cardTitle(unit: BranchUnit, counts: Map<string, number>): string {
  const title = baseTitle(unit)
  return (counts.get(title) ?? 0) > 1 ? `${title} · ${shortId(unit.id)}` : title
}

function shortId(id: string): string {
  return (id.startsWith('local_') ? id.slice(6) : id).slice(0, 8)
}

function shorten(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}
