import { readFile } from 'node:fs/promises'
import { runProcess } from '../../shared/child-process/run-process'
import { getFreshProcessTableSnapshot } from '../../shared/process-table-snapshot-reader'
import { resolveStructuredTuiChildPid } from '../runtime/structured-tui-process-identity'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'
import { codexResumeThreadFromCommandLine } from './codex-resume-process-proof'

export type CodexProcessLaunchEvidence = {
  pid: number
  processStartTimeMs: number
  home: string
  threadId: string
}

// macOS ps separates environment entries with spaces; reject duplicate/ambiguous fields.
export function codexProcessEnvironmentFields(
  text: string,
  platform: NodeJS.Platform
): {
  home: string
  paneKey: string
} | null {
  const fields =
    platform === 'linux' ? text.split('\0') : text.split(/ (?=[A-Za-z_][A-Za-z_0-9]*=)/)
  const homes = fields.filter((field) => field.startsWith('CODEX_HOME='))
  const panes = fields.filter((field) => field.startsWith('ORCA_PANE_KEY='))
  if (homes.length !== 1 || panes.length !== 1) {
    return null
  }
  const home = homes[0]!.slice('CODEX_HOME='.length).trimEnd()
  const paneKey = panes[0]!.slice('ORCA_PANE_KEY='.length).trimEnd()
  return home && paneKey ? { home, paneKey } : null
}

async function readEnvironment(pid: number, platform: NodeJS.Platform): Promise<string | null> {
  if (platform === 'linux') {
    return readFile(`/proc/${pid}/environ`, 'utf8')
  }
  if (platform !== 'darwin') {
    return null
  }
  const result = await runProcess({
    program: '/bin/ps',
    args: ['eww', '-p', String(pid), '-o', 'command='],
    timeoutMs: 5_000,
    maxOutputBytes: 256 * 1024
  })
  return result.code === 0 && !result.timedOut && !result.outputTruncated ? result.stdout : null
}

/** Recover only an exact local resumed process; never infer credentials from current selection. */
export async function readCodexProcessLaunchEvidence(
  input: {
    rootPid: number
    paneKey: string
    allowedHomes: readonly string[]
  },
  deps = {
    platform: process.platform,
    rows: getFreshProcessTableSnapshot,
    startTime: readProcessStartTimeMs,
    environment: readEnvironment
  }
): Promise<CodexProcessLaunchEvidence | null> {
  if (deps.platform !== 'darwin' && deps.platform !== 'linux') {
    return null
  }
  try {
    const rows = await deps.rows()
    if (!rows.some((row) => row.pid === input.rootPid)) {
      return null
    }
    const pid = resolveStructuredTuiChildPid(
      rows.map((row) => ({ ...row, foreground: row.stat.includes('+') })),
      input.rootPid,
      'codex'
    )
    const command = rows.find((row) => row.pid === pid)?.command
    const threadId = command && codexResumeThreadFromCommandLine(command, deps.platform)
    if (!pid || !threadId) {
      return null
    }
    const before = await deps.startTime(pid, deps.platform)
    if (before === null) {
      return null
    }
    const raw = await deps.environment(pid, deps.platform)
    const fields = raw && codexProcessEnvironmentFields(raw, deps.platform)
    const after = await deps.startTime(pid, deps.platform)
    const currentRows = await deps.rows()
    const currentPid = resolveStructuredTuiChildPid(
      currentRows.map((row) => ({ ...row, foreground: row.stat.includes('+') })),
      input.rootPid,
      'codex'
    )
    if (
      !fields ||
      before !== after ||
      currentPid !== pid ||
      currentRows.find((row) => row.pid === pid)?.command !== command ||
      fields.paneKey !== input.paneKey ||
      !input.allowedHomes.includes(fields.home)
    ) {
      return null
    }
    return { pid, processStartTimeMs: before, home: fields.home, threadId }
  } catch {
    return null
  }
}
