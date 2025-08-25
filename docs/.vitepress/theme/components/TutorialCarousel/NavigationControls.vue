<template>
  <div class="tutorial-navigation">
    <!-- Previous/Next Buttons -->
    <div class="nav-buttons">
      <button
        class="nav-button nav-button--prev"
        :disabled="isFirstStep"
        @click="$emit('previous')"
        :aria-label="'Previous step'"
      >
        <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
        Previous
      </button>

      <button
        class="nav-button nav-button--next"
        :disabled="isLastStep"
        @click="$emit('next')"
        :aria-label="'Next step'"
      >
        Next
        <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>

    <!-- Step Indicator Dots -->
    <div class="step-indicators" role="tablist" aria-label="Tutorial steps">
      <button
        v-for="(step, index) in steps"
        :key="step.id"
        class="step-dot"
        :class="{ 'step-dot--active': index === currentStep }"
        :aria-label="`Go to step ${index + 1}: ${step.title}`"
        :aria-selected="index === currentStep"
        role="tab"
        @click="$emit('goToStep', index)"
      >
        <span class="step-number">{{ index + 1 }}</span>
      </button>
    </div>

    <!-- Progress Bar -->
    <div v-if="showProgress" class="progress-bar">
      <div 
        class="progress-fill" 
        :style="{ width: `${progress}%` }"
        :aria-label="`Progress: ${Math.round(progress)}%`"
      ></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TutorialStep } from './types';

interface Props {
  steps: TutorialStep[];
  currentStep: number;
  isFirstStep: boolean;
  isLastStep: boolean;
  progress: number;
  showProgress?: boolean;
}

interface Emits {
  (e: 'previous'): void;
  (e: 'next'): void;
  (e: 'goToStep', index: number): void;
}

defineProps<Props>();
defineEmits<Emits>();
</script>

<style scoped>
.tutorial-navigation {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  align-items: center;
  padding: 0.5rem 0;
}

.nav-buttons {
  display: flex;
  gap: 1rem;
  align-items: center;
}

.nav-button {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  border: 2px solid var(--vp-c-brand-1);
  background: transparent;
  color: var(--vp-c-brand-1);
  border-radius: 0.5rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.nav-button:hover:not(:disabled) {
  background: var(--vp-c-brand-1);
  color: white;
  transform: translateY(-1px);
}

.nav-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

.nav-icon {
  width: 1rem;
  height: 1rem;
}

.step-indicators {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.step-dot {
  width: 2rem;
  height: 2rem;
  border-radius: 4px;
  border: 1px solid var(--vp-c-divider);
  background: transparent;
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8rem;
  font-weight: 500;
  font-family: var(--vp-font-family-mono);
}

.step-dot:hover {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
}

.step-dot--active {
  background: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  color: white;
}

.step-number {
  font-weight: 600;
}

.progress-bar {
  width: 100%;
  max-width: 20rem;
  height: 0.25rem;
  background: var(--vp-c-divider);
  border-radius: 0.125rem;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--vp-c-brand-1);
  border-radius: 0.125rem;
  transition: width 0.3s ease;
}

/* Mobile Responsive */
@media (max-width: 768px) {
  .nav-buttons {
    width: 100%;
    justify-content: space-between;
  }

  .nav-button {
    flex: 1;
    justify-content: center;
    max-width: 8rem;
  }

  .step-indicators {
    flex-wrap: wrap;
    justify-content: center;
  }

  .step-dot {
    width: 1.8rem;
    height: 1.8rem;
    font-size: 0.75rem;
  }
}
</style>
