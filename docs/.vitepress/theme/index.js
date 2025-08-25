// .vitepress/theme/index.js
import DefaultTheme from 'vitepress/theme';
import './custom.css';
import './custom-home.css';
import HomePage from './components/HomePage.vue';
import HeroSection from './components/HeroSection.vue';
import TutorialCarousel from './components/TutorialCarousel/TutorialCarousel.vue';
import GitHubStarButton from './components/GitHubStarButton.vue';
import ThemeProvider from './components/ThemeProvider.vue';
import NavHeader from './components/NavHeader.vue';

// Import all sections
import ComparisonTable from './components/sections/ComparisonTable.vue';
import FinalCTA from './components/sections/FinalCTA.vue';
import FeatureTiles from './components/sections/FeatureTiles.vue';
import KroSection from './components/sections/KroSection.vue';
import TutorialSection from './components/sections/TutorialSection.vue';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    // Register all components globally
    app.component('HomePage', HomePage);
    app.component('HeroSection', HeroSection);
    app.component('TutorialCarousel', TutorialCarousel);
    app.component('GitHubStarButton', GitHubStarButton);
    app.component('ThemeProvider', ThemeProvider);
    app.component('NavHeader', NavHeader);
    app.component('ComparisonTable', ComparisonTable);
    app.component('FinalCTA', FinalCTA);
    app.component('FeatureTiles', FeatureTiles);
    app.component('KroSection', KroSection);
    app.component('TutorialSection', TutorialSection);
  },
};
