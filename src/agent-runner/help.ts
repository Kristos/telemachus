/**
 * Phase 22-03 (AGENT-03): `tm agent` help text.
 *
 * Kept as a single-file module with no imports so it's cheap to load in the
 * CLI dispatch path. Writes to stderr so help output doesn't pollute any
 * stdout pipes a caller might be reading.
 */

export const HELP_TEXT = `tm agent — run autonomous jobs defined in config.agents

Subcommands:
  run <name>                       Run the named agent job once
  status [name] [--limit N]        Show recent runs and their status
  install <name>                   Install a launchd schedule for the job (macOS)
  uninstall <name>                 Remove a launchd schedule (macOS)
  list                             List configured jobs merged with launchd state
  --help, -h                       Show this help

Status usage:
  tm agent status                  List the last 20 runs across all jobs
  tm agent status <name>           List the last 50 runs for one job
  tm agent status --limit N        Override the row count

Install / schedule grammar (set under agents.<name>.schedule):
  hourly                           Fires at minute 0 of every hour
  daily                            Fires at 00:00 every day
  cron: M H D M DoW                Integers only — no */N, no ranges, no lists
                                   e.g. "cron: 30 14 * * 1" → Mondays 14:30

Timezone: launchd runs schedules in local time. DST edge case — jobs at
hour 2 may skip or double-fire on the spring-forward / fall-back days.
Schedule for hour 3+ if DST matters.

\`tm agent install\` is idempotent-refresh: re-run it after editing the
schedule in config.json and it will bootout, rewrite the plist, and
re-bootstrap in one step. Also re-run after reinstalling kc — the
absolute path to the kc binary is baked into the plist at install time.

\`tm agent uninstall\` removes the plist + launchd registration only. It
NEVER deletes ~/.telemachus/agent-runs/<name>/ — past run evidence stays.

\`tm agent list\` shows every configured job whether installed or not,
plus launchd's view (loaded, next fire, running).

Job config lives in ~/.telemachus/config.json under \`agents.<name>\`.
Artifacts written to ~/.telemachus/agent-runs/<name>/<timestamp>/.
`

export function printAgentHelp(): void {
  process.stderr.write(HELP_TEXT)
}
