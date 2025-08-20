// .vitepress/theme/index.js
import DefaultTheme from 'vitepress/theme'
import './custom.css'
import TutorialCarousel from './components/TutorialCarousel/TutorialCarousel.vue'
import GitHubStarButton from './components/GitHubStarButton.vue'

// Import Prism.js CSS theme
import 'prismjs/themes/prism-tomorrow.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    // Register global components
    app.component('TutorialCarousel', TutorialCarousel)
    app.component('GitHubStarButton', GitHubStarButton)
  }
}
