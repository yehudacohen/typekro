<template>
  <a 
    href="https://github.com/yehudacohen/typekro" 
    target="_blank" 
    rel="noopener noreferrer"
    class="github-star-button"
  >
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="star-icon">
      <path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z"/>
    </svg>
    Star on GitHub
  </a>
</template>

<script setup>
// GitHub star button component styled as hero button
</script>

<style scoped>
.github-star-button {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  border-radius: 6px;
  font-family: var(--vp-font-family-mono);
  font-weight: 600;
  text-decoration: none;
  transition: all 0.3s ease;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  border: 1px solid var(--vp-c-divider);
}

.github-star-button:hover {
  background: var(--vp-c-bg-mute);
  transform: translateY(-2px);
  text-decoration: none;
}

.star-icon {
  width: 16px;
  height: 16px;
  opacity: 0.8;
}

.github-star-button:hover .star-icon {
  opacity: 1;
}
</style>