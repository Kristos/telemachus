/**
 * SEC-08 sandbox regression test.
 *
 * This test launches a REAL sandboxed subprocess (the mcp-sandbox-probe fixture)
 * and is the only test in the repo that does so. It proves that the Phase 25
 * sandbox-exec wrapper actually denies what it claims:
 *   1. Write to /tmp outside cwd → EACCES or EPERM (filesystem deny)
 *   2. TCP connect to a local listener → connection error (network deny)
 *
 * The test goes through the FULL connectAndBridge path via McpManager.
 * It does NOT shortcut to raw process spawning on sandbox argv (D-20).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { McpManager } from '../manager.js'
import { ToolRegistry } from '../../tools/registry.js'
import { DEFAULT_CONFIG } from '../../config/types.js'
import type { KristosConfig } from '../../config/types.js'
import * as net from 'node:net'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fs from 'node:fs'

// Resolve fixture path relative to this test file:
//   src/mcp/__tests__/sandbox.test.ts → ../../../../test/fixtures/mcp-sandbox-probe/index.ts
const fixturePath = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../../test/fixtures/mcp-sandbox-probe/index.ts',
)

// Fail fast with a clear message if the fixture is missing
if (!fs.existsSync(fixturePath)) {
  throw new Error(`SEC-08: fixture not found at ${fixturePath}`)
}

describe.skipIf(process.platform !== 'darwin')(
  'MCP sandbox regression (SEC-08: requires darwin sandbox-exec)',
  () => {
    let tcpServer: net.Server
    let listenerPort: number
    let manager: McpManager
    let registry: ToolRegistry

    beforeEach(async () => {
      // Stand up a local TCP listener so probe_tcp_connect has a reachable target.
      // With sandbox network-off enforced, the connect should be denied before reaching it.
      await new Promise<void>((resolve) => {
        tcpServer = net.createServer()
        tcpServer.listen(0, '127.0.0.1', () => {
          listenerPort = (tcpServer.address() as net.AddressInfo).port
          resolve()
        })
      })

      registry = new ToolRegistry()
      const config: KristosConfig = {
        ...DEFAULT_CONFIG,
        mcpServers: {
          probe: {
            command: 'bun',
            args: [fixturePath],
            eagerLoad: true,
            trustTier: 'dangerous',
          },
        },
      }
      manager = new McpManager({ config, registry, sessionId: 'sec08-test' })
      await manager.loadEager()
    }, 30000)

    afterEach(async () => {
      await manager.dispose()
      await new Promise<void>((resolve) => tcpServer.close(() => resolve()))
    })

    it(
      'probe_write_outside_cwd is denied (EACCES or EPERM) — filesystem sandbox enforced',
      async () => {
        const tool = registry.find('mcp__probe__probe_write_outside_cwd')
        expect(tool).toBeDefined()

        const result = await tool!.execute({}, {
          cwd: process.cwd(),
          toolTimeoutMs: 30000,
          askUser: async () => '',
        })

        // Must NOT succeed
        expect(result.content).not.toContain('NO_ERROR')
        // Must contain a permission-denied error code (SBPL denies as EACCES or EPERM on macOS)
        const denied = result.content.includes('EACCES') || result.content.includes('EPERM')
        expect(denied).toBe(true)
      },
      30000,
    )

    it(
      'probe_tcp_connect is denied — network sandbox enforced (loopback TCP blocked)',
      async () => {
        const tool = registry.find('mcp__probe__probe_tcp_connect')
        expect(tool).toBeDefined()

        const result = await tool!.execute({ port: listenerPort }, {
          cwd: process.cwd(),
          toolTimeoutMs: 30000,
          askUser: async () => '',
        })

        // Must NOT succeed — sandbox network-off profile should deny the connect syscall
        expect(result.content).not.toContain('NO_ERROR')
        // Accept any connection-denied marker; exact error depends on macOS kernel behavior
        // when SBPL denies the network-outbound syscall (ECONNREFUSED / EPERM / EHOSTUNREACH)
        const blocked =
          result.content.includes('ECONNREFUSED') ||
          result.content.includes('EPERM') ||
          result.content.includes('EHOSTUNREACH') ||
          result.content.toLowerCase().includes('operation not permitted')
        expect(blocked).toBe(true)
      },
      30000,
    )
  },
)
