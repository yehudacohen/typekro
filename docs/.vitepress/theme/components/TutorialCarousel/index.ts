// TutorialCarousel component exports
export { default as TutorialCarousel } from './TutorialCarousel.vue';
export { default as TutorialStep } from './TutorialStep.vue';
export { default as NavigationControls } from './NavigationControls.vue';
export { default as TutorialTransition } from './TutorialTransition.vue';

// Data and configuration
export { tutorialSteps, tutorialConfig } from './tutorialData';

// Types
export * from './types';

// Composables
export { useCarouselState } from './composables/useCarouselState';
export { useKeyboardNavigation } from './composables/useKeyboardNavigation';
export { useSwipeNavigation } from './composables/useSwipeNavigation';
export { useStepValidation } from './composables/useStepValidation';
export { usePrismHighlighting } from './composables/usePrismHighlighting';