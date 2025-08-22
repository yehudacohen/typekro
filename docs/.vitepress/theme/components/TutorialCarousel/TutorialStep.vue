<template>
  <div class="tutorial-step" :class="{ 'step--mobile': isMobile }">
    <!-- Step Header -->
    <div class="step-header">
      <div class="step-meta">
        <span class="step-counter">Step {{ stepNumber }} of {{ totalSteps }}</span>
        <h3 class="step-title">{{ step.title }}</h3>
      </div>
      <p class="step-description">{{ step.description }}</p>
    </div>

    <!-- Main Content Layout -->
    <div class="step-content">
      <!-- Multiple Code Blocks -->
      <div v-if="step.codeBlocks && step.codeBlocks.length > 0" class="code-section">
        <div v-for="(block, index) in step.codeBlocks" :key="index" class="code-block-container">
          <h4 v-if="block.title" class="code-block-title">{{ block.title }}</h4>
          <div class="code-wrapper">
            <div class="code-header">
              <span class="code-language">{{ block.example.language }}</span>
              <button 
                class="copy-button"
                @click="copyBlockCode(block.example.code)"
                :aria-label="'Copy code to clipboard'"
              >
                <svg v-if="!copied" class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                <svg v-else class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <polyline points="20,6 9,17 4,12"></polyline>
                </svg>
                {{ copied ? 'Copied!' : 'Copy' }}
              </button>
            </div>
            <pre class="code-block"><code :class="`language-${block.example.language}`" v-html="highlightCode(block.example.code, block.example.language)"></code></pre>
          </div>
        </div>
      </div>
      
      <!-- Single Code Example (fallback) -->
      <div v-else-if="step.codeExample" class="code-section">
        <div class="code-header">
          <span class="code-language">{{ step.codeExample.language }}</span>
          <button 
            class="copy-button"
            @click="copyCode"
            :aria-label="'Copy code to clipboard'"
          >
            <svg v-if="!copied" class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <svg v-else class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <polyline points="20,6 9,17 4,12"></polyline>
            </svg>
            {{ copied ? 'Copied!' : 'Copy' }}
          </button>
        </div>
        <pre class="code-block"><code :class="`language-${step.codeExample.language}`" v-html="highlightedCode"></code></pre>
      </div>

      <!-- Explanation -->
      <div class="explanation-section">
        <div class="explanation-content">
          <p class="explanation-text">{{ step.explanation }}</p>
          
          <!-- Highlights -->
          <div v-if="step.highlights && step.highlights.length > 0" class="highlights">
            <h4 class="highlights-title">Key Features:</h4>
            <ul class="highlights-list">
              <li v-for="highlight in step.highlights" :key="highlight" class="highlight-item">
                {{ highlight }}
              </li>
            </ul>
          </div>

          <!-- Call to Action Buttons -->
          <div v-if="step.nextSteps && step.nextSteps.length > 0" class="next-steps">
            <button
              v-for="action in step.nextSteps"
              :key="action.text"
              class="next-step-button"
              :class="`next-step-button--${action.type}`"
              @click="$emit('callToAction', action)"
            >
              {{ action.text }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import type { TutorialStep, CallToAction } from './types';
import { usePrismHighlighting } from './composables/usePrismHighlighting';

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

// Refs
const copied = ref(false);
const isMobile = ref(false);

// Prism highlighting
const { highlightCode, isLoaded } = usePrismHighlighting();

// Computed
const highlightedCode = computed(() => {
  if (props.step.codeExample) {
    return highlightCode(props.step.codeExample.code, props.step.codeExample.language);
  }
  return '';
});

// Methods
const copyCode = async () => {
  if (!props.step.codeExample) return;
  try {
    await navigator.clipboard.writeText(props.step.codeExample.code);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch (err) {
    console.error('Failed to copy code:', err);
  }
};

const copyBlockCode = async (code: string) => {
  try {
    await navigator.clipboard.writeText(code);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch (err) {
    console.error('Failed to copy code:', err);
  }
};

const checkMobile = () => {
  isMobile.value = window.innerWidth < 768;
};

// Lifecycle
onMounted(() => {
  checkMobile();
  window.addEventListener('resize', checkMobile);
});
</script>

<style scoped>
.tutorial-step {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  height: 100%;
  width: 100%;
  overflow: hidden;
}

.step-header {
  text-align: left;
}

.step-meta {
  margin-bottom: 0.5rem;
}

.step-counter {
  display: inline-block;
  padding: 0.25rem 0.75rem;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand);
  border-radius: 1rem;
  font-size: 0.875rem;
  font-weight: 500;
  margin-bottom: 0.5rem;
}

.step-title {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--vp-c-text-1);
  margin: 0;
}

.step-description {
  font-size: 1rem;
  color: var(--vp-c-text-2);
  margin: 0;
}

.step-content {
  display: grid;
  grid-template-columns: 1.6fr 1fr;
  gap: 2.5rem;
  flex: 1;
  height: 100%;
  min-height: 500px;
  max-height: 500px;
  overflow: hidden;
}

.code-section {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 500px;
  max-height: 450px;
  overflow-y: auto;
}

.code-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  background: var(--vp-c-bg-soft);
  border-radius: 0.5rem 0.5rem 0 0;
  border-bottom: 1px solid var(--vp-c-divider);
}

