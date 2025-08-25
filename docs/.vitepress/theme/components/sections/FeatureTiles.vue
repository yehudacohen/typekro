<template>
  <section class="features-section">
    <div class="features-container">
      <div class="features-grid">
        <div class="feature-tile">
          <div class="feature-icon">🔒</div>
          <h3 class="feature-title">Type-Safe Infrastructure</h3>
          <p class="feature-description">
            Write Kubernetes resources in TypeScript with full IDE support. Catch configuration errors at compile time, not runtime.
          </p>
        </div>
        
        <div class="feature-tile">
          <div class="feature-icon">🔗</div>
          <h3 class="feature-title">Control Plane Aware</h3>
          <p class="feature-description">
            Resources reference each other's runtime state using CEL expressions. Built on Kubernetes Resource Orchestrator (KRO) for dynamic infrastructure.
          </p>
        </div>
        
        <div class="feature-tile">
          <div class="feature-icon">🚀</div>
          <h3 class="feature-title">Deploy Anywhere</h3>
          <p class="feature-description">
            Same code deploys directly to clusters, generates GitOps YAML, or runs with KRO orchestration. Choose your strategy without rewriting.
          </p>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.features-section {
  padding: 4rem 2rem;
  background: transparent !important;
}

.features-container {
  max-width: 1200px;
  margin: 0 auto;
}

.features-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 2rem;
}

.feature-tile {
  background: transparent !important;
  padding: 2rem;
  border-radius: 12px;
  text-align: center;
  border: 1px solid var(--vp-c-divider);
  transition: all 0.3s ease;
}

.feature-tile:hover {
  transform: translateY(-4px);
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 8px 25px rgba(0, 0, 0, 0.1);
}

.dark .feature-tile:hover {
  box-shadow: 0 8px 25px rgba(16, 185, 129, 0.15);
}

.feature-icon {
  font-size: 4rem;
  margin-bottom: 1.5rem;
  line-height: 1;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.1));
}

.dark .feature-icon {
  filter: drop-shadow(0 2px 4px rgba(16, 185, 129, 0.3));
}

.feature-title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
  margin-bottom: 1rem;
  font-family: var(--vp-font-family-mono);
}

.feature-description {
  color: var(--vp-c-text-2);
  line-height: 1.6;
  font-size: 1rem;
  font-family: var(--vp-font-family-mono);
}

@media (max-width: 768px) {
  .features-section {
    padding: 2rem 1rem;
  }
  
  .features-grid {
    grid-template-columns: 1fr;
    gap: 1.5rem;
  }
  
  .feature-tile {
    padding: 1.5rem;
  }
  
  .feature-icon {
    font-size: 3rem;
  }
}
</style>

/* Force section to be transparent in both light and dark mode */
.features-section {
  background-color: transparent !important;
  background: transparent !important;
}

.dark .features-section {
  background-color: transparent !important;
  background: transparent !important;
}
