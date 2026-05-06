import { describe, expect, test } from 'bun:test'
import { validateArgString } from './validate.js'

describe('validateArgString', () => {
  test('empty string is valid', () => {
    expect(validateArgString('')).toBeNull()
  })

  test('plain word is valid', () => {
    expect(validateArgString('foo')).toBeNull()
  })

  test('plain multi-word is valid', () => {
    expect(validateArgString('foo bar baz')).toBeNull()
  })

  test('single-quoted metachar is valid', () => {
    expect(validateArgString("'foo; bar'")).toBeNull()
    expect(validateArgString("'|&><`$('")).toBeNull()
  })

  test('double-quoted metachar is valid', () => {
    expect(validateArgString('"foo; bar"')).toBeNull()
    expect(validateArgString('"|&><"')).toBeNull()
  })

  test('escaped semicolon is valid', () => {
    expect(validateArgString('foo\\;bar')).toBeNull()
  })

  test('escaped pipe is valid', () => {
    expect(validateArgString('foo\\|bar')).toBeNull()
  })

  test('raw semicolon is rejected', () => {
    const err = validateArgString('foo; bar')
    expect(err).not.toBeNull()
    expect(err).toContain(';')
  })

  test('backtick is rejected', () => {
    const err = validateArgString('echo `date`')
    expect(err).not.toBeNull()
    expect(err).toContain('backtick')
  })

  test('command substitution $( is rejected', () => {
    const err = validateArgString('echo $(date)')
    expect(err).not.toBeNull()
    expect(err).toContain('$(')
  })

  test('arithmetic expansion $(( is rejected', () => {
    const err = validateArgString('echo $((1+1))')
    expect(err).not.toBeNull()
    expect(err).toContain('$((')
  })

  test('unbalanced single quote is rejected', () => {
    const err = validateArgString("foo 'bar")
    expect(err).not.toBeNull()
    expect(err).toContain('single')
  })

  test('unbalanced double quote is rejected', () => {
    const err = validateArgString('foo "bar')
    expect(err).not.toBeNull()
    expect(err).toContain('double')
  })

  test('trailing backslash is rejected', () => {
    const err = validateArgString('foo\\')
    expect(err).not.toBeNull()
    expect(err).toContain('backslash')
  })

  test('logical and && is rejected', () => {
    const err = validateArgString('cmd1 && cmd2')
    expect(err).not.toBeNull()
    expect(err).toContain('&&')
  })

  test('logical or || is rejected', () => {
    const err = validateArgString('cmd1 || cmd2')
    expect(err).not.toBeNull()
    expect(err).toContain('||')
  })

  test('single ampersand is rejected', () => {
    const err = validateArgString('cmd &')
    expect(err).not.toBeNull()
    expect(err).toContain('ampersand')
  })

  test('single pipe is rejected', () => {
    const err = validateArgString('echo foo | grep bar')
    expect(err).not.toBeNull()
    expect(err).toContain('pipe')
  })

  test('redirect > is rejected', () => {
    const err = validateArgString('echo foo > file')
    expect(err).not.toBeNull()
    expect(err).toContain('>')
  })

  test('redirect < is rejected', () => {
    const err = validateArgString('cat < file')
    expect(err).not.toBeNull()
    expect(err).toContain('<')
  })
})
