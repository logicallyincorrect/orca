import { readCodexProcessLaunchEvidence } from '../codex/codex-process-launch-evidence'
import { randomUUID } from 'node:crypto'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import type { OrcaRuntimeService } from './orca-runtime'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import { readStructuredTuiProcessIdentity } from './structured-tui-process-identity'
import { readCodexResumeProcessIdentity } from '../codex/codex-resume-process-proof'
import { waitForStructuredTuiProcessExit } from './structured-tui-exit-proof'
import { resolvePinnedCodexRolloutProof } from '../codex/codex-tui-rollout-proof'
import {
  TerminalCodexAccountFailover,
  type CodexFailoverTerminal,
  type TerminalCodexFailoverDeps
} from './terminal-codex-account-failover'

export function createTerminalCodexFailover(
  input: {
    runtime: Pick<
      OrcaRuntimeService,
      | 'getTerminalAgentStatus'
      | 'getTerminalInteractiveWait'
      | 'closeTerminal'
      | 'ensureAgentSession'
      | 'waitForTerminal'
      | 'sendTerminalAgentPrompt'
    >
    controller: () => RuntimePtyController | null
    discoverContext?: TerminalCodexFailoverDeps['discoverContext']
    isCurrentTerminal?: (terminal: CodexFailoverTerminal) => boolean
  } & Pick<TerminalCodexFailoverDeps, 'enabled' | 'seamless' | 'accounts' | 'context'>
): TerminalCodexAccountFailover {
  const { runtime } = input
  const identities = new WeakMap<CodexFailoverTerminal, AgentSessionProcessIdentity>()
  const current = (terminal: CodexFailoverTerminal): boolean => {
    const context =
      input.context(terminal.ptyId) ??
      (terminal.recoveredProcess && input.isCurrentTerminal?.(terminal) ? terminal : null)
    return (
      agentSessionPtyWriteGate.boundSessionId(terminal.ptyId) === null &&
      context?.incarnationId === terminal.incarnationId &&
      context.threadId === terminal.threadId &&
      context.home === terminal.home
    )
  }
  const inventory = async (ptyId: string) =>
    (await input.controller()?.listProcesses?.(null))?.find((entry) => entry.id === ptyId)
  return new TerminalCodexAccountFailover({
    ...input,
    current,
    hold: (terminal) =>
      agentSessionPtyWriteGate.holdUnboundPtyForRecovery(terminal.ptyId, terminal.threadId),
    ready: async (terminal) => {
      const status = await runtime.getTerminalAgentStatus(terminal.handle)
      if (
        !status.isRunningAgent ||
        status.status !== 'idle' ||
        (await runtime.getTerminalInteractiveWait(terminal.handle)) !== null
      ) {
        return false
      }
      const process = await inventory(terminal.ptyId)
      if (
        !process?.rootProcessId ||
        process.incarnationId !== terminal.incarnationId ||
        process.wslDistro
      ) {
        return false
      }
      if (terminal.recoveredProcess) {
        const evidence = await readCodexProcessLaunchEvidence({
          rootPid: process.rootProcessId,
          paneKey: `${terminal.tabId}:${terminal.leafId}`,
          allowedHomes: [terminal.home]
        })
        if (
          !evidence ||
          evidence.pid !== terminal.recoveredProcess.pid ||
          evidence.processStartTimeMs !== terminal.recoveredProcess.processStartTimeMs ||
          evidence.threadId !== terminal.threadId
        ) {
          return false
        }
      }
      const identity = await readStructuredTuiProcessIdentity({
        hostId: 'local',
        rootPid: process.rootProcessId,
        spawnToken: randomUUID(),
        agent: 'codex'
      })
      identities.set(terminal, identity)
      return current(terminal)
    },
    stop: async (terminal) => {
      const identity = identities.get(terminal)
      if (!identity || !current(terminal)) {
        return false
      }
      const result = await runtime.closeTerminal(terminal.handle)
      if (!result.ptyKilled) {
        return false
      }
      await waitForStructuredTuiProcessExit({ identity })
      return true
    },
    resume: async (terminal, account) => {
      const result = await runtime.ensureAgentSession(
        {
          kind: 'explicit',
          worktree: `id:${terminal.workspaceId}`,
          agent: 'codex',
          providerSession: { key: 'session_id', id: terminal.threadId },
          placement: { tabId: terminal.tabId, leafId: terminal.leafId },
          ...(terminal.agentArgs !== undefined ? { agentArgs: terminal.agentArgs } : {}),
          presentation: 'background'
        },
        {},
        { spawnToken: randomUUID(), providerRoot: account.managedHomePath }
      )
      if (!result.terminal.ptyId || result.disposition !== 'created') {
        throw new Error('Codex recovery did not acquire a new terminal')
      }
      return { handle: result.terminal.handle, ptyId: result.terminal.ptyId }
    },
    prove: async (terminal, threadId, home) => {
      const wait = await runtime.waitForTerminal(terminal.handle, {
        condition: 'tui-idle',
        timeoutMs: 30_000
      })
      const process = await inventory(terminal.ptyId)
      if (
        !wait.satisfied ||
        !process?.rootProcessId ||
        !(await resolvePinnedCodexRolloutProof(home, threadId))
      ) {
        throw new Error('Resumed Codex conversation is unverifiable')
      }
      await readCodexResumeProcessIdentity({
        hostId: 'local',
        rootPid: process.rootProcessId,
        spawnToken: randomUUID(),
        threadId
      })
    },
    continue: async (terminal) => {
      await runtime.sendTerminalAgentPrompt(
        terminal.handle,
        'Continue from the interrupted turn. Preserve completed work and do not repeat completed tool actions.',
        {
          acceptQueued: true,
          requestId: randomUUID(),
          beforeWrite: () => {
            if (!input.enabled() || !input.seamless()) {
              throw new Error('Automatic continuation superseded')
            }
          }
        }
      )
    }
  })
}
