import { describe, test, expect, mock } from 'bun:test'
import { formatProfile } from '../../src/ui/slash/format.js'
import { handleProfileSlash } from '../../src/ui/slash/profile-handler.js'
import type { KristosConfig, ProfileConfig } from '../../src/config/types.js'

describe('formatProfile', () => {
  test('undefined profiles → hint text', () => {
    const out = formatProfile(undefined, undefined)
    expect(out).toContain('No profiles configured')
    expect(out).toContain('~/.telemachus/config.json')
  })

  test('lists profiles, marks active with *', () => {
    const profiles: Record<string, ProfileConfig> = {
      local: { mcpServers: ['a', 'b'] },
      cloud: { mcpServers: ['c'] },
    }
    const out = formatProfile(profiles, 'local')
    expect(out).toContain('* local')
    expect(out).toContain('  cloud')
    // mcpServers summary
    expect(out).toMatch(/local.*2/)
    expect(out).toMatch(/cloud.*1/)
  })

  test('profile without mcpServers field shows "(all)"', () => {
    const profiles: Record<string, ProfileConfig> = { x: {} }
    const out = formatProfile(profiles, undefined)
    expect(out).toContain('x')
    expect(out.toLowerCase()).toContain('all')
  })
})

describe('handleProfileSlash', () => {
  function makeMgr() {
    const reloadForProfile = mock(async () => {})
    return {
      manager: { reloadForProfile } as unknown as {
        reloadForProfile: (c: KristosConfig, n: string | undefined) => Promise<void>
      },
      reloadForProfile,
    }
  }

  const config: KristosConfig = {
    provider: 'anthropic',
    model: 'm',
    windowSize: 40,
    permissionMode: 'yolo',
    temperature: 0.7,
    maxIterations: 50,
    toolTimeoutMs: 30000,
    autoCompactThreshold: 90,
    providerConfigs: {},
    profiles: { local: { mcpServers: ['a'] }, cloud: { mcpServers: ['b'] } },
  }

  test('no arg → lists profiles, does NOT call reloadForProfile', async () => {
    const { manager, reloadForProfile } = makeMgr()
    const res = await handleProfileSlash('', config, 'local', manager)
    expect(res.message).toContain('local')
    expect(res.newActiveProfile).toBe('local')
    expect(reloadForProfile).not.toHaveBeenCalled()
  })

  test('named switch calls reloadForProfile and returns new active', async () => {
    const { manager, reloadForProfile } = makeMgr()
    const res = await handleProfileSlash('cloud', config, 'local', manager)
    expect(reloadForProfile).toHaveBeenCalledTimes(1)
    expect(reloadForProfile.mock.calls[0][1]).toBe('cloud')
    expect(res.newActiveProfile).toBe('cloud')
    expect(res.message).toMatch(/cloud/i)
  })

  test('"default" resets to undefined', async () => {
    const { manager, reloadForProfile } = makeMgr()
    const res = await handleProfileSlash('default', config, 'local', manager)
    expect(reloadForProfile).toHaveBeenCalledTimes(1)
    expect(reloadForProfile.mock.calls[0][1]).toBeUndefined()
    expect(res.newActiveProfile).toBeUndefined()
  })

  test('"reset" resets to undefined', async () => {
    const { manager, reloadForProfile } = makeMgr()
    const res = await handleProfileSlash('reset', config, 'local', manager)
    expect(reloadForProfile.mock.calls[0][1]).toBeUndefined()
    expect(res.newActiveProfile).toBeUndefined()
  })

  test('error from reloadForProfile becomes a message, active unchanged', async () => {
    const reloadForProfile = mock(async () => {
      throw new Error('kaboom ghost')
    })
    const manager = { reloadForProfile } as unknown as {
      reloadForProfile: (c: KristosConfig, n: string | undefined) => Promise<void>
    }
    const res = await handleProfileSlash('ghost', config, 'local', manager)
    expect(res.message).toContain('kaboom ghost')
    expect(res.newActiveProfile).toBe('local')
  })
})
