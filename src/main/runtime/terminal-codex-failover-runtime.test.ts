import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import type { CodexAccountFailoverInput } from '../codex-accounts/codex-account-failover'
import type { CodexFailoverTerminal } from './terminal-codex-account-failover'
import { createTerminalCodexFailover } from './terminal-codex-failover-runtime'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'

const { identify, identifyResume, probe, rollout } = vi.hoisted(() => ({
  identify: vi.fn(),
  identifyResume: vi.fn(),
  probe: vi.fn(),
  rollout: vi.fn()
}))
vi.mock('./structured-tui-process-identity', () => ({ readStructuredTuiProcessIdentity: identify }))
vi.mock('../codex/codex-resume-process-proof', () => ({
  readCodexResumeProcessIdentity: identifyResume
}))
vi.mock('./agent-session-process-identity-probe', () => ({
  probeAgentSessionProcessIdentity: probe
}))
vi.mock('../codex/codex-tui-rollout-proof', () => ({ resolvePinnedCodexRolloutProof: rollout }))
vi.mock('../codex/codex-account-conversation-link', () => ({
  retainCodexAccountConversation: vi.fn()
}))

const ERROR = '\n■ You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage'
const THREAD = '11111111-1111-4111-8111-111111111111'
beforeEach(() => {
  vi.resetAllMocks()
  agentSessionPtyWriteGate.detachRecordLookup()
  identify.mockResolvedValue({ hostId: 'local', pid: 42, processStartTimeMs: 1, spawnToken: 'old' })
  identifyResume.mockResolvedValue({
    hostId: 'local',
    pid: 43,
    processStartTimeMs: 2,
    spawnToken: 'new'
  })
  probe.mockResolvedValue({ outcome: 'pid-absent' })
  rollout.mockResolvedValue('/b/sessions/thread.jsonl')
})

