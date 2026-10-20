import type { EngineInterface, SessionMessage } from 'claude-code'

/**
 * The environment values the plugin reads. Names are literals in the hooks
 * module, because the host lists env reads from the source's call sites; the
 * library only ever sees the plain values.
 */
export type HostEnv = {
  readonly home: string | undefined
  readonly userProfile: string | undefined
  readonly appData: string | undefined
  readonly localAppData: string | undefined
  readonly xdgConfigHome: string | undefined
}

/**
 * The host capabilities the library needs, as bound closures built in the
 * hooks module. `$` is never passed across an import: the host follows it only
 * into functions declared in the module that spells `$.noun.event(...)`.
 */
export type HostDeps = {
  readonly env: HostEnv
  readonly sessionId: EngineInterface['session']['id']
  readonly sessionCwd: EngineInterface['session']['cwd']
  readonly sessionMessages: () => Promise<SessionMessage[]>
  readonly fsExists: EngineInterface['fs']['exists']
  readonly fsList: EngineInterface['fs']['list']
  readonly fsRead: (path: string) => Promise<string>
  readonly fsWrite: EngineInterface['fs']['write']
  readonly configList: EngineInterface['config']['list']
  readonly mcpCall: EngineInterface['mcp']['call']
  readonly toolCall: EngineInterface['tool']['call']
  readonly processRun: EngineInterface['process']['run']
}
