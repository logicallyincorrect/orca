import { beforeEach, expect, it, vi } from 'vitest'
import { prepareRecoveredCodexPaneRestart } from './codex-pane-restart-preparation'
const { retain } = vi.hoisted(() => ({ retain: vi.fn() }))
vi.mock('./codex-account-conversation-link', () => ({ retainCodexAccountConversation: retain }))
beforeEach(() => vi.clearAllMocks())
function fixture() {
  const terminal = {
    ptyId: 'pty',
    incarnationId: 'inc',
    handle: 'term',
    home: '/system',
    threadId: '11111111-1111-4111-8111-111111111111',
    workspaceId: 'folder:project',
    tabId: 'tab',
    leafId: 'leaf'
  }
  const homes = { resolveSelectedHostAccountCodexHomePathForResume: vi.fn(() => '/managed') }
  const recover = vi.fn(async () => terminal)
  return { homes, recover, terminal }
}
it('retains the exact history before preparing a managed account resume', async () => {
  const f = fixture()
  expect(await prepareRecoveredCodexPaneRestart(f.homes, f.recover)).toEqual({
    key: 'session_id',
    id: f.terminal.threadId
  })
  expect(retain).toHaveBeenCalledWith('/system', '/managed', f.terminal.threadId)
  expect(f.recover).toHaveBeenCalledTimes(2)
})
it('refuses a replaced process or selection changed during history preparation', async () => {
  for (const change of ['process', 'selection']) {
    const f = fixture()
    retain.mockImplementationOnce(async () => {
      if (change === 'selection') {
        f.homes.resolveSelectedHostAccountCodexHomePathForResume.mockReturnValue('/other')
      } else {
        f.recover.mockResolvedValue({ ...f.terminal, incarnationId: 'new' })
      }
    })
    await expect(prepareRecoveredCodexPaneRestart(f.homes, f.recover)).rejects.toThrow('changed')
  }
})
