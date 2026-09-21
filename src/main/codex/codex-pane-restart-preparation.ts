import type { CodexAccountService } from '../codex-accounts/service'
import type { CodexFailoverTerminal } from '../runtime/terminal-codex-account-failover'
import { retainCodexAccountConversation } from './codex-account-conversation-link'

export async function prepareRecoveredCodexPaneRestart(
  homes: Pick<
    CodexAccountService['runtimeHomeService'],
    'resolveSelectedHostAccountCodexHomePathForResume'
  >,
  recover: () => Promise<CodexFailoverTerminal | null>
): Promise<{ key: 'session_id'; id: string }> {
  const terminal = await recover()
  if (!terminal) {
    throw new Error(
      'Codex conversation identity is unavailable. Resume this conversation manually.'
    )
  }
  const home = homes.resolveSelectedHostAccountCodexHomePathForResume()
  if (!home) {
    throw new Error('Select a managed Codex account before restarting this conversation.')
  }
  await retainCodexAccountConversation(terminal.home, home, terminal.threadId)
  const current = await recover()
  if (
    !current ||
    current.incarnationId !== terminal.incarnationId ||
    current.threadId !== terminal.threadId ||
    current.home !== terminal.home ||
    homes.resolveSelectedHostAccountCodexHomePathForResume() !== home
  ) {
    throw new Error('Codex account or conversation changed. Try restarting again.')
  }
  return { key: 'session_id', id: terminal.threadId }
}
