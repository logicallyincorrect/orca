import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  prepareCodexAccountRestartStartup,
  resolveCodexAccountRestartStartup
} from './codex-account-restart-startup'

const THREAD = '11111111-1111-4111-8111-111111111111'
const PANE = 'tab:leaf'

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    agentStatusByPaneKey: {
      [PANE]: {
        paneKey: PANE,
        agentType: 'codex',
        state: 'done',
        prompt: '',
        updatedAt: 1,
        stateStartedAt: 1,
        stateHistory: [],
        providerSession: {
          key: 'session_id',
          id: THREAD,
          transcriptPath: '/old-account/rollout.jsonl'
        }
      }
    }
  })
})

describe('Codex account restart identity', () => {
  it('resumes the exact completed conversation without pinning the previous account home', () => {
    const startup = resolveCodexAccountRestartStartup(
      useAppStore.getState(),
      'folder:project',
      'tab',
      'leaf'
    )
    expect(startup.command).toBe(`codex 'resume' '${THREAD}'`)
    expect(startup.launchAgent).toBe('codex')
    expect(startup.startupCommandDelivery).toBe('shell-ready')
    expect(startup.resumeProviderSession).toBeUndefined()
    expect(startup.env?.CODEX_HOME).toBeUndefined()
  })

  it.each(['missing', 'restored', 'different-agent', 'invalid-id'] as const)(
    'refuses %s identity before a restart can dispose the live terminal',
    (kind) => {
      const state = useAppStore.getState()
      const entry = state.agentStatusByPaneKey[PANE]!
      if (kind === 'missing') {
        entry.providerSession = undefined
      }
      if (kind === 'restored') {
        entry.restoredUnconfirmed = true
      }
      if (kind === 'different-agent') {
        entry.agentType = 'claude'
      }
      if (kind === 'invalid-id') {
        entry.providerSession = { key: 'session_id', id: '--last' }
      }
      expect(() =>
        resolveCodexAccountRestartStartup(state, 'folder:project', 'tab', 'leaf')
      ).toThrow('identity is unavailable')
    }
  )
})

it('prepares the verified live conversation when old hook identity is missing', async () => {
  useAppStore.setState({ agentStatusByPaneKey: {} })
  const preparePaneRestart = vi.fn(async () => ({ key: 'session_id', id: THREAD }))
  vi.stubGlobal('window', { api: { codexAccounts: { preparePaneRestart } } })
  try {
    const startup = await prepareCodexAccountRestartStartup(
      useAppStore.getState(),
      'folder:project',
      'tab',
      'leaf',
      'old-pty'
    )
    expect(preparePaneRestart).toHaveBeenCalledWith({ ptyId: 'old-pty' })
    expect(startup.command).toBe(`codex 'resume' '${THREAD}'`)
    expect(startup.resumeProviderSession).toBeUndefined()
  } finally {
    vi.unstubAllGlobals()
  }
})
