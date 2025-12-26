<template>
  <div class="hero-section">
    <div class="hero-container">
      <!-- Top 25% - Logo and text -->
      <div class="hero-content">
        <div class="hero-branding">
          <img src="/typekro-logo.svg" alt="TypeKro Logo" class="hero-logo" />
        </div>
        <div class="hero-text">
          <h1 class="hero-title">Write TypeScript. Deploy Kubernetes.</h1>
          <p class="hero-tagline">Runtime intelligence included.</p>
        </div>
        <div class="hero-actions">
          <button @click="navigateToGuide" class="VPButton medium brand">Get Started</button>
          <button @click="navigateToExamples" class="VPButton medium alt">View Examples</button>
          <a href="https://github.com/yehudacohen/typekro" class="VPButton medium alt" target="_blank">⭐ Star on GitHub</a>
        </div>
      </div>
      
      <!-- Bottom 75% - Code example -->
      <div class="code-sidebar">
        <div class="code-container" v-html="highlightedCode"></div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue';
import { codeToHtml } from 'shiki';

export default {
  name: 'HeroSection',
  setup() {
    const highlightedCode = ref('');

    const codeExample = `import { type } from 'arktype';
import { kubernetesComposition } from 'typekro';
import { Deployment, Service } from 'typekro/simple';

// Define a reusable WebApp composition
const WebApp = kubernetesComposition({
  name: 'webapp',
  apiVersion: 'example.com/v1',
  kind: 'WebApp',
  spec: type({ name: 'string', image: 'string', replicas: 'number' }),
  status: type({ ready: 'boolean', endpoint: 'string' })
}, (spec) => {
  const deploy = Deployment({ id: 'app', name: spec.name, image: spec.image, replicas: spec.replicas });
  const svc = Service({ id: 'svc', name: \`\${spec.name}-svc\`, selector: { app: spec.name }, ports: [{ port: 80 }] });

  return {
    ready: deploy.status.readyReplicas > 0,     // ✨ JavaScript → CEL
    endpoint: \`http://\${svc.status.clusterIP}\`  // ✨ Template → CEL
  };
});

// Deploy multiple instances with a simple loop
const apps = [
  { name: 'frontend', image: 'nginx', replicas: 3 },
  { name: 'api', image: 'node:20', replicas: 2 }
];

const factory = WebApp.factory('direct', { namespace: 'production' });
for (const app of apps) await factory.deploy(app);`;

    const navigateToGuide = () => {
      document.getElementById('getting-started')?.scrollIntoView({ behavior: 'smooth' });
    };

    const navigateToExamples = () => {
      window.location.href = '/examples/';
    };

    onMounted(async () => {
      try {
        const html = await codeToHtml(codeExample, {
          lang: 'typescript',
          themes: {
            light: 'github-light',
            dark: 'github-dark',
          },
        });
        highlightedCode.value = html;
      } catch (error) {
        console.error('Syntax highlighting failed:', error);
        highlightedCode.value = `<pre class="fallback-code"><code>${codeExample}</code></pre>`;
      }
    });

    return {
      highlightedCode,
      navigateToGuide,
      navigateToExamples,
    };
  },
};
</script>

<style scoped>
/* Vertical 25/75 Hero Layout */
.hero-section {
  min-height: 90vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
}

.hero-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: 1000px;
  margin: 0 auto;
  gap: 2rem;
  width: 100%;
}

/* Top section - Logo and text (25%) */
.hero-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  width: 100%;
}

/* Logo styling */
.hero-branding {
  margin-bottom: 1rem;
}

.hero-logo {
  height: 80px;
  width: auto;
}

/* Text */
.hero-text {
  margin-bottom: 1.5rem;
}

.hero-title {
  font-size: 2.5rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
  line-height: 1.2;
  margin-bottom: 0.5rem;
  font-family: var(--vp-font-family-mono);
}

.hero-tagline {
  font-size: 1.2rem;
  font-weight: 400;
  color: var(--vp-c-text-2);
  line-height: 1.6;
  margin-bottom: 0;
  font-family: var(--vp-font-family-mono);
}

/* Action buttons */
.hero-actions {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  justify-content: center;
}

/* Bottom section - Code (75%) */
.code-sidebar {
  width: 100%;
  max-width: 900px;
}

.code-container {
  width: 100%;
  max-height: 450px;
  overflow-y: auto;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.code-container :deep(pre) {
  margin: 0;
  padding: 1.25rem;
  font-size: 0.8rem;
  line-height: 1.4;
  border-radius: 8px;
  font-family: var(--vp-font-family-mono);
  background: var(--vp-c-bg-soft) !important;
  border: 1px solid var(--vp-c-border) !important;
}

.code-container :deep(.shiki) {
  background: var(--vp-c-bg-soft) !important;
}

.fallback-code {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  padding: 1.25rem;
  border-radius: 8px;
  font-family: var(--vp-font-family-mono);
  font-size: 0.8rem;
  line-height: 1.4;
  overflow-x: auto;
  border: 1px solid var(--vp-c-border);
}

/* VitePress Button Styles */
.VPButton {
  display: inline-block;
  border: 1px solid transparent;
  text-align: center;
  font-weight: 600;
  white-space: nowrap;
  transition: all 0.3s ease;
  cursor: pointer;
  text-decoration: none;
  font-family: var(--vp-font-family-mono);
}

.VPButton.medium {
  border-radius: 20px;
  padding: 0 20px;
  line-height: 38px;
  font-size: 14px;
}

.VPButton.brand {
  border-color: var(--vp-c-brand-1);
  color: white;
  background-color: var(--vp-c-brand-1);
}

.VPButton.brand:hover {
  border-color: var(--vp-c-brand-2);
  background-color: var(--vp-c-brand-2);
  transform: translateY(-2px);
}

.VPButton.alt {
  border-color: var(--vp-c-border);
  color: var(--vp-c-text-1);
  background-color: var(--vp-c-bg-soft);
}

.VPButton.alt:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
  transform: translateY(-2px);
}

/* Mobile Layout */
@media (max-width: 768px) {
  .hero-section {
    min-height: auto;
    padding: 1rem;
  }
  
  .hero-container {
    gap: 1.5rem;
  }
  
  .hero-title {
    font-size: 1.8rem;
  }
  
  .hero-tagline {
    font-size: 1rem;
  }
  
  .code-container {
    max-height: 350px;
  }
  
  .code-container :deep(pre) {
    font-size: 0.75rem;
    padding: 1rem;
  }
  
  .hero-actions {
    flex-direction: column;
    align-items: center;
  }
}

/* Dark theme code block overrides */
.dark .code-container :deep(pre) {
  background: #0d1117 !important;
  color: #f0f6fc !important;
  border: 1px solid #30363d !important;
}

.dark .code-container :deep(.shiki) {
  color: #f0f6fc !important;
  background: #0d1117 !important;
}

.dark .code-container :deep(.shiki span) {
  color: var(--shiki-dark) !important;
}

.dark .code-container :deep(pre),
.dark .code-container :deep(pre *) {
  color: #f0f6fc !important;
}

.dark .fallback-code {
  background: #0d1117 !important;
  color: #f0f6fc !important;
  border: 1px solid #30363d !important;
}
</style>
