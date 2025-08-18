import { ref, computed, reactive } from 'vue';
import type { CarouselState, TutorialStep } from '../types';

export function useCarouselState(steps: TutorialStep[]) {
  const state = reactive<CarouselState>({
    currentStep: 0,
    totalSteps: steps.length,
    isPlaying: false,
    direction: 'forward'
  });

  const currentStepData = computed(() => steps[state.currentStep]);
  const isFirstStep = computed(() => state.currentStep === 0);
  const isLastStep = computed(() => state.currentStep === state.totalSteps - 1);
  const progress = computed(() => ((state.currentStep + 1) / state.totalSteps) * 100);

  const goToStep = (stepIndex: number) => {
    if (stepIndex < 0 || stepIndex >= state.totalSteps) return;
    
    state.direction = stepIndex > state.currentStep ? 'forward' : 'backward';
    state.currentStep = stepIndex;
    
    // Track step view for analytics
    trackStepView(stepIndex);
  };

  const nextStep = () => {
    if (!isLastStep.value) {
      goToStep(state.currentStep + 1);
    }
  };

  const previousStep = () => {
    if (!isFirstStep.value) {
      goToStep(state.currentStep - 1);
    }
  };

  const startAutoPlay = (interval: number = 5000) => {
    if (state.isPlaying) return;
    
    state.isPlaying = true;
    const autoPlayInterval = setInterval(() => {
      if (isLastStep.value) {
        stopAutoPlay();
        return;
      }
      nextStep();
    }, interval);

    // Return cleanup function
    return () => {
      clearInterval(autoPlayInterval);
      state.isPlaying = false;
    };
  };

  const stopAutoPlay = () => {
    state.isPlaying = false;
  };

  const reset = () => {
    state.currentStep = 0;
    state.direction = 'forward';
    state.isPlaying = false;
  };

  // Analytics tracking
  const trackStepView = (stepIndex: number) => {
    if (typeof window !== 'undefined' && (window as any).gtag) {
      (window as any).gtag('event', 'tutorial_step_view', {
        event_category: 'tutorial',
        event_label: `step_${stepIndex + 1}`,
        step_id: steps[stepIndex]?.id
      });
    }
  };

  const trackCompletion = () => {
    if (typeof window !== 'undefined' && (window as any).gtag) {
      (window as any).gtag('event', 'tutorial_completed', {
        event_category: 'tutorial',
        total_steps: state.totalSteps
      });
    }
  };

  const trackDropoff = (stepIndex: number) => {
    if (typeof window !== 'undefined' && (window as any).gtag) {
      (window as any).gtag('event', 'tutorial_dropoff', {
        event_category: 'tutorial',
        event_label: `step_${stepIndex + 1}`,
        step_id: steps[stepIndex]?.id
      });
    }
  };

  return {
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
    trackDropoff
  };
}