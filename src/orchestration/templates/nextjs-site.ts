/**
 * Phase 43: Next.js site template definition.
 *
 * Creates a Next.js application with App Router, Tailwind CSS, and TypeScript.
 * Requires Node.js runtime (checked via node --version).
 *
 * Task DAG:
 *   init-project
 *       ├── configure-tailwind
 *       └── create-layout
 *               └── create-homepage (also depends on configure-tailwind)
 *                       └── add-tests
 */

import type { TemplateDefinition } from './types'

export const nextjsSiteTemplate: TemplateDefinition = {
  name: 'nextjs-site',
  description: 'Next.js application with App Router, Tailwind CSS, and TypeScript',
  runtime: {
    command: 'node',
    args: ['--version'],
    description: 'Node.js runtime',
  },
  tasks: [
    {
      id: 'init-project',
      prompt:
        'Scaffold a new Next.js 14+ project using `npx create-next-app@latest . --typescript --tailwind --app --no-src-dir --import-alias "@/*"`. Accept all defaults. Confirm the project structure was created correctly by listing the top-level files. Do not start the dev server.',
    },
    {
      id: 'configure-tailwind',
      prompt:
        "Configure Tailwind CSS for the project. Verify that tailwind.config.ts includes the App Router content paths (`'./app/**/*.{js,ts,jsx,tsx}'`). Add any missing configuration. Check that globals.css has the Tailwind directives (@tailwind base/components/utilities).",
      dependsOn: ['init-project'],
    },
    {
      id: 'create-layout',
      prompt:
        "Create the root layout in app/layout.tsx. The layout should: import the Inter font from next/font/google, apply it via a className on the html element, include metadata with a descriptive title and description, and render children wrapped in a <main> tag with sensible Tailwind classes. Ensure the layout is server-side by default (no 'use client' directive).",
      dependsOn: ['init-project'],
    },
    {
      id: 'create-homepage',
      prompt:
        "Create the homepage in app/page.tsx. The page should be a server component that displays: a hero section with a centered heading and subheading using Tailwind typography classes, a grid of 3 feature cards with icon placeholders, and a call-to-action button. Keep it visually clean and responsive. Use the layout and Tailwind configuration already set up.",
      dependsOn: ['configure-tailwind', 'create-layout'],
    },
    {
      id: 'add-tests',
      prompt:
        'Add a basic test suite for the homepage. Install vitest and @testing-library/react if not already present. Create `__tests__/page.test.tsx` that renders the homepage and asserts the heading text is visible. Run the tests with `npx vitest run` and confirm they pass. Update package.json to add a `test` script if missing.',
      dependsOn: ['create-homepage'],
    },
  ],
  defaultMaxParallel: 2,
}
