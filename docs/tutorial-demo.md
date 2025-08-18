# Tutorial Carousel Demo

This page demonstrates the Interactive Tutorial Carousel component.

<TutorialCarousel />

## Features

- ✅ Step-by-step tutorial with 6 comprehensive steps
- ✅ Smooth transitions between steps
- ✅ Keyboard navigation (arrow keys, space)
- ✅ Touch/swipe navigation on mobile
- ✅ Progress indicators and navigation controls
- ✅ **Optimized Layout**: Wider carousel with balanced 1.6:1 code-to-description proportions
- ✅ **Enhanced** Syntax-highlighted code examples with proper TypeScript/JavaScript highlighting
- ✅ Copy-to-clipboard functionality
- ✅ Call-to-action buttons for next steps
- ✅ Analytics tracking integration

## Usage

The tutorial carousel can be embedded in any VitePress page using:

```vue
<TutorialCarousel />
```

Or with custom props:

```vue
<TutorialCarousel 
  :auto-play="true"
  :show-progress="true"
  :enable-swipe="true"
  :show-completion-message="true"
/>
```

## Tutorial Content Features

- ✅ **Complete TypeKro Workflow**: From ArkType schemas to production deployment
- ✅ **KRO Integration**: Shows actual ResourceGraphDefinition YAML generation
- ✅ **Real Implementation Examples**: Based on actual TypeKro factory patterns
- ✅ **CEL Expression Templating**: Demonstrates KRO's templating capabilities
- ✅ **Multiple Deployment Strategies**: Direct, KRO controller, and Alchemy integration
- ✅ **GitOps Workflow**: ResourceGraphDefinitions for version-controlled infrastructure

## Syntax Highlighting Features

- ✅ **Prism.js Integration**: Professional syntax highlighting using Prism.js library
- ✅ **TypeScript Support**: Full syntax highlighting for TypeScript code examples
- ✅ **JavaScript Support**: Complete JavaScript syntax highlighting
- ✅ **YAML Support**: Proper YAML syntax highlighting for KRO ResourceGraphDefinitions
- ✅ **Bash Support**: Command-line syntax highlighting for shell examples
- ✅ **Monokai Theme**: Professional dark theme with light theme support
- ✅ **Proper Tokenization**: Accurate parsing with keywords, types, strings, comments, and more
- ✅ **Safe HTML**: XSS-safe HTML generation with proper escaping
- ✅ **Dynamic Loading**: Client-side loading to avoid SSR issues
- ✅ **Fallback Support**: Graceful degradation to plain text if highlighting fails

## Layout & Sizing Features

- ✅ **Wider Layout**: Expanded to 98% page width (900px-1400px range) for better content visibility
- ✅ **Enhanced Height**: Increased to 650px height with 500px content area for more comfortable reading
- ✅ **Optimized Proportions**: 1.6:1 ratio between code and explanation sections (62.5% / 37.5%)
- ✅ **Fixed Heights**: Consistent 500px for both code and description sections prevents layout shifts
- ✅ **Better Spacing**: Increased gap to 2.5rem between sections for improved visual separation
- ✅ **Responsive Breakpoints**: Optimized layouts for desktop, tablet, and mobile
- ✅ **Overflow Handling**: Proper scrolling for long content in both sections
- ✅ **Mobile Optimization**: Stacked layout with proportional heights on small screens