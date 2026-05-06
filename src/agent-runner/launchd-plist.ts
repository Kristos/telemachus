/**
 * Phase 24-01 (AGENT-07): pure launchd plist XML generator.
 *
 * Emits XML with exactly four top-level keys in locked order:
 *   Label, ProgramArguments, StartCalendarInterval, EnvironmentVariables
 *
 * Zero I/O, zero subprocess. Consumed by Plan 24-02 orchestrator.
 */
import type { CalendarInterval } from './schedule-parse'

export interface RenderPlistInput {
  label: string
  programArguments: string[]
  /**
   * One or more calendar intervals. A single entry renders as a `<dict>`,
   * multiple entries render as `<array><dict>...</dict>...</array>`. launchd
   * fires the job whenever ANY interval in the array matches.
   */
  calendarInterval: CalendarInterval | CalendarInterval[]
  envPath: string
  /**
   * Post-v3.8 hotfix: without WorkingDirectory, launchd spawns the job at
   * cwd='/' and the SAND-02 sandbox probe rejects every run. Optional so
   * tests stay minimal; real installs should always pass the project root.
   */
  workingDirectory?: string
}

const XML_HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'

const SCI_KEY_ORDER: ReadonlyArray<keyof CalendarInterval> = [
  'Minute',
  'Hour',
  'Day',
  'Month',
  'Weekday',
]

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function renderPlist(input: RenderPlistInput): string {
  const { label, programArguments, calendarInterval, envPath, workingDirectory } = input
  const lines: string[] = []
  lines.push(XML_HEADER)
  lines.push('<plist version="1.0">')
  lines.push('<dict>')

  // Label
  lines.push('    <key>Label</key>')
  lines.push(`    <string>${escape(label)}</string>`)

  // ProgramArguments
  lines.push('    <key>ProgramArguments</key>')
  lines.push('    <array>')
  for (const arg of programArguments) {
    lines.push(`        <string>${escape(arg)}</string>`)
  }
  lines.push('    </array>')

  // StartCalendarInterval — single <dict> or <array><dict>...</dict></array>
  lines.push('    <key>StartCalendarInterval</key>')
  const intervals = Array.isArray(calendarInterval)
    ? calendarInterval
    : [calendarInterval]
  const renderDict = (ci: CalendarInterval, indent: string): void => {
    lines.push(`${indent}<dict>`)
    for (const key of SCI_KEY_ORDER) {
      const value = ci[key]
      if (value === undefined) continue
      lines.push(`${indent}    <key>${key}</key>`)
      lines.push(`${indent}    <integer>${value}</integer>`)
    }
    lines.push(`${indent}</dict>`)
  }
  if (intervals.length === 1) {
    renderDict(intervals[0]!, '    ')
  } else {
    lines.push('    <array>')
    for (const ci of intervals) {
      renderDict(ci, '        ')
    }
    lines.push('    </array>')
  }

  // EnvironmentVariables
  lines.push('    <key>EnvironmentVariables</key>')
  lines.push('    <dict>')
  lines.push('        <key>PATH</key>')
  lines.push(`        <string>${escape(envPath)}</string>`)
  lines.push('    </dict>')

  // WorkingDirectory — prevents cwd='/' at spawn time (see run-job.ts notes).
  if (workingDirectory && workingDirectory.length > 0) {
    lines.push('    <key>WorkingDirectory</key>')
    lines.push(`    <string>${escape(workingDirectory)}</string>`)
  }

  lines.push('</dict>')
  lines.push('</plist>')
  return lines.join('\n') + '\n'
}
