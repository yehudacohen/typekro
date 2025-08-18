import { ref, onMounted } from 'vue';

export function useSyntaxHighlighting() {
  const isHighlightingLoaded = ref(false);

  // Enhanced TypeScript/JavaScript syntax highlighting
  const highlightCode = (code: string, language: string): string => {
    if (!code) return '';

    // Escape HTML first to prevent XSS
    let escapedCode = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Only highlight TypeScript and JavaScript
    if (language === 'typescript' || language === 'javascript') {
      escapedCode = highlightTypeScript(escapedCode);
    } else if (language === 'yaml') {
      escapedCode = highlightYaml(escapedCode);
    } else if (language === 'bash') {
      escapedCode = highlightBash(escapedCode);
    }

    return `<pre class="shiki github-dark vp-code"><code>${escapedCode}</code></pre>`;
  };

  const highlightTypeScript = (code: string): string => {
    return code
      // Comments first (to avoid highlighting keywords in comments)
      .replace(/\/\/.*$/gm, '<span class="token-comment">$&</span>')
      .replace(/\/\*[\s\S]*?\*\//g, '<span class="token-comment">$&</span>')
      
      // String literals (handle escaped quotes properly)
      .replace(/'(?:[^'\\]|\\.)*'/g, '<span class="token-string">$&</span>')
      .replace(/"(?:[^"\\]|\\.)*"/g, '<span class="token-string">$&</span>')
      .replace(/`(?:[^`\\]|\\.)*`/g, '<span class="token-template-string">$&</span>')
      
      // Numbers
      .replace(/\b\d+\.?\d*\b/g, '<span class="token-number">$&</span>')
      
      // Keywords
      .replace(/\b(import|export|from|as|default|const|let|var|function|async|await|return|if|else|for|while|do|break|continue|switch|case|try|catch|finally|throw|new|this|super|class|extends|implements|interface|type|enum|namespace|module|declare|public|private|protected|static|readonly|abstract)\b/g, 
        '<span class="token-keyword">$1</span>')
      
      // Types and built-ins
      .replace(/\b(string|number|boolean|object|any|void|null|undefined|never|unknown|Promise|Array|Record|Partial|Required|Pick|Omit|Exclude|Extract|NonNullable|Parameters|ReturnType|InstanceType|ThisType)\b/g, 
        '<span class="token-type">$1</span>')
      
      // Function names (before parentheses)
      .replace(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()/g, 
        '<span class="token-function">$1</span>')
      
      // Property access
      .replace(/\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g, 
        '.<span class="token-property">$1</span>')
      
      // Operators
      .replace(/(\+|\-|\*|\/|%|=|!|&|\||<|>|\?|:)/g, 
        '<span class="token-operator">$1</span>');
  };

  const highlightYaml = (code: string): string => {
    return code
      // Comments
      .replace(/#.*$/gm, '<span class="token-comment">$&</span>')
      
      // Keys (before colon)
      .replace(/^(\s*)([a-zA-Z_][a-zA-Z0-9_-]*)\s*:/gm, 
        '$1<span class="token-key">$2</span>:')
      
      // String values
      .replace(/:\s*"([^"]*)"/g, ': <span class="token-string">"$1"</span>')
      .replace(/:\s*'([^']*)'/g, ': <span class="token-string">\'$1\'</span>')
      
      // Numbers
      .replace(/:\s*(\d+)/g, ': <span class="token-number">$1</span>')
      
      // Booleans
      .replace(/:\s*(true|false|null)\b/g, ': <span class="token-boolean">$1</span>');
  };

  const highlightBash = (code: string): string => {
    return code
      // Comments
      .replace(/#.*$/gm, '<span class="token-comment">$&</span>')
      
      // Commands
      .replace(/^\s*([a-zA-Z_][a-zA-Z0-9_-]*)/gm, 
        '<span class="token-function">$1</span>')
      
      // Flags
      .replace(/\s(-{1,2}[a-zA-Z0-9_-]+)/g, 
        ' <span class="token-parameter">$1</span>')
      
      // Strings
      .replace(/'([^']*)'/g, '<span class="token-string">\'$1\'</span>')
      .replace(/"([^"]*)"/g, '<span class="token-string">"$1"</span>');
  };

  onMounted(() => {
    isHighlightingLoaded.value = true;
  });

  return {
    highlightCode,
    isHighlightingLoaded
  };
}