import type { BranchCard, GraphNode, GraphSnapshot, SessionInfo } from '../types'
import type { AppSessionRecord } from './app-store'
import type { ParsedMessage } from './parse'

export type SessionFile = {
  id: string
  path: string
  mtimeMs: number
  createdAt: number
  title?: string | undefined
  messages: ParsedMessage[]
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
): GraphSnapshot {
  const units = buildUnits(files, appSessions)
  const unitById = new Map(units.map(unit => [unit.id, unit]))
  const parentOf = resolveUnitParents(units, unitById)
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

function buildUnits(files: SessionFile[], appSessions: AppSessionRecord[]): BranchUnit[] {
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

  const units = new Map<string, BranchUnit>()
  for (const file of files) {
    const record = recordOfTranscript.get(file.id)
    const id = record !== undefined ? record.id : file.id
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
        primary: file,
        createdAt: record?.createdAt ?? file.createdAt,
        lastTimestamp: 0,
      }
      units.set(id, unit)
    }
    unit.files.push(file)
    if (record?.createdAt !== undefined && record.createdAt > 0) unit.createdAt = record.createdAt
  }

  for (const unit of units.values()) {
    const appCliId = unit.app?.cliSessionId
    const liveFile = appCliId === undefined ? undefined : unit.files.find(file => file.id === appCliId)
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

function resolveUnitParents(units: BranchUnit[], byId: Map<string, BranchUnit>): Map<string, string | null> {
  const parentOf = new Map<string, string | null>()

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
    parentOf.set(unit.id, inferParent(unit, units))
  }

  breakCycles(parentOf)
  return parentOf
}

/**
 * A parent is always older. Without this, a newly forked transcript with fewer
 * messages can look like the parent of the original root, which flips the root
 * whenever another branch is added.
 */
function inferParent(unit: BranchUnit, units: BranchUnit[]): string | null {
  if (unit.uuidSet.size === 0) return null

  const isEarlier = (other: BranchUnit): boolean => {
    if (other.uuidSet.size === 0) return false
    if (other.createdAt > 0 && unit.createdAt > 0 && other.createdAt !== unit.createdAt) {
      return other.createdAt < unit.createdAt
    }
    if (other.uuidSet.size !== unit.uuidSet.size) return other.uuidSet.size > unit.uuidSet.size
    return other.id < unit.id
  }

  let best: string | null = null
  let bestScore = -Infinity
  let bestCreated = -Infinity
  for (const other of units) {
    if (other.id === unit.id || !isEarlier(other)) continue
    const smaller = other.uuidSet.size <= unit.uuidSet.size ? other.uuidSet : unit.uuidSet
    const larger = other.uuidSet.size <= unit.uuidSet.size ? unit.uuidSet : other.uuidSet
    let shared = 0
    for (const uuid of smaller) if (larger.has(uuid)) shared += 1
    if (shared === 0) continue
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

  return {
    sessionId: unit.id,
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
