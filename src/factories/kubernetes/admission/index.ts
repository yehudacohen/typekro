/**
 * Kubernetes Admission Resource Factories
 *
 * This module provides factory functions for Kubernetes admission control resources
 * including MutatingWebhookConfigurations and ValidatingWebhookConfigurations.
 */

export { mutatingWebhookConfiguration } from './mutating-webhook-configuration.js';
export { validatingWebhookConfiguration } from './validating-webhook-configuration.js';
