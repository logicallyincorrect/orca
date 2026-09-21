import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane } from './agent-transcript-pane-test-harness'
import {
  TerminalCodexAccountFailover,
  type CodexFailoverTerminal
} from './terminal-codex-account-failover'
import type { CodexAccountFailoverInput } from '../codex-accounts/codex-account-failover'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const THREAD = '11111111-1111-4111-8111-111111111111'
const ERROR =
  '■ You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at\nSep 19th, 2026 6:42 AM.'
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-terminal-failover-'))
  roots.push(root)
  const home = join(root, 'a')
  const targetHome = join(root, 'b')
  const relative = join('sessions', '2026', '09', '17', `rollout-capture-${THREAD}.jsonl`)
  const source = join(home, relative)
  await mkdir(join(home, 'sessions', '2026', '09', '17'), { recursive: true })
  await writeFile(source, `${JSON.stringify({ type: 'session_meta', payload: { id: THREAD } })}\n`)
  const terminal: CodexFailoverTerminal = {
    ptyId: 'pty-1',
    incarnationId: 'inc-1',
    handle: 'term-1',
    threadId: THREAD,
    home,
    workspaceId: 'folder:workspace',
    tabId: 'tab-1',
    leafId: 'leaf-1'
  }
  const account = {
    id: 'b',
    email: 'b@example.test',
    managedHomePath: targetHome,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
  const release = vi.fn()
  const automation = { isExhausted: vi.fn(async () => true), reportFailure: vi.fn() }
  const select = vi.fn()
  const failover = vi.fn(async (input: CodexAccountFailoverInput) => {
    if (!input.isSafe()) {
      return false
    }
    await input.migrate(account, () => true)
    select()
    return true
  })
  const deps = {
    enabled: vi.fn(() => true),
    seamless: vi.fn(() => true),
    accounts: () => ({ failover, automation }),
    context: vi.fn<(ptyId: string) => CodexFailoverTerminal | null>(() => terminal),
    current: vi.fn(() => true),
    ready: vi.fn(async () => true),
    hold: vi.fn(() => release),
    stop: vi.fn(async () => true),
    resume: vi.fn(async () => ({ handle: 'term-2', ptyId: 'pty-2' })),
    prove: vi.fn(async () => {}),
    continue: vi.fn(async () => {})
  }
  const coordinator = new TerminalCodexAccountFailover(deps)
  const observe = () => coordinator.observe('pty-1', 'inc-1', `\n${ERROR}`)
  return {
    root,
    home,
    targetHome,
    relative,
    source,
    terminal,
    account,
    release,
    automation,
    select,
    failover,
    deps,
    coordinator,
    observe
  }
}

