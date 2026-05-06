import { describe, test, expect } from 'bun:test'
import {
  reducer,
  initialState,
  draftText,
  isDraftEmpty,
  isDraftUnedited,
  type InputState,
  type InputEvent,
  type InputAction,
} from './input-state.js'

// --- helpers ---------------------------------------------------------------

function apply(state: InputState, events: InputEvent[]): { state: InputState; lastAction: InputAction } {
  let s = state
  let lastAction: InputAction = { kind: 'none' }
  for (const e of events) {
    const r = reducer(s, e)
    s = r.state
    lastAction = r.action
  }
  return { state: s, lastAction }
}

function typeChars(text: string): InputEvent[] {
  return Array.from(text).map(char => ({ type: 'char', char }) as InputEvent)
}

// --- Task 1: editing surface ----------------------------------------------

describe('initialState', () => {
  test('returns fresh empty draft', () => {
    expect(initialState()).toEqual({
      lines: [''],
      cursorLine: 0,
      cursorCol: 0,
      history: [],
      historyIdx: null,
      savedDraft: null,
    })
  })
})

describe('char insertion', () => {
  test('appends char at cursor and advances cursorCol', () => {
    const { state } = apply(initialState(), typeChars('hi'))
    expect(state.lines).toEqual(['hi'])
    expect(state.cursorCol).toBe(2)
    expect(state.cursorLine).toBe(0)
  })

  test('inserts mid-string', () => {
    const s0 = initialState()
    const { state } = apply(s0, [
      ...typeChars('hello'),
      { type: 'home' },
      ...typeChars('X'),
    ])
    expect(state.lines).toEqual(['Xhello'])
    expect(state.cursorCol).toBe(1)
  })
})

describe('backspace', () => {
  test('deletes char before cursor', () => {
    const { state } = apply(initialState(), [...typeChars('abc'), { type: 'backspace' }])
    expect(state.lines).toEqual(['ab'])
    expect(state.cursorCol).toBe(2)
  })

  test('at col 0 on line > 0 merges with previous line', () => {
    const { state } = apply(initialState(), [
      ...typeChars('hello'),
      { type: 'shiftEnter' },
      ...typeChars('world'),
      { type: 'home' },
      { type: 'backspace' },
    ])
    expect(state.lines).toEqual(['helloworld'])
    expect(state.cursorLine).toBe(0)
    expect(state.cursorCol).toBe(5) // at the join point
  })

  test('no-op at start of draft', () => {
    const { state } = apply(initialState(), [{ type: 'backspace' }])
    expect(state.lines).toEqual([''])
    expect(state.cursorCol).toBe(0)
  })
})

describe('delete (forward)', () => {
  test('removes char at cursor', () => {
    const { state } = apply(initialState(), [
      ...typeChars('abc'),
      { type: 'home' },
      { type: 'delete' },
    ])
    expect(state.lines).toEqual(['bc'])
    expect(state.cursorCol).toBe(0)
  })

  test('at end-of-line merges next line', () => {
    const { state } = apply(initialState(), [
      ...typeChars('foo'),
      { type: 'shiftEnter' },
      ...typeChars('bar'),
      { type: 'up' }, // go to line 0
      { type: 'end' },
      { type: 'delete' },
    ])
    expect(state.lines).toEqual(['foobar'])
  })
})

describe('shiftEnter', () => {
  test('splits line at cursor', () => {
    const { state } = apply(initialState(), [
      ...typeChars('helloworld'),
      { type: 'home' },
      ...typeChars(''),
      { type: 'right' },
      { type: 'right' },
      { type: 'right' },
      { type: 'right' },
      { type: 'right' },
      { type: 'shiftEnter' },
    ])
    expect(state.lines).toEqual(['hello', 'world'])
    expect(state.cursorLine).toBe(1)
    expect(state.cursorCol).toBe(0)
  })

  test('split at end of line leaves empty second line', () => {
    const { state } = apply(initialState(), [...typeChars('abc'), { type: 'shiftEnter' }])
    expect(state.lines).toEqual(['abc', ''])
    expect(state.cursorLine).toBe(1)
    expect(state.cursorCol).toBe(0)
  })
})

