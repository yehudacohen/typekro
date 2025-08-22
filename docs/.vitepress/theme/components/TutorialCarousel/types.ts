// TypeScript interfaces for tutorial data structures

export interface CodeExample {
  language: string;
  code: string;
  highlights?: string[];
  annotations?: CodeAnnotation[];
  runnable?: boolean;
}

export interface CodeAnnotation {
  line: number;
  message: string;
  type: 'info' | 'warning' | 'success';
}

export interface CallToAction {
  text: string;
  url: string;
  type: 'primary' | 'secondary';
}

export interface CodeBlock {
  title?: string;
  example: CodeExample;
}

export interface TutorialStep {
  id: string;
  title: string;
  description: string;
  codeExample?: CodeExample;
  codeBlocks?: CodeBlock[];
  explanation: string;
  highlights?: string[];
  nextSteps?: CallToAction[];
}

export interface CarouselState {
  currentStep: number;
  totalSteps: number;
  isPlaying: boolean;
  direction: 'forward' | 'backward';
}

export interface TutorialCarouselProps {
  autoPlay?: boolean;
  showProgress?: boolean;
  enableSwipe?: boolean;
}

export interface TutorialConfig {
  steps: TutorialStep[];
  settings: {
    autoPlayInterval?: number;
    enableKeyboardNavigation: boolean;
    enableSwipeNavigation: boolean;
    showProgressBar: boolean;
    theme: 'light' | 'dark' | 'auto';
  };
  analytics?: {
    trackStepViews: boolean;
    trackCompletions: boolean;
    trackDropoffs: boolean;
  };
}
