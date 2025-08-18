// .vitepress/theme/index.js
import DefaultTheme from 'vitepress/theme'
import './custom.css'
import TutorialCarousel from './components/TutorialCarousel/TutorialCarousel.vue'

// Import Prism.js CSS theme
import 'prismjs/themes/prism-tomorrow.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    // Register global components
    app.component('TutorialCarousel', TutorialCarousel)
  }
}