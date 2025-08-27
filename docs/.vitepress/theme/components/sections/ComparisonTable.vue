<template>
  <div class="comparison-section">
    <h2 class="section-title">Why TypeKro?</h2>
    <div class="table-container">
      <table class="comparison-table">
        <thead>
          <tr>
            <th>Feature</th>
            <th>TypeKro</th>
            <th>Pulumi</th>
            <th>CDK8s</th>
            <th>Helm</th>
            <th>Kustomize</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Type Safety</strong></td>
            <td>✅ Full TypeScript</td>
            <td>✅ Multi-language</td>
            <td>✅ TypeScript</td>
            <td>❌ Templates</td>
            <td>❌ YAML</td>
          </tr>
          <tr>
            <td><strong>GitOps Ready</strong></td>
            <td>✅ Deterministic YAML</td>
            <td>❌ State backend</td>
            <td>✅ YAML output</td>
            <td>✅ Charts</td>
            <td>✅ YAML</td>
          </tr>
          <tr>
            <td><strong>Runtime Dependencies</strong></td>
            <td>✅ KRO + CEL expressions</td>
            <td>❌ Deploy-time only</td>
            <td>❌ Static</td>
            <td>❌ Templates</td>
            <td>❌ Static</td>
          </tr>
          <tr>
            <td><strong>IDE Support</strong></td>
            <td>✅ Full autocomplete</td>
            <td>✅ Language support</td>
            <td>✅ TypeScript</td>
            <td>❌ Limited</td>
            <td>❌ Limited</td>
          </tr>
          <tr>
            <td><strong>Learning Curve</strong></td>
            <td>🟢 Just TypeScript</td>
            <td>🔴 New concepts</td>
            <td>🟡 TypeScript + K8s</td>
            <td>🔴 Templates</td>
            <td>🔴 YAML complexity</td>
          </tr>
          <tr>
            <td><strong>Kubernetes Native</strong></td>
            <td>✅ Pure K8s resources</td>
            <td>❌ Abstraction layer</td>
            <td>✅ Pure K8s</td>
            <td>✅ K8s resources</td>
            <td>✅ K8s resources</td>
          </tr>
          <tr>
            <td><strong>Cross-Resource Refs</strong></td>
            <td>✅ Runtime resolution</td>
            <td>❌ Deploy-time</td>
            <td>❌ Manual</td>
            <td>❌ Manual</td>
            <td>❌ Manual</td>
          </tr>
          <tr>
            <td><strong>Multi-Cloud</strong></td>
            <td>✅ Via Alchemy</td>
            <td>✅ Native</td>
            <td>❌ K8s only</td>
            <td>❌ K8s only</td>
            <td>❌ K8s only</td>
          </tr>
          <tr>
            <td><strong>State Management</strong></td>
            <td>✅ Stateless</td>
            <td>❌ State backend</td>
            <td>✅ Stateless</td>
            <td>✅ Stateless</td>
            <td>✅ Stateless</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.comparison-section {
  padding: 4rem 2rem;
  background: transparent;
  margin: 2rem 0;
}

.section-title {
  line-height: 1.2;
  padding: 1rem 0;
  font-size: 2.5rem;
  font-weight: 700;
  text-align: center;
  margin-bottom: 1rem;
  color: var(--vp-c-brand-1);
  background: linear-gradient(120deg, var(--vp-c-brand-1) 30%, var(--typekro-emerald));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  font-family: var(--vp-font-family-mono);
}

.section-subtitle {
  text-align: center;
  font-size: 1.1rem;
  color: var(--vp-c-text-2);
  max-width: 800px;
  margin: 0 auto 3rem;
  line-height: 1.6;
  font-family: var(--vp-font-family-mono);
}

.table-container {
  overflow-x: auto;
  max-width: 1400px;
  margin: 0 auto;
}

.comparison-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--vp-c-bg);
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  font-family: var(--vp-font-family-mono);
}

.comparison-table th {
  background: var(--vp-c-bg-soft);
  padding: 1rem 0.75rem;
  text-align: center;
  font-weight: 600;
  font-size: 0.9rem;
  color: var(--vp-c-text-1);
  border-bottom: 2px solid var(--vp-c-border);
}

.comparison-table td {
  padding: 0.75rem;
  text-align: center;
  border-bottom: 1px solid var(--vp-c-border);
  font-size: 0.85rem;
  vertical-align: middle;
  color: var(--vp-c-text-2);
}

.comparison-table td:first-child {
  text-align: left;
  font-weight: 600;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
}

.comparison-table tr:hover {
  background: var(--vp-c-bg-soft);
}

.comparison-table tr:hover td:first-child {
  background: var(--vp-c-bg-mute);
}

/* TypeKro column highlighting */
.comparison-table th:nth-child(2) {
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
}

.comparison-table td:nth-child(2) {
  background: var(--vp-c-brand-softest);
  font-weight: 500;
  color: var(--vp-c-text-1);
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .comparison-section {
    padding: 2rem 1rem;
  }
  
  .section-title {
    font-size: 2rem;
  }
  
  .comparison-table {
    font-size: 0.8rem;
  }
  
  .comparison-table th,
  .comparison-table td {
    padding: 0.5rem 0.25rem;
  }
}

/* Fallback for gradient text */
@supports not (background-clip: text) or not (-webkit-background-clip: text) {
  .section-title {
    background: none;
    -webkit-text-fill-color: initial;
    color: var(--vp-c-brand-1);
  }
}

/* Dark mode gradient */
.dark .section-title {
  background: linear-gradient(120deg, var(--vp-c-brand-1) 30%, var(--typekro-emerald-light));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
</style>
