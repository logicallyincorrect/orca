import type { CodexProcessLaunchEvidence } from '../codex/codex-process-launch-evidence'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import type { CodexAccountService } from '../codex-accounts/service'
import { retainCodexAccountConversation } from '../codex/codex-account-conversation-link'
import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import { normalizeTerminalChunk } from './terminal-ansi-normalization'

export type CodexFailoverTerminal = {
  ptyId: string
  incarnationId: string
  handle: string
  home: string
  threadId: string
  workspaceId: string
  tabId: string
  leafId: string
  recoveredProcess?: CodexProcessLaunchEvidence
  agentArgs?: string
}

type ResumedTerminal = { handle: string; ptyId: string }
type FailoverAccounts = Pick<CodexAccountService, 'failover'> & {
  automation: Pick<CodexAccountService['automation'], 'isExhausted' | 'reportFailure'>
}

export type TerminalCodexFailoverDeps = {
  enabled: () => boolean
  seamless: () => boolean
  accounts: () => FailoverAccounts | undefined
  context: (ptyId: string) => CodexFailoverTerminal | null
  discoverContext?: (ptyId: string) => Promise<CodexFailoverTerminal | null>
  current: (terminal: CodexFailoverTerminal) => boolean
  ready: (terminal: CodexFailoverTerminal) => Promise<boolean>
  hold: (terminal: CodexFailoverTerminal) => (() => void) | null
  stop: (terminal: CodexFailoverTerminal) => Promise<boolean>
  resume: (
    terminal: CodexFailoverTerminal,
    account: CodexManagedAccount
  ) => Promise<ResumedTerminal>
  prove: (terminal: ResumedTerminal, threadId: string, home: string) => Promise<void>
  continue: (terminal: ResumedTerminal) => Promise<void>
}

// Captured from Codex 0.155.0; require its error marker and usage URL, not a generic rate limit.
const QUOTA_ERROR =
  /(?:^|[\r\n])\s*(?:■\s*)?You['’]ve hit your usage limit\.\s+Visit\s+https:\/\/chatgpt\.com\/codex\/settings\/usage\b/
const CHAIN_TTL_MS = 120_000

export class TerminalCodexAccountFailover {
  private readonly observations = new Map<
    string,
    { incarnationId: string; text: string; pendingAnsi: string }
  >()
  private readonly recovering = new Set<string>()
  private readonly failed = new Set<string>()
  private readonly chains = new Map<string, { homes: string[]; expiresAt: number }>()

  constructor(private readonly deps: TerminalCodexFailoverDeps) {}

  observe(ptyId: string, incarnationId: string | null, data: string): void {
    if (!incarnationId || !this.deps.enabled()) {
      return
    }
    let stream = this.observations.get(ptyId)
    if (stream?.incarnationId !== incarnationId) {
      stream = { incarnationId, text: '', pendingAnsi: '' }
      this.observations.set(ptyId, stream)
    }
    const normalized = normalizeTerminalChunk(data, stream.pendingAnsi)
    stream.pendingAnsi = normalized.pendingAnsi
    stream.text = (stream.text + stripAnsiEscapeSequences(normalized.text)).slice(-8192)
    const match = QUOTA_ERROR.exec(stream.text)
    if (!match) {
      return
    }
    stream.text = stream.text.slice(match.index + match[0].length)
    const key = `${ptyId}:${incarnationId}`
    if (this.recovering.has(key) || this.failed.has(key)) {
      return
    }
    this.recovering.add(key)
    void this.attempt(ptyId, incarnationId)
      .catch(() => {
        if (this.observations.get(ptyId)?.incarnationId === incarnationId) {
          this.failed.add(key)
        }
        this.deps
          .accounts()
          ?.automation.reportFailure(
            'Codex terminal account recovery paused. Resume the conversation manually before continuing.'
          )
      })
      .finally(() => this.recovering.delete(key))
  }

  forget(ptyId: string): void {
    const stream = this.observations.get(ptyId)
    if (stream) {
      this.failed.delete(`${ptyId}:${stream.incarnationId}`)
    }
    this.observations.delete(ptyId)
  }

  private async attempt(ptyId: string, incarnationId: string): Promise<void> {
    for (let attempt = 0; attempt < 4 && this.deps.enabled(); attempt += 1) {
      const terminal = this.deps.context(ptyId) ?? (await this.deps.discoverContext?.(ptyId))
      if (terminal) {
        if (terminal.incarnationId === incarnationId) {
          await this.recover(terminal)
        }
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (this.deps.enabled()) {
      this.deps
        .accounts()
        ?.automation.reportFailure(
          'Codex reached its usage limit, but its terminal account or conversation identity could not be verified. Account recovery was not started.'
        )
    }
  }

  private async recover(terminal: CodexFailoverTerminal): Promise<void> {
    const accounts = this.deps.accounts()
    if (!accounts) {
      return
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 60_000)
    timeout.unref()
    const safe = (): boolean =>
      !controller.signal.aborted && this.deps.enabled() && this.deps.current(terminal)
    let release: (() => void) | null = null
    const selection: { replacement?: CodexManagedAccount; isCurrent?: () => boolean } = {}
    try {
      let ready = false
      for (let attempt = 0; attempt < 4 && safe(); attempt += 1) {
        ready = await this.deps.ready(terminal)
        if (ready) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (!ready || !safe()) {
        if (safe()) {
          accounts.automation.reportFailure(
            'Codex reached its usage limit, but its terminal could not be verified as idle. Account recovery was not started.'
          )
        }
        return
      }
      release = this.deps.hold(terminal)
      if (!release || !(await accounts.automation.isExhausted(terminal.home, controller.signal))) {
        return
      }
      for (const [threadId, chain] of this.chains) {
        if (chain.expiresAt <= Date.now()) {
          this.chains.delete(threadId)
        }
      }
      const homes = this.chains.get(terminal.threadId)?.homes ?? []
      const switched = await accounts.failover({
        home: terminal.home,
        signal: controller.signal,
        isSafe: safe,
        excludedHomes: homes,
        allowUnselectedSource: true,
        migrate: async (account, isCurrent) => {
          await retainCodexAccountConversation(
            terminal.home,
            account.managedHomePath,
            terminal.threadId
          )
          if (
            !safe() ||
            !isCurrent() ||
            !(await this.deps.ready(terminal)) ||
            !safe() ||
            !isCurrent()
          ) {
            throw new Error('Account switch superseded')
          }
          if (!(await this.deps.stop(terminal))) {
            throw new Error('Provider exit is unverifiable')
          }
          selection.replacement = account
          selection.isCurrent = isCurrent
        }
      })
      const replacement = selection.replacement
      if (
        !switched ||
        !replacement ||
        !selection.isCurrent?.() ||
        controller.signal.aborted ||
        !this.deps.enabled()
      ) {
        return
      }
      this.chains.set(terminal.threadId, {
        homes: [...new Set([...homes, terminal.home, replacement.managedHomePath])],
        expiresAt: Date.now() + CHAIN_TTL_MS
      })
      const resumed = await this.deps.resume(terminal, replacement)
      await this.deps.prove(resumed, terminal.threadId, replacement.managedHomePath)
      if (
        !controller.signal.aborted &&
        selection.isCurrent?.() &&
        this.deps.enabled() &&
        this.deps.seamless()
      ) {
        // An ambiguous submission is never retried, including after a runtime restart.
        await this.deps.continue(resumed)
      }
    } finally {
      clearTimeout(timeout)
      release?.()
    }
  }
}
