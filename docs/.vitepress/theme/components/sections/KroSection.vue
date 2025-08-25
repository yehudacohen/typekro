<template>
  <section class="kro-section">
    <div class="kro-container">
      <h2 class="section-title">What is KRO?</h2>
      <div class="kro-content">
        <p class="kro-description">
          Kubernetes Resource Orchestrator (KRO) is a powerful orchestration engine that enables dynamic, 
          stateful resource management. TypeKro builds on KRO to provide type-safe infrastructure as code 
          with runtime state awareness.
        </p>
        
        <div class="kro-features">
          <div class="kro-feature">
            <h4 class="feature-label">Dynamic Resources</h4>
            <p class="feature-text">Create resources that adapt based on runtime state</p>
          </div>
          <div class="kro-feature">
            <h4 class="feature-label">State Awareness</h4>
            <p class="feature-text">Reference other resource states in your definitions</p>
          </div>
          <div class="kro-feature">
            <h4 class="feature-label">CEL Integration</h4>
            <p class="feature-text">Use Common Expression Language for complex logic</p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.kro-section {
  padding: 4rem 2rem;
  background: transparent;
}

.kro-container {
  max-width: 800px;
  margin: 0 auto;
  text-align: center;
}

.section-title {
  line-height: 1.2;
  padding: 1rem 0;
  font-size: 2rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
  margin-bottom: 2rem;
  font-family: var(--vp-font-family-mono);
}

.kro-content {
  text-align: left;
}

.kro-description {
  font-size: 1.1rem;
  color: var(--vp-c-text-2);
  line-height: 1.6;
  margin-bottom: 3rem;
  font-family: var(--vp-font-family-mono);
}

.kro-features {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 2rem;
}

.kro-feature {
  padding: 1.5rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: transparent;
  transition: all 0.3s ease;
}

.kro-feature:hover {
  border-color: var(--vp-c-brand-1);
  transform: translateY(-2px);
}

.feature-label {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--vp-c-text-1);
  margin-bottom: 0.5rem;
  font-family: var(--vp-font-family-mono);
}

.feature-text {
  color: var(--vp-c-text-2);
  line-height: 1.5;
  font-family: var(--vp-font-family-mono);
}

@media (max-width: 768px) {
  .kro-section {
    padding: 2rem 1rem;
  }
  
  .section-title {
  line-height: 1.2;
  padding: 1rem 0;
    font-size: 1.5rem;
  }
  
  .kro-description {
    font-size: 1rem;
  }
  
  .kro-features {
    grid-template-columns: 1fr;
    gap: 1rem;
  }
  
  .kro-feature {
    padding: 1rem;
  }
}
</style>
