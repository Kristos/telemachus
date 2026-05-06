/**
 * SAND-01 regression tests (Phase 62, BACKLOG 999.14).
 *
 * Locks the todo_write empty-HOME failure mode: production session logs
 * showed 17 consecutive mkdir '/.telemachus' EROFS failures when
 * context.cwd resolved to filesystem root. Fix is to resolve the data
 * path via os.homedir() with an explicit guard that surfaces a
 * descriptive error when homedir() returns '' or '/'.
 *
 * Test discipline: spyOn(os, 'homedir') + afterEach restore — no
 * mock.module (CLAUDE.md rule).
 */
import { describe, it, expect, afterEach, spyOn } from 'bun:test'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as os from 'node:os'
import { todoWriteTool } from './todo-write.js'
import type { ToolContext } from '../types.js'

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: '/tmp/kc-test-cwd',
    toolTimeoutMs: 5000,
    askUser: async () => '',
    ...overrides,
  }
}

describe('todoWriteTool SAND-01 regression (Phase 62, 999.14)', () => {
  let homedirSpy: ReturnType<typeof spyOn> | undefined
  const tmpDirsCreated: string[] = []

  afterEach(async () => {
    homedirSpy?.mockRestore()
    homedirSpy = undefined
    for (const dir of tmpDirsCreated.splice(0)) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  describe('HOME validation guard', () => {
    it('returns isError with descriptive message when homedir() returns empty string', async () => {
      homedirSpy = spyOn(os, 'homedir').mockReturnValue('')

      const result = await todoWriteTool.execute(
        { todos: [{ id: '1', content: 'x', status: 'pending' }] },
        makeContext(),
      )

      expect(result.isError).toBe(true)
      // Message must cite os.homedir() so operators can triage
      expect(result.content).toContain('os.homedir()')
      // Message must acknowledge the empty-string case explicitly
      expect(result.content.toLowerCase()).toContain('empty')
      // Must NOT surface an EROFS — that would mean mkdir ran
      expect(result.content).not.toContain('EROFS')
    })

    it('returns isError with descriptive message when homedir() returns "/"', async () => {
      homedirSpy = spyOn(os, 'homedir').mockReturnValue('/')

      const result = await todoWriteTool.execute(
        { todos: [{ id: '1', content: 'x', status: 'pending' }] },
        makeContext(),
      )

      expect(result.isError).toBe(true)
      expect(result.content).toContain('os.homedir()')
      // Message must quote the actual returned value for triage
      expect(result.content).toContain("'/'")
      expect(result.content).not.toContain('EROFS')
    })
  })

  describe('happy-path persistence under os.homedir()', () => {
    it('writes todos to {homedir}/.telemachus/todos.json', async () => {
      const tmpHome = await mkdtemp(join(tmpdir(), 'kc-todo-happy-'))
      tmpDirsCreated.push(tmpHome)
      homedirSpy = spyOn(os, 'homedir').mockReturnValue(tmpHome)

      const todos = [
        { id: '1', content: 'first task', status: 'pending' as const },
        { id: '2', content: 'second task', status: 'in_progress' as const },
      ]

      const result = await todoWriteTool.execute({ todos }, makeContext())

      expect(result.isError).toBe(false)
      const expectedPath = join(tmpHome, '.telemachus', 'todos.json')
      await access(expectedPath) // throws if missing

      const contents = await readFile(expectedPath, 'utf8')
      const parsed = JSON.parse(contents)
      expect(parsed).toEqual(todos)
    })

    it('ignores context.cwd — data lands under homedir() not cwd', async () => {
      const tmpHome = await mkdtemp(join(tmpdir(), 'kc-todo-ignore-cwd-'))
      tmpDirsCreated.push(tmpHome)
      homedirSpy = spyOn(os, 'homedir').mockReturnValue(tmpHome)

      const todos = [{ id: '1', content: 'task', status: 'pending' as const }]
      const arbitraryCwd = '/some/arbitrary/path-that-does-not-exist'

      const result = await todoWriteTool.execute(
        { todos },
        makeContext({ cwd: arbitraryCwd }),
      )

      // Write must succeed under tmpHome even though cwd is nonsense
      expect(result.isError).toBe(false)
      await access(join(tmpHome, '.telemachus', 'todos.json'))
      // And nothing should have been created under the arbitrary cwd
      await expect(
        access(join(arbitraryCwd, '.telemachus', 'todos.json')),
      ).rejects.toThrow()
    })
  })
})
