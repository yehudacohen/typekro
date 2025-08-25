/**
 * Simple YAML Factory Functions
 */

import { yamlFile } from '../../kubernetes/yaml/yaml-file.js';
import type { DeploymentClosure, AppliedResource } from '../../../core/types/deployment.js';

/**
 * Create a YAML file resource with simplified parameters
 *
 * @param path - Path to YAML file (local or git URL)
 * @param namespace - Optional namespace override
 * @returns DeploymentClosure with applied resources
 */
export function YamlFile(path: string, namespace?: string): DeploymentClosure<AppliedResource[]> {
  const name =
    path
      .split('/')
      .pop()
      ?.replace(/\.(yaml|yml)$/, '') || 'yaml-file';
  return yamlFile({
    name,
    path,
    ...(namespace && { namespace }),
  });
}
