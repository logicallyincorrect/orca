import type { GlobalSettings } from '../../shared/global-settings-types'
import { getSelectedCodexAccountIdForTarget } from '../codex-accounts/runtime-selection'
import {
  recordCodexPaneAccount,
  listRecordedCodexPaneAccounts,
  type CodexPaneHomeRoute
} from './codex-pane-account-registry'

export type StaleCodexPane = {
  ptyId: string
  launchAccountId: string | null
  activeAccountId: string | null
  reason: 'account-change' | 'home-route-change'
}

type CodexPaneSelectionCheck = {
  ptyIds: readonly string[]
  settings: GlobalSettings
  activeHostHomeRoute?: CodexPaneHomeRoute
}

/** Compares immutable launch attribution with the selected account in the same runtime. */
export function listStaleCodexPanes(args: CodexPaneSelectionCheck): StaleCodexPane[] {
  const stalePanes: StaleCodexPane[] = []
  const records = listRecordedCodexPaneAccounts(args.ptyIds)
  for (const ptyId of args.ptyIds) {
    const record = records.get(ptyId)
    if (!record) {
      continue
    }
    const activeAccountId = getSelectedCodexAccountIdForTarget(
      args.settings,
      parseSelectionLaneKey(record.selectionKey)
    )
    if (
      record.dismissedRestartTarget ===
      restartTarget(
        activeAccountId,
        record.selectionKey === 'host' ? args.activeHostHomeRoute : undefined
      )
    ) {
      continue
    }
    const homeRouteChanged =
      record.selectionKey === 'host' &&
      record.homeRoute !== undefined &&
      record.homeRoute !== 'custom-home' &&
      args.activeHostHomeRoute !== undefined &&
      record.homeRoute !== args.activeHostHomeRoute
    const accountChanged = record.accountId !== activeAccountId
    if (accountChanged || homeRouteChanged) {
      stalePanes.push({
        ptyId,
        launchAccountId: record.accountId,
        activeAccountId,
        reason: accountChanged ? 'account-change' : 'home-route-change'
      })
    }
  }
  return stalePanes
}

/** Retain the actual launch account for quota recovery after the warning is dismissed. */
export function dismissStaleCodexPanes(args: CodexPaneSelectionCheck): void {
  for (const [ptyId, record] of listRecordedCodexPaneAccounts(args.ptyIds)) {
    const accountId = getSelectedCodexAccountIdForTarget(
      args.settings,
      parseSelectionLaneKey(record.selectionKey)
    )
    recordCodexPaneAccount(ptyId, {
      ...record,
      dismissedRestartTarget: restartTarget(
        accountId,
        record.selectionKey === 'host' ? args.activeHostHomeRoute : undefined
      )
    })
  }
}

function restartTarget(
  accountId: string | null,
  homeRoute: CodexPaneHomeRoute | undefined
): string {
  return JSON.stringify([accountId, homeRoute ?? null])
}

function parseSelectionLaneKey(selectionKey: string): {
  runtime: 'host' | 'wsl'
  wslDistro: string | null
} {
  if (!selectionKey.startsWith('wsl:')) {
    return { runtime: 'host', wslDistro: null }
  }
  const distro = selectionKey.slice('wsl:'.length)
  // Why: the lane key round-trips through getCodexSelectionLaneKey, whose
  // default-distro sentinel must resolve back to "no specific distro".
  return { runtime: 'wsl', wslDistro: distro === '__default__' ? null : distro }
}
