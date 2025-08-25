<template>
  <div :class="['theme-wrapper', { 'dark': isDark }]">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch, provide } from 'vue'

const isDark = ref(false)

const toggleTheme = () => {
  isDark.value = !isDark.value
}

onMounted(() => {
  const savedTheme = localStorage.getItem('typekro-theme')
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  isDark.value = savedTheme === 'dark' || (!savedTheme && prefersDark)
  
  document.documentElement.classList.toggle('dark', isDark.value)
  document.body.classList.toggle('dark', isDark.value)
})

watch(isDark, (newValue) => {
  localStorage.setItem('typekro-theme', newValue ? 'dark' : 'light')
  document.documentElement.classList.toggle('dark', newValue)
  document.body.classList.toggle('dark', newValue)
})

// Provide theme state and functions to child components
provide('isDark', isDark)
provide('toggleTheme', toggleTheme)
</script>

<style>
.theme-wrapper {
  min-height: 100vh;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  transition: background-color 0.3s ease, color 0.3s ease;
}
</style>
