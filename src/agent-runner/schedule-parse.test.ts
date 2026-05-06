/**
 * Phase 24-01 Task 1 (RED) / Task 2 (GREEN): parseSchedule cases.
 *
 * Contract locked in 24-CONTEXT Decisions and 24-RESEARCH Examples 1-4.
 * v1 integers-only; ranges/steps/lists are rejected.
 */
import { describe, test, expect } from 'bun:test'
import { parseSchedule, type CalendarInterval } from './schedule-parse'

const ACCEPTED_FORMS_MSG_PARTS = ['hourly', 'daily', 'cron: M H D M DoW']

function expectRejectNamingForms(input: string): void {
  let caught: unknown
  try {
    parseSchedule(input)
  } catch (e) {
    caught = e
  }
  expect(caught).toBeInstanceOf(Error)
  const msg = (caught as Error).message
  for (const part of ACCEPTED_FORMS_MSG_PARTS) {
    expect(msg).toContain(part)
  }
}

function expectRangeError(
  input: string,
  name: 'Minute' | 'Hour' | 'Day' | 'Month' | 'Weekday',
  value: number,
  lo: number,
  hi: number,
): void {
  expect(() => parseSchedule(input)).toThrow(
    `cron field ${name}: value ${value} out of range ${lo}-${hi}`,
  )
}

