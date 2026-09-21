import type { CodexFailoverTerminal } from '../runtime/terminal-codex-account-failover'
import { prepareRecoveredCodexPaneRestart } from '../codex/codex-pane-restart-preparation'
import { ipcMain } from 'electron'
import type { CodexAccountAddTarget, CodexAccountService } from '../codex-accounts/service'
import type { CodexAccountSelectionTarget } from '../codex-accounts/runtime-selection'
import { getCodexPaneAccount, listRecordedCodexPaneLanes } from '../codex/codex-pane-account-registry'
import { dismissStaleCodexPanes, listStaleCodexPanes } from '../codex/codex-stale-pane-accounts'
import type { GlobalSettings } from '../../shared/global-settings-types'

export function registerCodexAccountHandlers(
  codexAccounts: CodexAccountService,
  getSettings?: () => GlobalSettings,
  recoverPane?: (ptyId: string) => Promise<CodexFailoverTerminal | null>
): void {
  ipcMain.handle('codexAccounts:listStalePanes', async (_event, args: { ptyIds?: unknown }) => {
    const settings = getSettings?.()
    if (!settings || !Array.isArray(args?.ptyIds)) {
      return []
    }
    for (const ptyId of args.ptyIds) {
      if (typeof ptyId === 'string' && !getCodexPaneAccount(ptyId)) {
        await recoverPane?.(ptyId)
      }
    }
    return listStaleCodexPanes({
      ptyIds: args.ptyIds.filter((ptyId): ptyId is string => typeof ptyId === 'string'),
      settings: getSettings?.() ?? settings,
      activeHostHomeRoute: codexAccounts.runtimeHomeService.getSelectedHostCodexHomeRoute()
    })
  })
  ipcMain.handle('codexAccounts:preparePaneRestart', (_event, args: { ptyId?: unknown }) => {
    const ptyId = args?.ptyId
    if (typeof ptyId !== 'string' || !recoverPane) {
      throw new Error('Codex conversation identity is unavailable.')
    }
    return prepareRecoveredCodexPaneRestart(codexAccounts.runtimeHomeService, () =>
      recoverPane(ptyId)
    )
  })
  ipcMain.handle('codexAccounts:listRecordedPaneLanes', (_event, args: { ptyIds?: unknown }) => {
    if (!Array.isArray(args?.ptyIds)) {
      return {}
    }
    return listRecordedCodexPaneLanes(
      args.ptyIds.filter((ptyId): ptyId is string => typeof ptyId === 'string')
    )
  })
  ipcMain.handle('codexAccounts:forgetStalePanes', (_event, args: { ptyIds?: unknown }) => {
    const settings = getSettings?.()
    if (!settings || !Array.isArray(args?.ptyIds)) {
      return
    }
    dismissStaleCodexPanes({
      ptyIds: args.ptyIds.filter((ptyId): ptyId is string => typeof ptyId === 'string'),
      settings,
      activeHostHomeRoute: codexAccounts.runtimeHomeService.getSelectedHostCodexHomeRoute()
    })
  })
  ipcMain.handle('codexAccounts:list', () => codexAccounts.listAccounts())
  ipcMain.handle('codexAccounts:add', (_event, args?: CodexAccountAddTarget) =>
    codexAccounts.addAccount(args)
  )
  ipcMain.handle(
    'codexAccounts:reauthenticate',
    (_event, args: { accountId: string; activateIfSelectionWasEmpty?: boolean }) =>
      codexAccounts.reauthenticateAccount(args.accountId, {
        activateIfSelectionWasEmpty: args.activateIfSelectionWasEmpty === true
      })
  )
  ipcMain.handle('codexAccounts:remove', (_event, args: { accountId: string }) =>
    codexAccounts.removeAccount(args.accountId)
  )
  ipcMain.handle(
    'codexAccounts:select',
    (_event, args: { accountId: string | null } & CodexAccountSelectionTarget) => {
      if (!args.runtime) {
        // Why: older renderer surfaces selected by account id only. Let the
        // service infer the account's runtime instead of treating missing
        // runtime as Windows/host and rejecting valid WSL accounts.
        return codexAccounts.selectAccount(args.accountId)
      }
      return codexAccounts.selectAccountForTarget(args.accountId, args)
    }
  )
}
