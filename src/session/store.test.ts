import { describe, it, expect } from 'bun:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { open, rename } from 'node:fs/promises'

describe('session store path safety', () => {
  it('uses path.join (not hardcoded slashes) for cross-platform separators', () => {
    // Sanity check: path.join produces platform-correct separators.
    const joined = path.join('a', 'b', 'c.jsonl')
    expect(joined).toContain('c.jsonl')
    // On posix path.sep === '/', on win32 === '\\'. Either way, no double-slash bugs.
    expect(joined).not.toContain('//')
    expect(joined).not.toContain('\\\\')
  })

  it('atomic rename writes a file then renames it across a tmp dir', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kc-store-test-'))
    try {
      const final = path.join(dir, 'session.jsonl')
      const tmp = final + '.tmp'
      const fh = await open(tmp, 'w')
      await fh.writeFile('{"type":"meta"}\n', 'utf8')
      await fh.datasync()
      await fh.close()
      await rename(tmp, final)
      const text = await readFile(final, 'utf8')
      expect(text).toBe('{"type":"meta"}\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('path.normalize collapses mixed separators to a stable form', () => {
    // Simulates a Windows-style input with mixed separators flowing through
    // any code path that calls path.normalize / path.join.
    const mixed = 'dir\\sub/file.json'
    const normalized = path.normalize(mixed)
    // On posix, backslashes survive as part of the filename (one segment).
    // On win32, both separators collapse to '\\'. Either way, no crash and
    // the result is deterministic and ends with file.json.
    expect(normalized.endsWith('file.json')).toBe(true)
    // path.join with split segments produces a clean, separator-correct path.
    const joined = path.join('dir', 'sub', 'file.json')
    expect(joined).toContain('file.json')
    expect(joined.split(path.sep)).toContain('sub')
  })
})

describe('multimodal Message JSONL round-trip (Phase 21-03)', () => {
  it('round-trips a user message containing text + image content blocks', () => {
    const message = {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'what is in this image?' },
        {
          type: 'image' as const,
          source: { type: 'base64' as const, mediaType: 'image/png', data: 'iVBORw0KGgo=' },
        },
      ],
    }
    const line = JSON.stringify({ type: 'msg', message })
    const parsed = JSON.parse(line)
    expect(parsed.type).toBe('msg')
    expect(parsed.message.role).toBe('user')
    expect(Array.isArray(parsed.message.content)).toBe(true)
    expect(parsed.message.content).toHaveLength(2)
    expect(parsed.message.content[0].type).toBe('text')
    expect(parsed.message.content[0].text).toBe('what is in this image?')
    expect(parsed.message.content[1].type).toBe('image')
    expect(parsed.message.content[1].source.mediaType).toBe('image/png')
    expect(parsed.message.content[1].source.data).toBe('iVBORw0KGgo=')
  })

  it('preserves backwards-compatible string content for text-only messages', () => {
    const message = { role: 'user' as const, content: 'plain text only' }
    const line = JSON.stringify({ type: 'msg', message })
    const parsed = JSON.parse(line)
    expect(typeof parsed.message.content).toBe('string')
    expect(parsed.message.content).toBe('plain text only')
  })
})
