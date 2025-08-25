<template>
  <div class="cta-section">
    <h2 class="cta-title">Ready to Get Started?</h2>
    <div class="cta-buttons">
      <button @click="navigateToGuide" class="btn btn-primary">Install TypeKro</button>
      <button @click="navigateToExamples" class="btn btn-secondary">View Examples</button>
    </div>
  </div>
</template>

<script>
export default {
  name: 'FinalCTA',
  setup() {
    const navigateToGuide = () => {
      window.location.href = '/guide/getting-started';
    };

    const navigateToExamples = () => {
      window.location.href = '/examples/';
    };

    return {
      navigateToGuide,
      navigateToExamples,
    };
  },
};
</script>

<style scoped>
.cta-section {
  padding: 4rem 2rem;
  background: transparent;
  text-align: center;
  margin: 2rem 0;
  overflow: visible;
}

.cta-title {
  font-size: 2.5rem;
  font-weight: 700;
  margin-bottom: 2rem;
  line-height: 1.2;
  padding: 0.5rem 0;
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
}

/* Gradient text with proper fallback */
.cta-title {
  background: linear-gradient(120deg, var(--vp-c-brand-1) 30%, var(--typekro-emerald));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* Dark mode gradient */
.dark .cta-title {
  background: linear-gradient(120deg, var(--vp-c-brand-1) 30%, var(--typekro-emerald-light));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* Fallback for browsers that don't support background-clip */
@supports not (background-clip: text) or not (-webkit-background-clip: text) {
  .cta-title {
    background: none;
    -webkit-text-fill-color: initial;
    color: var(--vp-c-brand-1);
  }
}

.cta-buttons {
  display: flex;
  gap: 1rem;
  justify-content: center;
  flex-wrap: wrap;
}

.btn {
  display: inline-block;
  padding: 0.75rem 2rem;
  border-radius: 6px;
  font-weight: 600;
  text-decoration: none;
  transition: all 0.3s ease;
  font-size: 1.1rem;
  border: none;
  cursor: pointer;
  font-family: var(--vp-font-family-mono);
}

.btn-primary {
  background: var(--vp-c-brand-1);
  color: white;
}

.btn-primary:hover {
  background: var(--vp-c-brand-2);
  transform: translateY(-2px);
}

.btn-secondary {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  border: 1px solid var(--vp-c-border);
}

.btn-secondary:hover {
  background: var(--vp-c-bg-mute);
  transform: translateY(-2px);
}
</style>
