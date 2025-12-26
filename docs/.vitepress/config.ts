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
        { text: 'Guide', link: '/guide/philosophy' },
        { text: 'Examples', link: '/examples/basic-webapp' },
        { text: 'API Reference', link: '/api/' },
        { text: 'Advanced', link: '/advanced/arktype-schemas' },
        { text: 'Discord', link: 'https://discord.gg/kKNSDDjW' },
      ],

      sidebar: {
        '/guide/': [
          {
            text: 'Guide',
            items: [
              { text: 'Getting Started', link: '/guide/getting-started' },
              { text: 'Philosophy', link: '/guide/philosophy' },
              { text: 'Magic Proxy System', link: '/guide/magic-proxy' },
              { text: 'JavaScript to CEL', link: '/guide/javascript-to-cel' },
              { text: 'Deployment Modes', link: '/guide/deployment-modes' },
              { text: 'External References', link: '/guide/external-references' },
              { text: 'Troubleshooting', link: '/guide/troubleshooting' },
            ],
          },
        ],
        '/api/': [
          {
            text: 'Core API',
            items: [
              { text: 'Overview', link: '/api/' },
              { text: 'Import Patterns', link: '/api/imports' },
              { text: 'kubernetesComposition', link: '/api/kubernetes-composition' },
              { text: 'CEL Expressions', link: '/api/cel' },
              { text: 'YAML & Helm Integration', link: '/api/yaml-closures' },
              { text: 'Types', link: '/api/types' },
            ],
          },
          {
            text: 'Factory Functions',
            items: [
              { text: 'Overview', link: '/api/factories/' },
              { text: 'Workloads', link: '/api/factories/workloads' },
              { text: 'Networking', link: '/api/factories/networking' },
              { text: 'Config', link: '/api/factories/config' },
              { text: 'Storage', link: '/api/factories/storage' },
              { text: 'RBAC', link: '/api/factories/rbac' },
              { text: 'YAML', link: '/api/factories/yaml' },
            ],
          },
          {
            text: 'Ecosystems',
            items: [
              { text: 'Kubernetes', link: '/api/kubernetes/' },
              { text: 'Cilium', link: '/api/cilium/' },
              { text: 'Cert-Manager', link: '/api/cert-manager/' },
              { text: 'Flux', link: '/api/flux/' },
              { text: 'Kro', link: '/api/kro/' },
              { text: 'Kro Runtime Bootstrap', link: '/api/kro/compositions/runtime' },
              { text: 'APISix', link: '/api/apisix/' },
              { text: 'External-DNS', link: '/api/external-dns/' },
              { text: 'Pebble', link: '/api/pebble/' },
            ],
          },
        ],
        '/examples/': [
          {
            text: 'Examples',
            items: [
              { text: 'Basic Web App', link: '/examples/basic-webapp' },
              { text: 'Database App', link: '/examples/database-app' },
              { text: 'Helm Integration', link: '/examples/helm-integration' },
              { text: 'Multi-Environment', link: '/examples/multi-environment' },
              { text: 'Custom CRD', link: '/examples/custom-crd' },
            ],
          },
        ],
        '/advanced/': [
          {
            text: 'Advanced Topics',
            items: [
              { text: 'ArkType Schemas', link: '/advanced/arktype-schemas' },
              { text: 'Custom Integrations', link: '/advanced/custom-integrations' },
              { text: 'Alchemy Integration', link: '/advanced/alchemy-integration' },
              { text: 'Migration Guide', link: '/advanced/migration' },
              { text: 'Resource IDs', link: '/advanced/resource-ids' },
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
    ],
  })
);
