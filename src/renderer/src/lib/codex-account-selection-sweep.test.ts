import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import {
  notifyCodexPaneBoundForStaleSweep,
  resetCodexStalePaneSweepForTests,
  sweepChangedCodexAccountSelection
} from './codex-stale-pane-sweep'

const { scan } = vi.hoisted(() => ({ scan: vi.fn() }))
vi.mock('./codex-session-restart', () => ({ markRestoredStaleCodexSessionsForRestart: scan }))

beforeEach(() => {
  vi.useFakeTimers()
  scan
    .mockReset()
    .mockResolvedValue([
      { ptyId: 'pty', eligible: true, inconclusive: false, launchedCodex: true, notified: true }
    ])
  resetCodexStalePaneSweepForTests()
})
afterEach(() => {
  resetCodexStalePaneSweepForTests()
  vi.useRealTimers()
})

function settings(host: string | null, wsl: Record<string, string | null> = {}) {
  return createGlobalSettingsFixture({
    activeCodexManagedAccountId: host,
    activeCodexManagedAccountIdsByRuntime: { host, wsl }
  })
}

describe('account changes recheck retained Codex panes', () => {
  it('rechecks a previously warned pane without requiring a rebind', async () => {
    notifyCodexPaneBoundForStaleSweep('pty')
    await vi.advanceTimersByTimeAsync(300)
    expect(scan).toHaveBeenCalledTimes(1)
    sweepChangedCodexAccountSelection(
      {
        settings: settings('b'),
        ptyIdsByTabId: { hiddenTab: ['pty'] }
      },
      settings('a')
    )
    await vi.advanceTimersByTimeAsync(300)
    expect(scan).toHaveBeenCalledTimes(2)
    expect(scan).toHaveBeenLastCalledWith({ ptyIds: ['pty'] })
  })

  it('does not poll on unrelated settings updates or equal cloned selections', async () => {
    const previous = settings('a', { Ubuntu: 'wsl-a' })
    sweepChangedCodexAccountSelection(
      {
        settings: { ...settings('a', { Ubuntu: 'wsl-a' }), codexAutomaticFailover: true },
        ptyIdsByTabId: { tab: ['pty'] }
      },
      previous
    )
    await vi.advanceTimersByTimeAsync(60_000)
    expect(scan).not.toHaveBeenCalled()
  })

  it('checks WSL selection changes and excludes terminals owned by other machines', async () => {
    sweepChangedCodexAccountSelection(
      {
        settings: settings('a', { Ubuntu: 'wsl-b' }),
        ptyIdsByTabId: { tab: ['pty', 'remote:env-1@@terminal-1', 'ssh:host@@pty-1'] }
      },
      settings('a', { Ubuntu: 'wsl-a' })
    )
    await vi.advanceTimersByTimeAsync(300)
    expect(scan).toHaveBeenCalledExactlyOnceWith({ ptyIds: ['pty'] })
  })
})