describe('terminal Codex account recovery', () => {
  it('replays captured PTY bytes through onPtyData and resumes exactly once', async () => {
    const f = await fixture()
    const observe = f.coordinator.observe.bind(f.coordinator)
    vi.spyOn(TerminalCodexAccountFailover.prototype, 'observe').mockImplementation(observe)
    const data = await readFile(
      join(import.meta.dirname, '__fixtures__', 'codex-usage-limit.txt'),
      'utf8'
    )
    expect(data).toContain('\u001b[')
    const { runtime } = await createTranscriptPane({
      paneTitle: 'Codex',
      foregroundProcess: 'codex',
      data: ''
    })
    for (let i = 0; i < data.length; i += 37) {
      runtime.onPtyData('pty-1', data.slice(i, i + 37), Date.now())
    }
    await vi.waitFor(() => expect(f.deps.continue).toHaveBeenCalledOnce())
    expect(f.failover).toHaveBeenCalledOnce()
    expect(f.deps.resume).toHaveBeenCalledWith(f.terminal, f.account)
    expect(f.deps.prove).toHaveBeenCalledWith(
      { handle: 'term-2', ptyId: 'pty-2' },
      THREAD,
      f.targetHome
    )
    expect((await stat(join(f.targetHome, f.relative))).ino).toBe((await stat(f.source)).ino)
    expect(f.deps.stop.mock.invocationCallOrder[0]).toBeLessThan(
      f.select.mock.invocationCallOrder[0]!
    )
    expect(f.select.mock.invocationCallOrder[0]).toBeLessThan(
      f.deps.resume.mock.invocationCallOrder[0]!
    )
    expect(f.deps.prove.mock.invocationCallOrder[0]).toBeLessThan(
      f.deps.continue.mock.invocationCallOrder[0]!
    )
    expect(f.release).toHaveBeenCalledOnce()
  })

  it.each(['Rate limit exceeded', 'Authentication failed', `› ${ERROR}`])(
    'does not treat %s as a quota failure',
    async (text) => {
      const f = await fixture()
      f.coordinator.observe('pty-1', 'inc-1', text)
      expect(f.failover).not.toHaveBeenCalled()
    }
  )

  it('detects the usage message when the terminal omits Codex’s decorative marker', async () => {
    const f = await fixture()
    f.coordinator.observe('pty-1', 'inc-1', ERROR.replace('■ ', ''))
    await vi.waitFor(() => expect(f.deps.continue).toHaveBeenCalledOnce())
    expect(f.failover).toHaveBeenCalledOnce()
  })

  it('requires fresh exhausted quota even when the terminal prints the exact message', async () => {
    const f = await fixture()
    f.automation.isExhausted.mockResolvedValue(false)
    f.observe()
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
    expect(f.failover).not.toHaveBeenCalled()
    expect(f.deps.stop).not.toHaveBeenCalled()
  })

  it('can recover a later quota failure after replaying an old error on a healthy account', async () => {
    const f = await fixture()
    f.automation.isExhausted.mockResolvedValueOnce(false)
    f.observe()
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
    f.observe()
    await vi.waitFor(() => expect(f.deps.continue).toHaveBeenCalledOnce())
  })

  it('does not touch a terminal already held by another owner', async () => {
    const f = await fixture()
    vi.spyOn(f.deps, 'hold').mockImplementation(() => null)
    f.observe()
    await vi.waitFor(() => expect(f.deps.hold).toHaveBeenCalledOnce())
    expect(f.failover).not.toHaveBeenCalled()
  })

  it('does not stop the conversation if all alternatives are unavailable', async () => {
    const f = await fixture()
    f.failover.mockResolvedValue(false)
    f.observe()
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
    expect(f.deps.stop).not.toHaveBeenCalled()
    expect(f.deps.resume).not.toHaveBeenCalled()
  })

  it.each(['disabled', 'replaced'] as const)(
    'cancels if %s while reading quota',
    async (reason) => {
      const f = await fixture()
      f.automation.isExhausted.mockImplementation(async () => {
        if (reason === 'disabled') {
          f.deps.enabled.mockReturnValue(false)
        } else {
          f.deps.current.mockReturnValue(false)
        }
        return true
      })
      f.observe()
      await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
      expect(f.deps.stop).not.toHaveBeenCalled()
    }
  )

  it('waits for the finished hook following the quota paint', async () => {
    const f = await fixture()
    f.deps.ready.mockResolvedValueOnce(false)
    f.observe()
    await vi.waitFor(() => expect(f.deps.continue).toHaveBeenCalledOnce())
  })

  it.each(['identity', 'idle'] as const)(
    'reports an unverifiable %s instead of silently stopping',
    async (guard) => {
      const f = await fixture()
      if (guard === 'identity') {
        vi.spyOn(f.deps, 'context').mockImplementation(() => null)
      } else {
        f.deps.ready.mockResolvedValue(false)
      }
      f.observe()
      await vi.waitFor(() => expect(f.automation.reportFailure).toHaveBeenCalledOnce(), {
        timeout: 2000
      })
      expect(f.automation.reportFailure).toHaveBeenCalledWith(
        expect.stringContaining(guard === 'identity' ? 'conversation identity' : 'verified as idle')
      )
      expect(f.deps.stop).not.toHaveBeenCalled()
      expect(f.deps.resume).not.toHaveBeenCalled()
    }
  )

  it('refuses a terminal that starts working during history preparation', async () => {
    const f = await fixture()
    f.deps.ready.mockResolvedValueOnce(true).mockResolvedValue(false)
    f.observe()
    await vi.waitFor(() => expect(f.automation.reportFailure).toHaveBeenCalledOnce())
    expect(f.deps.stop).not.toHaveBeenCalled()
  })

  it('never launches over an unverifiable old process', async () => {
    const f = await fixture()
    f.deps.stop.mockResolvedValue(false)
    f.observe()
    await vi.waitFor(() => expect(f.automation.reportFailure).toHaveBeenCalledOnce())
    expect(f.select).not.toHaveBeenCalled()
    expect(f.deps.resume).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('resumes without submitting when continuation is disabled', async () => {
    const f = await fixture()
    f.deps.seamless.mockReturnValue(false)
    f.observe()
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
    expect(f.deps.prove).toHaveBeenCalledOnce()
    expect(f.deps.continue).not.toHaveBeenCalled()
  })

  it('carries attempted homes into the next terminal recovery to prevent cycling', async () => {
    const f = await fixture()
    f.observe()
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
    f.terminal.ptyId = 'pty-2'
    f.terminal.incarnationId = 'inc-2'
    f.terminal.home = f.targetHome
    f.failover.mockResolvedValue(false)
    f.coordinator.observe('pty-2', 'inc-2', ERROR)
    await vi.waitFor(() => expect(f.failover).toHaveBeenCalledTimes(2))
    expect(f.failover.mock.calls[1]?.[0].excludedHomes).toEqual([f.home, f.targetHome])
  })

  it('does not continue if a manual account change supersedes recovery during resume', async () => {
    const f = await fixture()
    let current = true
    f.failover.mockImplementation(async (input) => {
      await input.migrate(f.account, () => current)
      return true
    })
    f.deps.prove.mockImplementation(async () => {
      current = false
    })
    f.observe()
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce())
    expect(f.deps.continue).not.toHaveBeenCalled()
  })

  it.each(['prove', 'continue'] as const)('never retries an ambiguous %s', async (step) => {
    const f = await fixture()
    f.deps[step].mockRejectedValue(new Error('unverifiable'))
    f.observe()
    await vi.waitFor(() => expect(f.automation.reportFailure).toHaveBeenCalledOnce())
    f.observe()
    expect(f.deps[step]).toHaveBeenCalledOnce()
    if (step === 'prove') {
      expect(f.deps.continue).not.toHaveBeenCalled()
    }
  })
})

it('recovers missing launch context before checking quota and migrating', async () => {
  const f = await fixture()
  f.deps.context.mockReturnValue(null)
  const discoverContext = vi.fn(async () => f.terminal)
  const recovery = new TerminalCodexAccountFailover({ ...f.deps, discoverContext })
  recovery.observe('pty-1', 'inc-1', `\n${ERROR}`)
  await vi.waitFor(() => expect(f.deps.resume).toHaveBeenCalledOnce())
  expect(discoverContext).toHaveBeenCalledWith('pty-1')
})
