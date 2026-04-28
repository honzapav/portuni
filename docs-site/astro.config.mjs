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
						{ label: 'Project Status & Roadmap', slug: 'getting-started/roadmap' },
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
					label: 'Foundations',
					items: [
						{ label: 'Design Principles', slug: 'concepts/design-principles' },
						{ label: 'POPP Framework', slug: 'concepts/popp' },
						{ label: 'Organization Invariant', slug: 'concepts/organization-invariant' },
					],
				},
				{
					label: 'The Graph',
					items: [
						{ label: 'Actors & Responsibilities', slug: 'concepts/actors-responsibilities' },
						{ label: 'Lifecycle States', slug: 'concepts/lifecycle-states' },
						{ label: 'Events', slug: 'concepts/events' },
						{ label: 'Audit Trail', slug: 'concepts/audit-trail' },
					],
				},
				{
					label: 'Files & Sync',
					items: [
						{ label: 'Local Mirrors', slug: 'concepts/mirrors' },
						{ label: 'Filesystem Permissions', slug: 'concepts/permissions' },
						{ label: 'Scope Enforcement', slug: 'concepts/scope-enforcement', badge: { text: 'in design', variant: 'caution' } },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Setting Up Remotes', slug: 'guides/setting-up-remotes' },
						{ label: 'Symbiotic Workflows', slug: 'guides/symbiotic-workflows' },
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
