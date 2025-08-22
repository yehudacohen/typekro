<template>
  <div 
    ref="carouselElement"
    class="tutorial-carousel"
    :class="{ 'carousel--mobile': isMobile }"
    role="region"
    aria-label="Interactive TypeKro Tutorial"
  >
    <!-- Header -->
    <div class="carousel-header">
      <h2 class="carousel-title">Using TypeKro</h2>
    </div>

    <!-- Main Content -->
    <div class="carousel-content">
      <TutorialTransition :direction="state.direction">
        <TutorialStep
          :key="currentStepData.id"
          :step="currentStepData"
          :step-number="state.currentStep + 1"
          :total-steps="state.totalSteps"
          @call-to-action="handleCallToAction"
        />
      </TutorialTransition>
    </div>

    <!-- Navigation -->
    <NavigationControls
      :steps="steps"
      :current-step="state.currentStep"
      :is-first-step="isFirstStep"
      :is-last-step="isLastStep"
      :progress="progress"
      :show-progress="showProgress"
      @previous="previousStep"
      @next="nextStep"
      @go-to-step="goToStep"
    />

    <!-- Completion Message -->
    <div v-if="isLastStep && showCompletionMessage" class="completion-message">
      <h3>🎉 Tutorial Complete!</h3>
      <p>You've learned the complete TypeKro workflow. Ready to build something amazing?</p>
      <div class="completion-actions">
        <a href="/guide/getting-started" class="cta-button cta-button--primary">
          Install TypeKro
        </a>
        <button @click="reset" class="cta-button cta-button--secondary">
          Restart Tutorial
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import TutorialStep from './TutorialStep.vue';
import NavigationControls from './NavigationControls.vue';
import TutorialTransition from './TutorialTransition.vue';
import { useCarouselState } from './composables/useCarouselState';
import { useKeyboardNavigation } from './composables/useKeyboardNavigation';
import { useSwipeNavigation } from './composables/useSwipeNavigation';
import { useStepValidation } from './composables/useStepValidation';
import { tutorialSteps } from './tutorialData';
import type { TutorialCarouselProps, CallToAction } from './types';

interface Props extends TutorialCarouselProps {
  showCompletionMessage?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  autoPlay: false,
  showProgress: true,
  enableSwipe: true,
  showCompletionMessage: true,
});

// Refs
const carouselElement = ref<HTMLElement | null>(null);

// Validation
const { validateSteps } = useStepValidation();
const validation = validateSteps(tutorialSteps);

if (!validation.isValid) {
  console.error('Tutorial validation failed:', validation.errors);
}

// State management
const {
  state,
  currentStepData,
  isFirstStep,
  isLastStep,
  progress,
  goToStep,
  nextStep,
  previousStep,
  startAutoPlay,
  stopAutoPlay,
  reset,
  trackCompletion,
} = useCarouselState(tutorialSteps);

// Computed properties
const steps = computed(() => tutorialSteps);
const isMobile = ref(false);

// Navigation
useKeyboardNavigation(nextStep, previousStep, true);
useSwipeNavigation(carouselElement, nextStep, previousStep, props.enableSwipe);

// Auto-play functionality
let autoPlayCleanup: (() => void) | null = null;

const startTutorialAutoPlay = () => {
  if (props.autoPlay && !autoPlayCleanup) {
    autoPlayCleanup = startAutoPlay(5000);
  }
};

const stopTutorialAutoPlay = () => {
  if (autoPlayCleanup) {
    autoPlayCleanup();
    autoPlayCleanup = null;
  }
  stopAutoPlay();
};

// Event handlers
const handleCallToAction = (action: CallToAction) => {
  // Track CTA click
  if (typeof window !== 'undefined' && (window as any).gtag) {
    (window as any).gtag('event', 'tutorial_cta_click', {
      event_category: 'tutorial',
      event_label: action.text,
      step_id: currentStepData.value.id,
    });
  }

  // Handle navigation
  if (action.url.startsWith('/')) {
    // Internal link - use router if available
    window.location.href = action.url;
  } else {
    // External link
    window.open(action.url, '_blank', 'noopener,noreferrer');
  }
};

