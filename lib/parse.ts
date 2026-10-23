export type ParsedMessage = {
  uuid: string
  parentUuid: string | null
  timestamp: number
  role: 'user' | 'assistant'
  preview: string
  sessionId: string
  isSidechain: boolean
  /** CLI-only presentation metadata; inherited prompts are excluded later. */
  isUserPrompt?: boolean
}

export type ParsedTranscript = {
  messages: ParsedMessage[]
  forkOrigins: TranscriptForkOrigin[]
  continuedInSessionId?: string
  branchOrigin?: TranscriptBranchOrigin
  title?: string
  firstTimestamp: number
}

/** Host-written /fork notification; message ids survive rewritten sessionIds. */
export type TranscriptForkOrigin = {
  markerUuid: string
  anchorUuid: string
  sharedThrough: number
  timestamp: number
}

export type TranscriptBranchOrigin = {
  parentSessionId: string
  sharedThrough: number
  createdAt?: number
}

type RawRecord = {
  type?: unknown
  uuid?: unknown
  parentUuid?: unknown
  timestamp?: unknown
  message?: unknown
  sessionId?: unknown
  isSidechain?: unknown
  customTitle?: unknown
  aiTitle?: unknown
  origin?: unknown
  promptSource?: unknown
  continuedInSessionId?: unknown
  forkedFrom?: unknown
  isMeta?: unknown
  subtype?: unknown
  content?: unknown
  commandRun?: unknown
}

type RawNode = {
  parent: string | null
  timestamp: number
}

type ContentSummary = {
  text: string
  tools: string[]
  hasResult: boolean
}

export function parseTranscript(text: string, fileId: string): ParsedTranscript {
  const records = new Map<string, RawNode>()
  const raw: RawRecord[] = []
  let title: string | undefined
  let firstTimestamp = 0
  let lastTs = 0
  const continuations = new Set<string>()
  const branchSources = new Set<string>()
  let branchSharedThrough: number | undefined

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let record: RawRecord
    try {
      record = JSON.parse(line) as RawRecord
    } catch {
      continue
    }
    raw.push(record)

    // A copied transcript can contain another session's metadata. Only the
    // source file's own continuation record establishes its replacement.
    if (record.type === 'continued-in' && record.sessionId === fileId
      && typeof record.continuedInSessionId === 'string'
      && record.continuedInSessionId.trim() !== '' && record.continuedInSessionId !== fileId) {
      continuations.add(record.continuedInSessionId)
    }

    if (firstTimestamp === 0) {
      const first = parseFirstTimestamp(record.timestamp)
      if (first !== null) firstTimestamp = first
    }

    if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.trim() !== '') {
      title = record.customTitle.trim()
    } else if (title === undefined && record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim() !== '') {
      title = record.aiTitle.trim()
    }

    if (typeof record.uuid !== 'string' || record.uuid === '') continue
    const ts = parseTimestamp(record.timestamp, lastTs)
    if (ts > lastTs) lastTs = ts
    records.set(record.uuid, {
      parent: typeof record.parentUuid === 'string' && record.parentUuid !== '' ? record.parentUuid : null,
      timestamp: ts,
    })
    const copied = record.forkedFrom as { sessionId?: unknown; messageUuid?: unknown } | null | undefined
    if (record.sessionId === fileId && record.isSidechain !== true
      && typeof copied?.sessionId === 'string' && copied.sessionId !== '' && copied.sessionId !== fileId
      && copied.messageUuid === record.uuid) {
      branchSources.add(copied.sessionId)
      if (branchSharedThrough === undefined || ts > branchSharedThrough) branchSharedThrough = ts
    }
  }

  const messageUuids = new Set<string>()
  for (const record of raw) {
    if (record.type !== 'user' && record.type !== 'assistant') continue
    if (typeof record.uuid === 'string' && record.uuid !== '') messageUuids.add(record.uuid)
  }

  // A parent often points at an attachment or system row; walk up to the
  // nearest record that is itself a message so the graph stays connected.
  const nearestMessageParent = (start: unknown): string | null => {
    let current = typeof start === 'string' && start !== '' ? start : null
    const guard = new Set<string>()
    while (current !== null) {
      if (messageUuids.has(current)) return current
      if (guard.has(current)) return null
      guard.add(current)
      current = records.get(current)?.parent ?? null
    }
    return null
  }

  const messages: ParsedMessage[] = []
  const forkOrigins: TranscriptForkOrigin[] = []
  const seen = new Set<string>()
  for (const record of raw) {
    if (record.type !== 'user' && record.type !== 'assistant') continue
    if (typeof record.uuid !== 'string' || record.uuid === '' || seen.has(record.uuid)) continue
    seen.add(record.uuid)
    const summary = summarizeContent(record.message)
    const role: 'user' | 'assistant' = record.type === 'assistant' ? 'assistant' : 'user'
    const parentUuid = nearestMessageParent(record.parentUuid)
    const timestamp = records.get(record.uuid)?.timestamp ?? 0
    const forkOrigin = forkOriginOf(record, summary.text, parentUuid, timestamp)
    if (forkOrigin !== null) forkOrigins.push(forkOrigin)
    messages.push({
      uuid: record.uuid,
      parentUuid,
      timestamp,
      role,
      preview: makePreview(role, summary),
      sessionId: typeof record.sessionId === 'string' ? record.sessionId : fileId,
      isSidechain: record.isSidechain === true,
      isUserPrompt: role === 'user' && record.isMeta !== true && record.isSidechain !== true
        && record.promptSource !== 'system'
        && !/^\s*<(?:command-name|local-command-|task-notification|system-reminder|teammate-message|bash-)/i.test(summary.text)
        && previewOf(summary.text) !== '',
    })
  }

  const continuedInSessionId = continuations.size === 1 ? [...continuations][0] : undefined
  const parentSessionId = branchSources.size === 1 ? [...branchSources][0] : undefined
  let branchCreatedAt: number | undefined
  for (const record of raw) {
    const command = record.commandRun as { command?: unknown } | undefined | null
    if (record.type !== 'system' || record.subtype !== 'local_command' || record.sessionId !== fileId
      || command?.command !== 'branch' || typeof record.content !== 'string') continue
    const ids = /You are now in the new branch \(session ([0-9a-f-]{36})\)\. Use \/resume ([0-9a-f-]{36})/i.exec(record.content)
    const timestamp = parseFirstTimestamp(record.timestamp)
    if (ids?.[1] === fileId && ids[2] === parentSessionId && timestamp !== null && timestamp > 0) branchCreatedAt = timestamp
  }
  return {
    messages, forkOrigins, title, firstTimestamp,
    ...(continuedInSessionId === undefined ? {} : { continuedInSessionId }),
    ...(parentSessionId === undefined || branchSharedThrough === undefined ? {} : {
      branchOrigin: {
        parentSessionId, sharedThrough: branchSharedThrough,
        ...(branchCreatedAt === undefined ? {} : { createdAt: branchCreatedAt }),
      },
    }),
  }
}

