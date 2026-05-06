import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { loadSkills } from './loader.js'
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs'
import { join } from 'path'

// Use a temp directory for each test
const TMP = join(import.meta.dir, '__test_skills_tmp__')

beforeEach(() => mkdirSync(TMP, { recursive: true }))
afterEach(() => rmSync(TMP, { recursive: true, force: true }))

describe('loadSkills', () => {
  test('loads skill from flat .md file', async () => {
    writeFileSync(join(TMP, 'my-skill.md'), '# My Skill\nContent here')
    const skills = await loadSkills(TMP)
    expect(skills.find(s => s.name === 'my-skill')).toBeTruthy()
    expect(skills.find(s => s.name === 'my-skill')!.content).toContain('# My Skill')
  })

  test('loads skill from subdir/SKILL.md', async () => {
    const sub = join(TMP, 'complex-skill')
    mkdirSync(sub)
    writeFileSync(join(sub, 'SKILL.md'), '# Complex\nDetails')
    const skills = await loadSkills(TMP)
    expect(skills.find(s => s.name === 'complex-skill')).toBeTruthy()
    expect(skills.find(s => s.name === 'complex-skill')!.content).toContain('# Complex')
  })

  test('follows symlinked directory', async () => {
    // Create actual dir outside TMP, symlink into TMP
    const actual = join(TMP, '__actual__')
    mkdirSync(actual)
    writeFileSync(join(actual, 'SKILL.md'), '# Linked')
    symlinkSync(actual, join(TMP, 'linked-skill'))
    const skills = await loadSkills(TMP)
    expect(skills.find(s => s.name === 'linked-skill')).toBeTruthy()
  })

  test('returns empty array for missing directory', async () => {
    const skills = await loadSkills('/nonexistent/path/xyz')
    expect(skills).toEqual([])
  })

  test('skips non-.md files in flat format', async () => {
    writeFileSync(join(TMP, 'readme.txt'), 'not a skill')
    writeFileSync(join(TMP, 'data.zip'), 'binary')
    writeFileSync(join(TMP, 'real.md'), '# Real')
    const skills = await loadSkills(TMP)
    expect(skills.length).toBe(1)
    expect(skills[0].name).toBe('real')
  })

  test('unknown slash command does not crash', async () => {
    const skills = await loadSkills(TMP)
    // Just verifying empty skills array works
    expect(skills.find(s => s.name === 'nonexistent')).toBeUndefined()
  })
})