describe('parseSchedule', () => {
  describe('hourly', () => {
    test('"hourly" → [{ Minute: 0 }]', () => {
      expect(parseSchedule('hourly')).toEqual([{ Minute: 0 }] as CalendarInterval[])
    })
  })

  describe('daily', () => {
    test('"daily" → [{ Hour: 0, Minute: 0 }]', () => {
      expect(parseSchedule('daily')).toEqual([
        { Hour: 0, Minute: 0 },
      ] as CalendarInterval[])
    })
  })

  describe('cron valid (single-value fields)', () => {
    test('"cron: 0 0 * * *" → [{ Minute: 0, Hour: 0 }]', () => {
      expect(parseSchedule('cron: 0 0 * * *')).toEqual([{ Minute: 0, Hour: 0 }])
    })
    test('"cron: 30 14 * * 1" → Minute/Hour/Weekday', () => {
      expect(parseSchedule('cron: 30 14 * * 1')).toEqual([
        { Minute: 30, Hour: 14, Weekday: 1 },
      ])
    })
    test('"cron: * * * * 0" → [{ Weekday: 0 }]', () => {
      expect(parseSchedule('cron: * * * * 0')).toEqual([{ Weekday: 0 }])
    })
    test('"cron: * * 15 6 *" → [{ Day: 15, Month: 6 }]', () => {
      expect(parseSchedule('cron: * * 15 6 *')).toEqual([{ Day: 15, Month: 6 }])
    })
    test('"cron: * * * * 7" normalizes Weekday 7 → 0', () => {
      expect(parseSchedule('cron: * * * * 7')).toEqual([{ Weekday: 0 }])
    })
    test('"cron: 59 23 31 12 6" high edges', () => {
      expect(parseSchedule('cron: 59 23 31 12 6')).toEqual([
        { Minute: 59, Hour: 23, Day: 31, Month: 12, Weekday: 6 },
      ])
    })
    test('"cron: 0 0 1 1 0" low edges', () => {
      expect(parseSchedule('cron: 0 0 1 1 0')).toEqual([
        { Minute: 0, Hour: 0, Day: 1, Month: 1, Weekday: 0 },
      ])
    })
    test('whitespace tolerant: multiple spaces after colon', () => {
      expect(parseSchedule('cron:  0 0 * * *')).toEqual([{ Minute: 0, Hour: 0 }])
    })
    test('whitespace tolerant: multiple spaces between fields', () => {
      expect(parseSchedule('cron: 0  0 * * *')).toEqual([{ Minute: 0, Hour: 0 }])
    })
  })

  describe('cron valid (comma-separated lists expand to multiple dicts)', () => {
    test('DoW list "1,3,5" → 3 dicts, Mon/Wed/Fri', () => {
      expect(parseSchedule('cron: 0 8 * * 1,3,5')).toEqual([
        { Minute: 0, Hour: 8, Weekday: 1 },
        { Minute: 0, Hour: 8, Weekday: 3 },
        { Minute: 0, Hour: 8, Weekday: 5 },
      ])
    })
    test('Hour list "8,17" → 2 dicts', () => {
      expect(parseSchedule('cron: 0 8,17 * * *')).toEqual([
        { Minute: 0, Hour: 8 },
        { Minute: 0, Hour: 17 },
      ])
    })
    test('two lists cartesian product: 2 hours × 3 weekdays = 6 dicts', () => {
      const result = parseSchedule('cron: 0 8,17 * * 1,3,5')
      expect(result).toHaveLength(6)
      expect(result).toContainEqual({ Minute: 0, Hour: 8, Weekday: 1 })
      expect(result).toContainEqual({ Minute: 0, Hour: 17, Weekday: 5 })
    })
    test('list with duplicates dedupes: "1,1,3" → 2 dicts', () => {
      expect(parseSchedule('cron: 0 0 * * 1,1,3')).toEqual([
        { Minute: 0, Hour: 0, Weekday: 1 },
        { Minute: 0, Hour: 0, Weekday: 3 },
      ])
    })
    test('single-element list "1" equivalent to bare "1"', () => {
      expect(parseSchedule('cron: 0 0 * * 1')).toEqual(
        parseSchedule('cron: 0 0 * * 1'),
      )
    })
    test('out-of-range member in list still rejects with range error', () => {
      expect(() => parseSchedule('cron: 0 0 * * 1,8')).toThrow(
        'cron field Weekday: value 8 out of range 0-7',
      )
    })
    test('Weekday normalization applies inside lists: "0,7" dedupes to [0]', () => {
      expect(parseSchedule('cron: 0 0 * * 0,7')).toEqual([
        { Minute: 0, Hour: 0, Weekday: 0 },
      ])
    })
  })

  describe('cron reject grammar', () => {
    test('"weekly" rejected', () => {
      expectRejectNamingForms('weekly')
    })
    test('empty string rejected', () => {
      expectRejectNamingForms('')
    })
    test('"cron:" no fields', () => {
      expectRejectNamingForms('cron:')
    })
    test('"cron: 0 0 * *" 4 fields', () => {
      expectRejectNamingForms('cron: 0 0 * *')
    })
    test('"cron: 0 0 * * * *" 6 fields', () => {
      expectRejectNamingForms('cron: 0 0 * * * *')
    })
    test('"cron 0 0 * * *" missing colon', () => {
      expectRejectNamingForms('cron 0 0 * * *')
    })
  })

  describe('cron reject syntax (integers-only)', () => {
    test('step "*/5" rejected', () => {
      expectRejectNamingForms('cron: */5 * * * *')
    })
    test('range "1-5" rejected', () => {
      expectRejectNamingForms('cron: 1-5 * * * *')
    })
    test('list "1,3,5" now accepted (was rejected in v1)', () => {
      // The "integers only" contract was relaxed to also accept
      // comma-separated integer lists so agents can fire on specific
      // weekdays like Mon/Wed/Fri. Steps and ranges are still rejected.
      expect(() => parseSchedule('cron: 1,3,5 * * * *')).not.toThrow()
    })
    test('step "0/2" rejected', () => {
      expectRejectNamingForms('cron: 0/2 * * * *')
    })
    test('trailing comma rejected', () => {
      expectRejectNamingForms('cron: 1, * * * *')
    })
    test('empty element in list "1,,3" rejected', () => {
      expectRejectNamingForms('cron: 1,,3 * * * *')
    })
  })

  describe('cron reject range', () => {
    test('Minute 60', () => {
      expectRangeError('cron: 60 * * * *', 'Minute', 60, 0, 59)
    })
    test('Hour 24', () => {
      expectRangeError('cron: * 24 * * *', 'Hour', 24, 0, 23)
    })
    test('Day 0', () => {
      expectRangeError('cron: * * 0 * *', 'Day', 0, 1, 31)
    })
    test('Day 32', () => {
      expectRangeError('cron: * * 32 * *', 'Day', 32, 1, 31)
    })
    test('Month 0', () => {
      expectRangeError('cron: * * * 0 *', 'Month', 0, 1, 12)
    })
    test('Month 13', () => {
      expectRangeError('cron: * * * 13 *', 'Month', 13, 1, 12)
    })
    test('Weekday 8', () => {
      expectRangeError('cron: * * * * 8', 'Weekday', 8, 0, 7)
    })
    test('Weekday -1 (rejected by integer regex)', () => {
      // "-1" fails the ^(\*|\d+)$ regex so it rejects via naming-forms message.
      expectRejectNamingForms('cron: * * * * -1')
    })
  })
})
