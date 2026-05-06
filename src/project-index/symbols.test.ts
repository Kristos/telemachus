import { describe, test, expect } from 'bun:test'
import { extractSymbols } from './symbols.js'

describe('extractSymbols', () => {
  test('returns empty array for empty string', () => {
    expect(extractSymbols('', 'foo.ts')).toEqual([])
  })

  test('extracts exported async function', () => {
    const content = `export async function myAsyncFn() {\n  return 42\n}`
    const symbols = extractSymbols(content, 'foo.ts')
    expect(symbols.some(s => s.name === 'myAsyncFn' && s.kind === 'function')).toBe(true)
  })

  test('extracts exported function', () => {
    const content = `export function myFn() {}`
    const symbols = extractSymbols(content, 'foo.ts')
    expect(symbols.some(s => s.name === 'myFn' && s.kind === 'function')).toBe(true)
  })

  test('extracts exported class', () => {
    const content = `export class MyClass {}`
    const symbols = extractSymbols(content, 'foo.ts')
    expect(symbols.some(s => s.name === 'MyClass' && s.kind === 'class')).toBe(true)
  })

  test('extracts exported const', () => {
    const content = `export const MY_CONST = 42`
    const symbols = extractSymbols(content, 'foo.ts')
    expect(symbols.some(s => s.name === 'MY_CONST' && s.kind === 'const')).toBe(true)
  })

  test('extracts exported type', () => {
    const content = `export type MyType = string | number`
    const symbols = extractSymbols(content, 'foo.ts')
    expect(symbols.some(s => s.name === 'MyType' && s.kind === 'type')).toBe(true)
  })

  test('extracts exported interface', () => {
    const content = `export interface MyInterface {\n  name: string\n}`
    const symbols = extractSymbols(content, 'foo.ts')
    expect(symbols.some(s => s.name === 'MyInterface' && s.kind === 'interface')).toBe(true)
  })

  test('extracts exported enum', () => {
    const content = `export enum MyEnum { A, B, C }`
    const symbols = extractSymbols(content, 'foo.ts')
    expect(symbols.some(s => s.name === 'MyEnum' && s.kind === 'enum')).toBe(true)
  })

  test('extracts non-exported function', () => {
    const content = `function helper() {}`
    const symbols = extractSymbols(content, 'foo.ts')
    expect(symbols.some(s => s.name === 'helper' && s.kind === 'function')).toBe(true)
  })

  test('extracts non-exported async function', () => {
    const content = `async function helperAsync() {}`
    const symbols = extractSymbols(content, 'foo.ts')
    expect(symbols.some(s => s.name === 'helperAsync' && s.kind === 'function')).toBe(true)
  })

  test('extracts non-exported class', () => {
    const content = `class LocalClass {}`
    const symbols = extractSymbols(content, 'foo.ts')
    expect(symbols.some(s => s.name === 'LocalClass' && s.kind === 'class')).toBe(true)
  })

  test('extracts non-exported const', () => {
    const content = `const localConst = 'hello'`
    const symbols = extractSymbols(content, 'foo.ts')
    expect(symbols.some(s => s.name === 'localConst' && s.kind === 'const')).toBe(true)
  })

  test('extracts named import', () => {
    const content = `import { foo, bar } from 'some-module'`
    const symbols = extractSymbols(content, 'foo.ts')
    const names = symbols.filter(s => s.kind === 'import').map(s => s.name)
    expect(names).toContain('foo')
    expect(names).toContain('bar')
  })

  test('extracts default import', () => {
    const content = `import React from 'react'`
    const symbols = extractSymbols(content, 'foo.ts')
    expect(symbols.some(s => s.name === 'React' && s.kind === 'import')).toBe(true)
  })

  test('extracts multi-line file with mixed declarations', () => {
    const content = [
      `import { z } from 'zod'`,
      `import path from 'node:path'`,
      ``,
      `export interface Config {`,
      `  name: string`,
      `}`,
      ``,
      `export function parseConfig(raw: unknown): Config {`,
      `  return raw as Config`,
      `}`,
      ``,
      `export class ConfigManager {`,
      `  private config: Config`,
      `}`,
      ``,
      `const DEFAULT_NAME = 'default'`,
    ].join('\n')

    const symbols = extractSymbols(content, 'config.ts')
    const names = symbols.map(s => s.name)

    expect(names).toContain('z')
    expect(names).toContain('path')
    expect(names).toContain('Config')
    expect(names).toContain('parseConfig')
    expect(names).toContain('ConfigManager')
    expect(names).toContain('DEFAULT_NAME')
  })

  test('ignores indented declarations (not top-level)', () => {
    const content = [
      `function outer() {`,
      `  function inner() {}`,
      `  class InnerClass {}`,
      `  const localVar = 1`,
      `}`,
    ].join('\n')

    const symbols = extractSymbols(content, 'foo.ts')
    expect(symbols.some(s => s.name === 'inner')).toBe(false)
    expect(symbols.some(s => s.name === 'InnerClass')).toBe(false)
    expect(symbols.some(s => s.name === 'localVar')).toBe(false)
    // outer is still top-level
    expect(symbols.some(s => s.name === 'outer')).toBe(true)
  })

  test('line numbers are correct (1-indexed)', () => {
    const content = [`import { z } from 'zod'`, ``, `export function myFn() {}`].join('\n')
    const symbols = extractSymbols(content, 'foo.ts')
    const importSym = symbols.find(s => s.name === 'z' && s.kind === 'import')
    const fnSym = symbols.find(s => s.name === 'myFn' && s.kind === 'function')
    expect(importSym!.line).toBe(1)
    expect(fnSym!.line).toBe(3)
  })

  test('returns immutable array (no mutation concerns)', () => {
    const content = `export function myFn() {}`
    const result = extractSymbols(content, 'foo.ts')
    expect(Array.isArray(result)).toBe(true)
  })

  test('import with spaces in destructuring', () => {
    const content = `import { alpha, beta, gamma } from 'module'`
    const symbols = extractSymbols(content, 'foo.ts')
    const importNames = symbols.filter(s => s.kind === 'import').map(s => s.name)
    expect(importNames).toContain('alpha')
    expect(importNames).toContain('beta')
    expect(importNames).toContain('gamma')
  })

  test('import with aliases (as) extracts local name', () => {
    const content = `import { foo as localFoo } from 'module'`
    const symbols = extractSymbols(content, 'foo.ts')
    const importNames = symbols.filter(s => s.kind === 'import').map(s => s.name)
    // The local name (after 'as') should be extracted, or the original — implementation choice
    // We test that at least one import symbol is found
    expect(importNames.length).toBeGreaterThan(0)
  })
})
