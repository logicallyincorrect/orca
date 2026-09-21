import { parsePaneKey } from '../../shared/stable-pane-id'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { readCodexProcessLaunchEvidence } from '../codex/codex-process-launch-evidence'
import { resolveCodexPaneLaunchAccount } from '../codex/codex-pane-launch-account'
import { recordCodexPaneAccount } from '../codex/codex-pane-account-registry'
import { resolvePinnedCodexRolloutProof } from '../codex/codex-tui-rollout-proof'
import type { resolveTerminalCodexFailoverContext } from './terminal-codex-failover-context'
import type { CodexFailoverTerminal } from './terminal-codex-account-failover'
import type { RuntimePtyController } from './runtime-pty-controller-contract'

type ContextInput = Parameters<typeof resolveTerminalCodexFailoverContext>[0]

export async function recoverTerminalCodexContext(
  input: ContextInput,
  controller: RuntimePtyController | null,
  isCurrent: (terminal: CodexFailoverTerminal) => boolean
): Promise<CodexFailoverTerminal | null> {
  const { handle, settings, rows } = input
  const pty = input.pty ? { ...input.pty } : undefined
  if (
    !pty?.connected ||
    !pty.incarnationId ||
    pty.connectionId ||
    pty.isWsl ||
    pty.wslDistro ||
    !pty.paneKey ||
    !handle ||
    rows.some((row) => row.paneKey === pty.paneKey && row.subagents?.length)
  ) {
    return null
  }
  const pane = parsePaneKey(pty.paneKey)
  if (!pane) {
    return null
  }
  const process = (await controller?.listProcesses?.(null))?.find((entry) => entry.id === pty.ptyId)
  if (!process?.rootProcessId || process.incarnationId !== pty.incarnationId || process.wslDistro) {
    return null
  }
  const evidence = await readCodexProcessLaunchEvidence({
    rootPid: process.rootProcessId,
    paneKey: pty.paneKey,
    allowedHomes: [
      getSystemCodexHomePath(),
      ...settings.codexManagedAccounts
        .filter((account) => account.managedHomeRuntime !== 'wsl' && !account.wslDistro)
        .map((account) => account.managedHomePath)
    ]
  })
  if (!evidence || !(await resolvePinnedCodexRolloutProof(evidence.home, evidence.threadId))) {
    return null
  }
  const terminal: CodexFailoverTerminal = {
    ptyId: pty.ptyId,
    incarnationId: pty.incarnationId,
    handle,
    home: evidence.home,
    threadId: evidence.threadId,
    workspaceId: pty.worktreeId,
    ...pane,
    recoveredProcess: evidence,
    ...(pty.launchConfig ? { agentArgs: pty.launchConfig.agentArgs } : {})
  }
  if (!isCurrent(terminal)) {
    return null
  }
  recordCodexPaneAccount(
    pty.ptyId,
    resolveCodexPaneLaunchAccount({
      pinnedByResume: true,
      launchCodexHomePath: evidence.home,
      systemCodexHomePath: getSystemCodexHomePath(),
      settings,
      target: { runtime: 'host' }
    })
  )
  return terminal
}
