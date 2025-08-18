import { onMounted, onUnmounted } from 'vue';

export function useKeyboardNavigation(
  nextStep: () => void,
  previousStep: () => void,
  enabled: boolean = true
) {
  const handleKeydown = (event: KeyboardEvent) => {
    if (!enabled) return;

    // Only handle keyboard navigation when not in input fields
    const activeElement = document.activeElement;
    if (activeElement && (
      activeElement.tagName === 'INPUT' ||
      activeElement.tagName === 'TEXTAREA' ||
      activeElement.isContentEditable
    )) {
      return;
    }

    switch (event.key) {
      case 'ArrowRight':
      case ' ': // Space key
        event.preventDefault();
        nextStep();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        previousStep();
        break;
      case 'Home':
        event.preventDefault();
        // Could add goToStep(0) if needed
        break;
      case 'End':
        event.preventDefault();
        // Could add goToStep(totalSteps - 1) if needed
        break;
    }
  };

  onMounted(() => {
    if (enabled) {
      document.addEventListener('keydown', handleKeydown);
    }
  });

  onUnmounted(() => {
    document.removeEventListener('keydown', handleKeydown);
  });

  return {
    handleKeydown
  };
}