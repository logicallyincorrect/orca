import { describe, expect, it, vi } from 'vitest'
import {
  codexProcessEnvironmentFields,
  readCodexProcessLaunchEvidence
} from './codex-process-launch-evidence'

const threadId = '01a0a7a8-1811-7473-92cf-fb6ddf3f97ae'
const home = '/Users/example/Library/Application Support/orca/codex-accounts/a/home'
function fixture() {
  const input = { rootPid: 10, paneKey: 'tab:leaf', allowedHomes: [home] }
  const deps = {
    platform: 'darwin' as const,
    rows: vi.fn(async () => [
      { pid: 10, ppid: 1, command: '/bin/zsh', stat: 'S' },
      { pid: 11, ppid: 10, command: `codex resume ${threadId}`, stat: 'S+' }
    ]),
    startTime: vi.fn(async () => 100),
    environment: vi.fn(
      async () =>
        `codex resume ${threadId} CODEX_HOME=${home} ORCA_PANE_KEY=tab:leaf SECRET=not-returned\n`
    )
  }
  return { input, deps }
}

describe('Codex live launch evidence', () => {
  it('recovers the exact resume thread and home, including spaces, without returning other env', async () => {
    const f = fixture()
    expect(await readCodexProcessLaunchEvidence(f.input, f.deps)).toEqual({
      pid: 11,
      processStartTimeMs: 100,
      home,
      threadId
    })
  })
  it.each(['pid-reused', 'wrong-pane', 'unknown-home', 'no-resume', 'ambiguous-child'] as const)(
    'refuses %s evidence',
    async (kind) => {
      const f = fixture()
      if (kind === 'pid-reused') {
        f.deps.startTime.mockResolvedValueOnce(100).mockResolvedValueOnce(200)
      }
      if (kind === 'wrong-pane') {
        f.input.paneKey = 'other:leaf'
      }
      if (kind === 'unknown-home') {
        f.input.allowedHomes = ['/other']
      }
      if (kind === 'no-resume') {
        f.deps.rows.mockResolvedValue([{ pid: 10, ppid: 1, command: 'codex', stat: 'S+' }])
      }
      if (kind === 'ambiguous-child') {
        const rows = await f.deps.rows()
        f.deps.rows.mockResolvedValue([
          ...rows,
          { pid: 12, ppid: 10, command: `codex resume ${threadId}`, stat: 'S+' }
        ])
      }
      expect(await readCodexProcessLaunchEvidence(f.input, f.deps)).toBeNull()
    }
  )
  it('does not probe Windows through POSIX tools', async () => {
    const f = fixture()
    expect(
      await readCodexProcessLaunchEvidence(f.input, { ...f.deps, platform: 'win32' })
    ).toBeNull()
    expect(f.deps.rows).not.toHaveBeenCalled()
  })
  it('reads Linux null-delimited environment fields', () => {
    expect(
      codexProcessEnvironmentFields(`CODEX_HOME=${home}\0ORCA_PANE_KEY=tab:leaf\0`, 'linux')
    ).toEqual({ home, paneKey: 'tab:leaf' })
  })
  it('rejects ambiguous macOS fields', () => {
    expect(
      codexProcessEnvironmentFields('codex CODEX_HOME=/a CODEX_HOME=/b ORCA_PANE_KEY=x', 'darwin')
    ).toBeNull()
  })
})

it('refuses command identity changed between process snapshots', async () => {
  const f = fixture()
  const rows = await f.deps.rows()
  f.deps.rows
    .mockResolvedValueOnce(rows)
    .mockResolvedValueOnce([
      rows[0]!,
      { ...rows[1]!, command: 'codex resume 44444444-4444-4444-8444-444444444444' }
    ])
  expect(await readCodexProcessLaunchEvidence(f.input, f.deps)).toBeNull()
})
