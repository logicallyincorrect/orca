import { OrcaRuntimeService } from './orca-runtime'
import { beforeEach, expect, it, vi } from 'vitest'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { createCodexAccountSettings } from '../codex-accounts/codex-account-settings-fixture'
import { recoverTerminalCodexContext } from './terminal-codex-recovered-context'

const { evidence, rollout, record } = vi.hoisted(() => ({
  evidence: vi.fn(),
  rollout: vi.fn(),
  record: vi.fn()
}))
vi.mock('../codex/codex-process-launch-evidence', () => ({
  readCodexProcessLaunchEvidence: evidence
}))
vi.mock('../codex/codex-tui-rollout-proof', () => ({ resolvePinnedCodexRolloutProof: rollout }))
vi.mock('../codex/codex-pane-account-registry', () => ({ recordCodexPaneAccount: record }))
const tabId = '11111111-1111-4111-8111-111111111111'
const leafId = '22222222-2222-4222-8222-222222222222'
const threadId = '33333333-3333-4333-8333-333333333333'
beforeEach(() => {
  vi.clearAllMocks()
  evidence.mockResolvedValue({
    pid: 42,
    processStartTimeMs: 1,
    home: getSystemCodexHomePath(),
    threadId
  })
  rollout.mockResolvedValue('/verified/rollout.jsonl')
})
function fixture() {
  const input: Parameters<typeof recoverTerminalCodexContext>[0] = {
    pty: {
      ptyId: 'pty',
      connected: true,
      incarnationId: 'inc',
      connectionId: null,
      isWsl: false,
      wslDistro: null,
      paneKey: `${tabId}:${leafId}`,
      launchAgent: 'codex',
      foregroundAgent: 'codex',
      launchToken: null,
      launchConfig: null,
      worktreeId: 'folder:project'
    },
    handle: 'term',
    settings: createCodexAccountSettings('/workspace'),
    rows: []
  }
  const controller = {
    write: vi.fn(() => true),
    kill: vi.fn(() => true),
    resize: vi.fn(),
    getForegroundProcess: vi.fn(async () => 'codex'),
    listProcesses: vi.fn(async () => [
      { id: 'pty', rootProcessId: 40, incarnationId: 'inc', cwd: '/workspace', title: 'Codex' }
    ])
  }
  return { input, controller }
}
it('recovers an old System default terminal without hook or account records', async () => {
  const f = fixture()
  expect(await recoverTerminalCodexContext(f.input, f.controller, () => true)).toMatchObject({
    home: getSystemCodexHomePath(),
    threadId,
    tabId,
    leafId,
    workspaceId: 'folder:project'
  })
  expect(record).toHaveBeenCalledWith('pty', {
    selectionKey: 'host',
    accountId: null,
    homeRoute: 'real-home'
  })
})
it.each(['ssh', 'wsl', 'replaced', 'missing-rollout'] as const)(
  'does not attribute %s evidence',
  async (kind) => {
    const f = fixture()
    if (kind === 'ssh') {
      f.input.pty!.connectionId = 'ssh'
    }
    if (kind === 'wsl') {
      f.input.pty!.isWsl = true
    }
    if (kind === 'missing-rollout') {
      rollout.mockResolvedValue(null)
    }
    expect(
      await recoverTerminalCodexContext(f.input, f.controller, () => kind !== 'replaced')
    ).toBeNull()
    expect(record).not.toHaveBeenCalled()
  }
)

it('uses verified process identity when reattachment has not restored agent labels', async () => {
  const f = fixture()
  f.input.pty!.launchAgent = null
  f.input.pty!.foregroundAgent = null
  expect(await recoverTerminalCodexContext(f.input, f.controller, () => true)).toMatchObject({
    threadId
  })
  expect(record).toHaveBeenCalledOnce()
})

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

it('resolves a restored renderer handle without requiring a prior CLI lookup', async () => {
  const f = fixture()
  const runtime = new OrcaRuntimeService(null)
  Object.assign(runtime, {
    store: { getSettings: () => f.input.settings },
    ptyController: f.controller,
    ptysById: new Map([['pty', f.input.pty]]),
    handleByPtyId: new Map(),
    handleByPtyIncarnation: new Map([['pty', { incarnationId: 'inc', handle: 'renderer-handle' }]])
  })
  expect(await runtime.recoverCodexTerminalContext('pty')).toMatchObject({
    handle: 'renderer-handle',
    threadId,
    home: getSystemCodexHomePath()
  })
})
