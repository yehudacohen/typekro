import { computed } from 'vue';
import type { TutorialStep, CodeExample } from '../types';

export function useStepValidation() {
  const validateCodeExample = (codeExample: CodeExample): boolean => {
    if (!codeExample.language || !codeExample.code) {
      console.warn('Code example missing required language or code');
      return false;
    }

    // Validate language is supported
    const supportedLanguages = ['typescript', 'javascript', 'yaml', 'json', 'bash'];
    if (!supportedLanguages.includes(codeExample.language)) {
      console.warn(`Unsupported language: ${codeExample.language}`);
      return false;
    }

    // Validate code is not empty
    if (codeExample.code.trim().length === 0) {
      console.warn('Code example is empty');
      return false;
    }

    return true;
  };

  const validateStep = (step: TutorialStep): boolean => {
    // Check required fields
    if (!step.id || !step.title || !step.description) {
      console.warn('Step missing required fields (id, title, description)');
      return false;
    }

    // Validate ID format (kebab-case)
    const idPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    if (!idPattern.test(step.id)) {
      console.warn(`Step ID should be kebab-case: ${step.id}`);
      return false;
    }

    // Validate code content - either codeExample or codeBlocks must be present
    if (step.codeExample) {
      // Single code example
      if (!validateCodeExample(step.codeExample)) {
        console.warn(`Invalid code example for step: ${step.id}`);
        return false;
      }
    } else if (step.codeBlocks && step.codeBlocks.length > 0) {
      // Multiple code blocks
      for (const codeBlock of step.codeBlocks) {
        if (!validateCodeExample(codeBlock.example)) {
          console.warn(`Invalid code block for step: ${step.id}`);
          return false;
        }
      }
    } else {
      console.warn(`Step missing code content (either codeExample or codeBlocks): ${step.id}`);
      return false;
    }

    // Validate explanation
    if (!step.explanation || step.explanation.trim().length === 0) {
      console.warn(`Step missing explanation: ${step.id}`);
      return false;
    }

    // Validate next steps if present
    if (step.nextSteps) {
      for (const nextStep of step.nextSteps) {
        if (!nextStep.text || !nextStep.url) {
          console.warn(`Invalid next step for step: ${step.id}`);
          return false;
        }
      }
    }

    return true;
  };

  const validateSteps = (steps: TutorialStep[]): { isValid: boolean; errors: string[] } => {
    const errors: string[] = [];

    if (!steps || steps.length === 0) {
      errors.push('No tutorial steps provided');
      return { isValid: false, errors };
    }

    // Check for duplicate IDs
    const ids = steps.map((step) => step.id);
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicateIds.length > 0) {
      errors.push(`Duplicate step IDs found: ${duplicateIds.join(', ')}`);
    }

    // Validate each step
    steps.forEach((step, index) => {
      if (!validateStep(step)) {
        errors.push(`Invalid step at index ${index}: ${step.id || 'unknown'}`);
      }
    });

    return {
      isValid: errors.length === 0,
      errors,
    };
  };

  const getStepById = (steps: TutorialStep[], id: string): TutorialStep | undefined => {
    return steps.find((step) => step.id === id);
  };

  const getStepIndex = (steps: TutorialStep[], id: string): number => {
    return steps.findIndex((step) => step.id === id);
  };

  return {
    validateStep,
    validateSteps,
    validateCodeExample,
    getStepById,
    getStepIndex,
  };
}