.code-language {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--vp-c-text-2);
  text-transform: uppercase;
}

.copy-button {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.5rem;
  background: transparent;
  border: 1px solid var(--vp-c-divider);
  border-radius: 0.25rem;
  color: var(--vp-c-text-2);
  cursor: pointer;
  font-size: 0.75rem;
  transition: all 0.2s ease;
}

.copy-button:hover {
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
}

.copy-icon {
  width: 0.875rem;
  height: 0.875rem;
}

.code-block {
  flex: 1;
  margin: 0;
  padding: 1rem;
  background: var(--vp-c-bg-soft);
  border-radius: 0 0 0.5rem 0.5rem;
  overflow-x: auto;
  font-family: var(--vp-font-family-mono);
  font-size: 0.875rem;
  line-height: 1.5;
}

.code-block code {
  color: var(--vp-c-text-1);
}

/* Enhanced code styling with Prism.js integration */
.code-block {
  position: relative;
  border-radius: 0 0 0.5rem 0.5rem;
  overflow-x: auto;
  overflow-y: auto;
  flex: 1;
  height: 100%;
  min-height: 420px;
  max-height: 420px;
  background: #2d2d2d !important;
  border: 1px solid #404040;
  margin: 0;
  padding: 1rem;
  font-family: 'Fira Code', 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', 'Source Code Pro', monospace;
  font-size: 0.875rem;
  line-height: 1.7;
  tab-size: 2;
}

.code-block code {
  display: block;
  white-space: pre;
  word-wrap: break-word;
  color: #ccc;
  background: transparent;
  padding: 0;
  margin: 0;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
}

/* Override Prism.js default styles to match our theme */
.code-block :deep(.token.comment),
.code-block :deep(.token.prolog),
.code-block :deep(.token.doctype),
.code-block :deep(.token.cdata) {
  color: #999;
  font-style: italic;
}

.code-block :deep(.token.punctuation) {
  color: #ccc;
}

.code-block :deep(.token.property),
.code-block :deep(.token.tag),
.code-block :deep(.token.boolean),
.code-block :deep(.token.number),
.code-block :deep(.token.constant),
.code-block :deep(.token.symbol),
.code-block :deep(.token.deleted) {
  color: #f92672;
}

.code-block :deep(.token.selector),
.code-block :deep(.token.attr-name),
.code-block :deep(.token.string),
.code-block :deep(.token.char),
.code-block :deep(.token.builtin),
.code-block :deep(.token.inserted) {
  color: #a6e22e;
}

.code-block :deep(.token.operator),
.code-block :deep(.token.entity),
.code-block :deep(.token.url),
.code-block :deep(.language-css .token.string),
.code-block :deep(.style .token.string) {
  color: #f8f8f2;
}

