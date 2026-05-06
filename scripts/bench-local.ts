#!/usr/bin/env bun
/**
 * bench-local.ts — benchmark a local OpenAI-compatible LLM server (llama.cpp,
 * LM Studio, Ollama) against agent-style workloads.
 *
 * Measures what actually matters for telemachus:
 *   - TTFT (time to first token)
 *   - generation tok/s
 *   - prompt-processing throughput (input tok/s)
 *   - tool-call success rate (does the model emit a valid call?)
 *   - tool-call argument validity (does the JSON parse + match schema?)
 *   - multi-turn coherence (does it stay on task across 3 turns?)
 *
 * Works against any endpoint that speaks /v1/chat/completions.
 *
 * Usage:
 *   bun run scripts/bench-local.ts \
 *     --base-url http://localhost:8080/v1 \
 *     --model glm-4.7-flash
 *
 *   # Remote rig over Tailscale:
 *   bun run scripts/bench-local.ts \
 *     --base-url http://windowsbox.tailnet-name.ts.net:8080/v1 \
 *     --model qwen3-coder-next
 *
 *   # Compare two endpoints (run twice and diff the JSON):
 *   bun run scripts/bench-local.ts ... > a.json
 *   bun run scripts/bench-local.ts ... > b.json
 *
 * Exit code is 0 if all scenarios completed (regardless of pass/fail);
 * non-zero only on connection errors.
 */

import OpenAI from 'openai'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions.js'

interface Args {
  baseURL: string
  model: string
  apiKey: string
  json: boolean
}

function parseArgs(): Args {
  const args: Args = {
    baseURL: 'http://localhost:8080/v1',
    model: 'local-model',
    apiKey: 'sk-local',
    json: false,
  }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base-url') args.baseURL = argv[++i]
    else if (a === '--model') args.model = argv[++i]
    else if (a === '--api-key') args.apiKey = argv[++i]
    else if (a === '--json') args.json = true
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: bun run scripts/bench-local.ts --base-url URL --model NAME [--api-key KEY] [--json]',
      )
      process.exit(0)
    }
  }
  return args
}

interface ScenarioResult {
  name: string
  passed: boolean
  reason?: string
  ttftMs: number
  totalMs: number
  inputTokens: number
  outputTokens: number
  genTokPerSec: number
  textPreview: string
  toolCalls: Array<{ name: string; argsValid: boolean }>
}

async function runChat(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  tools?: ChatCompletionTool[],
): Promise<ScenarioResult['ttftMs'] extends never ? never : {
  ttftMs: number
  totalMs: number
  text: string
  toolCalls: Array<{ name: string; rawArgs: string }>
  inputTokens: number
  outputTokens: number
}> {
  const start = performance.now()
  let firstTokenAt: number | null = null
  let text = ''
  const toolCallAcc = new Map<number, { name: string; args: string }>()
  let inputTokens = 0
  let outputTokens = 0

  const stream = await client.chat.completions.create({
    model,
    messages,
    ...(tools ? { tools } : {}),
    stream: true,
    stream_options: { include_usage: true },
    temperature: 0.2,
  })

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta
    if (delta?.content) {
      if (firstTokenAt === null) firstTokenAt = performance.now()
      text += delta.content
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (firstTokenAt === null) firstTokenAt = performance.now()
        const idx = tc.index
        const existing = toolCallAcc.get(idx)
        if (tc.id || !existing) {
          toolCallAcc.set(idx, {
            name: (existing?.name ?? '') + (tc.function?.name ?? ''),
            args: (existing?.args ?? '') + (tc.function?.arguments ?? ''),
          })
        } else {
          if (tc.function?.name) existing.name += tc.function.name
          if (tc.function?.arguments) existing.args += tc.function.arguments
        }
      }
    }
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? 0
      outputTokens = chunk.usage.completion_tokens ?? 0
    }
  }

  const totalMs = performance.now() - start
  const ttftMs = (firstTokenAt ?? performance.now()) - start

  return {
    ttftMs,
    totalMs,
    text,
    toolCalls: Array.from(toolCallAcc.values()).map(v => ({ name: v.name, rawArgs: v.args })),
    inputTokens,
    outputTokens,
  }
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

const READ_FILE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read the contents of a file from the local filesystem.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
      },
      required: ['path'],
    },
  },
}

const RUN_BASH_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'run_bash',
    description: 'Execute a shell command and return stdout/stderr.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run' },
      },
      required: ['command'],
    },
  },
}

interface Scenario {
  name: string
  build(client: OpenAI, model: string): Promise<ScenarioResult>
}

