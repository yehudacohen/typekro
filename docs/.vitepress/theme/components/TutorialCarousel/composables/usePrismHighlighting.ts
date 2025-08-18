import { ref, onMounted } from 'vue';

export function usePrismHighlighting() {
  const isLoaded = ref(false);
  const prism = ref<any>(null);

  const loadPrism = async () => {
    try {
      // Dynamic import to avoid SSR issues
      if (typeof window !== 'undefined') {
        const Prism = await import('prismjs');
        
        // Load TypeScript language support
        await import('prismjs/components/prism-typescript');
        await import('prismjs/components/prism-javascript');
        await import('prismjs/components/prism-yaml');
        await import('prismjs/components/prism-bash');
        
        prism.value = Prism.default;
        isLoaded.value = true;
      }
    } catch (error) {
      console.warn('Failed to load Prism.js:', error);
      isLoaded.value = false;
    }
  };

  const highlightCode = (code: string, language: string): string => {
    if (!isLoaded.value || !prism.value) {
      // Fallback to plain text with HTML escaping
      return code
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    try {
      // Map language aliases
      const languageMap: Record<string, string> = {
        'typescript': 'typescript',
        'javascript': 'javascript',
        'js': 'javascript',
        'ts': 'typescript',
        'yaml': 'yaml',
        'yml': 'yaml',
        'bash': 'bash',
        'shell': 'bash',
        'sh': 'bash'
      };

      const prismLanguage = languageMap[language] || 'typescript';
      
      if (prism.value.languages[prismLanguage]) {
        return prism.value.highlight(code, prism.value.languages[prismLanguage], prismLanguage);
      } else {
        // Fallback to plain text
        return code
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }
    } catch (error) {
      console.warn('Prism highlighting failed:', error);
      // Fallback to plain text
      return code
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
  };

  onMounted(() => {
    loadPrism();
  });

  return {
    highlightCode,
    isLoaded
  };
}