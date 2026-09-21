import type { AppState } from '@/store'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'
import { resolveAgentResumeLaunchTarget } from './agent-resume-launch-target'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'
import { getLocalProjectExecutionRuntimeContext } from './local-preflight-context'
import type { PtyPaneStartup } from '@/components/terminal-pane/pty-connection-types'
import { parseExecutionHostId } from '../../../shared/execution-host'

export function resolveCodexAccountRestartStartup(
  state: AppState,
  worktreeId: string,
  tabId: string,
  leafId: string | null,
  recoveredSession?: { key: 'session_id'; id: string }
): NonNullable<PtyPaneStartup> {
  const paneKey = leafId ? `${tabId}:${leafId}` : null
  const entry = paneKey ? state.agentStatusByPaneKey[paneKey] : undefined
  const retained = paneKey ? state.sleepingAgentSessionsByPaneKey[paneKey] : undefined
  const providerSession =
    recoveredSession ??
    (entry?.agentType === 'codex' && !entry.restoredUnconfirmed
      ? entry.providerSession
      : !entry && retained?.agent === 'codex' && retained.origin === 'live'
        ? retained.providerSession
        : undefined)
  if (!providerSession || !/^[0-9a-f-]{36}$/i.test(providerSession.id)) {
    throw new Error(
      'Codex conversation identity is unavailable. Resume this conversation manually.'
    )
  }
  const tab = state.tabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
  const worktree = state.getKnownWorktreeById(worktreeId)
  const repo = worktree ? state.repos.find((candidate) => candidate.id === worktree.repoId) : null
  const executionHostId = getExecutionHostIdForWorktree(state, worktreeId)
  const host = parseExecutionHostId(executionHostId)
  const connectionId = host?.kind === 'ssh' ? host.targetId : repo?.connectionId
  const target = resolveAgentResumeLaunchTarget({
    projectRuntime: getLocalProjectExecutionRuntimeContext(state, worktreeId),
    connectionId,
    executionHostId,
    worktreePath: worktree?.path,
    terminalWindowsShell: state.settings?.terminalWindowsShell,
    tabShellOverride: tab?.shellOverride
  })
  const launchConfig = entry
    ? state.getAgentLaunchConfigForStatusEntry(entry)
    : retained?.launchConfig
  const plan = buildAgentResumeStartupPlan({
    agent: 'codex',
    providerSession,
    cmdOverrides: state.settings?.agentCmdOverrides ?? {},
    agentArgs: launchConfig?.agentArgs ?? null,
    isRemote: Boolean(connectionId),
    ...target
  })
  if (!plan) {
    throw new Error('Codex conversation cannot be resumed.')
  }
  // Account restarts use the selected home; ordinary history resumes pin the origin account.
  return {
    command: plan.launchCommand,
    launchAgent: 'codex',
    launchConfig: plan.launchConfig,
    startupCommandDelivery: 'shell-ready'
  }
}

export async function prepareCodexAccountRestartStartup(
  state: AppState,
  worktreeId: string,
  tabId: string,
  leafId: string | null,
  ptyId: string | null | undefined
): Promise<NonNullable<PtyPaneStartup>> {
  try {
    return resolveCodexAccountRestartStartup(state, worktreeId, tabId, leafId)
  } catch (error) {
    if (
      !ptyId ||
      !leafId ||
      getExecutionHostIdForWorktree(state, worktreeId) !== 'local' ||
      !window.api.codexAccounts.preparePaneRestart
    ) {
      throw error
    }
    const providerSession = await window.api.codexAccounts.preparePaneRestart({ ptyId })
    return resolveCodexAccountRestartStartup(state, worktreeId, tabId, leafId, providerSession)
  }
}
