import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import type { Skill } from './types.js'

/**
 * Loads skills from a directory. Two formats supported:
 * - Format A: skills-dir/skill-name.md → name = "skill-name"
 * - Format B: skills-dir/skill-name/SKILL.md → name = "skill-name"
 *
 * Uses stat() (not lstat()) to follow symlinks.
 * Silently skips entries that fail to read.
 */
export async function loadSkills(
  skillsDir?: string,
): Promise<Skill[]> {
  const dir = skillsDir ?? `${process.env.HOME}/.claude/skills`
  const skills: Skill[] = []

  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry)
    try {
      const info = await stat(fullPath) // follows symlinks

      if (info.isFile() && entry.endsWith('.md')) {
        // Format A: bare .md file
        const name = entry.replace(/\.md$/, '')
        const content = await Bun.file(fullPath).text()
        skills.push({ name, content })
      } else if (info.isDirectory()) {
        // Format B: subdir with SKILL.md
        const skillMdPath = join(fullPath, 'SKILL.md')
        try {
          const content = await Bun.file(skillMdPath).text()
          skills.push({ name: entry, content })
        } catch {
          // No SKILL.md in this directory — skip silently
        }
      }
    } catch {
      // Skip entries that fail to stat (broken symlinks, permission errors)
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}
