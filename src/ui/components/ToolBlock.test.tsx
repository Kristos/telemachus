import React from 'react'
import { describe, test, expect, afterEach } from 'bun:test'
import { render, cleanup } from 'ink-testing-library'
import { ToolBlock, countLines, shouldCollapseByDefault } from './ToolBlock.js'

afterEach(() => cleanup())

const noop = () => {}

describe('countLines', () => {
  test('empty string is one line', () => {
    expect(countLines('')).toBe(1)
  })
  test('single token is one line', () => {
    expect(countLines('a')).toBe(1)
  })
  test('two newline-separated lines', () => {
    expect(countLines('a\nb')).toBe(2)
  })
  test('trailing newline does not add a line', () => {
    expect(countLines('a\nb\n')).toBe(2)
  })
  test('trailing whitespace lines do not count', () => {
    expect(countLines('a\nb\n   \n')).toBe(2)
  })
  test('blank middle lines DO count', () => {
    expect(countLines('a\n\nb')).toBe(3)
  })
})

describe('shouldCollapseByDefault', () => {
  test('short text under threshold', () => {
    expect(shouldCollapseByDefault('short', 10)).toBe(false)
  })
  test('11 lines over threshold of 10', () => {
    const text = Array.from({ length: 11 }, (_, i) => `l${i + 1}`).join('\n')
    expect(shouldCollapseByDefault(text, 10)).toBe(true)
  })
  test('honors custom threshold', () => {
    const text = Array.from({ length: 6 }, (_, i) => `l${i}`).join('\n')
    expect(shouldCollapseByDefault(text, 5)).toBe(true)
    expect(shouldCollapseByDefault(text, 10)).toBe(false)
  })
})

describe('ToolBlock rendering', () => {
  const shortResult = 'l1\nl2\nl3'
  const longResult = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join('\n')

  test('short result expanded shows header and body', () => {
    const { lastFrame } = render(
      <ToolBlock
        toolId="t1"
        toolName="bash"
        result={shortResult}
        collapsed={false}
        focused={false}
        onToggle={noop}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('▾ Tool: bash')
    expect(frame).toContain('l1')
    expect(frame).toContain('l3')
  })

  test('short result collapsed shows summary with duration, no body', () => {
    const { lastFrame } = render(
      <ToolBlock
        toolId="t1"
        toolName="bash"
        result={shortResult}
        durationMs={42}
        collapsed={true}
        focused={false}
        onToggle={noop}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('▸ Tool: bash')
    expect(frame).toContain('(3 lines, 42ms)')
    expect(frame).not.toContain('l1')
  })

  test('long result collapsed', () => {
    const { lastFrame } = render(
      <ToolBlock
        toolId="t1"
        toolName="bash"
        result={longResult}
        collapsed={true}
        focused={false}
        onToggle={noop}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('▸ Tool: bash')
    expect(frame).toContain('(15 lines)')
    expect(frame).not.toContain('line15')
  })

  test('long result expanded shows all lines', () => {
    const { lastFrame } = render(
      <ToolBlock
        toolId="t1"
        toolName="bash"
        result={longResult}
        collapsed={false}
        focused={false}
        onToggle={noop}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('▾ Tool: bash')
    expect(frame).toContain('line1')
    expect(frame).toContain('line15')
  })

  test('focused=true adds focus marker', () => {
    const { lastFrame } = render(
      <ToolBlock
        toolId="t1"
        toolName="bash"
        result={shortResult}
        collapsed={true}
        focused={true}
        onToggle={noop}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('›')
  })

  test('focused=false omits marker', () => {
    const { lastFrame } = render(
      <ToolBlock
        toolId="t1"
        toolName="bash"
        result={shortResult}
        collapsed={true}
        focused={false}
        onToggle={noop}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).not.toContain('›')
  })

  test('mcp tool name renders as-is', () => {
    const { lastFrame } = render(
      <ToolBlock
        toolId="t1"
        toolName="mcp:redshift:run_sql"
        result={shortResult}
        collapsed={true}
        focused={false}
        onToggle={noop}
      />,
    )
    expect(lastFrame() ?? '').toContain('Tool: mcp:redshift:run_sql')
  })

  test('cli tool name renders as-is', () => {
    const { lastFrame } = render(
      <ToolBlock
        toolId="t1"
        toolName="cli:gh"
        result={shortResult}
        collapsed={true}
        focused={false}
        onToggle={noop}
      />,
    )
    expect(lastFrame() ?? '').toContain('Tool: cli:gh')
  })

  test('no duration -> no ms segment', () => {
    const { lastFrame } = render(
      <ToolBlock
        toolId="t1"
        toolName="bash"
        result={shortResult}
        collapsed={true}
        focused={false}
        onToggle={noop}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('(3 lines)')
    expect(frame).not.toContain('ms')
  })

  test('duration 1500ms', () => {
    const { lastFrame } = render(
      <ToolBlock
        toolId="t1"
        toolName="bash"
        result={shortResult}
        durationMs={1500}
        collapsed={true}
        focused={false}
        onToggle={noop}
      />,
    )
    expect(lastFrame() ?? '').toContain('(3 lines, 1500ms)')
  })
})
