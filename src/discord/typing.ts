const INTERVAL_MS = 8000

/**
 * Sends a typing indicator to Discord on start() and repeats every 8 seconds.
 * Call stop() to cancel. Safe to call stop() multiple times.
 */
export class TypingKeepAlive {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly sendTyping: () => void) {}

  start(): void {
    this.sendTyping()
    this.timer = setInterval(() => this.sendTyping(), INTERVAL_MS)
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as { unref(): void }).unref()
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
