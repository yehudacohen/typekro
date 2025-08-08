/**
 * Kubernetes RBAC Resource Factories
 * 
 * This module provides factory functions for Kubernetes RBAC resources
 * including Roles, RoleBindings, ClusterRoles, ServiceAccounts, etc.
 */

export { clusterRole } from './cluster-role.js';
export { clusterRoleBinding } from './cluster-role-binding.js';
export { role } from './role.js';
export { roleBinding } from './role-binding.js';
export { serviceAccount } from './service-account.js';