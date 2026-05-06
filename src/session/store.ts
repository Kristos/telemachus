import { open, rename, readdir, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { Message } from '../providers/types.js'
import type { MetaEntry, MsgEntry, UsageEntry, SessionEntry } from './types.js'

const SESSIONS_DIR = join(homedir(), '.telemachus', 'sessions')

function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.jsonl`)
}

function tmpPath(id: string): string {
  return sessionPath(id) + '.tmp'
}

export async function initSession(
  id: string,
  meta: Omit<MetaEntry, 'type'>
): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true })
  const entry: MetaEntry = { type: 'meta', ...meta }
  const line = JSON.stringify(entry) + '\n'
  const tmp = tmpPath(id)
  const fh = await open(tmp, 'w')
  await fh.writeFile(line, 'utf8')
  await fh.datasync()
  await fh.close()
  await rename(tmp, sessionPath(id))
}

export async function appendMessage(id: string, message: Message): Promise<void> {
  try {
    const entry: MsgEntry = { type: 'msg', message }
    const line = JSON.stringify(entry) + '\n'
    const fh = await open(sessionPath(id), 'a')
    await fh.appendFile(line, 'utf8')
    await fh.datasync()
    await fh.close()
  } catch (err) {
    process.stderr.write(
      `[session] warn: could not append message: ${err instanceof Error ? err.message : String(err)}\n`
    )
  }
}

export async function appendUsage(
  id: string,
  usage: Omit<UsageEntry, 'type'>
): Promise<void> {
  try {
    const entry: UsageEntry = { type: 'usage', ...usage }
    const line = JSON.stringify(entry) + '\n'
    const fh = await open(sessionPath(id), 'a')
    await fh.appendFile(line, 'utf8')
    await fh.datasync()
    await fh.close()
  } catch (err) {
    process.stderr.write(
      `[session] warn: could not append usage: ${err instanceof Error ? err.message : String(err)}\n`
    )
  }
}

export async function loadSession(id: string): Promise<SessionEntry[]> {
  const text = await Bun.file(sessionPath(id)).text()
  const lines = text.split('\n').filter(l => l.trim().length > 0)
  const entries: SessionEntry[] = []
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as SessionEntry)
    } catch {
      // Skip corrupt lines — fault-tolerant
    }
  }
  return entries
}

export async function listSessions(): Promise<string[]> {
  let files: string[]
  try {
    files = await readdir(SESSIONS_DIR)
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }

  const jsonlFiles = files.filter(f => f.endsWith('.jsonl'))

  // Stat each file to get mtime for newest-first sort
  const withMtime = await Promise.all(
    jsonlFiles.map(async f => {
      try {
        const s = await stat(join(SESSIONS_DIR, f))
        return { id: f.replace(/\.jsonl$/, ''), mtime: s.mtimeMs }
      } catch {
        return { id: f.replace(/\.jsonl$/, ''), mtime: 0 }
      }
    })
  )

  return withMtime
    .sort((a, b) => b.mtime - a.mtime)
    .map(x => x.id)
}
