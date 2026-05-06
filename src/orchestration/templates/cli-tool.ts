/**
 * Phase 43: CLI tool template definition.
 *
 * Creates a CLI tool with argument parsing, help text, and TypeScript.
 * Requires Node.js runtime (checked via node --version).
 *
 * Task DAG:
 *   init-project
 *       └── add-commands
 *               ├── add-help
 *               └── add-tests
 */

import type { TemplateDefinition } from './types'

export const cliToolTemplate: TemplateDefinition = {
  name: 'cli-tool',
  description: 'CLI tool with argument parsing, help text, and TypeScript',
  runtime: {
    command: 'node',
    args: ['--version'],
    description: 'Node.js runtime',
  },
  tasks: [
    {
      id: 'init-project',
      prompt:
        'Initialize a new Node.js + TypeScript CLI project. Run `npm init -y`. Install dependencies: commander (for argument parsing), typescript, tsx, @types/node. Set `"bin"` in package.json to point to `./src/index.ts`. Create tsconfig.json with strict mode, outDir ./dist, and target ES2022. Create src/index.ts as the entry point with a shebang `#!/usr/bin/env node` and import the main CLI program. Add a `start` script using tsx and a `build` script using tsc. Verify the file structure looks correct.',
    },
    {
      id: 'add-commands',
      prompt:
        "Create the CLI command structure in src/index.ts. Use the commander library to define a program with: a name, version (from package.json), and description. Add at least two subcommands: (1) `greet <name>` — prints a greeting to stdout (e.g. 'Hello, <name>!'), optional --uppercase flag to uppercase the output; (2) `list [items...]` — lists the provided items or prints 'No items provided' if empty, optional --numbered flag to prefix each item with its number. Wire up all commands to their handlers. Run `npx tsx src/index.ts --help` to confirm help text appears correctly.",
      dependsOn: ['init-project'],
    },
    {
      id: 'add-help',
      prompt:
        "Enhance the help output. Add a `.description()` to each command explaining what it does and what the arguments mean. Add `.argument()` descriptions. Add `.option()` descriptions for all flags. Add examples section to the main program using `.addHelpText('after', ...)` with two realistic usage examples. Run `npx tsx src/index.ts --help` and `npx tsx src/index.ts greet --help` to verify the help text is complete and readable. The help output should be self-explanatory to a new user.",
      dependsOn: ['add-commands'],
    },
    {
      id: 'add-tests',
      prompt:
        "Add a unit test suite for the CLI logic. Install vitest if not present. Extract the command handler functions (greet, list) into src/handlers.ts so they can be tested independently of commander. Create src/__tests__/handlers.test.ts that tests: greet('Alice') returns 'Hello, Alice!'; greet('Alice', { uppercase: true }) returns 'HELLO, ALICE!'; list(['a', 'b']) returns a string with both items; list([], {}) returns a string containing 'No items'. Run `npx vitest run` and confirm all tests pass.",
      dependsOn: ['add-commands'],
    },
  ],
  defaultMaxParallel: 2,
}
