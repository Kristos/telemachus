// Pure input state machine for the TUI.
// No React, no Ink, no side effects. Every transition returns a new state.
//
// Design note (cursor column): when moving between lines of different lengths,
// cursorCol clamps to the target line's length. We deliberately do NOT track a
// "desired column" across consecutive vertical moves — this keeps v1 simple.
// If a user hits Up/Down across a short line, the column will be clamped and
// stay clamped. Revisit if it becomes annoying in practice.
//
// Design note (baseline / "unedited"): we know the draft is unedited since the
// last recall or reset when either:
//   - historyIdx !== null AND lines equals history[historyIdx] split by '\n'
//   - historyIdx === null AND lines equals the initial draft ([""]) — i.e. a
//     fresh/reset draft. Any typing clears historyIdx and puts us on a dirty
//     fresh draft where Up no longer hijacks into history.

export interface InputState {
  lines: string[] // draft buffer, never empty (at least [""])
  cursorLine: number // 0-based index into lines
  cursorCol: number // 0-based column within lines[cursorLine]
  history: string[] // in-memory, chronological (oldest first)
  historyIdx: number | null // null = editing draft; N = recalled history[N]
  savedDraft: string[] | null // draft snapshot while browsing history
}

export type InputEvent =
  | { type: 'char'; char: string }
  | { type: 'enter' }
  | { type: 'shiftEnter' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'pushHistory'; text: string }
  | { type: 'clearHistory' }
  | { type: 'reset' }

export type InputAction =
  | { kind: 'none' }
  | { kind: 'submit'; text: string }

export interface ReducerResult {
  state: InputState
  action: InputAction
}

const NONE: InputAction = { kind: 'none' }

export function initialState(): InputState {
  return {
    lines: [''],
    cursorLine: 0,
    cursorCol: 0,
    history: [],
    historyIdx: null,
    savedDraft: null,
  }
}

export function draftText(state: InputState): string {
  return state.lines.join('\n')
}

export function isDraftEmpty(state: InputState): boolean {
  return state.lines.length === 1 && state.lines[0] === ''
}

export function isDraftUnedited(state: InputState): boolean {
  if (state.historyIdx !== null) {
    const recalled = state.history[state.historyIdx]
    if (recalled === undefined) return false
    const recalledLines = recalled.split('\n')
    return linesEqual(state.lines, recalledLines)
  }
  // No history recall active: unedited iff draft is the fresh empty draft.
  return isDraftEmpty(state)
}

function linesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function replaceLine(lines: string[], idx: number, newLine: string): string[] {
  const out = lines.slice()
  out[idx] = newLine
  return out
}

function clampCursorToLine(lines: string[], line: number, col: number) {
  const l = Math.max(0, Math.min(line, lines.length - 1))
  const c = Math.max(0, Math.min(col, lines[l].length))
  return { cursorLine: l, cursorCol: c }
}

function loadHistoryEntry(state: InputState, idx: number): InputState {
  const entry = state.history[idx]
  const lines = entry.split('\n')
  const lastLine = lines.length - 1
  return {
    ...state,
    lines,
    cursorLine: lastLine,
    cursorCol: lines[lastLine].length,
    historyIdx: idx,
    savedDraft: state.savedDraft ?? state.lines,
  }
}

function materializeRecallIntoDraft(state: InputState): InputState {
  // User started editing while in history mode: copy recalled entry into draft.
  if (state.historyIdx === null) return state
  return {
    ...state,
    historyIdx: null,
    savedDraft: null,
  }
}

