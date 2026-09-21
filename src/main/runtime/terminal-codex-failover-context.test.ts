import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveTerminalCodexFailoverContext } from './terminal-codex-failover-context'
import { createCodexAccountSettings } from '../codex-accounts/codex-account-settings-fixture'

const { attribution } = vi.hoisted(() => ({ attribution: vi.fn() }))
vi.mock('../codex/codex-pane-account-registry', () => ({ getCodexPaneAccount: attribution }))

beforeEach(() => {
  attribution.mockReturnValue({ accountId: 'a', selectionKey: 'host', homeRoute: 'account-home' })
})

function fixture(): Parameters<typeof resolveTerminalCodexFailoverContext>[0] {
  const paneKey = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'
  return {
    pty: {
      ptyId: 'pty',
      connected: true,
      incarnationId: 'inc',
      connectionId: null,
      isWsl: false,
      wslDistro: null,
      paneKey,
      launchAgent: 'codex',
      foregroundAgent: 'codex',
      launchToken: 'launch',
      launchConfig: null,
      worktreeId: 'folder:project'
    },
    handle: 'term',
    settings: createCodexAccountSettings('/workspace', {
      codexManagedAccounts: [
        {
          id: 'a',
          email: 'a@example.test',
          managedHomePath: '/a',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ]
    }),
    rows: [
      {
        paneKey,
        connectionId: null,
        launchToken: 'launch',
        agentType: 'codex',
        state: 'done',
        prompt: 'Continue the task',
        receivedAt: Date.now(),
        stateStartedAt: Date.now(),
        providerSession: { key: 'session_id', id: '33333333-3333-4333-8333-333333333333' }
      }
    ]
  }
}

describe('terminal failover execution ownership', () => {
  it('uses the live pane account and exact hook thread, including folder workspaces', () => {
    expect(resolveTerminalCodexFailoverContext(fixture())).toMatchObject({
      home: '/a',
      threadId: '33333333-3333-4333-8333-333333333333',
      workspaceId: 'folder:project'
    })
  })

  it('keeps exact launch-token identity after a long-running turn', () => {
    const f = fixture()
    const row = f.rows[0]
    if (!row) {
      throw new Error('missing fixture hook')
    }
    row.receivedAt = 1
    expect(resolveTerminalCodexFailoverContext(f)?.home).toBe('/a')
  })

  it.each(['ssh', 'wsl', 'disconnected', 'shell'] as const)('refuses %s execution', (kind) => {
    const f = fixture()
    if (!f.pty) {
      throw new Error('missing fixture PTY')
    }
    if (kind === 'ssh') {
      f.pty.connectionId = 'ssh-owner'
    }
    if (kind === 'wsl') {
      f.pty.isWsl = true
    }
    if (kind === 'disconnected') {
      f.pty.connected = false
    }
    if (kind === 'shell') {
      f.pty.launchAgent = null
      f.pty.foregroundAgent = null
    }
    expect(resolveTerminalCodexFailoverContext(f)).toBeNull()
  })

  it.each(['stale', 'restored', 'different-launch', 'subagent'] as const)(
    'refuses %s hook evidence',
    (kind) => {
      const f = fixture()
      const row = f.rows[0]
      if (!row) {
        throw new Error('missing fixture hook')
      }
      if (kind === 'stale') {
        row.receivedAt = 1
        if (f.pty) {
          f.pty.launchToken = null
        }
      }
      if (kind === 'restored') {
        row.restoredUnconfirmed = true
      }
      if (kind === 'different-launch') {
        row.launchToken = 'another-launch'
      }
      if (kind === 'subagent') {
        row.subagents = [{ id: 'child', state: 'working', startedAt: 1 }]
      }
      expect(resolveTerminalCodexFailoverContext(f)).toBeNull()
    }
  )

  it('does not infer an account from an unattributed custom home', () => {
    attribution.mockReturnValue({ accountId: 'a', selectionKey: 'host', homeRoute: 'custom-home' })
    expect(resolveTerminalCodexFailoverContext(fixture())).toBeNull()
  })
})

it('resolves a System default terminal with an exact live conversation', () => {
  attribution.mockReturnValue({ accountId: null, selectionKey: 'host', homeRoute: 'real-home' })
  expect(resolveTerminalCodexFailoverContext(fixture())).toMatchObject({
    home: getSystemCodexHomePath(),
    threadId: '33333333-3333-4333-8333-333333333333'
  })
})
