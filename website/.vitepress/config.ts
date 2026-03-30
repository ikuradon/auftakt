import { defineConfig } from 'vitepress';

export default defineConfig({
  title: '@ikuradon/auftakt',
  description: 'Reactive event store for rx-nostr with NIP semantics',
  base: '/auftakt/',

  head: [
    ['meta', { property: 'og:title', content: '@ikuradon/auftakt' }],
    ['meta', { property: 'og:description', content: 'Reactive event store for rx-nostr with NIP semantics' }],
  ],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/store' },
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
        text: 'API Reference',
        items: [
          { text: 'createEventStore', link: '/api/store' },
          { text: 'connectStore', link: '/api/connect-store' },
          { text: 'createSyncedQuery', link: '/api/synced-query' },
          { text: 'publishEvent', link: '/api/publish' },
          { text: 'Backends', link: '/api/backends' },
          { text: 'Types', link: '/api/types' },
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