export function reducer(state: InputState, event: InputEvent): ReducerResult {
  switch (event.type) {
    case 'char': {
      const s = materializeRecallIntoDraft(state)
      const line = s.lines[s.cursorLine]
      const newLine = line.slice(0, s.cursorCol) + event.char + line.slice(s.cursorCol)
      return {
        state: {
          ...s,
          lines: replaceLine(s.lines, s.cursorLine, newLine),
          cursorCol: s.cursorCol + event.char.length,
        },
        action: NONE,
      }
    }

    case 'shiftEnter': {
      const s = materializeRecallIntoDraft(state)
      const line = s.lines[s.cursorLine]
      const before = line.slice(0, s.cursorCol)
      const after = line.slice(s.cursorCol)
      const lines = s.lines.slice(0, s.cursorLine).concat([before, after], s.lines.slice(s.cursorLine + 1))
      return {
        state: { ...s, lines, cursorLine: s.cursorLine + 1, cursorCol: 0 },
        action: NONE,
      }
    }

    case 'enter': {
      if (isDraftEmpty(state)) return { state, action: NONE }
      const text = draftText(state)
      return { state, action: { kind: 'submit', text } }
    }

    case 'backspace': {
      const s = materializeRecallIntoDraft(state)
      if (s.cursorCol === 0) {
        if (s.cursorLine === 0) return { state: s, action: NONE }
        const prev = s.lines[s.cursorLine - 1]
        const curr = s.lines[s.cursorLine]
        const merged = prev + curr
        const lines = s.lines
          .slice(0, s.cursorLine - 1)
          .concat([merged], s.lines.slice(s.cursorLine + 1))
        return {
          state: { ...s, lines, cursorLine: s.cursorLine - 1, cursorCol: prev.length },
          action: NONE,
        }
      }
      const line = s.lines[s.cursorLine]
      const newLine = line.slice(0, s.cursorCol - 1) + line.slice(s.cursorCol)
      return {
        state: {
          ...s,
          lines: replaceLine(s.lines, s.cursorLine, newLine),
          cursorCol: s.cursorCol - 1,
        },
        action: NONE,
      }
    }

    case 'delete': {
      const s = materializeRecallIntoDraft(state)
      const line = s.lines[s.cursorLine]
      if (s.cursorCol === line.length) {
        if (s.cursorLine === s.lines.length - 1) return { state: s, action: NONE }
        const next = s.lines[s.cursorLine + 1]
        const merged = line + next
        const lines = s.lines
          .slice(0, s.cursorLine)
          .concat([merged], s.lines.slice(s.cursorLine + 2))
        return { state: { ...s, lines }, action: NONE }
      }
      const newLine = line.slice(0, s.cursorCol) + line.slice(s.cursorCol + 1)
      return {
        state: { ...s, lines: replaceLine(s.lines, s.cursorLine, newLine) },
        action: NONE,
      }
    }

    case 'left': {
      if (state.cursorCol > 0) {
        return { state: { ...state, cursorCol: state.cursorCol - 1 }, action: NONE }
      }
      if (state.cursorLine > 0) {
        const prev = state.lines[state.cursorLine - 1]
        return {
          state: { ...state, cursorLine: state.cursorLine - 1, cursorCol: prev.length },
          action: NONE,
        }
      }
      return { state, action: NONE }
    }

    case 'right': {
      const line = state.lines[state.cursorLine]
      if (state.cursorCol < line.length) {
        return { state: { ...state, cursorCol: state.cursorCol + 1 }, action: NONE }
      }
      if (state.cursorLine < state.lines.length - 1) {
        return { state: { ...state, cursorLine: state.cursorLine + 1, cursorCol: 0 }, action: NONE }
      }
      return { state, action: NONE }
    }

    case 'home':
      return { state: { ...state, cursorCol: 0 }, action: NONE }

    case 'end':
      return {
        state: { ...state, cursorCol: state.lines[state.cursorLine].length },
        action: NONE,
      }

    case 'up': {
      // Multi-line cursor move first: only hijack into history from top line.
      if (state.cursorLine > 0) {
        const target = state.cursorLine - 1
        const { cursorLine, cursorCol } = clampCursorToLine(state.lines, target, state.cursorCol)
        return { state: { ...state, cursorLine, cursorCol }, action: NONE }
      }
      // At top line: history recall only if unedited.
      if (!isDraftUnedited(state)) return { state, action: NONE }
      if (state.history.length === 0) return { state, action: NONE }
      if (state.historyIdx === null) {
        const idx = state.history.length - 1
        return { state: loadHistoryEntry(state, idx), action: NONE }
      }
      if (state.historyIdx > 0) {
        return { state: loadHistoryEntry(state, state.historyIdx - 1), action: NONE }
      }
      return { state, action: NONE }
    }

    case 'down': {
      if (state.cursorLine < state.lines.length - 1) {
        const target = state.cursorLine + 1
        const { cursorLine, cursorCol } = clampCursorToLine(state.lines, target, state.cursorCol)
        return { state: { ...state, cursorLine, cursorCol }, action: NONE }
      }
      // At bottom line: history forward-navigation if we're currently in history.
      if (state.historyIdx === null) return { state, action: NONE }
      if (!isDraftUnedited(state)) return { state, action: NONE }
      if (state.historyIdx < state.history.length - 1) {
        return { state: loadHistoryEntry(state, state.historyIdx + 1), action: NONE }
      }
      // Past newest: return to savedDraft.
      const draft = state.savedDraft ?? ['']
      const lastLine = draft.length - 1
      return {
        state: {
          ...state,
          lines: draft,
          cursorLine: lastLine,
          cursorCol: draft[lastLine].length,
          historyIdx: null,
          savedDraft: null,
        },
        action: NONE,
      }
    }

    case 'pushHistory': {
      return {
        state: { ...state, history: state.history.concat([event.text]) },
        action: NONE,
      }
    }

    case 'clearHistory': {
      return {
        state: { ...state, history: [], historyIdx: null, savedDraft: null },
        action: NONE,
      }
    }

    case 'reset': {
      return {
        state: {
          ...state,
          lines: [''],
          cursorLine: 0,
          cursorCol: 0,
          historyIdx: null,
          savedDraft: null,
        },
        action: NONE,
      }
    }
  }
}
