/**
 * Container Build Errors
 */

import { TypeKroError } from '../errors.js';

export class ContainerBuildError extends TypeKroError {
  constructor(
    message: string,
    code: string,
    public readonly suggestions: string[] = [],
    cause?: Error
  ) {
    super(message, code, { suggestions }, cause ? { cause } : undefined);
    this.name = 'ContainerBuildError';
  }

  static dockerNotAvailable(detail?: string): ContainerBuildError {
    return new ContainerBuildError(
      `Docker is not available${detail ? `: ${detail}` : ''}`,
      'DOCKER_NOT_AVAILABLE',
      [
        'Is Docker or Orbstack running?',
        "Run 'docker info' to check the Docker daemon status.",
        'If using Orbstack, ensure the Docker engine is enabled in settings.',
      ]
    );
  }

  static buildFailed(exitCode: number, stderr: string): ContainerBuildError {
    return new ContainerBuildError(
      `Docker build failed with exit code ${exitCode}:\n${stderr.slice(0, 500)}`,
      'BUILD_FAILED',
      [
        'Check the Dockerfile for syntax errors.',
        'Verify the build context contains all required files.',
        "Run 'docker build' manually to see the full output.",
      ]
    );
  }

  static pushFailed(imageUri: string, cause: Error): ContainerBuildError {
    return new ContainerBuildError(
      `Failed to push ${imageUri}: ${cause.message}`,
      'PUSH_FAILED',
      [
        'Verify registry credentials are valid.',
        'Check that the repository exists (or enable createRepository).',
        `Run 'docker push ${imageUri}' manually to diagnose.`,
      ],
      cause
    );
  }

  static ecrAuthFailed(cause: Error): ContainerBuildError {
    return new ContainerBuildError(
      `ECR authentication failed: ${cause.message}`,
      'ECR_AUTH_FAILED',
      [
        'Verify AWS credentials: aws sts get-caller-identity',
        'If using SSO: aws sso login --profile <your-profile>',
        'Set AWS_REGION or pass region in the ECR config.',
        'Check IAM permissions: ecr:GetAuthorizationToken is required.',
      ],
      cause
    );
  }

  static registryNotSupported(type: string): ContainerBuildError {
    return new ContainerBuildError(
      `Registry type '${type}' is not yet implemented.`,
      'REGISTRY_NOT_SUPPORTED',
      [
        'Supported registries: orbstack, ecr.',
        'GCR and ACR support is planned — contributions welcome.',
      ]
    );
  }
}
