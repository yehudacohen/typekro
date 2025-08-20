import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

export default withMermaid(
  defineConfig({
    title: 'TypeKro',
    description: 'Hypermodern Infrastructure-as-Code for Kubernetes with TypeScript',
    base: '/',

    head: [
      ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
      ['link', { rel: 'apple-touch-icon', href: '/typekro-crow.svg' }],
      ['meta', { name: 'theme-color', content: '#1E40AF' }],
      ['link', { rel: 'canonical', href: 'https://typekro.run' }],
      ['meta', { property: 'og:url', content: 'https://typekro.run' }],
      ['meta', { name: 'og:type', content: 'website' }],
      ['meta', { name: 'og:locale', content: 'en' }],
      ['meta', { name: 'og:site_name', content: 'TypeKro' }],
      ['meta', { name: 'og:image', content: '/typekro-logo.svg' }],
    ],

    sitemap: {
      hostname: 'https://typekro.run',
    },

    themeConfig: {
      logo: '/typekro-crow.svg',

      nav: [
        { text: 'Guide', link: '/guide/getting-started' },
        { text: 'API Reference', link: '/api/' },
        { text: 'Examples', link: '/examples/' },
        { text: 'Discord', link: 'https://discord.gg/kKNSDDjW' },
      ],

      sidebar: {
        '/guide/': [
          {
            text: 'Introduction',
            items: [
              { text: 'What is TypeKro?', link: '/guide/what-is-typekro' },
              { text: 'Getting Started', link: '/guide/getting-started' },
              { text: 'Quick Start', link: '/guide/quick-start' },
            ],
          },
          {
            text: 'Core Concepts',
            items: [
              { text: 'Schema Definition', link: '/guide/schema-definition' },
              { text: 'Factory Functions', link: '/guide/factory-functions' },
              { text: 'Resource Graphs', link: '/guide/resource-graphs' },
              { text: 'Cross-Resource References', link: '/guide/cross-references' },
              { text: 'CEL Expressions', link: '/guide/cel-expressions' },
              { text: 'Status Hydration', link: '/guide/status-hydration' },
            ],
          },
          {
            text: 'Deployment Strategies',
            items: [
              { text: 'Overview', link: '/guide/deployment/' },
              { text: 'Direct Deployment', link: '/guide/deployment/direct' },
              { text: 'Kro Integration', link: '/guide/deployment/kro' },
              { text: 'Alchemy Integration', link: '/guide/deployment/alchemy' },
              { text: 'GitOps Workflows', link: '/guide/deployment/gitops' },
              { text: 'Helm Integration', link: '/guide/deployment/helm' },
            ],
          },
          {
            text: 'Advanced Topics',
            items: [
              { text: 'Custom Factory Functions', link: '/guide/custom-factories' },
              { text: 'Type Safety Patterns', link: '/guide/type-safety' },
              { text: 'Performance Optimization', link: '/guide/performance' },
              { text: 'Troubleshooting', link: '/guide/troubleshooting' },
            ],
          },
        ],
        '/api/': [
          {
            text: 'Core API',
            items: [
              { text: 'toResourceGraph', link: '/api/to-resource-graph' },
              { text: 'Factory Functions', link: '/api/factories' },
              { text: 'CEL Expressions', link: '/api/cel' },
              { text: 'Types', link: '/api/types' },
            ],
          },
          {
            text: 'Factory Functions',
            items: [
              { text: 'Workloads', link: '/api/factories/workloads' },
              { text: 'Networking', link: '/api/factories/networking' },
              { text: 'Storage', link: '/api/factories/storage' },
              { text: 'Configuration', link: '/api/factories/config' },
              { text: 'RBAC', link: '/api/factories/rbac' },
            ],
          },
        ],
        '/examples/': [
          {
            text: 'Basic Examples',
            items: [
              { text: 'Simple Web App', link: '/examples/simple-webapp' },
              { text: 'Database Integration', link: '/examples/database' },
              { text: 'Microservices', link: '/examples/microservices' },
            ],
          },
          {
            text: 'Advanced Examples',
            items: [
              { text: 'Multi-Environment', link: '/examples/multi-environment' },
              { text: 'CI/CD Integration', link: '/examples/cicd' },
              { text: 'Monitoring Stack', link: '/examples/monitoring' },
            ],
          },
        ],
      },

      socialLinks: [
        { icon: 'github', link: 'https://github.com/yehudacohen/typekro' },
        { icon: 'npm', link: 'https://www.npmjs.com/package/typekro' },
        { icon: 'discord', link: 'https://discord.gg/kKNSDDjW' },
      ],

      footer: {
        message: 'Released under the Apache 2.0 License.',
        copyright: 'Copyright © 2024-present TypeKro Contributors',
      },

      search: {
        provider: 'local',
      },

      editLink: {
        pattern: 'https://github.com/yehudacohen/typekro/edit/main/docs/:path',
        text: 'Edit this page on GitHub',
      },
    },

    markdown: {
      theme: {
        light: 'github-light',
        dark: 'github-dark',
      },
      codeTransformers: [],
    },

    mermaid: {
      theme: 'default',
    },

    ignoreDeadLinks: [
      /typekro-examples$/,
      /discord\.gg\/typekro$/,
      /guide\/direct-deployment$/,
      /guide\/security$/,
      /api\/factories\/index$/,
      /direct-deployment$/,
    ],
  })
);