describe('left/right with line wrap', () => {
  test('right at end-of-line jumps to start of next', () => {
    const { state } = apply(initialState(), [
      ...typeChars('ab'),
      { type: 'shiftEnter' },
      ...typeChars('cd'),
      { type: 'up' },
      { type: 'end' },
      { type: 'right' },
    ])
    expect(state.cursorLine).toBe(1)
    expect(state.cursorCol).toBe(0)
  })

  test('left at col 0 jumps to end of previous line', () => {
    const { state } = apply(initialState(), [
      ...typeChars('ab'),
      { type: 'shiftEnter' },
      ...typeChars('cd'),
      { type: 'home' },
      { type: 'left' },
    ])
    expect(state.cursorLine).toBe(0)
    expect(state.cursorCol).toBe(2)
  })

  test('left at 0,0 is a no-op', () => {
    const { state } = apply(initialState(), [{ type: 'left' }])
    expect(state.cursorLine).toBe(0)
    expect(state.cursorCol).toBe(0)
  })
})

describe('home/end', () => {
  test('home -> col 0, end -> line length', () => {
    const { state } = apply(initialState(), [
      ...typeChars('hello'),
      { type: 'home' },
    ])
    expect(state.cursorCol).toBe(0)
    const { state: s2 } = apply(state, [{ type: 'end' }])
    expect(s2.cursorCol).toBe(5)
  })
})

describe('draftText / isDraftEmpty', () => {
  test('joins lines with newline', () => {
    const { state } = apply(initialState(), [
      ...typeChars('ab'),
      { type: 'shiftEnter' },
      ...typeChars('cd'),
    ])
    expect(draftText(state)).toBe('ab\ncd')
  })

  test('isDraftEmpty detects fresh state', () => {
    expect(isDraftEmpty(initialState())).toBe(true)
    const { state } = apply(initialState(), typeChars('x'))
    expect(isDraftEmpty(state)).toBe(false)
  })
})

// --- Task 2: submit/reset/history -----------------------------------------

describe('enter / submit', () => {
  test('enter on empty draft does nothing', () => {
    const { lastAction } = apply(initialState(), [{ type: 'enter' }])
    expect(lastAction).toEqual({ kind: 'none' })
  })

  test('enter on non-empty draft emits submit', () => {
    const { lastAction } = apply(initialState(), [...typeChars('hello'), { type: 'enter' }])
    expect(lastAction).toEqual({ kind: 'submit', text: 'hello' })
  })

  test('enter on multi-line draft submits joined text', () => {
    const { lastAction } = apply(initialState(), [
      ...typeChars('ab'),
      { type: 'shiftEnter' },
      ...typeChars('cd'),
      { type: 'enter' },
    ])
    expect(lastAction).toEqual({ kind: 'submit', text: 'ab\ncd' })
  })
})

describe('reset', () => {
  test('clears draft but preserves history', () => {
    const { state } = apply(initialState(), [
      ...typeChars('hello'),
      { type: 'pushHistory', text: 'hello' },
      { type: 'reset' },
    ])
    expect(state.lines).toEqual([''])
    expect(state.cursorLine).toBe(0)
    expect(state.cursorCol).toBe(0)
    expect(state.history).toEqual(['hello'])
    expect(state.historyIdx).toBeNull()
    expect(state.savedDraft).toBeNull()
  })
})

describe('pushHistory / clearHistory', () => {
  test('pushHistory appends; duplicates preserved in order', () => {
    const { state } = apply(initialState(), [
      { type: 'pushHistory', text: 'a' },
      { type: 'pushHistory', text: 'b' },
      { type: 'pushHistory', text: 'a' },
    ])
    expect(state.history).toEqual(['a', 'b', 'a'])
  })

  test('clearHistory empties everything', () => {
    const { state } = apply(initialState(), [
      { type: 'pushHistory', text: 'a' },
      { type: 'pushHistory', text: 'b' },
      { type: 'clearHistory' },
    ])
    expect(state.history).toEqual([])
    expect(state.historyIdx).toBeNull()
    expect(state.savedDraft).toBeNull()
  })
})

