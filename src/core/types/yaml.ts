// YAML File Resource Types
export interface YamlFileSpec {
  path: string;
}

export interface YamlFileStatus {
  phase: 'Pending' | 'Loading' | 'Applied' | 'Ready' | 'Failed';
  message?: string;
  appliedResources?: Array<{
    kind: string;
    name: string;
    namespace?: string;
  }>;
}

// YAML Directory Resource Types
export interface YamlDirectorySpec {
  path: string;
  recursive: boolean;
  include: string[];
  exclude: string[];
}

export interface YamlDirectoryStatus {
  phase: 'Pending' | 'Processing' | 'Applied' | 'Ready' | 'Failed';
  message?: string;
  processedFiles: number;
  totalFiles: number;
}