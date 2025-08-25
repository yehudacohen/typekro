<template>
  <div class="tutorial-step">
    <!-- Step Header -->
    <div class="step-header">
      <span class="step-counter">Step {{ stepNumber }} of {{ totalSteps }}</span>
      <h3 class="step-title">{{ step.title }}</h3>
      <p class="step-description">{{ step.description }}</p>
    </div>

    <!-- Content Layout -->
    <div class="step-content">
      <!-- Code Section -->
      <div class="step-code">
        <!-- Single Code Example -->
        <div v-if="step.codeExample" class="code-container">
          <div v-html="singleHighlightedCode"></div>
        </div>
        
        <!-- Multiple Code Blocks (Sequential) -->
        <div v-else-if="step.codeBlocks && step.codeBlocks.length > 0" class="code-blocks-container">
          <div 
            v-for="(block, index) in step.codeBlocks"
            :key="index"
            class="code-block-item"
          >
            <h4 class="code-block-title">{{ block.title }}</h4>
            <div class="code-container">
              <div v-html="getHighlightedCodeForBlock(index)"></div>
            </div>
            <div v-if="block.example.highlights && block.example.highlights.length > 0" class="block-highlights">
              <ul>
                <li v-for="highlight in block.example.highlights" :key="highlight">{{ highlight }}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Explanation Section -->
      <div class="step-explanation">
        <p class="explanation-text">{{ step.explanation }}</p>
        
        <!-- Global highlights (for single code example) -->
        <div v-if="step.highlights && step.highlights.length > 0" class="highlights">
          <h4>Key Features:</h4>
          <ul>
            <li v-for="highlight in step.highlights" :key="highlight">{{ highlight }}</li>
          </ul>
        </div>

        <!-- Call to Action Buttons -->
        <div v-if="step.nextSteps && step.nextSteps.length > 0" class="next-steps">
          <button
            v-for="action in step.nextSteps"
            :key="action.text"
            class="VPButton medium brand"
            @click="$emit('callToAction', action)"
          >
            {{ action.text }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { codeToHtml } from 'shiki';
import type { TutorialStep, CallToAction } from './types';

interface Props {
  step: TutorialStep;
  stepNumber: number;
  totalSteps: number;
}

interface Emits {
  (e: 'callToAction', action: CallToAction): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const singleHighlightedCode = ref('');
const multipleHighlightedCodes = ref<string[]>([]);

// Highlight single code example
const highlightSingleCode = async () => {
  if (props.step.codeExample) {
    try {
      const html = await codeToHtml(props.step.codeExample.code, {
        lang: props.step.codeExample.language,
        themes: {
          light: 'github-light',
          dark: 'github-dark',
        },
      });
      singleHighlightedCode.value = html;
    } catch (error) {
      console.error('Syntax highlighting failed:', error);
      singleHighlightedCode.value = `<pre class="fallback-code"><code>${props.step.codeExample.code}</code></pre>`;
    }
  }
};

// Highlight multiple code blocks
const highlightMultipleCode = async () => {
  if (props.step.codeBlocks && props.step.codeBlocks.length > 0) {
    const highlighted: string[] = [];

    for (let i = 0; i < props.step.codeBlocks.length; i++) {
      const block = props.step.codeBlocks[i];
      try {
        const html = await codeToHtml(block.example.code, {
          lang: block.example.language,
          themes: {
            light: 'github-light',
            dark: 'github-dark',
          },
        });
        highlighted[i] = html;
      } catch (error) {
        console.error('Syntax highlighting failed for block', i, error);
        highlighted[i] = `<pre class="fallback-code"><code>${block.example.code}</code></pre>`;
      }
    }

    multipleHighlightedCodes.value = highlighted;
  }
};

// Get highlighted code for a specific block
const getHighlightedCodeForBlock = (index: number) => {
  return multipleHighlightedCodes.value[index] || '';
};

onMounted(async () => {
  await Promise.all([highlightSingleCode(), highlightMultipleCode()]);
});
</script>

<style scoped>
.tutorial-step {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  margin-bottom: 1rem;
}

.step-header {
  text-align: left;
}

.step-counter {
  display: inline-block;
  padding: 0.25rem 0.75rem;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  border-radius: 1rem;
  font-size: 0.875rem;
  font-weight: 500;
  margin-bottom: 1rem;
  font-family: var(--vp-font-family-mono);
}

.step-title {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--vp-c-text-1);
  margin-bottom: 0.5rem;
  font-family: var(--vp-font-family-mono);
}

.step-description {
  font-size: 1rem;
  color: var(--vp-c-text-2);
  margin-bottom: 0;
  font-family: var(--vp-font-family-mono);
}

.step-content {
  display: grid;
  grid-template-columns: 60% 40%; height: 450px; min-height: 450px; max-height: 450px;
  gap: 2rem;
}

.step-code {
  display: flex;
  flex-direction: column;
}

/* Sequential code blocks container */
.code-blocks-container {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  max-height: 400px;
  overflow-y: auto;
}

.code-block-item {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.code-block-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--vp-c-brand-1);
  margin: 0;
  font-family: var(--vp-font-family-mono);
}

