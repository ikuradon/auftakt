import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'auftakt',
  description: 'Reactive event store for rx-nostr with NIP semantics',
  base: '/auftakt/',
  lastUpdated: true,
  srcExclude: ['design.md', 'specs/**', 'plans/**', 'review-*.md'],
  markdown: {
    lineNumbers: true,
  },

  head: [
    ['meta', { property: 'og:title', content: '@ikuradon/auftakt' }],
    ['meta', { property: 'og:description', content: 'Reactive event store for rx-nostr with NIP semantics' }],
  ],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/reference/api' },
      { text: 'GitHub', link: 'https://github.com/ikuradon/auftakt' },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Core Concepts', link: '/guide/core-concepts' },
          { text: 'Backends', link: '/guide/backends' },
          { text: 'Svelte Integration', link: '/guide/svelte' },
          { text: 'Patterns', link: '/guide/patterns' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'API', link: '/reference/api' },
          { text: 'Architecture', link: '/reference/architecture' },
          { text: 'NIP Support', link: '/reference/nip-support' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/ikuradon/auftakt' },
    ],

    footer: {
      message: 'Released under the MIT License.',
    },
  },
});
