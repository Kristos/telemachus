import { describe, expect, test } from 'bun:test'
import { escapeHtml } from '../html-escape.js'

describe('escapeHtml (TGAGENT-03)', () => {
  test('empty string returns empty', () => {
    expect(escapeHtml('')).toBe('')
  })
  test('plain text passes through', () => {
    expect(escapeHtml('plain text')).toBe('plain text')
  })
  test('escapes ampersand', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b')
  })
  test('escapes angle brackets', () => {
    expect(escapeHtml('<tag>')).toBe('&lt;tag&gt;')
  })
  test('all three together', () => {
    expect(escapeHtml('1 < 2 & 3 > 0')).toBe('1 &lt; 2 &amp; 3 &gt; 0')
  })
  test('& is escaped first — no double-escaping of &lt;', () => {
    // After escaping, '&lt;' becomes '&amp;lt;' (the & is escaped, the
    // 'lt;' is left alone). If ordering were wrong we'd get '&amp;amp;lt;'.
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  })
  test('code-path-style content survives', () => {
    expect(escapeHtml('./src/foo.ts')).toBe('./src/foo.ts')
  })
  test('TypeScript generics escape correctly', () => {
    expect(escapeHtml('Array<string>')).toBe('Array&lt;string&gt;')
  })
})
