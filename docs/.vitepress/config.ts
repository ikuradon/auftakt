import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'auftakt',
  description: 'rx-nostr 専用リアクティブイベントストア',
  base: '/auftakt/',
  lastUpdated: true,
  srcExclude: ['specs/**', 'plans/**', 'superpowers/**'],
  markdown: {
    lineNumbers: true,
  },

  head: [
    ['meta', { property: 'og:title', content: '@ikuradon/auftakt' }],
    ['meta', { property: 'og:description', content: 'Reactive event store for rx-nostr with NIP semantics' }],
  ],

  locales: {
    root: {
      label: '日本語',
      lang: 'ja',
      themeConfig: {
        nav: [
          { text: 'ガイド', link: '/guide/getting-started' },
          { text: 'リファレンス', link: '/reference/api' },
        ],
        sidebar: {
          '/guide/': [
            {
              text: 'ガイド',
              items: [
                { text: 'はじめに', link: '/guide/getting-started' },
                { text: 'コアコンセプト', link: '/guide/core-concepts' },
                { text: 'バックエンド', link: '/guide/backends' },
                { text: 'Svelte 連携', link: '/guide/svelte' },
                { text: 'パターン集', link: '/guide/patterns' },
              ],
            },
          ],
          '/reference/': [
            {
              text: 'リファレンス',
              items: [
                { text: 'API リファレンス', link: '/reference/api' },
                { text: 'アーキテクチャ', link: '/reference/architecture' },
                { text: 'NIP 対応状況', link: '/reference/nip-support' },
              ],
            },
          ],
        },
        outline: {
          label: 'このページの目次',
        },
        docFooter: {
          prev: '前のページ',
          next: '次のページ',
        },
        lastUpdated: {
          text: '最終更新',
        },
        returnToTopLabel: 'トップに戻る',
        sidebarMenuLabel: 'メニュー',
        darkModeSwitchLabel: 'テーマ切替',
        editLink: {
          pattern: 'https://github.com/ikuradon/auftakt/edit/main/docs/:path',
          text: 'このページを編集する',
        },
      },
    },
  },

  themeConfig: {
    socialLinks: [
      { icon: 'github', link: 'https://github.com/ikuradon/auftakt' },
    ],
    search: {
      provider: 'local',
    },
    footer: {
      message: 'MIT License',
      copyright: 'Copyright © 2026 ikuradon',
    },
  },
});