.code-block :deep(.token.atrule),
.code-block :deep(.token.attr-value),
.code-block :deep(.token.keyword) {
  color: #66d9ef;
}

.code-block :deep(.token.function),
.code-block :deep(.token.class-name) {
  color: #e6db74;
}

.code-block :deep(.token.regex),
.code-block :deep(.token.important),
.code-block :deep(.token.variable) {
  color: #fd971f;
}

/* Light theme overrides */
.light .code-block {
  background: #f8f8f8 !important;
  border: 1px solid #e1e4e8;
}

.light .code-block code {
  color: #24292e;
}

.light .code-block :deep(.token.comment),
.light .code-block :deep(.token.prolog),
.light .code-block :deep(.token.doctype),
.light .code-block :deep(.token.cdata) {
  color: #6a737d;
}

.light .code-block :deep(.token.punctuation) {
  color: #24292e;
}

.light .code-block :deep(.token.property),
.light .code-block :deep(.token.tag),
.light .code-block :deep(.token.boolean),
.light .code-block :deep(.token.number),
.light .code-block :deep(.token.constant),
.light .code-block :deep(.token.symbol),
.light .code-block :deep(.token.deleted) {
  color: #d73a49;
}

.light .code-block :deep(.token.selector),
.light .code-block :deep(.token.attr-name),
.light .code-block :deep(.token.string),
.light .code-block :deep(.token.char),
.light .code-block :deep(.token.builtin),
.light .code-block :deep(.token.inserted) {
  color: #032f62;
}

.light .code-block :deep(.token.operator),
.light .code-block :deep(.token.entity),
.light .code-block :deep(.token.url),
.light .code-block :deep(.language-css .token.string),
.light .code-block :deep(.style .token.string) {
  color: #24292e;
}

.light .code-block :deep(.token.atrule),
.light .code-block :deep(.token.attr-value),
.light .code-block :deep(.token.keyword) {
  color: #d73a49;
}

.light .code-block :deep(.token.function),
.light .code-block :deep(.token.class-name) {
  color: #6f42c1;
}

.light .code-block :deep(.token.regex),
.light .code-block :deep(.token.important),
.light .code-block :deep(.token.variable) {
  color: #e36209;
}

/* Better scrollbar styling */
.code-block::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.code-block::-webkit-scrollbar-track {
  background: transparent;
}

.code-block::-webkit-scrollbar-thumb {
  background: var(--vp-c-divider);
  border-radius: 3px;
}

.code-block::-webkit-scrollbar-thumb:hover {
  background: var(--vp-c-text-3);
}

/* Responsive adjustments */
@media (max-width: 768px) {
  .code-block {
    max-height: 300px;
    font-size: 0.8rem;
    line-height: 1.5;
  }
}

.explanation-section {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 500px;
  max-height: 500px;
  overflow-y: auto;
}

.explanation-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.explanation-text {
  color: var(--vp-c-text-1);
  line-height: 1.6;
  margin: 0;
}

.highlights {
  padding: 1rem;
  background: var(--vp-c-bg-soft);
  border-radius: 0.5rem;
  border-left: 4px solid var(--vp-c-brand);
}

.highlights-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--vp-c-text-1);
  margin: 0 0 0.5rem 0;
}

.highlights-list {
  margin: 0;
  padding-left: 1rem;
}

.highlight-item {
  color: var(--vp-c-text-2);
  font-size: 0.875rem;
  margin-bottom: 0.25rem;
}

.next-steps {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-top: auto;
}

.next-step-button {
  padding: 0.5rem 1rem;
  border-radius: 0.375rem;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  border: none;
  text-decoration: none;
}

.next-step-button--primary {
  background: var(--vp-c-brand);
  color: var(--vp-c-bg);
}

