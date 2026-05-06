import React from 'react'
import { describe, test, expect, mock, afterEach } from 'bun:test'
import { render, cleanup } from 'ink-testing-library'
import { Input, mapInkKeyToEvent, computeVisibleWindow, type ImageAttachment } from './input.js'

// Key sequences that Ink's useInput understands
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const SHIFT_ENTER = '\x1b\r' // ESC + CR — Ink maps this to { return: true, shift: true }
const ENTER = '\r'
const TAB = '\t'

async function tick() {
  // Let Ink flush effects and re-render
  await new Promise(resolve => setTimeout(resolve, 50))
}

/** Must be called after render() before first stdin.write — lets useInput mount. */
async function ready() {
  await new Promise(resolve => setTimeout(resolve, 40))
}

describe('Input component', () => {
  afterEach(() => {
    cleanup()
  })

  test('typing "hello" shows "> hello" in frame', async () => {
    const onSubmit = mock(() => {})
    const { lastFrame, stdin } = render(
      <Input isProcessing={false} onSubmit={onSubmit} onExitRequested={() => {}} />,
    )
    await ready()
    stdin.write('hello')
    await tick()
    expect(lastFrame()).toContain('> hello')
  })

  test('Enter submits single-line draft', async () => {
    const onSubmit = mock(() => {})
    const { stdin } = render(
      <Input isProcessing={false} onSubmit={onSubmit} onExitRequested={() => {}} />,
    )
    await ready()
    stdin.write('hello')
    await tick()
    stdin.write(ENTER)
    await tick()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect((onSubmit.mock.calls[0] as unknown as [{ text: string; attachments: ImageAttachment[] }])[0].text).toBe('hello')
  })
  // Note: Shift+Enter key encoding varies per terminal and ink-testing-library's
  // stdin doesn't reliably emit a parsed shift+return event. The mapInkKeyToEvent
  // unit test below covers the key→event wiring; multi-line editing via shiftEnter
  // is covered exhaustively by the input-state reducer tests (Plan 01).

  test('Up arrow on empty draft recalls submitted turn', async () => {
    const onSubmit = mock(() => {})
    const { lastFrame, stdin } = render(
      <Input isProcessing={false} onSubmit={onSubmit} onExitRequested={() => {}} />,
    )
    await ready()
    stdin.write('first')
    await tick()
    stdin.write(ENTER)
    await tick()
    stdin.write(UP)
    await tick()
    expect(lastFrame()).toContain('first')
  })

  test('Up then Down returns to empty draft', async () => {
    const onSubmit = mock(() => {})
    const { lastFrame, stdin } = render(
      <Input isProcessing={false} onSubmit={onSubmit} onExitRequested={() => {}} />,
    )
    await ready()
    stdin.write('first')
    await tick()
    stdin.write(ENTER)
    await tick()
    stdin.write(UP)
    await tick()
    stdin.write(DOWN)
    await tick()
    const frame = lastFrame() ?? ''
    // Draft should be empty — look for '> ' followed by no content (caret only)
    expect(frame).not.toContain('first')
  })

  test('clearSignal bump clears history so Up does nothing', async () => {
    const onSubmit = mock(() => {})
    const { lastFrame, stdin, rerender } = render(
      <Input
        isProcessing={false}
        onSubmit={onSubmit}
        clearSignal={0}
        onExitRequested={() => {}}
      />,
    )
    await ready()
    stdin.write('first')
    await tick()
    stdin.write(ENTER)
    await tick()
    // Bump clearSignal
    rerender(
      <Input
        isProcessing={false}
        onSubmit={onSubmit}
        clearSignal={1}
        onExitRequested={() => {}}
      />,
    )
    await tick()
    stdin.write(UP)
    await tick()
    expect(lastFrame() ?? '').not.toContain('first')
  })

  test('historyInitial seeds history for recall', async () => {
    const onSubmit = mock(() => {})
    const { lastFrame, stdin } = render(
      <Input
        isProcessing={false}
        onSubmit={onSubmit}
        historyInitial={['seeded-entry']}
        onExitRequested={() => {}}
      />,
    )
    await ready()
    stdin.write(UP)
    await tick()
    expect(lastFrame()).toContain('seeded-entry')
  })

  test('historyInitial with multi-line entry + maxLines=3 shows only 3 lines', async () => {
    // Avoid shift+enter in tests — seed a multi-line history entry and recall it.
    const onSubmit = mock(() => {})
    const multiLine = 'a\nb\nc\nd\ne'
    const { lastFrame, stdin } = render(
      <Input
        isProcessing={false}
        onSubmit={onSubmit}
        maxLines={3}
        historyInitial={[multiLine]}
        onExitRequested={() => {}}
      />,
    )
    await ready()
    stdin.write(UP)
    await tick()
    const frame = lastFrame() ?? ''
    // Cursor lands at end ('e') so 'e' must be visible; at most 3 lines shown.
    expect(frame).toContain('e')
    const rendered = frame.split('\n').filter(l => /^[>\s]\s[a-e]$/.test(l))
    expect(rendered.length).toBeLessThanOrEqual(3)
  })

  test('tab completion on /he offers /help', async () => {
    const onSubmit = mock(() => {})
    const { lastFrame, stdin } = render(
      <Input isProcessing={false} onSubmit={onSubmit} onExitRequested={() => {}} />,
    )
    await ready()
    stdin.write('/he')
    await tick()
    stdin.write(TAB)
    await tick()
    expect(lastFrame()).toContain('/help')
  })

  test('Ctrl+C invokes onExitRequested without crashing', async () => {
    const onSubmit = mock(() => {})
    const onExitRequested = mock(() => {})
    const { stdin } = render(
      <Input
        isProcessing={false}
        onSubmit={onSubmit}
        onExitRequested={onExitRequested}
      />,
    )
    await ready()
    stdin.write('\x03') // Ctrl+C
    await tick()
    expect(onExitRequested).toHaveBeenCalled()
  })

  // ───── Phase 21-03: paste + attachment + vision gating ─────

  const fakeAttachment: ImageAttachment = {
    label: 'pasted.png',
    mediaType: 'image/png',
    data: 'iVBORw0KGgo=',
  }
  const stubResolver = mock(async (raw: string) => {
    if (raw.includes('image')) return fakeAttachment
    return null
  })

  test('paste of recognised image shows attachment pill (vision-capable)', async () => {
    const onSubmit = mock(() => {})
    const { lastFrame, stdin } = render(
      <Input
        isProcessing={false}
        onSubmit={onSubmit}
        visionCapable={true}
        currentModelLabel="claude-sonnet-4-6"
        resolveAttachment={stubResolver}
        onExitRequested={() => {}}
      />,
    )
    await ready()
    // Simulate a paste — multi-char chunk that the resolver will recognise
    stdin.write('data:image/png;base64,iVBORw0KGgo=')
    await tick()
    await tick()
    expect(lastFrame() ?? '').toContain('📎')
    expect(lastFrame() ?? '').toContain('pasted.png')
  })

  test('paste of recognised image shows yellow warning when not vision-capable', async () => {
    const onSubmit = mock(() => {})
    const { lastFrame, stdin } = render(
      <Input
        isProcessing={false}
        onSubmit={onSubmit}
        visionCapable={false}
        currentModelLabel="GLM-4.7-Flash"
        resolveAttachment={stubResolver}
        onExitRequested={() => {}}
      />,
    )
    await ready()
    stdin.write('data:image/png;base64,iVBORw0KGgo=')
    await tick()
    await tick()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('not vision-capable')
    expect(frame).toContain('GLM-4.7-Flash')
  })

  test('submit with attachments + visionCapable=true → onSubmit receives attachments', async () => {
    const onSubmit = mock(() => {})
    const { stdin } = render(
      <Input
        isProcessing={false}
        onSubmit={onSubmit}
        visionCapable={true}
        currentModelLabel="claude-sonnet-4-6"
        resolveAttachment={stubResolver}
        onExitRequested={() => {}}
      />,
    )
    await ready()
    stdin.write('data:image/png;base64,iVBORw0KGgo=')
    await tick()
    await tick()
    stdin.write(ENTER)
    await tick()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const arg = (onSubmit.mock.calls[0] as unknown as [{ text: string; attachments: ImageAttachment[] }])[0]
    expect(arg.attachments).toHaveLength(1)
    expect(arg.attachments[0].mediaType).toBe('image/png')
  })

  test('submit with attachments + visionCapable=false → attachments dropped', async () => {
    const onSubmit = mock(() => {})
    const { stdin } = render(
      <Input
        isProcessing={false}
        onSubmit={onSubmit}
        visionCapable={false}
        currentModelLabel="GLM-4.7-Flash"
        resolveAttachment={stubResolver}
        onExitRequested={() => {}}
      />,
    )
    await ready()
    stdin.write('data:image/png;base64,iVBORw0KGgo=')
    await tick()
    await tick()
    // Need some text or attachments to allow submit; attachments suffice now.
    stdin.write(ENTER)
    await tick()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    const arg = (onSubmit.mock.calls[0] as unknown as [{ text: string; attachments: ImageAttachment[] }])[0]
    expect(arg.attachments).toHaveLength(0)
  })

  test('clearSignal bump drops pending attachments', async () => {
    const onSubmit = mock(() => {})
    const { lastFrame, stdin, rerender } = render(
      <Input
        isProcessing={false}
        onSubmit={onSubmit}
        visionCapable={true}
        currentModelLabel="claude-sonnet-4-6"
        resolveAttachment={stubResolver}
        clearSignal={0}
        onExitRequested={() => {}}
      />,
    )
    await ready()
    stdin.write('data:image/png;base64,iVBORw0KGgo=')
    await tick()
    await tick()
    expect(lastFrame() ?? '').toContain('📎')
    rerender(
      <Input
        isProcessing={false}
        onSubmit={onSubmit}
        visionCapable={true}
        currentModelLabel="claude-sonnet-4-6"
        resolveAttachment={stubResolver}
        clearSignal={1}
        onExitRequested={() => {}}
      />,
    )
    await tick()
    expect(lastFrame() ?? '').not.toContain('📎')
  })

  test('isProcessing shows Processing... instead of input box', async () => {
    const onSubmit = mock(() => {})
    const { lastFrame } = render(
      <Input isProcessing={true} onSubmit={onSubmit} onExitRequested={() => {}} />,
    )
    await ready()
    expect(lastFrame()).toContain('Processing...')
  })
})

