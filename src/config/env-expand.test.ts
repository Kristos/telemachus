import { describe, expect, test, beforeEach } from 'bun:test'
import { expandMcpServerEnv, _resetEnvExpandWarnings } from './env-expand.js'
import type { McpServerConfig } from './types.js'

describe('expandMcpServerEnv', () => {
  beforeEach(() => {
    _resetEnvExpandWarnings()
  })

  test('expands ${VAR} in env values', () => {
    const cfg: McpServerConfig = {
      command: 'python',
      env: { DB_PASS: '${TEST_DB_PASS}' },
    }
    const out = expandMcpServerEnv(cfg, { TEST_DB_PASS: 'secret123' })
    expect(out.env?.DB_PASS).toBe('secret123')
  })

  test('expands $VAR (unbraced) in env values', () => {
    const cfg: McpServerConfig = {
      command: 'python',
      env: { DB_PASS: '$TEST_DB_PASS' },
    }
    const out = expandMcpServerEnv(cfg, { TEST_DB_PASS: 'secret123' })
    expect(out.env?.DB_PASS).toBe('secret123')
  })

  test('expands inside larger strings', () => {
    const cfg: McpServerConfig = {
      command: 'python',
      env: { AUTH: 'Bearer ${TEST_TOKEN}' },
    }
    const out = expandMcpServerEnv(cfg, { TEST_TOKEN: 'xyz' })
    expect(out.env?.AUTH).toBe('Bearer xyz')
  })

  test('expands in args, command, cwd', () => {
    const cfg: McpServerConfig = {
      command: '${TEST_BIN}/python',
      args: ['-m', '${TEST_MODULE}'],
      cwd: '${TEST_CWD}',
    }
    const out = expandMcpServerEnv(cfg, {
      TEST_BIN: '/opt/venv/bin',
      TEST_MODULE: 'foo.server',
      TEST_CWD: '/home/user/proj',
    })
    expect(out.command).toBe('/opt/venv/bin/python')
    expect(out.args).toEqual(['-m', 'foo.server'])
    expect(out.cwd).toBe('/home/user/proj')
  })

  test('missing env var expands to empty string (does not throw)', () => {
    const cfg: McpServerConfig = {
      command: 'python',
      env: { SECRET: '${DOES_NOT_EXIST_XYZ}' },
    }
    const out = expandMcpServerEnv(cfg, {})
    expect(out.env?.SECRET).toBe('')
  })

  test('literal strings with no placeholders pass through unchanged', () => {
    const cfg: McpServerConfig = {
      command: '/usr/bin/python',
      args: ['server.py'],
      env: { FOO: 'bar' },
      cwd: '/tmp',
    }
    const out = expandMcpServerEnv(cfg, {})
    expect(out.command).toBe('/usr/bin/python')
    expect(out.args).toEqual(['server.py'])
    expect(out.env?.FOO).toBe('bar')
    expect(out.cwd).toBe('/tmp')
  })

  test('preserves non-string fields (eagerLoad, trustTier, toolOverrides)', () => {
    const cfg: McpServerConfig = {
      command: 'python',
      eagerLoad: true,
      trustTier: 'risky',
      toolOverrides: { safe_read: 'safe' },
    }
    const out = expandMcpServerEnv(cfg, {})
    expect(out.eagerLoad).toBe(true)
    expect(out.trustTier).toBe('risky')
    expect(out.toolOverrides).toEqual({ safe_read: 'safe' })
  })

  test('does not mutate the input config', () => {
    const cfg: McpServerConfig = {
      command: 'python',
      env: { PASS: '${TEST_PASS}' },
    }
    expandMcpServerEnv(cfg, { TEST_PASS: 'x' })
    expect(cfg.env?.PASS).toBe('${TEST_PASS}')
  })
})