function fixture() {
  const terminal: CodexFailoverTerminal = {
    ptyId: 'old',
    incarnationId: 'inc-old',
    handle: 'term-old',
    home: '/a',
    threadId: THREAD,
    workspaceId: 'folder:project',
    tabId: 'tab',
    leafId: 'leaf',
    agentArgs: '--model custom-model'
  }
  const account = {
    id: 'b',
    email: 'b@example.test',
    managedHomePath: '/b',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
  const runtime = {
    getTerminalAgentStatus: vi
      .fn<OrcaRuntimeService['getTerminalAgentStatus']>()
      .mockResolvedValue({
        handle: 'term-old',
        isRunningAgent: true,
        status: 'idle'
      }),
    getTerminalInteractiveWait: vi
      .fn<OrcaRuntimeService['getTerminalInteractiveWait']>()
      .mockResolvedValue(null),
    closeTerminal: vi.fn<OrcaRuntimeService['closeTerminal']>().mockResolvedValue({
      handle: 'term-old',
      tabId: 'tab',
      ptyKilled: true
    }),
    ensureAgentSession: vi.fn<OrcaRuntimeService['ensureAgentSession']>().mockResolvedValue({
      disposition: 'created',
      terminal: {
        handle: 'term-new',
        ptyId: 'new',
        worktreeId: terminal.workspaceId,
        title: 'Codex'
      }
    }),
    waitForTerminal: vi.fn<OrcaRuntimeService['waitForTerminal']>().mockResolvedValue({
      handle: 'term-new',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    }),
    sendTerminalAgentPrompt: vi
      .fn<OrcaRuntimeService['sendTerminalAgentPrompt']>()
      .mockResolvedValue({
        handle: 'term-new',
        accepted: true,
        bytesWritten: 100
      })
  }
  const controller = {
    write: vi.fn(() => true),
    kill: vi.fn(() => true),
    getForegroundProcess: vi.fn(async () => 'codex'),
    listProcesses: vi.fn(async () => [
      { id: 'old', rootProcessId: 40, incarnationId: 'inc-old', cwd: '/workspace', title: 'Codex' },
      { id: 'new', rootProcessId: 41, incarnationId: 'inc-new', cwd: '/workspace', title: 'Codex' }
    ])
  }
  const automation = { isExhausted: vi.fn(async () => true), reportFailure: vi.fn() }
  const failover = vi.fn(async (input: CodexAccountFailoverInput) => {
    expect(agentSessionPtyWriteGate.admit('old').admitted).toBe(false)
    await input.migrate(account, () => true)
    return true
  })
  const recovery = createTerminalCodexFailover({
    runtime,
    controller: () => controller,
    enabled: () => true,
    seamless: () => true,
    accounts: () => ({ failover, automation }),
    context: () => terminal
  })
  const observe = () => recovery.observe('old', 'inc-old', ERROR)
  return { runtime, controller, recovery, observe, automation, failover, terminal }
}

describe('terminal account recovery host wiring', () => {
  it('resumes the explicit thread in the same folder pane and continues only after proof', async () => {
    const f = fixture()
    f.observe()
    await vi.waitFor(() => expect(f.runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce())
    expect(f.runtime.closeTerminal).toHaveBeenCalledWith('term-old')
    expect(f.runtime.ensureAgentSession).toHaveBeenCalledWith(
      {
        kind: 'explicit',
        worktree: 'id:folder:project',
        agent: 'codex',
        providerSession: { key: 'session_id', id: THREAD },
        placement: { tabId: 'tab', leafId: 'leaf' },
        agentArgs: '--model custom-model',
        presentation: 'background'
      },
      {},
      { spawnToken: expect.any(String), providerRoot: '/b' }
    )
    expect(identifyResume).toHaveBeenCalledWith(
      expect.objectContaining({ rootPid: 41, threadId: THREAD })
    )
    expect(agentSessionPtyWriteGate.admit('old').admitted).toBe(true)
  })

  it.each(['identity-matched', 'unverifiable'])(
    'does not resume after exit probe %s',
    async (outcome) => {
      const f = fixture()
      probe.mockResolvedValue({ outcome })
      f.observe()
      await vi.waitFor(() => expect(f.automation.reportFailure).toHaveBeenCalledOnce(), {
        timeout: 8000
      })
      expect(f.runtime.ensureAgentSession).not.toHaveBeenCalled()
    }
  )

  it('waits for a terminating Codex child instead of racing its shell exit', async () => {
    const f = fixture()
    probe
      .mockResolvedValueOnce({ outcome: 'identity-matched' })
      .mockResolvedValue({ outcome: 'pid-absent' })
    f.observe()
    await vi.waitFor(() => expect(f.runtime.sendTerminalAgentPrompt).toHaveBeenCalledOnce())
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('does not continue when resume unexpectedly adopts another live owner', async () => {
    const f = fixture()
    f.runtime.ensureAgentSession.mockResolvedValue({
      disposition: 'adopted',
      terminal: {
        handle: 'other',
        ptyId: 'other',
        worktreeId: 'folder:project',
        title: 'Codex'
      }
    })
    f.observe()
    await vi.waitFor(() => expect(f.automation.reportFailure).toHaveBeenCalledOnce())
    expect(f.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('does not submit a continuation into a startup dialog', async () => {
    const f = fixture()
    f.runtime.waitForTerminal.mockResolvedValue({
      handle: 'term-new',
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null,
      blockedReason: 'codex-trust-workspace'
    })
    f.observe()
    await vi.waitFor(() => expect(f.automation.reportFailure).toHaveBeenCalledOnce())
    expect(f.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('refuses a changed PTY incarnation before stopping anything', async () => {
    const f = fixture()
    f.controller.listProcesses.mockResolvedValue([
      {
        id: 'old',
        rootProcessId: 40,
        incarnationId: 'replacement',
        cwd: '/workspace',
        title: 'Codex'
      }
    ])
    f.observe()
    await vi.waitFor(() => expect(f.controller.listProcesses).toHaveBeenCalledTimes(4), {
      timeout: 2000
    })
    expect(f.runtime.closeTerminal).not.toHaveBeenCalled()
  })
})