describe('mapInkKeyToEvent', () => {
  const baseKey = {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
  }

  test('shift+return → shiftEnter', () => {
    expect(mapInkKeyToEvent('', { ...baseKey, return: true, shift: true })).toEqual({
      type: 'shiftEnter',
    })
  })
  test('return → enter', () => {
    expect(mapInkKeyToEvent('', { ...baseKey, return: true })).toEqual({ type: 'enter' })
  })
  test('printable char → char', () => {
    expect(mapInkKeyToEvent('x', baseKey)).toEqual({ type: 'char', char: 'x' })
  })
  test('ctrl+char → null', () => {
    expect(mapInkKeyToEvent('a', { ...baseKey, ctrl: true })).toBeNull()
  })
})

describe('computeVisibleWindow', () => {
  test('all lines visible when <= maxLines', () => {
    const r = computeVisibleWindow(['a', 'b', 'c'], 1, 10)
    expect(r.visible).toEqual(['a', 'b', 'c'])
    expect(r.scrollTop).toBe(0)
  })
  test('scrolls to keep cursor visible', () => {
    const lines = ['a', 'b', 'c', 'd', 'e']
    const r = computeVisibleWindow(lines, 4, 3)
    expect(r.visible.length).toBe(3)
    expect(r.visible).toContain('e')
  })
})
