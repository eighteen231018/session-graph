import type { EngineInterface } from 'claude-code'

type RevealResult = { ok: true } | { ok: false; reason: string }

/** The host binding is supplied by the hooks module, like the other deps. */
export async function revealCurrent(
  scroll: EngineInterface['ui']['scroll'],
  sessionId: string,
): Promise<RevealResult> {
  try {
    const result = await scroll({ in: 'session-graph', to: { key: `${sessionId}:title` }, block: 'start' })
    return result.deny === undefined ? { ok: true } : { ok: false, reason: result.deny }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
