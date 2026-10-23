export type GraphNode = {
  nodeId: string
  type: 'message' | 'fork'
  parentNodeId: string | null
  sessionId: string
  branchName?: string
  messagePreview: string
  timestamp: number
}

export type SessionInfo = {
  id: string
  title?: string
  branchName: string
  color: number
  isCurrent: boolean
  messageCount: number
  lastTimestamp: number
}

export type BranchCard = {
  sessionId: string
  /** The live CLI transcript id accepted by `claude --resume`. */
  cliSessionId?: string
  branchType?: 'root' | 'fork' | 'branch'
  /** First actual user prompt after this branch's creation, for CLI cards. */
  branchFirstUserMessage?: string
  title: string
  matchTitle: string
  firstUserMessage: string
  parentSessionId: string | null
  forkAtPreview: string | null
  ownMessageCount: number
  messageCount: number
  lastTimestamp: number
  isCurrent: boolean
  color: number
  depth: number
}

export type GraphSnapshot = {
  nodes: GraphNode[]
  sessions: SessionInfo[]
  cards: BranchCard[]
  source: 'transcript' | 'linear'
  notice?: string
  scannedAt: number
  theme: 'light' | 'dark'
  hiddenNodeCount: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-graph': {
      snapshot: GraphSnapshot
    }
  }
}
