import React, { useReducer, useState, useEffect, useRef } from 'react'
import { Box, Text, useInput, type Key } from 'ink'
import type { Skill } from '../skills/types.js'
import { BUILTIN_COMMAND_NAMES } from './slash/dispatcher.js'
import {
  reducer,
  initialState,
  draftText,
  isDraftEmpty,
  type InputEvent,
  type InputState,
} from './input-state.js'

/** Phase 21-03: an image attachment ready to ship as a multimodal block. */
export interface ImageAttachment {
  /** Display label — filename or "pasted-data-url". */
  label: string
  /** MIME type, e.g. "image/png". */
  mediaType: string
  /** Base64-encoded payload (no data: prefix). */
  data: string
}

/** Submission payload from the input box.
 *  String form is preserved as a backwards-compatible convenience for callers
 *  that pre-21-03 only needed text. */
export type SubmitPayload = { text: string; attachments: ImageAttachment[] }

interface InputProps {
  isProcessing: boolean
  onSubmit: (payload: SubmitPayload) => void
  skills?: Skill[]
  /** From config.ui.inputMaxLines. Default 10. */
  maxLines?: number
  /** Bump to dispatch clearHistory + reset. */
  clearSignal?: number
  /** Optional seed history on mount (for session resume). */
  historyInitial?: string[]
  /**
   * Internal/testing-only escape hatch. Default calls process.exit(0) on Ctrl+C.
   * Tests override to avoid killing the runner.
   */
  onExitRequested?: () => void
  /** Phase 21-03: whether the active model can ingest images. */
  visionCapable?: boolean
  /** Phase 21-03: human-friendly current model label for the warning text. */
  currentModelLabel?: string
  /** Phase 21-03 test hook: override paste→attachment resolution.
   *  Returns null when the raw chunk is not a recognised image. */
  resolveAttachment?: (raw: string) => Promise<ImageAttachment | null>
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i
const DATA_URL_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)$/

function extToMediaType(path: string): string {
  const m = path.match(/\.(png|jpe?g|gif|webp)$/i)
  if (!m) return 'application/octet-stream'
  const ext = m[1].toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  return `image/${ext}`
}

/** Default paste→attachment resolver. Supports:
 *   - data:image/<type>;base64,<data> URLs
 *   - absolute file paths to .png/.jpg/.jpeg/.gif/.webp
 *  Returns null when the input is not a recognised image. */
export async function defaultResolveAttachment(raw: string): Promise<ImageAttachment | null> {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  const dataMatch = trimmed.match(DATA_URL_RE)
  if (dataMatch) {
    const subtype = dataMatch[1].toLowerCase() === 'jpg' ? 'jpeg' : dataMatch[1].toLowerCase()
    return {
      label: 'pasted-data-url',
      mediaType: `image/${subtype}`,
      data: dataMatch[2],
    }
  }

  if (IMAGE_EXT_RE.test(trimmed) && (trimmed.startsWith('/') || /^[a-zA-Z]:\\/.test(trimmed))) {
    try {
      const file = Bun.file(trimmed)
      const exists = await file.exists()
      if (!exists) return null
      const buf = await file.arrayBuffer()
      const data = Buffer.from(buf).toString('base64')
      const label = trimmed.split(/[\\/]/).pop() ?? trimmed
      return { label, mediaType: extToMediaType(trimmed), data }
    } catch {
      return null
    }
  }

  return null
}

/**
 * Map an Ink key event to an InputEvent, or null if it should be ignored.
 * Exported for unit testing.
 */
export function mapInkKeyToEvent(char: string, key: Key): InputEvent | null {
  if (key.shift && key.return) return { type: 'shiftEnter' }
  if (key.return) return { type: 'enter' }
  if (key.leftArrow) return { type: 'left' }
  if (key.rightArrow) return { type: 'right' }
  if (key.upArrow) return { type: 'up' }
  if (key.downArrow) return { type: 'down' }
  if (key.backspace) return { type: 'backspace' }
  if (key.delete) return { type: 'delete' }
  if (char && !key.ctrl && !key.meta && !key.tab) {
    return { type: 'char', char }
  }
  return null
}

/**
 * Compute the visible window of lines given cursor position and maxLines.
 * Returns { visible, scrollTop } — scrollTop is the index in `lines` where
 * the visible window starts.
 */
export function computeVisibleWindow(
  lines: string[],
  cursorLine: number,
  maxLines: number,
): { visible: string[]; scrollTop: number } {
  if (lines.length <= maxLines) {
    return { visible: lines, scrollTop: 0 }
  }
  // Keep cursor visible. Simple strategy: scrollTop clamps so cursor fits.
  let scrollTop = Math.max(0, cursorLine - maxLines + 1)
  if (cursorLine < scrollTop) scrollTop = cursorLine
  scrollTop = Math.min(scrollTop, lines.length - maxLines)
  scrollTop = Math.max(0, scrollTop)
  return { visible: lines.slice(scrollTop, scrollTop + maxLines), scrollTop }
}