const scenarios: Scenario[] = [
  {
    name: 'cold-prompt-throughput',
    async build(client, model) {
      // Pure throughput test — no tools, generate a substantial answer.
      const r = await runChat(client, model, [
        {
          role: 'user',
          content:
            'Explain what TCP slow start does and why it exists. Be precise but concise. ~150 words.',
        },
      ])
      return {
        name: 'cold-prompt-throughput',
        passed: r.text.length > 200,
        reason: r.text.length > 200 ? undefined : 'response too short',
        ttftMs: r.ttftMs,
        totalMs: r.totalMs,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        genTokPerSec: r.outputTokens / Math.max((r.totalMs - r.ttftMs) / 1000, 0.001),
        textPreview: r.text.slice(0, 120),
        toolCalls: [],
      }
    },
  },
  {
    name: 'tool-call-single',
    async build(client, model) {
      // Does the model emit a valid tool call when one is obviously needed?
      const r = await runChat(
        client,
        model,
        [
          {
            role: 'system',
            content:
              'You are a coding agent. When the user asks about file contents, you MUST call the read_file tool. Do not guess.',
          },
          {
            role: 'user',
            content: 'What does /Users/you/projects/my-project/package.json contain?',
          },
        ],
        [READ_FILE_TOOL],
      )
      const calls = r.toolCalls.map(tc => {
        let valid = false
        try {
          const parsed = JSON.parse(tc.rawArgs)
          valid = typeof parsed.path === 'string' && parsed.path.includes('package.json')
        } catch {}
        return { name: tc.name, argsValid: valid }
      })
      return {
        name: 'tool-call-single',
        passed: calls.length > 0 && calls.every(c => c.name === 'read_file' && c.argsValid),
        reason:
          calls.length === 0
            ? 'no tool call emitted'
            : !calls.every(c => c.name === 'read_file')
              ? 'wrong tool name'
              : !calls.every(c => c.argsValid)
                ? 'args invalid or missing path'
                : undefined,
        ttftMs: r.ttftMs,
        totalMs: r.totalMs,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        genTokPerSec: r.outputTokens / Math.max((r.totalMs - r.ttftMs) / 1000, 0.001),
        textPreview: r.text.slice(0, 120),
        toolCalls: calls,
      }
    },
  },
  {
    name: 'tool-call-multi',
    async build(client, model) {
      // Two tools available — does the model pick the right one?
      const r = await runChat(
        client,
        model,
        [
          {
            role: 'system',
            content:
              'You are a coding agent with access to read_file and run_bash tools. Choose the appropriate tool for each request. Never answer from memory when a tool would be more accurate.',
          },
          {
            role: 'user',
            content: 'List the files in /tmp using ls -la.',
          },
        ],
        [READ_FILE_TOOL, RUN_BASH_TOOL],
      )
      const calls = r.toolCalls.map(tc => {
        let valid = false
        try {
          const parsed = JSON.parse(tc.rawArgs)
          valid =
            typeof parsed.command === 'string' &&
            parsed.command.toLowerCase().includes('ls')
        } catch {}
        return { name: tc.name, argsValid: valid }
      })
      return {
        name: 'tool-call-multi',
        passed: calls.length > 0 && calls[0].name === 'run_bash' && calls[0].argsValid,
        reason:
          calls.length === 0
            ? 'no tool call emitted'
            : calls[0].name !== 'run_bash'
              ? `picked wrong tool: ${calls[0].name}`
              : !calls[0].argsValid
                ? 'args invalid'
                : undefined,
        ttftMs: r.ttftMs,
        totalMs: r.totalMs,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        genTokPerSec: r.outputTokens / Math.max((r.totalMs - r.ttftMs) / 1000, 0.001),
        textPreview: r.text.slice(0, 120),
        toolCalls: calls,
      }
    },
  },
  {
    name: 'multi-turn-coherence',
    async build(client, model) {
      // Three turns. Does the model carry context and stay on task?
      const r = await runChat(client, model, [
        { role: 'system', content: 'You are a senior TypeScript engineer.' },
        { role: 'user', content: 'I am writing a function to debounce an async fetch. Sketch the signature.' },
        {
          role: 'assistant',
          content:
            'Sure. The signature would be: `function debounceAsync<T>(fn: (...args: any[]) => Promise<T>, waitMs: number): (...args: any[]) => Promise<T>`',
        },
        { role: 'user', content: 'Now show me the implementation, and explain how you handle in-flight cancellation.' },
      ])
      const lower = r.text.toLowerCase()
      const passed =
        lower.includes('debounce') &&
        (lower.includes('cancel') || lower.includes('abort')) &&
        (lower.includes('timeout') || lower.includes('settimeout'))
      return {
        name: 'multi-turn-coherence',
        passed,
        reason: passed ? undefined : 'missing one of: debounce / cancel|abort / timeout',
        ttftMs: r.ttftMs,
        totalMs: r.totalMs,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        genTokPerSec: r.outputTokens / Math.max((r.totalMs - r.ttftMs) / 1000, 0.001),
        textPreview: r.text.slice(0, 120),
        toolCalls: [],
      }
    },
  },
  {
    name: 'long-context-recall',
    async build(client, model) {
      // ~6k tokens of filler then a needle question. Tests prompt processing
      // throughput AND that the model can find the needle.
      const filler = Array.from(
        { length: 200 },
        (_, i) =>
          `Section ${i}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
      ).join('\n')
      const needle = 'The secret password is ORANGE-BICYCLE-42.'
      const haystack = `${filler}\n\n${needle}\n\n${filler}`
      const r = await runChat(client, model, [
        { role: 'system', content: 'Answer the user precisely. Quote facts from the document.' },
        {
          role: 'user',
          content: `Document:\n${haystack}\n\nQuestion: What is the secret password?`,
        },
      ])
      const passed = r.text.includes('ORANGE-BICYCLE-42')
      return {
        name: 'long-context-recall',
        passed,
        reason: passed ? undefined : 'did not recall the needle',
        ttftMs: r.ttftMs,
        totalMs: r.totalMs,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        // For long-context, prompt processing speed matters too.
        genTokPerSec: r.outputTokens / Math.max((r.totalMs - r.ttftMs) / 1000, 0.001),
        textPreview: r.text.slice(0, 120),
        toolCalls: [],
      }
    },
  },
]

// ─── Runner ───────────────────────────────────────────────────────────────────

function fmt(n: number, digits = 1): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits })
}

function printHuman(args: Args, results: ScenarioResult[]) {
  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(` LOCAL LLM BENCHMARK`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(` Endpoint: ${args.baseURL}`)
  console.log(` Model:    ${args.model}`)
  console.log('')
  for (const r of results) {
    const mark = r.passed ? '✓' : '✗'
    console.log(`  ${mark} ${r.name}`)
    console.log(
      `      TTFT ${fmt(r.ttftMs)}ms · total ${fmt(r.totalMs)}ms · in/out ${r.inputTokens}/${r.outputTokens} tok · gen ${fmt(r.genTokPerSec)} tok/s`,
    )
    if (r.toolCalls.length > 0) {
      const tcSummary = r.toolCalls
        .map(tc => `${tc.name}${tc.argsValid ? '(✓)' : '(✗)'}`)
        .join(', ')
      console.log(`      tools: ${tcSummary}`)
    }
    if (!r.passed && r.reason) {
      console.log(`      reason: ${r.reason}`)
    }
    if (r.textPreview) {
      console.log(`      preview: ${r.textPreview.replace(/\n/g, ' ')}…`)
    }
  }
  // Aggregate
  const passed = results.filter(r => r.passed).length
  const avgGen =
    results.filter(r => r.outputTokens > 0).reduce((s, r) => s + r.genTokPerSec, 0) /
    Math.max(results.filter(r => r.outputTokens > 0).length, 1)
  const avgTTFT = results.reduce((s, r) => s + r.ttftMs, 0) / Math.max(results.length, 1)
  console.log('')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(` Summary: ${passed}/${results.length} passed`)
  console.log(`          avg gen ${fmt(avgGen)} tok/s · avg TTFT ${fmt(avgTTFT)}ms`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
}

async function main() {
  const args = parseArgs()
  const client = new OpenAI({ apiKey: args.apiKey, baseURL: args.baseURL })

  // Sanity ping
  try {
    await client.chat.completions.create({
      model: args.model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    })
  } catch (err) {
    console.error(`Cannot reach ${args.baseURL} with model "${args.model}"`)
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  }

  const results: ScenarioResult[] = []
  for (const s of scenarios) {
    if (!args.json) process.stderr.write(`▶ ${s.name}…\n`)
    try {
      results.push(await s.build(client, args.model))
    } catch (err) {
      results.push({
        name: s.name,
        passed: false,
        reason: err instanceof Error ? err.message : String(err),
        ttftMs: 0,
        totalMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        genTokPerSec: 0,
        textPreview: '',
        toolCalls: [],
      })
    }
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          endpoint: args.baseURL,
          model: args.model,
          timestamp: new Date().toISOString(),
          results,
        },
        null,
        2,
      ),
    )
  } else {
    printHuman(args, results)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
