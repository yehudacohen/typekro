/**
 * Kubernetes Core Resource Factories
 * 
 * This module provides factory functions for core Kubernetes resources
 * including Pods, Namespaces, Nodes, and ComponentStatus.
 */

export { componentStatus } from './component-status.js';
export { namespace } from './namespace.js';
export { node } from './node.js';
export { pod } from './pod.js';