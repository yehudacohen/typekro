<template>
  <nav class="nav-header">
    <div class="nav-container">
      <!-- Logo/Brand -->
      <div class="nav-brand">
        <img src="/typekro-logo.svg" alt="TypeKro" class="nav-logo" />
        <span class="nav-title">TypeKro</span>
      </div>
      
      <!-- Navigation Links -->
      <div class="nav-links">
        <a href="#features" class="nav-link">Features</a>
        <a href="/guide/getting-started" class="nav-link" @click="navigate('/guide/getting-started', $event)">Guide</a>
        <a href="/examples/" class="nav-link" @click="navigate('/examples/', $event)">Examples</a>
        <a href="https://github.com/yehudacohen/typekro" target="_blank" class="nav-link nav-link--icon">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
          </svg>
        </a>
        <a href="https://discord.gg/typekro" target="_blank" class="nav-link nav-link--icon">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>
          </svg>
        </a>
        
        <!-- Theme Toggle -->
        <button @click="toggleTheme" class="theme-toggle" :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'">
          <svg v-if="isDark" class="theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="5"></circle>
            <line x1="12" y1="1" x2="12" y2="3"></line>
            <line x1="12" y1="21" x2="12" y2="23"></line>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
            <line x1="1" y1="12" x2="3" y2="12"></line>
            <line x1="21" y1="12" x2="23" y2="12"></line>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
          </svg>
          <svg v-else class="theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="m21 12.79c-.9.17-1.82.21-2.79.21-7.18 0-13-5.82-13-13 0-.97.04-1.89.21-2.79C3.11 1.1 1 5.85 1 12c0 6.075 4.925 11 11 11 6.15 0 10.9-2.11 12.79-4.21z"></path>
          </svg>
        </button>
      </div>
    </div>
  </nav>
</template>

<script setup lang="ts">
const navigate = (url: string, event: Event) => {
  event.preventDefault();
  window.location.href = url;
};

import { inject } from 'vue'

// Get theme functions from ThemeProvider
const toggleTheme = inject('toggleTheme') as () => void
const isDark = inject('isDark') as boolean
</script>

<style scoped>
.nav-header {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--vp-c-bg);
  border-bottom: 1px solid var(--vp-c-divider);
  backdrop-filter: blur(8px);
}

.nav-container {
  display: flex;
  align-items: center;
  justify-content: space-between;
  max-width: 1400px;
  margin: 0 auto;
  padding: 0.75rem 2rem;
}

.nav-brand {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  text-decoration: none;
}

.nav-logo {
  width: 32px;
  height: 32px;
}

.nav-title {
  font-family: var(--vp-font-family-mono);
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--vp-c-text-1);
}

.nav-links {
  display: flex;
  align-items: center;
  gap: 2rem;
}

.nav-link {
  font-family: var(--vp-font-family-mono);
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--vp-c-text-2);
  text-decoration: none;
  transition: all 0.3s ease;
  padding: 0.5rem 0;
  border-bottom: 2px solid transparent;
}

.nav-link:hover {
  color: var(--vp-c-brand-1);
  border-bottom-color: var(--vp-c-brand-1);
}

.nav-link--icon {
  padding: 0.5rem;
  border-radius: 6px;
  border-bottom: none;
}

.nav-link--icon:hover {
  background: var(--vp-c-bg-soft);
  transform: translateY(-1px);
  border-bottom: none;
}

.nav-icon {
  width: 20px;
  height: 20px;
}

.theme-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem;
  background: transparent;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: all 0.3s ease;
}

.theme-toggle:hover {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
  transform: translateY(-1px);
}

.theme-icon {
  width: 18px;
  height: 18px;
}

/* Mobile responsive */
@media (max-width: 768px) {
  .nav-container {
    padding: 0.75rem 1rem;
  }
  
  .nav-links {
    gap: 1rem;
  }
  
  .nav-link {
    font-size: 0.85rem;
  }
  
  .nav-title {
    font-size: 1.1rem;
  }
}

@media (max-width: 640px) {
  .nav-links {
    gap: 0.75rem;
  }
  
  /* Hide text links on very small screens, keep icons and theme toggle */
  .nav-link:not(.nav-link--icon):not(.theme-toggle) {
    display: none;
  }
}
</style>