.next-step-button--primary:hover {
  background: var(--vp-c-brand-darker, #1e40af);
  color: white;
  transform: translateY(-1px);
}

.next-step-button--secondary {
  background: transparent;
  color: var(--vp-c-brand);
  border: 1px solid var(--vp-c-brand);
}

.next-step-button--secondary:hover {
  background: var(--vp-c-brand-soft);
}

/* Mobile Layout */
.step--mobile .step-content {
  grid-template-columns: 1fr;
  gap: 1.5rem;
  min-height: 500px;
  max-height: 500px;
}

.step--mobile .code-section {
  min-height: 250px;
  max-height: 250px;
  overflow-y: auto;
}

.step--mobile .explanation-section {
  min-height: 200px;
  max-height: 200px;
}

.step--mobile .code-block {
  min-height: 200px;
  max-height: 200px;
}

.step--mobile .step-title {
  font-size: 1.25rem;
}

.step--mobile .next-steps {
  justify-content: center;
}

@media (max-width: 768px) {
  .step-content {
    grid-template-columns: 1fr;
    gap: 1.5rem;
    min-height: 500px;
    max-height: 500px;
  }

  .code-section {
    min-height: 250px;
    max-height: 250px;
    overflow-y: auto;
  }

  .explanation-section {
    min-height: 200px;
    max-height: 200px;
  }

  .code-block {
    min-height: 200px;
    max-height: 200px;
    font-size: 0.8rem;
  }

  .step-title {
    font-size: 1.25rem;
  }

  .next-steps {
    justify-content: center;
  }

  .next-step-button {
    flex: 1;
    min-width: 120px;
  }
}

/* Multiple Code Blocks Styling */
.code-block-container {
  margin-bottom: 1.5rem;
}

.code-block-container:last-child {
  margin-bottom: 0;
}

.code-block-title {
  color: var(--vp-c-text-1);
  font-size: 1rem;
  font-weight: 600;
  margin: 0 0 0.5rem 0;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--vp-c-divider-light);
}

.code-wrapper {
  background: var(--vp-c-bg-soft);
  border-radius: 0.5rem;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
}

.code-wrapper .code-block {
  margin: 0;
  min-height: auto;
  max-height: 200px;
  overflow-y: auto;
}

/* Mobile adjustments for multiple blocks */
.step--mobile .code-block-container {
  margin-bottom: 1rem;
}

.step--mobile .code-block-title {
  font-size: 0.9rem;
}

.step--mobile .code-wrapper .code-block {
  max-height: 150px;
  font-size: 0.75rem;
}


/* Multiple Code Blocks Styling */
.code-block-container {
  margin-bottom: 1.5rem;
}

.code-block-container:last-child {
  margin-bottom: 0;
}

.code-block-title {
  color: var(--vp-c-text-1);
  font-size: 1rem;
  font-weight: 600;
  margin: 0 0 0.5rem 0;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--vp-c-divider-light);
}

.code-wrapper {
  background: var(--vp-c-bg-soft);
  border-radius: 0.5rem;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
}

.code-wrapper .code-block {
  margin: 0;
  min-height: auto;
  max-height: 200px;
  overflow-y: auto;
}

/* Multiple Code Blocks Styling */
.code-block-container {
  margin-bottom: 1.5rem;
}

.code-block-container:last-child {
  margin-bottom: 0;
}

.code-block-title {
  color: var(--vp-c-text-1);
  font-size: 1rem;
  font-weight: 600;
  margin: 0 0 0.5rem 0;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--vp-c-divider-light);
}

.code-wrapper {
  background: var(--vp-c-bg-soft);
  border-radius: 0.5rem;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
}

.code-wrapper .code-block {
  margin: 0;
  min-height: auto;
  max-height: 200px;
  overflow-y: auto;
}

/* Mobile adjustments for multiple blocks */
.step--mobile .code-block-container {
  margin-bottom: 1rem;
}

.step--mobile .code-block-title {
  font-size: 0.9rem;
}

.step--mobile .code-wrapper .code-block {
  max-height: 150px;
  font-size: 0.75rem;
}
</style>