export function Input({
  isProcessing,
  onSubmit,
  skills = [],
  maxLines = 10,
  clearSignal = 0,
  historyInitial,
  onExitRequested,
  visionCapable = false,
  currentModelLabel = '',
  resolveAttachment = defaultResolveAttachment,
}: InputProps) {
  const [attachments, setAttachments] = useState<ImageAttachment[]>([])
  const [state, dispatch] = useReducer(
    (s: InputState, e: InputEvent) => reducer(s, e).state,
    undefined,
    () => {
      let s = initialState()
      if (historyInitial && historyInitial.length > 0) {
        for (const entry of historyInitial) {
          s = reducer(s, { type: 'pushHistory', text: entry }).state
        }
      }
      return s
    },
  )

  const [completions, setCompletions] = useState<string[]>([])
  const [completionIdx, setCompletionIdx] = useState(-1)

  // Track last seen clearSignal
  const lastClearSignalRef = useRef(clearSignal)
  useEffect(() => {
    if (clearSignal !== lastClearSignalRef.current) {
      lastClearSignalRef.current = clearSignal
      dispatch({ type: 'clearHistory' })
      dispatch({ type: 'reset' })
      setAttachments([])
    }
  }, [clearSignal])

  useInput((char, key) => {
    if (key.ctrl && char === 'c') {
      if (onExitRequested) onExitRequested()
      else process.exit(0)
      return
    }

    // Paste detection: Ink delivers bracketed-paste as one large `char` chunk.
    // Heuristic: any char chunk longer than 1 codepoint OR containing a newline
    // OR matching a data: URL is a paste candidate. Try to resolve as image first.
    const looksPasteable =
      (char && char.length > 1) ||
      (char && char.includes('\n')) ||
      (char && DATA_URL_RE.test(char.trim()))
    if (looksPasteable && !key.ctrl && !key.meta) {
      void resolveAttachment(char).then(att => {
        if (att) {
          setAttachments(prev => [...prev, att])
          return
        }
        // Not an image — fall back to multi-char insert into draft
        for (const c of char) dispatch({ type: 'char', char: c })
      })
      return
    }

    const currentText = draftText(state)
    const singleLine = state.lines.length === 1

    // Slash-command tab-completion: only on single-line '/'-prefixed draft
    if (key.tab && singleLine && currentText.startsWith('/')) {
      const prefix = currentText.slice(1).toLowerCase()
      const allCompletions = [...BUILTIN_COMMAND_NAMES, ...skills.map(s => s.name)]
      if (completions.length === 0 || completionIdx === -1) {
        const matches = allCompletions.filter(name => name.toLowerCase().startsWith(prefix))
        if (matches.length > 0) {
          setCompletions(matches)
          setCompletionIdx(0)
          // Replace the draft with '/' + matches[0] via reset + chars
          dispatch({ type: 'reset' })
          const newText = '/' + matches[0]
          for (const c of newText) dispatch({ type: 'char', char: c })
        }
      } else {
        const nextIdx = (completionIdx + 1) % completions.length
        setCompletionIdx(nextIdx)
        dispatch({ type: 'reset' })
        const newText = '/' + completions[nextIdx]
        for (const c of newText) dispatch({ type: 'char', char: c })
      }
      return
    }

    // Any non-tab key resets completions
    if (!key.tab) {
      if (completions.length > 0) {
        setCompletions([])
        setCompletionIdx(-1)
      }
    }

    const event = mapInkKeyToEvent(char, key)
    if (!event) return

    // Enter handling — check for submit action from reducer
    if (event.type === 'enter') {
      if (isProcessing) return
      // Allow submit when there's only attachments and no text — useful for "what is this image?"
      if (isDraftEmpty(state) && attachments.length === 0) return
      const result = reducer(state, event)
      // Use the result text if reducer produced a submit action; otherwise empty.
      const text = result.action.kind === 'submit' ? result.action.text : ''
      // Vision gating: drop attachments silently when model can't see images.
      const outAttachments = visionCapable ? attachments : []
      onSubmit({ text, attachments: outAttachments })
      if (text.length > 0) {
        dispatch({ type: 'pushHistory', text })
      }
      dispatch({ type: 'reset' })
      setAttachments([])
      return
    }

    dispatch(event)
  })

  if (isProcessing) {
    return <Text dimColor>Processing...</Text>
  }

  const { visible, scrollTop } = computeVisibleWindow(state.lines, state.cursorLine, maxLines)
  const hint =
    completions.length > 1 && completionIdx >= 0
      ? ` (${completionIdx + 1}/${completions.length})`
      : ''

  // Render visible lines with caret on cursor line
  const cursorVisibleIdx = state.cursorLine - scrollTop

  return (
    <Box flexDirection="column">
      {attachments.length > 0 && visionCapable && (
        <Box>
          <Text color="cyan">
            {attachments.map(a => `📎 ${a.label}`).join('  ')}
          </Text>
        </Box>
      )}
      {attachments.length > 0 && !visionCapable && (
        <Box>
          <Text color="yellow">
            {`⚠ ${currentModelLabel || 'current model'} is not vision-capable — images will be dropped on submit`}
          </Text>
        </Box>
      )}
      {visible.map((line, i) => {
        const prefix = i === 0 ? '> ' : '  '
        if (i === cursorVisibleIdx) {
          const before = line.slice(0, state.cursorCol)
          const after = line.slice(state.cursorCol)
          const caretChar = after.length > 0 ? after[0] : ' '
          const rest = after.slice(1)
          return (
            <Text key={i}>
              {prefix}
              {before}
              <Text inverse>{caretChar}</Text>
              {rest}
              {i === 0 && hint}
            </Text>
          )
        }
        return (
          <Text key={i}>
            {prefix}
            {line}
          </Text>
        )
      })}
    </Box>
  )
}
