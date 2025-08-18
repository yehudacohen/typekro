import { ref, onMounted, onUnmounted, type Ref } from 'vue';

export function useSwipeNavigation(
  element: Ref<HTMLElement | null>,
  nextStep: () => void,
  previousStep: () => void,
  enabled: boolean = true
) {
  const startX = ref(0);
  const startY = ref(0);
  const endX = ref(0);
  const endY = ref(0);
  const isSwipeActive = ref(false);

  const minSwipeDistance = 50; // Minimum distance for a swipe
  const maxVerticalDistance = 100; // Maximum vertical movement to still count as horizontal swipe

  const handleTouchStart = (event: TouchEvent) => {
    if (!enabled || !element.value) return;

    const touch = event.touches[0];
    startX.value = touch.clientX;
    startY.value = touch.clientY;
    isSwipeActive.value = true;
  };

  const handleTouchMove = (event: TouchEvent) => {
    if (!enabled || !isSwipeActive.value) return;

    // Prevent default scrolling behavior during swipe
    const touch = event.touches[0];
    const deltaX = Math.abs(touch.clientX - startX.value);
    const deltaY = Math.abs(touch.clientY - startY.value);

    // If horizontal movement is greater than vertical, prevent scrolling
    if (deltaX > deltaY) {
      event.preventDefault();
    }
  };

  const handleTouchEnd = (event: TouchEvent) => {
    if (!enabled || !isSwipeActive.value) return;

    const touch = event.changedTouches[0];
    endX.value = touch.clientX;
    endY.value = touch.clientY;

    const deltaX = endX.value - startX.value;
    const deltaY = Math.abs(endY.value - startY.value);

    // Check if it's a valid horizontal swipe
    if (Math.abs(deltaX) >= minSwipeDistance && deltaY <= maxVerticalDistance) {
      if (deltaX > 0) {
        // Swipe right - go to previous step
        previousStep();
      } else {
        // Swipe left - go to next step
        nextStep();
      }
    }

    isSwipeActive.value = false;
  };

  const setupSwipeListeners = () => {
    if (!element.value || !enabled) return;

    element.value.addEventListener('touchstart', handleTouchStart, { passive: true });
    element.value.addEventListener('touchmove', handleTouchMove, { passive: false });
    element.value.addEventListener('touchend', handleTouchEnd, { passive: true });
  };

  const removeSwipeListeners = () => {
    if (!element.value) return;

    element.value.removeEventListener('touchstart', handleTouchStart);
    element.value.removeEventListener('touchmove', handleTouchMove);
    element.value.removeEventListener('touchend', handleTouchEnd);
  };

  onMounted(() => {
    setupSwipeListeners();
  });

  onUnmounted(() => {
    removeSwipeListeners();
  });

  return {
    setupSwipeListeners,
    removeSwipeListeners,
    isSwipeActive
  };
}