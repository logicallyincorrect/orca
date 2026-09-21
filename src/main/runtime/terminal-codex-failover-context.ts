import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { getCodexPaneAccount } from '../codex/codex-pane-account-registry'
import { selectExactWorkerProviderSession } from './orchestration/worker-provider-session'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { CodexFailoverTerminal } from './terminal-codex-account-failover'

export function resolveTerminalCodexFailoverContext(input: {
  pty:
    | Pick<
        RuntimePtyWorktreeRecord,
        | 'ptyId'
        | 'connected'
        | 'incarnationId'
        | 'connectionId'
        | 'isWsl'
        | 'wslDistro'
        | 'paneKey'
        | 'launchAgent'
        | 'foregroundAgent'
        | 'launchToken'
        | 'launchConfig'
        | 'worktreeId'
      >
    | undefined
  handle: string | undefined
  settings: GlobalSettings
  rows: readonly AgentStatusIpcPayload[]
}): CodexFailoverTerminal | null {
  const { pty, handle, settings, rows } = input
  if (
    !pty?.connected ||
    !pty.incarnationId ||
    pty.connectionId ||
    pty.isWsl ||
    pty.wslDistro ||
    !pty.paneKey ||
    !handle ||
    (pty.launchAgent !== 'codex' && pty.foregroundAgent !== 'codex')
  ) {
    return null
  }
  const pane = parsePaneKey(pty.paneKey)
  const attribution = getCodexPaneAccount(pty.ptyId)
  if (
    !pane ||
    attribution?.selectionKey !== 'host' ||
    (attribution.homeRoute !== 'account-home' && attribution.homeRoute !== 'real-home')
  ) {
    return null
  }
  const account = settings.codexManagedAccounts.find((entry) => entry.id === attribution.accountId)
  if (
    (!account && attribution.homeRoute !== 'real-home') ||
    account?.managedHomeRuntime === 'wsl'
  ) {
    return null
  }
  if (rows.some((row) => row.paneKey === pty.paneKey && row.subagents?.length)) {
    return null
  }
  const liveRows = rows.filter((row) => !row.restoredUnconfirmed)
  const provider = selectExactWorkerProviderSession({
    paneKey: pty.paneKey,
    processIncarnation: pty.incarnationId,
    connectionId: null,
    launchToken: pty.launchToken,
    // A matching launch token retains thread identity through a long-running turn.
    observedAfter: pty.launchToken ? 0 : Date.now() - 60_000,
    statuses: liveRows
  })
  if (provider?.agent !== 'codex' || !/^[0-9a-f-]{36}$/i.test(provider.providerSession.id)) {
    return null
  }
  return {
    ptyId: pty.ptyId,
    incarnationId: pty.incarnationId,
    handle,
    home:
      attribution.homeRoute === 'real-home' ? getSystemCodexHomePath() : account!.managedHomePath,
    threadId: provider.providerSession.id,
    workspaceId: pty.worktreeId,
    tabId: pane.tabId,
    leafId: pane.leafId,
    ...(pty.launchConfig ? { agentArgs: pty.launchConfig.agentArgs } : {})
  }
}
