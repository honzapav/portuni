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
				{
					label: 'Getting Started',
					items: [
						{ label: 'Introduction', slug: 'getting-started/introduction' },
						{ label: 'Setup', slug: 'getting-started/setup' },
					],
				},
				{
					label: 'Concepts',
					items: [
						{ label: 'POPP Framework', slug: 'concepts/popp' },
						{ label: 'Events', slug: 'concepts/events' },
						{ label: 'Local Mirrors', slug: 'concepts/mirrors' },
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
