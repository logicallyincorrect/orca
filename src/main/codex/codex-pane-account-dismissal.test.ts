import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import {
  _internals,
  getCodexPaneAccount,
  recordCodexPaneAccount
} from './codex-pane-account-registry'
import { dismissStaleCodexPanes, listStaleCodexPanes } from './codex-stale-pane-accounts'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-account-dismissal-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', root)
  _internals.resetCache()
})
afterEach(() => {
  _internals.resetCache()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function settings(host: string | null, wsl: Record<string, string | null> = {}) {
  return createGlobalSettingsFixture({
    activeCodexManagedAccountId: host,
    activeCodexManagedAccountIdsByRuntime: { host, wsl }
  })
}

describe('dismissed Codex account attribution', () => {
  it('keeps the actual account across restart and warns again for a different selection', () => {
    recordCodexPaneAccount('pty', {
      selectionKey: 'host',
      accountId: 'a',
      homeRoute: 'account-home'
    })
    const args = {
      ptyIds: ['pty'],
      settings: settings('b'),
      activeHostHomeRoute: 'account-home' as const
    }
    dismissStaleCodexPanes(args)
    _internals.resetCache()
    expect(getCodexPaneAccount('pty')).toMatchObject({ accountId: 'a', homeRoute: 'account-home' })
    expect(listStaleCodexPanes(args)).toEqual([])
    expect(listStaleCodexPanes({ ...args, settings: settings('c') })).toEqual([
      { ptyId: 'pty', launchAccountId: 'a', activeAccountId: 'c', reason: 'account-change' }
    ])
    expect(listStaleCodexPanes({ ...args, settings: settings('a') })).toEqual([])
  })

  it('does not let host selection changes revoke a dismissal for a WSL account', () => {
    recordCodexPaneAccount('pty', {
      selectionKey: 'wsl:Ubuntu',
      accountId: 'a',
      homeRoute: 'account-home'
    })
    const args = { ptyIds: ['pty'], settings: settings('host-a', { Ubuntu: 'b' }) }
    dismissStaleCodexPanes(args)
    expect(listStaleCodexPanes({ ...args, settings: settings('host-b', { Ubuntu: 'b' }) })).toEqual(
      []
    )
    expect(
      listStaleCodexPanes({ ...args, settings: settings('host-b', { Ubuntu: 'c' }) })
    ).toHaveLength(1)
  })

  it('drops the prior dismissal when a replacement PTY is attributed to its actual account', () => {
    recordCodexPaneAccount('pty', { selectionKey: 'host', accountId: 'a' })
    dismissStaleCodexPanes({ ptyIds: ['pty'], settings: settings('b') })
    recordCodexPaneAccount('pty', { selectionKey: 'host', accountId: 'b' })
    _internals.resetCache()
    expect(getCodexPaneAccount('pty')).toEqual({ selectionKey: 'host', accountId: 'b' })
  })
})
