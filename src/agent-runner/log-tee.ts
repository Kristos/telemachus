/**
 * Phase 22 (AGENT-01): log-tee utility.
 *
 * Mirrors process.stdout and process.stderr to a file while preserving the
 * real streams. Wave 2's headless runner uses this to capture a verbatim
 * transcript of an agent job without having to route output through the
 * UI / logger chain.
 *
 * Nesting: each `startLogTee` call captures whatever `write` function was
 * currently installed (which may itself be a prior tee wrapper), and `stop`
 * restores that captured function. This gives LIFO nesting — the inner
 * stop restores the outer tee, not the pristine Node original.
 *
 * Robustness: a try/catch around `fs.writeSync` ensures a failed log write
 * (disk full, FD closed) never breaks the real stdout/stderr stream.
 */
import fs from 'node:fs'

export interface LogTeeHandle {
  stop: () => void
}

type WriteFn = typeof process.stdout.write

export function startLogTee(filePath: string): LogTeeHandle {
  const fd = fs.openSync(filePath, 'a')

  // Capture CURRENT write functions (may already be a prior tee wrapper).
  // Binding preserves `this` when the wrapper forwards.
  const prevOut: WriteFn = process.stdout.write.bind(process.stdout) as WriteFn
  const prevErr: WriteFn = process.stderr.write.bind(process.stderr) as WriteFn

  const teeTo = (chunk: unknown): void => {
    try {
      if (typeof chunk === 'string') {
        fs.writeSync(fd, chunk)
      } else if (chunk instanceof Uint8Array) {
        fs.writeSync(fd, chunk)
      } else if (chunk != null) {
        fs.writeSync(fd, String(chunk))
      }
    } catch {
      // Never let a log-file write error break the real stream.
    }
  }

  // Node's write signature is variadic: write(chunk, cb?) | write(chunk, encoding, cb?).
  // We accept rest args and forward them verbatim to the previous implementation.
  const wrapOut = ((chunk: unknown, ...rest: unknown[]): boolean => {
    teeTo(chunk)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prevOut as any)(chunk, ...rest)
  }) as WriteFn

  const wrapErr = ((chunk: unknown, ...rest: unknown[]): boolean => {
    teeTo(chunk)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (prevErr as any)(chunk, ...rest)
  }) as WriteFn

  process.stdout.write = wrapOut
  process.stderr.write = wrapErr

  let stopped = false
  return {
    stop: () => {
      if (stopped) return
      stopped = true
      process.stdout.write = prevOut
      process.stderr.write = prevErr
      try {
        fs.closeSync(fd)
      } catch {
        // fd may already be closed by a nested scope; ignore.
      }
    },
  }
}

/** Alias: `stopLogTee(handle)` is equivalent to `handle.stop()`. */
export function stopLogTee(handle: LogTeeHandle): void {
  handle.stop()
}
