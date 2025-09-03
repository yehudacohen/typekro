<template>
  <div class="hero-section">
    <div class="hero-container">
      <!-- Left 40% - Logo stacked above text, positioned higher -->
      <div class="hero-content">
        <div class="hero-branding">
          <img src="/typekro-logo.svg" alt="TypeKro Logo" class="hero-logo" />
        </div>
        <div class="hero-text">
          <h1 class="hero-title">Kubernetes with TypeScript</h1>
          <p class="hero-tagline">A control plane aware framework for orchestrating kubernetes resources like a programmer</p>
        </div>
        <div class="hero-actions">
          <button @click="navigateToGuide" class="VPButton medium brand">Get Started</button>
          <button @click="navigateToExamples" class="VPButton medium alt">View Examples</button>
          <a href="https://github.com/yehudacohen/typekro" class="VPButton medium alt" target="_blank">⭐ Star on GitHub</a>
        </div>
      </div>
      
      <!-- Right 60% - Code example positioned lower and taller -->
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

const webapp = kubernetesComposition(
  {
    name: 'webapp',
    apiVersion: 'example.com/v1',
    kind: 'WebApp',
    spec: type({ replicas: 'number' }),
    status: type({ ready: 'boolean' })
  },
  (spec) => {
    const deployment = Deployment({
      name: 'webapp',
      image: 'nginx',
      replicas: spec.replicas
    });
    
    const service = Service({
      name: 'webapp-service',
      selector: { app: 'webapp' },
      ports: [{ port: 80 }]
    });

    return {
      // ✨ Natural JavaScript - automatically converted to CEL
      ready: deployment.status.readyReplicas > 0
    };  
  }
);

await webapp.factory('direct').deploy({ replicas: 3 });`;

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
/* 40/60 Hero Layout - Keep size, adjust positioning */
.hero-container {
  display: flex;
  align-items: flex-start;
  min-height: 70vh;
  max-width: 1400px;
  margin: 0 auto;
  padding: 2rem 2rem 1rem;
  gap: 3rem;
}

/* Left 40% - Logo stacked above text, positioned higher */
.hero-content {
  flex: 0 0 42%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  text-align: left;
  padding-left: 4rem;
}

/* Right 60% - Code example positioned lower and taller */
.code-sidebar {
  flex: 0 0 55%;
  display: flex;
  align-items: flex-start;
  padding-top: 3rem; padding-right: 2rem;
}

/* Logo styling matching docs */
.hero-branding {
  margin-bottom: 1.5rem;
}

.hero-logo {
  height: 80px;
  width: auto;
  margin-bottom: 0.5rem;
}

/* Text positioning higher */
.hero-text {
  margin-bottom: 2.5rem;
}

.hero-title {
  font-size: 3.5rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
  line-height: 1.2;
  margin-bottom: 1rem;
  font-family: var(--vp-font-family-mono);
}

.hero-tagline {
  font-size: 1.4rem;
  font-weight: 400;
  color: var(--vp-c-text-2);
  line-height: 1.6;
  margin-bottom: 0;
  font-family: var(--vp-font-family-mono);
}

/* Action buttons - EXACT COPY of VitePress styling */
.hero-actions {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}

/* Code container - taller and positioned lower */
.code-container {
  width: 100%;
  height: 500px;
  overflow-y: auto;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.code-container :deep(pre) {
  margin: 0;
  padding: 1.5rem;
  font-size: 0.85rem;
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
  padding: 1.5rem;
  border-radius: 8px;
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
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
  .hero-container {
    flex-direction: column;
    gap: 2rem;
    padding: 1rem;
  }
  
  .hero-content {
    flex: none;
    padding-left: 0;
    text-align: center;
    align-items: center;
  }
  
  .code-sidebar {
    flex: none;
    padding-top: 0;
  }
  
  .hero-title {
    font-size: 2.5rem;
  }
  
  .hero-tagline {
    font-size: 1.1rem;
  }
  
  .code-container {
    height: 350px;
  }
  
  .hero-actions {
    justify-content: center;
  }
}
/* Dark theme code block overrides - use proper code colors, not green theme colors */
.dark .code-container :deep(pre) {
  background: #0d1117 !important;
  color: #f0f6fc !important;
  border: 1px solid #30363d !important;
}

.dark .code-container :deep(.shiki) {
  color: #f0f6fc !important;
  background: #0d1117 !important;
}

/* Dark mode syntax highlighting overrides */
.dark .code-container :deep(.shiki span) {
  color: var(--shiki-dark) !important;
}

.dark .code-container :deep(.shiki .token) {
  color: var(--shiki-dark) !important;
}

/* Force all text in dark mode code blocks to be light */
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

