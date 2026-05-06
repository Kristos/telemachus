/**
 * Phase 24-01 Task 3: renderPlist tests.
 *
 * Snapshot + shape cases for the four locked keys. Verifies XML header,
 * DOCTYPE, XML escaping, key ordering, and absence of forbidden keys.
 */
import { describe, test, expect } from 'bun:test'
import { renderPlist } from './launchd-plist'

const XML_HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'

const PROG_ARGS = ['/usr/bin/true', 'agent', 'run', 'test']
const ENV_PATH = '/usr/bin:/bin'

describe('renderPlist', () => {
  test('DOCTYPE present at top of output', () => {
    const xml = renderPlist({
      label: 'com.telemachus.agent.test',
      programArguments: PROG_ARGS,
      calendarInterval: { Minute: 0 },
      envPath: ENV_PATH,
    })
    expect(xml.startsWith(XML_HEADER)).toBe(true)
  })

  test('output ends with trailing newline', () => {
    const xml = renderPlist({
      label: 'com.telemachus.agent.test',
      programArguments: PROG_ARGS,
      calendarInterval: { Minute: 0 },
      envPath: ENV_PATH,
    })
    expect(xml.endsWith('\n')).toBe(true)
  })

  test('hourly: StartCalendarInterval has only Minute', () => {
    const xml = renderPlist({
      label: 'com.telemachus.agent.test',
      programArguments: PROG_ARGS,
      calendarInterval: { Minute: 0 },
      envPath: ENV_PATH,
    })
    expect(xml).toContain('<key>StartCalendarInterval</key>')
    expect(xml).toContain('<key>Minute</key>\n        <integer>0</integer>')
    expect(xml).not.toContain('<key>Hour</key>')
    expect(xml).not.toContain('<key>Day</key>')
    expect(xml).not.toContain('<key>Month</key>')
    expect(xml).not.toContain('<key>Weekday</key>')
  })

  test('daily: StartCalendarInterval has Hour and Minute', () => {
    const xml = renderPlist({
      label: 'com.telemachus.agent.test',
      programArguments: PROG_ARGS,
      calendarInterval: { Hour: 0, Minute: 0 },
      envPath: ENV_PATH,
    })
    expect(xml).toContain('<key>Minute</key>')
    expect(xml).toContain('<key>Hour</key>')
    expect(xml).not.toContain('<key>Day</key>')
    expect(xml).not.toContain('<key>Weekday</key>')
  })

  test('cron 30 14 * * 1: Minute, Hour, Weekday only', () => {
    const xml = renderPlist({
      label: 'com.telemachus.agent.test',
      programArguments: PROG_ARGS,
      calendarInterval: { Minute: 30, Hour: 14, Weekday: 1 },
      envPath: ENV_PATH,
    })
    expect(xml).toContain('<integer>30</integer>')
    expect(xml).toContain('<integer>14</integer>')
    expect(xml).toContain('<key>Weekday</key>')
    expect(xml).toContain('<integer>1</integer>')
    expect(xml).not.toContain('<key>Day</key>')
    expect(xml).not.toContain('<key>Month</key>')
  })

  test('env path expansion: full PATH appears verbatim', () => {
    const fullPath =
      '/Users/testuser/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
    const xml = renderPlist({
      label: 'com.telemachus.agent.test',
      programArguments: PROG_ARGS,
      calendarInterval: { Minute: 0 },
      envPath: fullPath,
    })
    expect(xml).toContain(`<string>${fullPath}</string>`)
    expect(xml).toContain('<key>EnvironmentVariables</key>')
    expect(xml).toContain('<key>PATH</key>')
  })

  test('xml escape: & in label becomes &amp;', () => {
    const xml = renderPlist({
      label: 'com.telemachus.agent.a&b',
      programArguments: PROG_ARGS,
      calendarInterval: { Minute: 0 },
      envPath: ENV_PATH,
    })
    expect(xml).toContain('<string>com.telemachus.agent.a&amp;b</string>')
    expect(xml).not.toContain('a&b</string>')
  })

  test('xml escape: all five unsafe chars in program arguments', () => {
    const xml = renderPlist({
      label: 'com.telemachus.agent.test',
      programArguments: ['<&>"\'', 'arg2'],
      calendarInterval: { Minute: 0 },
      envPath: ENV_PATH,
    })
    expect(xml).toContain('<string>&lt;&amp;&gt;&quot;&apos;</string>')
  })

  test('no forbidden keys ever appear', () => {
    const xml = renderPlist({
      label: 'com.telemachus.agent.test',
      programArguments: PROG_ARGS,
      calendarInterval: { Minute: 0, Hour: 12, Day: 1, Month: 6, Weekday: 3 },
      envPath: ENV_PATH,
    })
    for (const forbidden of [
      'StandardOutPath',
      'StandardErrorPath',
      'WorkingDirectory',
      'RunAtLoad',
      'KeepAlive',
      'ProcessType',
      'ThrottleInterval',
    ]) {
      expect(xml).not.toContain(forbidden)
    }
  })

  test('ProgramArguments order preserved', () => {
    const xml = renderPlist({
      label: 'com.telemachus.agent.test',
      programArguments: ['/Users/testuser/.bun/bin/kc', 'agent', 'run', 'nightly-job'],
      calendarInterval: { Minute: 0 },
      envPath: ENV_PATH,
    })
    const kcIdx = xml.indexOf('/Users/testuser/.bun/bin/kc')
    const agentIdx = xml.indexOf('<string>agent</string>')
    const runIdx = xml.indexOf('<string>run</string>')
    const nameIdx = xml.indexOf('<string>nightly-job</string>')
    expect(kcIdx).toBeGreaterThan(-1)
    expect(agentIdx).toBeGreaterThan(kcIdx)
    expect(runIdx).toBeGreaterThan(agentIdx)
    expect(nameIdx).toBeGreaterThan(runIdx)
  })

  test('top-level key order: Label, ProgramArguments, StartCalendarInterval, EnvironmentVariables', () => {
    const xml = renderPlist({
      label: 'com.telemachus.agent.test',
      programArguments: PROG_ARGS,
      calendarInterval: { Minute: 0 },
      envPath: ENV_PATH,
    })
    const labelIdx = xml.indexOf('<key>Label</key>')
    const progIdx = xml.indexOf('<key>ProgramArguments</key>')
    const sciIdx = xml.indexOf('<key>StartCalendarInterval</key>')
    const envIdx = xml.indexOf('<key>EnvironmentVariables</key>')
    expect(labelIdx).toBeGreaterThan(-1)
    expect(progIdx).toBeGreaterThan(labelIdx)
    expect(sciIdx).toBeGreaterThan(progIdx)
    expect(envIdx).toBeGreaterThan(sciIdx)
  })

  test('StartCalendarInterval key order within dict: Minute, Hour, Day, Month, Weekday', () => {
    const xml = renderPlist({
      label: 'com.telemachus.agent.test',
      programArguments: PROG_ARGS,
      calendarInterval: { Weekday: 3, Day: 1, Minute: 5, Month: 6, Hour: 12 },
      envPath: ENV_PATH,
    })
    const minuteIdx = xml.indexOf('<key>Minute</key>')
    const hourIdx = xml.indexOf('<key>Hour</key>')
    const dayIdx = xml.indexOf('<key>Day</key>')
    const monthIdx = xml.indexOf('<key>Month</key>')
    const weekdayIdx = xml.indexOf('<key>Weekday</key>')
    expect(hourIdx).toBeGreaterThan(minuteIdx)
    expect(dayIdx).toBeGreaterThan(hourIdx)
    expect(monthIdx).toBeGreaterThan(dayIdx)
    expect(weekdayIdx).toBeGreaterThan(monthIdx)
  })

  test('never emits <integer>*</integer>', () => {
    const xml = renderPlist({
      label: 'com.telemachus.agent.test',
      programArguments: PROG_ARGS,
      calendarInterval: { Minute: 0 },
      envPath: ENV_PATH,
    })
    expect(xml).not.toContain('<integer>*</integer>')
  })

  describe('multi-interval (array of CalendarInterval)', () => {
    test('Mon/Wed/Fri 08:00 renders as array of 3 dicts', () => {
      const xml = renderPlist({
        label: 'com.telemachus.agent.test',
        programArguments: PROG_ARGS,
        calendarInterval: [
          { Minute: 0, Hour: 8, Weekday: 1 },
          { Minute: 0, Hour: 8, Weekday: 3 },
          { Minute: 0, Hour: 8, Weekday: 5 },
        ],
        envPath: ENV_PATH,
      })
      // Outer <key>StartCalendarInterval</key> followed by <array>
      const sciIdx = xml.indexOf('<key>StartCalendarInterval</key>')
      const arrayIdx = xml.indexOf('<array>', sciIdx)
      const arrayCloseIdx = xml.indexOf('</array>', arrayIdx)
      expect(sciIdx).toBeGreaterThan(-1)
      expect(arrayIdx).toBeGreaterThan(sciIdx)
      expect(arrayCloseIdx).toBeGreaterThan(arrayIdx)
      // Three inner dicts
      const sciSection = xml.slice(arrayIdx, arrayCloseIdx)
      const dictOpens = sciSection.match(/<dict>/g) ?? []
      expect(dictOpens).toHaveLength(3)
      // All three weekdays present
      expect(xml).toContain('<integer>1</integer>')
      expect(xml).toContain('<integer>3</integer>')
      expect(xml).toContain('<integer>5</integer>')
    })
    test('single-element array still renders as bare <dict>', () => {
      const xml = renderPlist({
        label: 'com.telemachus.agent.test',
        programArguments: PROG_ARGS,
        calendarInterval: [{ Minute: 0 }],
        envPath: ENV_PATH,
      })
      const sciIdx = xml.indexOf('<key>StartCalendarInterval</key>')
      const nextOpen = xml.slice(sciIdx + 1).match(/<(dict|array)>/)
      expect(nextOpen?.[1]).toBe('dict')
    })
    test('array form still honors locked top-level key order', () => {
      const xml = renderPlist({
        label: 'com.telemachus.agent.test',
        programArguments: PROG_ARGS,
        calendarInterval: [
          { Minute: 0, Weekday: 1 },
          { Minute: 0, Weekday: 3 },
        ],
        envPath: ENV_PATH,
      })
      const labelIdx = xml.indexOf('<key>Label</key>')
      const progIdx = xml.indexOf('<key>ProgramArguments</key>')
      const sciIdx = xml.indexOf('<key>StartCalendarInterval</key>')
      const envIdx = xml.indexOf('<key>EnvironmentVariables</key>')
      expect(progIdx).toBeGreaterThan(labelIdx)
      expect(sciIdx).toBeGreaterThan(progIdx)
      expect(envIdx).toBeGreaterThan(sciIdx)
    })
  })
})
