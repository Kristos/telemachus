/**
 * Phase 24-02: help text assertions. Keeps the Phase 24 stub markers from
 * sneaking back in and pins the schedule grammar documentation.
 */
import { describe, test, expect } from 'bun:test'
import { HELP_TEXT } from './help'

describe('HELP_TEXT', () => {
  test('no stale Phase 24 stub markers', () => {
    expect(HELP_TEXT).not.toContain('coming in Phase 24')
  })

  test('documents schedule grammar forms', () => {
    expect(HELP_TEXT).toContain('hourly')
    expect(HELP_TEXT).toContain('daily')
    expect(HELP_TEXT).toContain('cron: M H D M DoW')
  })

  test('notes launchd runs in local time', () => {
    expect(HELP_TEXT).toContain('local time')
  })

  test('lists the three Phase 24 subcommands', () => {
    expect(HELP_TEXT).toContain('install <name>')
    expect(HELP_TEXT).toContain('uninstall <name>')
    expect(HELP_TEXT).toMatch(/\blist\b/)
  })
})
