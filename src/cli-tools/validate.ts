/**
 * Phase 20 (LEAN-02), decision 4: belt-and-suspenders arg-string validator.
 *
 * Since the dispatcher spawns via Bun.spawn (no shell), these metacharacters
 * would be literal anyway. Rejecting them explicitly signals intent and
 * catches future regressions if a caller ever pipes the string through a
 * shell. Returns `null` on OK, or a short one-line error message on reject.
 *
 * Rules:
 *  - Reject outside quotes: backtick, `$(`, `$((`, `;`, `|`, `&`, `>`, `<`, `&&`, `||`
 *  - Accept inside single or double quotes (quoting neutralizes metachars)
 *  - Accept after backslash escape (`\;`, `\|`, …)
 *  - Reject unbalanced quotes and trailing backslash
 *  - Empty string is valid
 */
export function validateArgString(s: string): string | null {
  let quote: 'single' | 'double' | null = null
  let escaped = false

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!

    if (escaped) {
      escaped = false
      continue
    }

    if (ch === '\\') {
      escaped = true
      continue
    }

    if (quote === 'single') {
      if (ch === "'") quote = null
      continue
    }

    if (quote === 'double') {
      if (ch === '"') quote = null
      continue
    }

    // Outside any quote — check metachars
    if (ch === "'") {
      quote = 'single'
      continue
    }
    if (ch === '"') {
      quote = 'double'
      continue
    }

    if (ch === '`') {
      return "rejected: backtick '`' not allowed outside quotes"
    }
    if (ch === '$' && s[i + 1] === '(') {
      if (s[i + 2] === '(') {
        return "rejected: arithmetic expansion '$((' not allowed"
      }
      return "rejected: command substitution '$(' not allowed"
    }
    if (ch === ';') {
      return "rejected: semicolon ';' not allowed outside quotes"
    }
    if (ch === '|') {
      if (s[i + 1] === '|') {
        return "rejected: logical or '||' not allowed"
      }
      return "rejected: pipe '|' not allowed outside quotes"
    }
    if (ch === '&') {
      if (s[i + 1] === '&') {
        return "rejected: logical and '&&' not allowed"
      }
      return "rejected: ampersand '&' not allowed outside quotes"
    }
    if (ch === '>') {
      return "rejected: redirect '>' not allowed outside quotes"
    }
    if (ch === '<') {
      return "rejected: redirect '<' not allowed outside quotes"
    }
  }

  if (escaped) {
    return 'rejected: trailing backslash with no following character'
  }
  if (quote !== null) {
    return `rejected: unbalanced ${quote} quote`
  }

  return null
}
