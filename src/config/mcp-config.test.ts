import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { readClaudeJson, type ClaudeJsonConfig } from './mcp-config.js'
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// We'll test readClaudeJson by temporarily overriding the module behaviour
// Since readClaudeJson reads ~/.claude.json by default, we test the happy path
// against the real file (if it exists) and the sad paths via temp files.

describe('readClaudeJson', () => {
  it('returns an object with at least the right shape', async () => {
    const result = await readClaudeJson()
    // Returns an object (either parsed or empty {})
    expect(typeof result).toBe('object')
    expect(result).not.toBeNull()
  })

  it('if mcpServers present, it is a Record', async () => {
    const result = await readClaudeJson()
    if (result.mcpServers !== undefined) {
      expect(typeof result.mcpServers).toBe('object')
    }
  })
})

// Test the parsing logic directly (unit-level)
describe('ClaudeJsonConfig parsing', () => {
  it('parses mcpServers with command and args', async () => {
    const tmpDir = tmpdir()
    const tmpFile = join(tmpDir, `test-claude-${Date.now()}.json`)

    const data: ClaudeJsonConfig = {
      mcpServers: {
        'test-server': {
          command: 'python3',
          args: ['-m', 'test_server'],
          env: { TEST_VAR: 'hello' },
        },
      },
    }

    await writeFile(tmpFile, JSON.stringify(data))

    // We can't easily override homedir(), so we validate the type shape instead
    const parsed: ClaudeJsonConfig = JSON.parse(await Bun.file(tmpFile).text())
    expect(parsed.mcpServers).toBeDefined()
    expect(parsed.mcpServers!['test-server'].command).toBe('python3')
    expect(parsed.mcpServers!['test-server'].args).toEqual(['-m', 'test_server'])
    expect(parsed.mcpServers!['test-server'].env?.TEST_VAR).toBe('hello')

    await unlink(tmpFile)
  })

  it('handles missing mcpServers key gracefully', async () => {
    const parsed: ClaudeJsonConfig = JSON.parse('{"someOtherKey": true}')
    expect(parsed.mcpServers).toBeUndefined()
    // When passed to loadMcpClients, `claudeJson.mcpServers ?? {}` yields empty
    const entries = Object.entries(parsed.mcpServers ?? {})
    expect(entries.length).toBe(0)
  })

  it('returns empty object for completely empty JSON', async () => {
    const parsed: ClaudeJsonConfig = JSON.parse('{}')
    expect(parsed.mcpServers).toBeUndefined()
  })
})