function forkOriginOf(
  record: RawRecord,
  text: string,
  anchorUuid: string | null,
  timestamp: number,
): TranscriptForkOrigin | null {
  const origin = record.origin as { kind?: unknown } | undefined | null
  // Never interpret ordinary user text, queued copies, or a failed /fork
  // command as lineage. This envelope is emitted by the CLI itself.
  if (record.type !== 'user' || record.promptSource !== 'system' || origin?.kind !== 'task-notification') return null
  if (record.isSidechain === true || anchorUuid === null || typeof record.uuid !== 'string') return null
  const body = /^\s*<task-notification>\s*<fork-source>([\s\S]*?)<\/fork-source>\s*<\/task-notification>\s*$/.exec(text)?.[1]
  if (body === undefined || !body.includes('This session began as a fork (copy) of another session')) return null
  const cutoff = /The conversation up to (\S+) is shared history/.exec(body)?.[1]
  const sharedThrough = cutoff === undefined ? NaN : Date.parse(cutoff)
  if (!Number.isFinite(sharedThrough) || sharedThrough <= 0 || timestamp <= sharedThrough) return null
  return { markerUuid: record.uuid, anchorUuid, sharedThrough, timestamp }
}

export function previewOf(text: string): string {
  const commandName = /<command-name>([^<]*)<\/command-name>/i.exec(text)?.[1]?.trim()
  if (commandName !== undefined && commandName !== '') {
    const args = /<command-args>([^<]*)<\/command-args>/i.exec(text)?.[1]?.trim() ?? ''
    return args === '' ? commandName : `${commandName} ${args}`
  }
  const clean = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<ide_[a-z_]+>[\s\S]*?<\/ide_[a-z_]+>/gi, ' ')
    .replace(/<local-command-[a-z-]+>[\s\S]*?<\/local-command-[a-z-]+>/gi, ' ')
    .replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (clean === '') return ''
  return clean.length > 150 ? `${clean.slice(0, 147)}…` : clean
}

function makePreview(role: 'user' | 'assistant', summary: ContentSummary): string {
  const who = role === 'user' ? 'You' : 'Claude'
  const text = previewOf(summary.text)
  const tools = summary.tools.length > 0
    ? `[${summary.tools.slice(0, 3).join(', ')}${summary.tools.length > 3 ? ', …' : ''}]`
    : ''
  if (text !== '' && tools !== '') return `${who}: ${text} ${tools}`
  if (text !== '') return `${who}: ${text}`
  if (tools !== '') return `${who}: ${tools}`
  if (summary.hasResult) return `${who}: [tool result]`
  return `${who}: (empty)`
}

function summarizeContent(message: unknown): ContentSummary {
  if (message === null || typeof message !== 'object') return { text: '', tools: [], hasResult: false }
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return { text: content, tools: [], hasResult: false }
  if (!Array.isArray(content)) return { text: '', tools: [], hasResult: false }

  const texts: string[] = []
  const tools: string[] = []
  let hasResult = false
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const typed = block as { type?: unknown; text?: unknown; name?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') {
      texts.push(typed.text)
    } else if (typed.type === 'tool_use' && typeof typed.name === 'string') {
      tools.push(typed.name)
    } else if (typed.type === 'tool_result') {
      hasResult = true
    }
  }
  return { text: texts.join(' '), tools, hasResult }
}

function parseFirstTimestamp(value: unknown): number | null {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function parseTimestamp(value: unknown, last: number): number {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return last + 1
}
