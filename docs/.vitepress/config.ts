import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

export default withMermaid(
  defineConfig({
    title: 'TypeKro',
    description:
      'A Kubernetes control plane aware framework for operating kubernetes like a programmer.',
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
        { text: 'Get Started', link: '/guide/getting-started' },
        { text: 'Learning Path', link: '/guide/first-app' },
        { text: 'Examples', link: '/examples/' },
        { text: 'API Reference', link: '/api/' },
        { text: 'Discord', link: 'https://discord.gg/kKNSDDjW' },
      ],

      sidebar: {
        '/guide/': [
          {
            text: '🚀 Getting Started',
            items: [
              { text: 'What is TypeKro?', link: '/guide/what-is-typekro' },
              { text: '🎯 Decision Guide', link: '/guide/decision-guide' },
              { text: '5-Minute Quick Start', link: '/guide/getting-started' },
              { text: 'Comprehensive Setup', link: '/guide/comprehensive-setup' },
            ],
          },
          {
            text: '📚 Learning Path',
            items: [
              { text: '1. Your First App', link: '/guide/first-app' },
              { text: '2. Factory Functions', link: '/guide/factories' },
              { text: '3. Magic Proxy System', link: '/guide/magic-proxy' },
              { text: '4. External References', link: '/guide/external-references' },
              { text: '5. Advanced Architecture', link: '/guide/architecture' },
            ],
          },
          {
            text: '🛠 Core Concepts',
            items: [
              { text: 'kubernetesComposition', link: '/guide/imperative-composition' },
              { text: 'Schema Definition', link: '/guide/schema-definition' },
              { text: 'Cross-Resource References', link: '/guide/cross-references' },
              { text: 'CEL Expressions', link: '/guide/cel-expressions' },
              { text: 'Status Hydration', link: '/guide/status-hydration' },
            ],
          },
          {
            text: '🚢 Deployment',
            items: [
              { text: 'Overview & Decision Guide', link: '/guide/deployment/' },
              { text: 'Direct Deployment', link: '/guide/deployment/direct' },
              { text: 'Kro Integration', link: '/guide/deployment/kro' },
              { text: 'GitOps Workflows', link: '/guide/deployment/gitops' },
              { text: 'Helm Integration', link: '/guide/deployment/helm' },
            ],
          },
          {
            text: '🔧 Advanced Topics',
            items: [
              { text: 'Custom Factory Functions', link: '/guide/custom-factories' },
              { text: 'TypeKro vs Alternatives', link: '/guide/comparison' },
              { text: 'Type Safety Patterns', link: '/guide/type-safety' },
              { text: 'Debugging Guide', link: '/guide/debugging' },
            ],
          },
        ],
        '/api/': [
          {
            text: 'Core API',
            items: [
              { text: 'kubernetesComposition', link: '/api/kubernetes-composition' },
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
              { text: 'YAML Integration', link: '/api/factories/yaml' },
            ],
          },
        ],
        '/examples/': [
          {
            text: 'Basic Examples',
            items: [
              { text: 'Basic Web App', link: '/examples/basic-webapp' },
              { text: 'Basic Patterns', link: '/examples/basic-patterns' },
              { text: 'Database App', link: '/examples/database-app' },
              { text: 'Microservices', link: '/examples/microservices' },
            ],
          },
          {
            text: 'Advanced Examples',
            items: [
              { text: 'Multi-Environment', link: '/examples/multi-environment' },
              { text: 'Monitoring Stack', link: '/examples/monitoring' },
              { text: 'Helm Patterns', link: '/examples/helm-patterns' },
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
