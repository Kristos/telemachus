// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
	integrations: [
		starlight({
			title: 'Telemachus',
			description: 'Personal CLI coding agent — Claude Code-style, multi-provider, runs anywhere.',
			customCss: ['./src/styles/custom.css'],
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/Kristos/telemachus' },
			],
			sidebar: [
				{
					label: 'Start here',
					items: [
						{ label: 'Overview', slug: 'index' },
						{ label: 'Quickstart', slug: 'quickstart' },
						{ label: 'Installation', slug: 'installation' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Providers & models', slug: 'guides/providers' },
						{ label: 'Local LLMs (Ollama, LM Studio)', slug: 'guides/local-llms' },
						{ label: 'Security', slug: 'guides/security' },
						{ label: 'MCP servers', slug: 'guides/mcp-servers' },
						{ label: 'Windows setup', slug: 'guides/windows' },
						{ label: 'Sessions & persistence', slug: 'guides/sessions' },
						{ label: 'Subagents', slug: 'guides/subagents' },
						{ label: 'Agent jobs (headless + scheduled)', slug: 'guides/agent-jobs' },
						{ label: 'Hooks', slug: 'guides/hooks' },
						{ label: 'Plan mode', slug: 'guides/plan-mode' },
						{ label: 'Worktrees', slug: 'guides/worktrees' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Built-in tools', slug: 'reference/tools' },
						{ label: 'Configuration', slug: 'reference/configuration' },
						{ label: 'CLI commands', slug: 'reference/cli' },
					],
				},
			],
		}),
	],
});
