/**
 * Phase 24-02 (AGENT-07): gated integration test against real launchctl.
 *
 * This suite ONLY runs when `KC_INTEGRATION_LAUNCHD=1` is set. Default
 * `bun test` skips it entirely. Manual pre-dogfood verification on the owner's
 * Mac before merging Phase 24.
 *
 * Safety: uses a throwaway label scoped to the test process PID so parallel
 * test runs can't collide. Cleans up in afterEach even on test failure.
 *
 * Run manually:
 *   KC_INTEGRATION_LAUNCHD=1 bun test src/agent-runner/launchd-install.integration.test.ts
 */
import { describe, test, expect, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { renderPlist } from './launchd-plist'
import { parseSchedule } from './schedule-parse'
import {
  realRunner,
  getUid,
  bootstrap,
  bootout,
  print,
} from './launchctl'

const GATED = process.env.KC_INTEGRATION_LAUNCHD === '1'
const describeGated = GATED ? describe : describe.skip

describeGated('launchd real subprocess integration', () => {
  const label = `com.telemachus.agent.kc-integration-test-${process.pid}`
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
  const plistPath = path.join(launchAgentsDir, `${label}.plist`)

  afterEach(async () => {
    // Defensive cleanup even if test body threw mid-flight.
    try {
      const uid = await getUid(realRunner)
      await bootout(realRunner, uid, label).catch(() => {})
    } catch {
      // ignore
    }
    await fs.unlink(plistPath).catch(() => {})
  })

  test('bootstrap → print → bootout round-trip', async () => {
    const uid = await getUid(realRunner)

    const xml = renderPlist({
      label,
      programArguments: ['/usr/bin/true'],
      calendarInterval: parseSchedule('hourly'),
      envPath: '/usr/bin:/bin',
    })
    await fs.mkdir(launchAgentsDir, { recursive: true })
    await fs.writeFile(plistPath, xml, { mode: 0o644 })

    await bootstrap(realRunner, uid, plistPath)

    const info = await print(realRunner, uid, label)
    expect(info.loaded).toBe(true)

    const first = await bootout(realRunner, uid, label)
    expect(first.wasLoaded).toBe(true)

    // Second bootout is idempotent — should report not-loaded.
    const second = await bootout(realRunner, uid, label)
    expect(second.wasLoaded).toBe(false)

    await fs.unlink(plistPath)
  }, 15000)
})
