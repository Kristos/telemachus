/**
 * Phase 20 (LEAN-02), decision 3: shell-style arg splitter with NO shell
 * interpolation. Honors single quotes, double quotes, and backslash escapes.
 * Does NOT expand `$VAR`, backticks, `~`, globs — those pass through literally.
 *
 * Assumes input already passed `validateArgString`. Returns the token list.
 */
export function parseArgString(s: string): string[] {
  const argv: string[] = []
  let current = ''
  let inToken = false
  let quote: 'single' | 'double' | null = null
  let escaped = false

  const push = () => {
    if (inToken) {
      argv.push(current)
      current = ''
      inToken = false
    }
  }

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!

    if (escaped) {
      current += ch
      inToken = true
      escaped = false
      continue
    }

    if (quote === 'single') {
      if (ch === "'") {
        quote = null
      } else {
        current += ch
      }
      continue
    }

    if (quote === 'double') {
      if (ch === '\\') {
        // Inside double quotes, backslash escapes the next char
        escaped = true
        continue
      }
      if (ch === '"') {
        quote = null
      } else {
        current += ch
      }
      continue
    }

    // Outside any quote
    if (ch === '\\') {
      escaped = true
      inToken = true
      continue
    }
    if (ch === "'") {
      quote = 'single'
      inToken = true
      continue
    }
    if (ch === '"') {
      quote = 'double'
      inToken = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      push()
      continue
    }
    current += ch
    inToken = true
  }

  push()
  return argv
}
