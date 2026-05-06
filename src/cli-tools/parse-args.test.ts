import { describe, expect, test } from 'bun:test'
import { parseArgString } from './parse-args.js'

describe('parseArgString', () => {
  test('empty string returns empty array', () => {
    expect(parseArgString('')).toEqual([])
  })

  test('whitespace-only string returns empty array', () => {
    expect(parseArgString('   \t  ')).toEqual([])
  })

  test('single word', () => {
    expect(parseArgString('foo')).toEqual(['foo'])
  })

  test('two words', () => {
    expect(parseArgString('foo bar')).toEqual(['foo', 'bar'])
  })

  test('collapses runs of whitespace', () => {
    expect(parseArgString('   foo   bar   ')).toEqual(['foo', 'bar'])
  })

  test('double-quoted segment within a token', () => {
    expect(parseArgString('foo "bar baz" qux')).toEqual(['foo', 'bar baz', 'qux'])
  })

  test('single-quoted segment within a token', () => {
    expect(parseArgString("foo 'bar baz' qux")).toEqual(['foo', 'bar baz', 'qux'])
  })

  test('single quotes do not process escapes', () => {
    expect(parseArgString("'foo\\nbar'")).toEqual(['foo\\nbar'])
  })

  test('double quotes process backslash escapes', () => {
    expect(parseArgString('"foo \\"bar\\" baz"')).toEqual(['foo "bar" baz'])
  })

  test('escaped space makes single token', () => {
    expect(parseArgString('foo\\ bar')).toEqual(['foo bar'])
  })

  test('mixed quotes', () => {
    expect(parseArgString(`'single' "double" plain`)).toEqual(['single', 'double', 'plain'])
  })

  test('dollar sign passes through literally (no shell expansion)', () => {
    expect(parseArgString('echo $HOME')).toEqual(['echo', '$HOME'])
  })

  test('tilde passes through literally (no expansion)', () => {
    expect(parseArgString('ls ~/foo')).toEqual(['ls', '~/foo'])
  })

  test('glob chars pass through literally', () => {
    expect(parseArgString('ls *.ts ?.md')).toEqual(['ls', '*.ts', '?.md'])
  })

  test('empty quoted string is preserved as empty token', () => {
    expect(parseArgString('foo "" bar')).toEqual(['foo', '', 'bar'])
  })

  test('adjacent quoted and unquoted concatenate into one token', () => {
    expect(parseArgString('foo"bar"baz')).toEqual(['foobarbaz'])
  })
})
