<template>
  <transition
    :name="transitionName"
    mode="out-in"
    @before-enter="onBeforeEnter"
    @enter="onEnter"
    @leave="onLeave"
  >
    <slot />
  </transition>
</template>

<script setup lang="ts">
import { computed } from 'vue';

interface Props {
  direction: 'forward' | 'backward';
  duration?: number;
}

const props = withDefaults(defineProps<Props>(), {
  duration: 300
});

const transitionName = computed(() => {
  return props.direction === 'forward' ? 'slide-left' : 'slide-right';
});

const onBeforeEnter = (el: Element) => {
  const element = el as HTMLElement;
  element.style.opacity = '0';
  element.style.transform = props.direction === 'forward' 
    ? 'translateX(30px)' 
    : 'translateX(-30px)';
};

const onEnter = (el: Element, done: () => void) => {
  const element = el as HTMLElement;
  
  // Force reflow
  element.offsetHeight;
  
  element.style.transition = `all ${props.duration}ms ease-out`;
  element.style.opacity = '1';
  element.style.transform = 'translateX(0)';
  
  setTimeout(done, props.duration);
};

const onLeave = (el: Element, done: () => void) => {
  const element = el as HTMLElement;
  
  element.style.transition = `all ${props.duration}ms ease-out`;
  element.style.opacity = '0';
  element.style.transform = props.direction === 'forward' 
    ? 'translateX(-30px)' 
    : 'translateX(30px)';
  
  setTimeout(done, props.duration);
};
</script>

<style scoped>
/* Fallback CSS transitions for browsers that don't support the JS transitions */
.slide-left-enter-active,
.slide-left-leave-active,
.slide-right-enter-active,
.slide-right-leave-active {
  transition: all 0.3s ease-out;
}

.slide-left-enter-from {
  opacity: 0;
  transform: translateX(30px);
}

.slide-left-leave-to {
  opacity: 0;
  transform: translateX(-30px);
}

.slide-right-enter-from {
  opacity: 0;
  transform: translateX(-30px);
}

.slide-right-leave-to {
  opacity: 0;
  transform: translateX(30px);
}

.slide-left-enter-to,
.slide-right-enter-to {
  opacity: 1;
  transform: translateX(0);
}
</style>