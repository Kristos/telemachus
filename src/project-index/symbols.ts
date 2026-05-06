import { z } from 'zod'

export const SymbolKindSchema = z.enum([
  'function',
  'class',
  'import',
  'type',
  'interface',
  'enum',
  'const',
])

export type SymbolKind = z.infer<typeof SymbolKindSchema>

export interface ExtractedSymbol {
  name: string
  kind: SymbolKind
  line: number
}

// Top-level declaration patterns (only match lines with no leading whitespace)
const PATTERNS: Array<{ re: RegExp; kind: SymbolKind }> = [
  { re: /^export\s+(?:async\s+)?function\s+(\w+)/, kind: 'function' },
  { re: /^export\s+class\s+(\w+)/, kind: 'class' },
  { re: /^export\s+const\s+(\w+)/, kind: 'const' },
  { re: /^export\s+type\s+(\w+)/, kind: 'type' },
  { re: /^export\s+interface\s+(\w+)/, kind: 'interface' },
  { re: /^export\s+enum\s+(\w+)/, kind: 'enum' },
  { re: /^(?:async\s+)?function\s+(\w+)/, kind: 'function' },
  { re: /^class\s+(\w+)/, kind: 'class' },
  { re: /^const\s+(\w+)\s*=/, kind: 'const' },
]

// Named import: import { a, b as c } from '...'
const NAMED_IMPORT_RE = /^import\s+\{([^}]+)\}\s+from/

// Default import: import Foo from '...'
const DEFAULT_IMPORT_RE = /^import\s+(\w+)\s+from/

/**
 * Extract top-level symbols from TypeScript/JavaScript source content.
 * Only processes lines starting at column 0 (no leading whitespace).
 *
 * @param content - Source file content
 * @param filePath - Used for context only (not currently used in extraction)
 * @returns Immutable array of extracted symbols with name, kind, and 1-indexed line number
 */
export function extractSymbols(content: string, _filePath: string): ReadonlyArray<ExtractedSymbol> {
  if (!content) return []

  const result: ExtractedSymbol[] = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1 // 1-indexed

    // Skip lines with leading whitespace — they are not top-level
    if (line.length > 0 && (line[0] === ' ' || line[0] === '\t')) {
      continue
    }

    // Check for named import: import { a, b as localB } from '...'
    const namedMatch = NAMED_IMPORT_RE.exec(line)
    if (namedMatch) {
      const names = namedMatch[1].split(',')
      for (const raw of names) {
        const trimmed = raw.trim()
        if (!trimmed) continue
        // Handle "foo as bar" — extract local name (bar)
        const asParts = trimmed.split(/\s+as\s+/)
        const localName = asParts.length > 1 ? asParts[1].trim() : asParts[0].trim()
        if (localName && /^\w+$/.test(localName)) {
          result.push({ name: localName, kind: 'import', line: lineNum })
        }
      }
      continue
    }

    // Check for default import: import Foo from '...'
    const defaultMatch = DEFAULT_IMPORT_RE.exec(line)
    if (defaultMatch) {
      result.push({ name: defaultMatch[1], kind: 'import', line: lineNum })
      continue
    }

    // Check declaration patterns
    for (const { re, kind } of PATTERNS) {
      const match = re.exec(line)
      if (match) {
        result.push({ name: match[1], kind, line: lineNum })
        break
      }
    }
  }

  return result
}
