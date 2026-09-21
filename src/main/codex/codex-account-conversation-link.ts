import { mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { relativePathInsideRoot } from '../../shared/cross-platform-path'
import { resolvePinnedCodexRolloutProof } from './codex-tui-rollout-proof'
import { tryHardlinkCodexSessionFile } from './codex-session-link'

export async function retainCodexAccountConversation(
  home: string,
  targetHome: string,
  threadId: string
): Promise<string> {
  const source = await resolvePinnedCodexRolloutProof(home, threadId)
  const relative = source && relativePathInsideRoot(join(home, 'sessions'), source)
  if (!source || !relative) {
    throw new Error('Codex conversation history could not be verified')
  }
  const destination = join(targetHome, 'sessions', relative)
  const existing = await resolvePinnedCodexRolloutProof(targetHome, threadId)
  if (existing) {
    const [sourceStat, existingStat] = await Promise.all([stat(source), stat(existing)])
    if (
      !sourceStat.ino ||
      sourceStat.ino !== existingStat.ino ||
      sourceStat.dev !== existingStat.dev
    ) {
      throw new Error('Conversation history has a different writer')
    }
    return existing
  }
  await mkdir(dirname(destination), { recursive: true })
  if (!tryHardlinkCodexSessionFile(source, destination)) {
    throw new Error('Conversation history could not be retained')
  }
  return destination
}
