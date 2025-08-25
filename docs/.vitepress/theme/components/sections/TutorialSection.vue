<template>
  <div class="tutorial-wrapper">
    <div class="tutorial-container">
      <TutorialCarousel />
    </div>
  </div>
</template>

<script>
import TutorialCarousel from '../TutorialCarousel/TutorialCarousel.vue'

export default {
  name: 'TutorialSection',
  components: {
    TutorialCarousel
  }
}
</script>

<style>
/* Tutorial carousel theme integration */
.tutorial-wrapper {
  background: var(--vp-c-bg-alt);
  padding: 4rem 2rem;
}

.tutorial-container {
  max-width: 1400px;
  margin: 0 auto;
}

/* Override carousel styles to match theme */
.tutorial-carousel {
  --tutorial-brand: var(--vp-c-brand-1);
  --tutorial-brand-dark: var(--vp-c-brand-2);
  --tutorial-brand-soft: var(--vp-c-brand-soft);
  --tutorial-bg: var(--vp-c-bg);
  --tutorial-bg-soft: var(--vp-c-bg-soft);
  --tutorial-bg-mute: var(--vp-c-bg-mute);
  --tutorial-text-1: var(--vp-c-text-1);
  --tutorial-text-2: var(--vp-c-text-2);
  --tutorial-divider: var(--vp-c-divider);
  
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
  padding: 3rem;
}

.tutorial-carousel .carousel-title {
  color: var(--vp-c-text-1);
  font-size: 2.5rem;
  font-weight: 700;
  text-align: center;
  margin-bottom: 2rem;
  background: linear-gradient(120deg, var(--vp-c-brand-1) 30%, var(--typekro-emerald));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* Code block styling in carousel */
.tutorial-carousel .code-block,
.tutorial-carousel .language-typescript,
.tutorial-carousel .vp-code {
  background: var(--vp-c-bg-soft) !important;
  border: 1px solid var(--vp-c-divider) !important;
  border-radius: 8px !important;
}

.tutorial-carousel pre {
  background: var(--vp-c-bg-soft) !important;
  color: var(--vp-c-text-1) !important;
}

.tutorial-carousel .step-content,
.tutorial-carousel .explanation-section {
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
}

.tutorial-carousel .step-title {
  color: var(--vp-c-text-1);
}

.tutorial-carousel .step-description {
  color: var(--vp-c-text-2);
}

/* Navigation styling */
.tutorial-carousel .nav-button {
  background: var(--vp-c-brand-1);
  color: white;
  border: none;
}

.tutorial-carousel .nav-button:hover {
  background: var(--vp-c-brand-2);
}

.tutorial-carousel .nav-button:disabled {
  background: var(--vp-c-bg-mute);
  color: var(--vp-c-text-3);
}

.tutorial-carousel .step-dot {
  background: var(--vp-c-bg-mute);
  border: 2px solid var(--vp-c-divider);
}

.tutorial-carousel .step-dot.active {
  background: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}

/* Dark mode adjustments */
.dark .tutorial-carousel {
  background: var(--vp-c-bg-soft);
}

.dark .tutorial-carousel .carousel-title {
  background: linear-gradient(120deg, var(--vp-c-brand-1) 30%, var(--typekro-emerald-light));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* Mobile adjustments */
@media (max-width: 768px) {
  .tutorial-wrapper {
    padding: 2rem 1rem;
  }
  
  .tutorial-carousel {
    padding: 2rem;
  }
  
  .tutorial-carousel .carousel-title {
    font-size: 2rem;
  }
}
</style>
