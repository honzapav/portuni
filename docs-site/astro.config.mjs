// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
	site: 'https://docs.portuni.com',
	integrations: [
		starlight({
			title: 'Portuni',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/honzapav/portuni' }],
			sidebar: [
				{ label: '← portuni.com', link: 'https://portuni.com', attrs: { 'aria-label': 'Back to portuni.com' } },
				{
					label: 'Getting Started',
					items: [
						{ label: 'Introduction', slug: 'getting-started/introduction' },
						{ label: 'Setup', slug: 'getting-started/setup' },
					],
				},
				{
					label: 'MCP Clients',
					items: [
						{ label: 'Overview', slug: 'clients/overview' },
						{ label: 'Claude Code', slug: 'clients/claude-code' },
						{ label: 'Codex CLI', slug: 'clients/codex-cli' },
						{ label: 'Gemini CLI', slug: 'clients/gemini-cli' },
					],
				},
				{
					label: 'Concepts',
					items: [
						{ label: 'POPP Framework', slug: 'concepts/popp' },
						{ label: 'Events', slug: 'concepts/events' },
						{ label: 'Local Mirrors', slug: 'concepts/mirrors' },
						{ label: 'Filesystem Permissions', slug: 'concepts/permissions' },
					],
				},
				{
					label: 'Tools Reference',
					autogenerate: { directory: 'reference' },
				},
			],
		}),
	],
});