// Responsive handling
const checkMobile = () => {
  isMobile.value = window.innerWidth < 768;
};

const handleResize = () => {
  checkMobile();
};

// Lifecycle
onMounted(() => {
  checkMobile();
  window.addEventListener('resize', handleResize);

  if (props.autoPlay) {
    startTutorialAutoPlay();
  }

  // Track tutorial start
  if (typeof window !== 'undefined' && (window as any).gtag) {
    (window as any).gtag('event', 'tutorial_started', {
      event_category: 'tutorial',
    });
  }
});

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
  stopTutorialAutoPlay();
});

// Watch for completion
const handleStepChange = () => {
  if (isLastStep.value) {
    trackCompletion();
    stopTutorialAutoPlay();
  }
};

// Expose methods for parent components
defineExpose({
  goToStep,
  nextStep,
  previousStep,
  reset,
  startAutoPlay: startTutorialAutoPlay,
  stopAutoPlay: stopTutorialAutoPlay,
});
</script>

<style scoped>
.tutorial-carousel {
  width: 98%;
  max-width: 1400px;
  min-width: 900px;
  margin: 0 auto;
  padding: 2.5rem;
  background: var(--vp-c-bg);
  border-radius: 1rem;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
}

.carousel-header {
  text-align: center;
  margin-bottom: 2rem;
}



.carousel-title {
  font-size: 2rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
  margin-bottom: 0.5rem;
  text-align: center;
}

.carousel-subtitle {
  font-size: 1.125rem;
  color: var(--vp-c-text-2);
  margin: 0;
}

.carousel-content {
  height: 650px;
  min-height: 650px;
  margin-bottom: 2rem;
  overflow: hidden;
}

.completion-message {
  text-align: center;
  padding: 2rem;
  background: var(--vp-c-bg-soft);
  border-radius: 0.5rem;
  margin-top: 2rem;
}

.completion-message h3 {
  font-size: 1.5rem;
  color: var(--vp-c-text-1);
  margin-bottom: 0.5rem;
}

.completion-message p {
  color: var(--vp-c-text-2);
  margin-bottom: 1.5rem;
}

.completion-actions {
  display: flex;
  gap: 1rem;
  justify-content: center;
  flex-wrap: wrap;
}

.cta-button {
  padding: 0.75rem 1.5rem;
  border-radius: 0.5rem;
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
  transition: all 0.2s ease;
  border: none;
  font-size: 1rem;
}

.cta-button--primary {
  background: var(--vp-c-brand);
  color: var(--vp-c-bg);
}

.cta-button--primary:hover {
  background: var(--vp-c-brand-darker, #1e40af); color: white;
  transform: translateY(-1px);
}

.cta-button--secondary {
  background: transparent;
  color: var(--vp-c-brand);
  border: 2px solid var(--vp-c-brand);
}

.cta-button--secondary:hover {
  background: var(--vp-c-brand);
  color: var(--vp-c-bg);
}

/* Mobile Responsive */
.carousel--mobile {
  padding: 1rem;
  min-width: 320px;
  width: 98%;
}

.carousel--mobile .carousel-title {
  font-size: 1.5rem;
}

.carousel--mobile .carousel-subtitle {
  font-size: 1rem;
}

.carousel--mobile .carousel-content {
  height: 550px;
  min-height: 550px;
}

.carousel--mobile .completion-actions {
  flex-direction: column;
  align-items: center;
}

.carousel--mobile .cta-button {
  width: 100%;
  max-width: 200px;
}

@media (max-width: 768px) {
  .tutorial-carousel {
    padding: 1rem;
    border-radius: 0.5rem;
    min-width: 320px;
    width: 98%;
  }

  .carousel-header {
    margin-bottom: 1.5rem;
  }

  .carousel-content {
    height: 550px;
    min-height: 550px;
    margin-bottom: 1.5rem;
  }
}
</style>