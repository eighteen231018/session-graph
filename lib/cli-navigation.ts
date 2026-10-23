import type { EngineInterface } from 'claude-code'
import type { BranchCard } from '../types'

export type CliNavigationDeps = {
  sessionId: EngineInterface['session']['id']
  sessionCwd: EngineInterface['session']['cwd']
  commandRun: EngineInterface['command']['run']
  processRun: EngineInterface['process']['run']
  sleep: EngineInterface['clock']['sleep']
  debug?: (message: string) => void
}

type ResumeResult = { opened: true; stoppedBackground: boolean } | { opened: false; message: string }

/** /resume switches the existing REPL, unlike spawning an interactive child. */
export async function resumeCliSession(deps: CliNavigationDeps, card: BranchCard): Promise<ResumeResult> {
  const id = (card.cliSessionId || card.sessionId).replace(/^local_/, '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { opened: false, message: '无法跳转：会话 ID 无效' }
  }
  const isTarget = async (): Promise<boolean> => (await deps.sessionId().catch(() => '')) === id
  if (await isTarget()) return { opened: true, stoppedBackground: false }
  let stoppedBackground = false

  // /resume can attach a live background view without changing session.id(),
  // and its local-jsx output can be empty. Resolve ownership independently of
  // that output, before allowing the host to attach the background view.
  const background = async (): Promise<{ jobId?: string; error?: string }> => {
    try {
      const cwd = await deps.sessionCwd()
      const listing = await deps.processRun(['claude', 'agents', '--json'], { cwd, timeoutMs: 5000 })
      if (listing.exitCode !== 0) return { error: listing.stderr || '无法读取后台会话状态' }
      const rows: unknown = JSON.parse(listing.stdout)
      if (!Array.isArray(rows)) return { error: '后台会话列表格式无效' }
      const matches = rows.filter(row => row !== null && typeof row === 'object'
        && typeof row.sessionId === 'string' && row.sessionId.toLowerCase() === id.toLowerCase() && row.kind === 'background')
      if (matches.length === 0) return {}
      const jobId: unknown = matches[0]?.id
      if (matches.length !== 1 || typeof jobId !== 'string' || !/^[0-9a-f]{8}$/i.test(jobId)) {
        return { error: '无法唯一确定目标后台任务 ID，未停止任何任务' }
      }
      return { jobId }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  const stop = async (jobId: string): Promise<string | undefined> => {
    try {
      deps.debug?.(`stop background job=${jobId} session=${id}`)
      // `claude stop` accepts a JOB id, not the full transcript UUID. This id
      // comes from the unique registry row matched by the full session UUID.
      const result = await deps.processRun(['claude', 'stop', jobId], { cwd: await deps.sessionCwd(), timeoutMs: 15000 })
      if (result.exitCode !== 0) return result.stderr || result.stdout || '后台会话停止失败'
      stoppedBackground = true
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  const waitForTarget = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      if (await isTarget()) return true
      await deps.sleep(100)
    }
    return isTarget()
  }

  let state = await background()
  if (state.jobId !== undefined) {
    const error = await stop(state.jobId)
    if (error !== undefined) return { opened: false, message: `无法停止目标后台会话：${error}` }
    await deps.sleep(300)
  } else if (state.error !== undefined && card.branchType === 'fork') {
    return { opened: false, message: `无法确认 fork 的后台状态：${state.error}` }
  }

  const resume = async (): Promise<string> => {
    try {
      deps.debug?.(`resume session=${id} stoppedBackground=${stoppedBackground}`)
      const result = await deps.commandRun({ command: 'resume', args: id })
      return (result.text ?? '').replace(/\u001b\[[0-9;]*m/g, '')
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  const first = await resume()
  if (await waitForTarget()) return { opened: true, stoppedBackground }
  // Account for a background process that started between the initial lookup
  // and /resume. Never rely on the JSX command returning its displayed text.
  state = await background()
  if (state.jobId !== undefined) {
    const error = await stop(state.jobId)
    if (error !== undefined) return { opened: false, message: `无法停止目标后台会话：${error}` }
  } else if (!stoppedBackground) {
    return { opened: false, message: first || state.error || '恢复命令已完成，但目标会话未进入主视图' }
  }
  let message = first
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await deps.sleep(300)
    message = await resume()
    if (await waitForTarget()) return { opened: true, stoppedBackground }
    if (message !== '' && !/running in the background|background session.*running/i.test(message)) break
  }
  return { opened: false, message: message || '目标后台会话已停止，但尚未恢复到主视图，请再次跳转' }
}