describe('history recall via Up/Down', () => {
  function seeded(): InputState {
    const { state } = apply(initialState(), [
      { type: 'pushHistory', text: 'first' },
      { type: 'pushHistory', text: 'second' },
      { type: 'pushHistory', text: 'third' },
    ])
    return state
  }

  test('up on empty draft loads newest entry, cursor at end', () => {
    const { state } = apply(seeded(), [{ type: 'up' }])
    expect(state.lines).toEqual(['third'])
    expect(state.historyIdx).toBe(2)
    expect(state.cursorLine).toBe(0)
    expect(state.cursorCol).toBe(5)
    expect(state.savedDraft).toEqual([''])
  })

  test('repeated up walks backward then clamps at oldest', () => {
    const { state } = apply(seeded(), [
      { type: 'up' },
      { type: 'up' },
      { type: 'up' },
      { type: 'up' }, // should no-op at idx 0
    ])
    expect(state.lines).toEqual(['first'])
    expect(state.historyIdx).toBe(0)
  })

  test('down past newest returns to savedDraft', () => {
    const { state } = apply(seeded(), [
      { type: 'up' },
      { type: 'down' }, // back to draft
    ])
    expect(state.lines).toEqual([''])
    expect(state.historyIdx).toBeNull()
    expect(state.savedDraft).toBeNull()
  })

  test('down at newest with no forward history returns to draft', () => {
    const { state } = apply(seeded(), [
      { type: 'up' }, // third
      { type: 'down' }, // back to empty draft
    ])
    expect(state.historyIdx).toBeNull()
    expect(state.lines).toEqual([''])
  })

  test('down walks forward through history', () => {
    const { state } = apply(seeded(), [
      { type: 'up' },
      { type: 'up' },
      { type: 'up' }, // at 'first'
      { type: 'down' }, // 'second'
    ])
    expect(state.lines).toEqual(['second'])
    expect(state.historyIdx).toBe(1)
  })

  test('up on multi-line draft with cursorLine > 0 moves cursor, no history', () => {
    const s0 = seeded()
    const { state } = apply(s0, [
      ...typeChars('abc'),
      { type: 'shiftEnter' },
      ...typeChars('defgh'),
      { type: 'up' },
    ])
    expect(state.historyIdx).toBeNull()
    expect(state.cursorLine).toBe(0)
    // clamped to line length (3)
    expect(state.cursorCol).toBe(3)
  })

  test('up on edited multi-line draft at line 0 does not enter history', () => {
    const s0 = seeded()
    const { state } = apply(s0, [
      ...typeChars('abc'),
      { type: 'shiftEnter' },
      ...typeChars('def'),
      { type: 'up' }, // moves to line 0
      { type: 'up' }, // line 0 but edited -> no-op
    ])
    expect(state.historyIdx).toBeNull()
    expect(state.lines).toEqual(['abc', 'def'])
  })

  test('typing while in history mode copies entry into draft and clears recall', () => {
    const { state } = apply(seeded(), [
      { type: 'up' }, // third
      ...typeChars('X'),
    ])
    expect(state.historyIdx).toBeNull()
    expect(state.savedDraft).toBeNull()
    expect(state.lines).toEqual(['thirdX'])
  })

  test('isDraftUnedited true after recall, false after edit', () => {
    const s0 = seeded()
    const afterUp = apply(s0, [{ type: 'up' }]).state
    expect(isDraftUnedited(afterUp)).toBe(true)
    const afterEdit = apply(afterUp, [...typeChars('!')]).state
    expect(isDraftUnedited(afterEdit)).toBe(false)
  })

  test('pushHistory then reset returns historyIdx to null and clears savedDraft', () => {
    const s0 = seeded()
    const { state } = apply(s0, [
      { type: 'up' },
      { type: 'pushHistory', text: 'fourth' },
      { type: 'reset' },
    ])
    expect(state.historyIdx).toBeNull()
    expect(state.savedDraft).toBeNull()
    expect(state.lines).toEqual([''])
    expect(state.history).toEqual(['first', 'second', 'third', 'fourth'])
  })
})
