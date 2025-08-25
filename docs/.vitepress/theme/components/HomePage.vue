<template>
  <main class="main-content">
    <!-- Beta badge positioned like original -->
    <div class="beta-badge">⚠️ BETA - Not for production</div>
    
    <HeroSection />
    <FeatureTiles />
    
    <!-- Tutorial Carousel Section -->
    <div id="getting-started">
      <TutorialSection />
    </div>
    
    <ComparisonTable />
    <KroSection />
    <FinalCTA />
  </main>
</template>

<script>
import HeroSection from './HeroSection.vue'
import FeatureTiles from './sections/FeatureTiles.vue'
import TutorialSection from './sections/TutorialSection.vue'
import ComparisonTable from './sections/ComparisonTable.vue'
import KroSection from './sections/KroSection.vue'
import FinalCTA from './sections/FinalCTA.vue'

export default {
  name: 'HomePage',
  components: {
    HeroSection,
    FeatureTiles,
    TutorialSection,
    ComparisonTable,
    KroSection,
    FinalCTA
  }
}
</script>

<style scoped>
.main-content {
  background: var(--vp-c-bg);
  position: relative;
}

/* Beta badge matching original VitePress position */
.beta-badge {
  position: fixed;
  top: 5rem;
  right: 2rem;
  background: rgba(37, 99, 235, 0.08);
  color: var(--vp-c-brand-1);
  padding: 0.4rem 1rem;
  border-radius: 16px;
  font-size: 0.75rem;
  font-weight: 600;
  font-family: var(--vp-font-family-mono);
  border: 1px solid var(--vp-c-brand-soft);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  z-index: 1000;
  transition: all 0.3s ease;
}

.beta-badge:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.dark .beta-badge {
  background: rgba(56, 189, 248, 0.08);
  color: var(--vp-c-brand-1);
  border: 1px solid var(--vp-c-brand-soft);
}

@media (max-width: 768px) {
  .beta-badge {
    top: 1rem;
    right: 4rem;
    font-size: 0.7rem;
    padding: 0.3rem 0.8rem;
  }
}
</style>
