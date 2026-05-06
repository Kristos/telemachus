/**
 * Phase 24-01 (AGENT-07): pure schedule string parser.
 *
 * Accepts exactly three forms:
 *   - "hourly"               → [{ Minute: 0 }]
 *   - "daily"                → [{ Hour: 0, Minute: 0 }]
 *   - "cron: M H D M DoW"    → one or more dicts; a field may be a
 *                              comma-separated list of integers (e.g. "1,3,5"
 *                              in the DoW slot). Each combination of list
 *                              values expands to its own dict. Single
 *                              integers and '*' work as before. Ranges
 *                              ("1-5") and steps ("*∕5") are still rejected.
 *
 * Returns a CalendarInterval[] — callers that only need one dict can take
 * `[0]` when the length is 1. The plist renderer emits a single dict or an
 * array of dicts based on length. No ranges, no steps. Local time. Leaf
 * module — no imports.
 */

export interface CalendarInterval {
  Minute?: number
  Hour?: number
  Day?: number
  Month?: number
  Weekday?: number
}

type FieldName = 'Minute' | 'Hour' | 'Day' | 'Month' | 'Weekday'

const CRON_FIELDS: ReadonlyArray<{ name: FieldName; lo: number; hi: number }> = [
  { name: 'Minute', lo: 0, hi: 59 },
  { name: 'Hour', lo: 0, hi: 23 },
  { name: 'Day', lo: 1, hi: 31 },
  { name: 'Month', lo: 1, hi: 12 },
  { name: 'Weekday', lo: 0, hi: 7 },
]

// A single field: star, an integer, OR a comma-separated integer list.
// Steps (`*/5`) and ranges (`1-5`) are still rejected.
const FIELD_RE = /^(\*|\d+(?:,\d+)*)$/

function formsError(input: string): Error {
  return new Error(
    `Phase 24 schedule only supports "hourly", "daily", or "cron: M H D M DoW" with integers or comma-separated integer lists (got ${JSON.stringify(input)})`,
  )
}

/**
 * Parse one cron field into `undefined` (meaning "*", omit key) or an array
 * of validated normalized integers. Throws on range/step/malformed.
 */
function parseField(
  field: string,
  spec: { name: FieldName; lo: number; hi: number },
  input: string,
): number[] | undefined {
  if (!FIELD_RE.test(field)) throw formsError(input)
  if (field === '*') return undefined
  const parts = field.split(',')
  const out: number[] = []
  for (const part of parts) {
    const n = Number.parseInt(part, 10)
    if (n < spec.lo || n > spec.hi) {
      throw new Error(
        `cron field ${spec.name}: value ${n} out of range ${spec.lo}-${spec.hi}`,
      )
    }
    const normalized = spec.name === 'Weekday' && n === 7 ? 0 : n
    if (!out.includes(normalized)) out.push(normalized)
  }
  return out
}

export function parseSchedule(input: string): CalendarInterval[] {
  const trimmed = input.trim()
  if (trimmed === '') throw formsError(input)
  if (trimmed === 'hourly') return [{ Minute: 0 }]
  if (trimmed === 'daily') return [{ Hour: 0, Minute: 0 }]

  if (!trimmed.startsWith('cron:')) throw formsError(input)

  const body = trimmed.slice('cron:'.length)
  const fields = body.split(/\s+/).filter((f) => f.length > 0)
  if (fields.length !== 5) throw formsError(input)

  // Parse each field into either undefined (star) or a list.
  const parsed: Array<{ name: FieldName; values: number[] | undefined }> = []
  for (let i = 0; i < 5; i++) {
    const spec = CRON_FIELDS[i]!
    const values = parseField(fields[i]!, spec, input)
    parsed.push({ name: spec.name, values })
  }

  // Build the cartesian product across all fields that have a list.
  // Fields with `undefined` contribute nothing (key omitted in result).
  let result: CalendarInterval[] = [{}]
  for (const { name, values } of parsed) {
    if (values === undefined) continue
    const next: CalendarInterval[] = []
    for (const existing of result) {
      for (const v of values) {
        next.push({ ...existing, [name]: v })
      }
    }
    result = next
  }

  return result
}
