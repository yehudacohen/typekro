<template>
  <div class="tutorial-section">
    <!-- Simple title like other sections -->
    <h2 class="section-title">Using TypeKro</h2>
    
    <!-- Content without any container styling -->
    <TutorialTransition :direction="state.direction">
      <TutorialStep
        :key="currentStepData.id"
        :step="currentStepData"
        :step-number="state.currentStep + 1"
        :total-steps="state.totalSteps"
        @call-to-action="handleCallToAction"
      />
    </TutorialTransition>

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

// Event handlers
const handleCallToAction = (action: CallToAction) => {
  if (action.url.startsWith('/')) {
    window.location.href = action.url;
  } else {
    window.open(action.url, '_blank', 'noopener,noreferrer');
  }
};

// Responsive handling
const checkMobile = () => {
  isMobile.value = window.innerWidth < 768;
};

onMounted(() => {
  checkMobile();
  window.addEventListener('resize', checkMobile);
});

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile);
});

// Expose methods
defineExpose({
  goToStep,
  nextStep,
  previousStep,
  reset,
});
</script>

<style scoped>
/* Simple section styling like rest of site */
.tutorial-section {
  margin: 2rem 0;
  padding: 0 4rem;
  background: transparent;
}

.section-title {
  line-height: 1.2;
  padding: 1rem 0;
  font-size: 2rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
  margin-bottom: 1rem;
  text-align: center;
  font-family: var(--vp-font-family-mono);
}

@media (max-width: 768px) {
  .tutorial-section {
    margin: 2rem 0; padding: 0 2rem;
  }
  
  .section-title {
  line-height: 1.2;
  padding: 1rem 0;
    font-size: 1.5rem;
    margin-bottom: 1.5rem;
  }
}
</style>
