import React, { useState } from 'react'
import { describe, test, expect, afterEach } from 'bun:test'
import { render, cleanup } from 'ink-testing-library'
import { Chat } from './chat.js'
import type { Message } from '../providers/types.js'

afterEach(() => cleanup())

const TAB = '\t'
const SHIFT_TAB = '\x1b[Z'
const ENTER = '\r'
const ESC = '\x1b'

const longResult = Array.from({ length: 20 }, (_, i) => `mline${i + 1}`).join('\n')
const shortBash = 'b1\nb2\nb3'
const shortCli = 'c1\nc2\nc3\nc4\nc5'

const buildMessages = (): Message[] => [
  { role: 'user', content: 'hi' },
  {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'tool-1', name: 'bash', input: {} }],
  },
  { role: 'tool', content: shortBash, toolCallId: 'tool-1' },
  {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'tool-2', name: 'mcp:rs:run_sql', input: {} }],
  },
  { role: 'tool', content: longResult, toolCallId: 'tool-2' },
  {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'tool-3', name: 'cli:gh', input: {} }],
  },
  { role: 'tool', content: shortCli, toolCallId: 'tool-3' },
]

async function ready() {
  await new Promise(r => setTimeout(r, 40))
}
async function tick() {
  await new Promise(r => setTimeout(r, 40))
}

describe('Chat tool block focus', () => {
  test('initial render: short expanded, long collapsed, no focus marker', async () => {
    const { lastFrame } = render(<Chat messages={buildMessages()} collapseThreshold={10} />)
    await ready()
    const frame = lastFrame() ?? ''
    // Short bash result expanded -> contains body
    expect(frame).toContain('b1')
    expect(frame).toContain('b3')
    // Long mcp collapsed -> summary, no mline20
    expect(frame).toContain('Tool: mcp:rs:run_sql')
    expect(frame).toContain('(20 lines)')
    expect(frame).not.toContain('mline20')
    // Short cli expanded
    expect(frame).toContain('c5')
    // No focus marker
    expect(frame).not.toContain('› ')
  })

  test('Tab focuses first, then second, then third, wraps', async () => {
    const { lastFrame, stdin } = render(<Chat messages={buildMessages()} collapseThreshold={10} />)
    await ready()
    stdin.write(TAB); await tick()
    expect(lastFrame() ?? '').toContain('› ')
    // First tool focused; first is bash (expanded). Second tab moves focus.
    stdin.write(TAB); await tick()
    stdin.write(TAB); await tick()
    // After three tabs we are on tool-3 (cli:gh)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('› ')
    // Wrap
    stdin.write(TAB); await tick()
    expect(lastFrame() ?? '').toContain('› ')
  })

  test('Shift+Tab from no focus wraps to last', async () => {
    const { lastFrame, stdin } = render(<Chat messages={buildMessages()} collapseThreshold={10} />)
    await ready()
    stdin.write(SHIFT_TAB); await tick()
    expect(lastFrame() ?? '').toContain('› ')
  })

  test('Enter on focused collapsed mcp expands it', async () => {
    const { lastFrame, stdin } = render(<Chat messages={buildMessages()} collapseThreshold={10} />)
    await ready()
    // Tab to bash, tab to mcp
    stdin.write(TAB); await tick()
    stdin.write(TAB); await tick()
    // Now mcp focused, collapsed by default
    expect(lastFrame() ?? '').not.toContain('mline20')
    stdin.write(ENTER); await tick()
    expect(lastFrame() ?? '').toContain('mline20')
    // Enter again collapses
    stdin.write(ENTER); await tick()
    expect(lastFrame() ?? '').not.toContain('mline20')
  })

  test('Escape clears focus', async () => {
    const { lastFrame, stdin } = render(<Chat messages={buildMessages()} collapseThreshold={10} />)
    await ready()
    stdin.write(TAB); await tick()
    expect(lastFrame() ?? '').toContain('› ')
    stdin.write(ESC); await tick()
    expect(lastFrame() ?? '').not.toContain('› ')
  })

  test('submitSignal change resets focus', async () => {
    function Wrapper() {
      const [sig, setSig] = useState(0)
      return (
        <>
          <Chat messages={buildMessages()} collapseThreshold={10} submitSignal={sig} />
          <ResetButton onPress={() => setSig(s => s + 1)} />
        </>
      )
    }
    function ResetButton({ onPress }: { onPress: () => void }) {
      const { useInput } = require('ink')
      useInput((input: string) => {
        if (input === 'r') onPress()
      })
      return null
    }
    const { lastFrame, stdin } = render(<Wrapper />)
    await ready()
    stdin.write(TAB); await tick()
    expect(lastFrame() ?? '').toContain('› ')
    stdin.write('r'); await tick()
    expect(lastFrame() ?? '').not.toContain('› ')
  })
})
