/**
 * Phase 43: REST API template definition.
 *
 * Creates a REST API with Express/Hono, TypeScript, and Zod validation.
 * Requires Node.js runtime (checked via node --version).
 *
 * Task DAG:
 *   init-project
 *       ├── add-router
 *       └── add-models
 *               └── add-endpoints (depends on router + models)
 *                       └── add-tests
 */

import type { TemplateDefinition } from './types'

export const restApiTemplate: TemplateDefinition = {
  name: 'rest-api',
  description: 'REST API with Express/Hono, TypeScript, and Zod validation',
  runtime: {
    command: 'node',
    args: ['--version'],
    description: 'Node.js runtime',
  },
  tasks: [
    {
      id: 'init-project',
      prompt:
        'Initialize a new Node.js + TypeScript project for a REST API. Run `npm init -y`. Install dependencies: hono (for routing), zod (for validation), typescript, tsx (for ts-node equivalent), @types/node. Create tsconfig.json with strict mode enabled and outDir set to ./dist. Create src/index.ts with a minimal Hono app that listens on port 3000 and has a health check route GET /health returning `{ status: "ok" }`. Test it starts with `npx tsx src/index.ts &` and curl the health endpoint.',
    },
    {
      id: 'add-router',
      prompt:
        'Create a modular router structure. Add src/routes/ directory. Create src/routes/index.ts that exports a Hono app with all sub-routes mounted. Create a placeholder src/routes/items.ts with routes: GET /items, POST /items, GET /items/:id, PUT /items/:id, DELETE /items/:id. Each route should return a 501 Not Implemented response for now with a JSON body `{ error: "not implemented" }`. Wire the routes into the main app in src/index.ts.',
      dependsOn: ['init-project'],
    },
    {
      id: 'add-models',
      prompt:
        'Create the data model layer. Add src/models/ directory. Create src/models/item.ts with: an Item interface (id: string, name: string, description: string, createdAt: string), a Zod schema CreateItemSchema (name: z.string().min(1).max(200), description: z.string().max(1000).optional()), and an in-memory store (a Map<string, Item>) with CRUD functions: createItem, getItem, listItems, updateItem, deleteItem. Use crypto.randomUUID() for IDs.',
      dependsOn: ['init-project'],
    },
    {
      id: 'add-endpoints',
      prompt:
        "Implement the REST endpoints in src/routes/items.ts using the model functions and Zod schemas created earlier. Implement: GET /items → list all items as JSON array; POST /items → validate body with CreateItemSchema, create item, return 201 with the created item; GET /items/:id → return item or 404; PUT /items/:id → validate body, update item or 404; DELETE /items/:id → delete item or 404, return 204. Add proper error handling that returns `{ error: \"message\" }` for validation failures (400) and not-found cases (404).",
      dependsOn: ['add-router', 'add-models'],
    },
    {
      id: 'add-tests',
      prompt:
        'Add an integration test suite. Install vitest if not present. Create src/__tests__/items.test.ts that tests each endpoint: POST /items creates an item and returns 201; GET /items returns an array; GET /items/:id returns the created item; PUT /items/:id updates it; DELETE /items/:id returns 204; GET /items/:id after delete returns 404. Use the Hono test helper (`app.request()`) to avoid spinning up a real server. Run `npx vitest run` and confirm all tests pass.',
      dependsOn: ['add-endpoints'],
    },
  ],
  defaultMaxParallel: 2,
}