.block-highlights {
  margin-top: 0.5rem;
}

.block-highlights ul {
  margin: 0;
  padding-left: 1rem;
  font-size: 0.8rem;
}

.block-highlights li {
  color: var(--vp-c-text-2);
  font-family: var(--vp-font-family-mono);
  margin-bottom: 0.25rem;
}

/* EXACT COPY of hero code styling */
.code-container {
  width: 100%;
  height: 400px; min-height: 400px; max-height: 400px;
  overflow-y: auto;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

/* For multiple code blocks, make containers smaller */
.code-blocks-container .code-container {
  height: auto;
  min-height: 150px;
  max-height: 200px;
}

.code-container :deep(pre) {
  margin: 0;
  padding: 1.5rem;
  font-size: 0.85rem;
  line-height: 1.4;
  border-radius: 8px;
  font-family: var(--vp-font-family-mono);
  background: var(--vp-c-bg-soft) !important;
  border: 1px solid var(--vp-c-border) !important;
}

.code-container :deep(.shiki) {
  background: var(--vp-c-bg-soft) !important;
}

.fallback-code {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  padding: 1.5rem;
  border-radius: 8px;
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
  line-height: 1.4;
  overflow-x: auto;
  border: 1px solid var(--vp-c-border);
}



.step-explanation {
  display: flex;
  flex-direction: column;
  gap: 1rem; height: 100%; min-height: 400px; max-height: 400px; overflow-y: auto;
}

.explanation-text {
  color: var(--vp-c-text-1);
  line-height: 1.6;
  margin: 0;
  font-family: var(--vp-font-family-mono);
}

.highlights {
  padding: 1rem;
  background: var(--vp-c-bg-soft);
  border-radius: 0.5rem;
  border-left: 4px solid var(--vp-c-brand-1);
}

.highlights h4 {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--vp-c-text-1);
  margin: 0 0 0.5rem 0;
  font-family: var(--vp-font-family-mono);
}

.highlights ul {
  margin: 0;
  padding-left: 1rem;
}

.highlights li {
  color: var(--vp-c-text-2);
  font-size: 0.875rem;
  margin-bottom: 0.25rem;
  font-family: var(--vp-font-family-mono);
}

.next-steps {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-top: auto;
}

/* EXACT COPY of VPButton styles from hero */
.VPButton {
  display: inline-block;
  border: 1px solid transparent;
  text-align: center;
  font-weight: 600;
  white-space: nowrap;
  transition: all 0.3s ease;
  cursor: pointer;
  text-decoration: none;
  font-family: var(--vp-font-family-mono);
}

.VPButton.medium {
  border-radius: 20px;
  padding: 0 20px;
  line-height: 38px;
  font-size: 14px;
}

.VPButton.brand {
  border-color: var(--vp-c-brand-1);
  color: white;
  background-color: var(--vp-c-brand-1);
}

.VPButton.brand:hover {
  border-color: var(--vp-c-brand-2);
  background-color: var(--vp-c-brand-2);
  transform: translateY(-2px);
}

/* Mobile Layout */
@media (max-width: 768px) {
  .step-content {
    grid-template-columns: 1fr;
    gap: 1.5rem; height: auto; min-height: auto; max-height: none;
  }
  
  .code-container {
    height: 300px; min-height: 300px; max-height: 300px;
  }
  
  .code-blocks-container .code-container {
    height: auto;
    min-height: 120px;
    max-height: 150px;
  }
  
  .step-title {
    font-size: 1.25rem;
  }
  
  .next-steps {
    justify-content: center;
  }
}
/* Dark theme code block overrides - use proper code colors, not green theme colors */
.dark .code-container :deep(pre) {
  background: #0d1117 !important;
  color: #f0f6fc !important;
  border: 1px solid #30363d !important;
}

.dark .code-container :deep(.shiki) {
  color: #f0f6fc !important;
  background: #0d1117 !important;
}

/* Dark mode syntax highlighting overrides */
.dark .code-container :deep(.shiki span) {
  color: var(--shiki-dark) !important;
}

.dark .code-container :deep(.shiki .token) {
  color: var(--shiki-dark) !important;
}

/* Force all text in dark mode code blocks to be light */
.dark .code-container :deep(pre),
.dark .code-container :deep(pre *) {
  color: #f0f6fc !important;
}

.dark .fallback-code {
  background: #0d1117 !important;
  color: #f0f6fc !important;
  border: 1px solid #30363d !important;
}
</style>