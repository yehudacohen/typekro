/**
 * Amazon ECR Registry Handler
 *
 * Uses the AWS SDK's credential provider chain for all authentication.
 * Supports env vars, profiles, SSO sessions, instance roles, and role
 * assumption — all through the SDK's standard mechanisms.
 */

import {
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
  ECRClient,
  GetAuthorizationTokenCommand,
} from '@aws-sdk/client-ecr';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';
import { getComponentLogger } from '../../logging/index.js';
import { ContainerBuildError } from '../errors.js';
import { execDocker } from '../exec.js';
import type { EcrRegistryConfig, RegistryHandler } from './types.js';

const logger = getComponentLogger('container-registry-ecr');

export class EcrRegistryHandler implements RegistryHandler {
  private resolvedAccountId: string | undefined;
  private resolvedRegion: string;
  private credentialProvider: AwsCredentialIdentityProvider;
  private ecrClient: ECRClient;

  constructor(private readonly config: EcrRegistryConfig) {
    this.resolvedRegion = config.region
      ?? process.env.AWS_REGION
      ?? process.env.AWS_DEFAULT_REGION
      ?? 'us-east-1';
    this.credentialProvider = fromNodeProviderChain(config.credentials ?? {});
    this.ecrClient = new ECRClient({
      region: this.resolvedRegion,
      credentials: this.credentialProvider,
    });
  }

  async resolveImageUri(imageName: string, tag: string): Promise<string> {
    const accountId = await this.getAccountId();
    return `${accountId}.dkr.ecr.${this.resolvedRegion}.amazonaws.com/${imageName}:${tag}`;
  }

  async authenticate(): Promise<void> {
    try {
      const authResponse = await this.ecrClient.send(new GetAuthorizationTokenCommand({}));
      const authData = authResponse.authorizationData?.[0];
      if (!authData?.authorizationToken || !authData.proxyEndpoint) {
        throw new Error('ECR returned empty authorization data');
      }

      const decoded = Buffer.from(authData.authorizationToken, 'base64').toString();
      const colonIndex = decoded.indexOf(':');
      if (colonIndex === -1) throw new Error('Failed to decode ECR authorization token');
      const password = decoded.slice(colonIndex + 1);

      await execDocker(['login', '--username', 'AWS', '--password-stdin', authData.proxyEndpoint], {
        stdin: password,
        quiet: true,
      });

      logger.info('Authenticated with ECR', { endpoint: authData.proxyEndpoint });

      if (!this.resolvedAccountId) {
        const match = authData.proxyEndpoint.match(/https?:\/\/(\d+)\.dkr\.ecr/);
        if (match?.[1]) this.resolvedAccountId = match[1];
      }
    } catch (error) {
      if (error instanceof ContainerBuildError) throw error;
      throw ContainerBuildError.ecrAuthFailed(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  async push(imageUri: string, imageName: string): Promise<boolean> {
    if (this.config.createRepository !== false) {
      await this.ensureRepositoryExists(imageName);
    }

    try {
      await execDocker(['push', imageUri]);
      logger.info('Image pushed to ECR', { imageUri });
      return true;
    } catch (error) {
      throw ContainerBuildError.pushFailed(
        imageUri,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  private async getAccountId(): Promise<string> {
    if (this.config.accountId) return this.config.accountId;
    if (this.resolvedAccountId) return this.resolvedAccountId;

    try {
      const sts = new STSClient({
        region: this.resolvedRegion,
        credentials: this.credentialProvider,
      });
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      if (!identity.Account) throw new Error('STS returned no account ID');
      this.resolvedAccountId = identity.Account;
      return identity.Account;
    } catch (error) {
      throw ContainerBuildError.ecrAuthFailed(
        new Error(
          `Cannot determine AWS account ID. Provide accountId explicitly or ensure valid AWS credentials.\n` +
          `Cause: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  private async ensureRepositoryExists(repoName: string): Promise<void> {
    try {
      await this.ecrClient.send(new DescribeRepositoriesCommand({ repositoryNames: [repoName] }));
    } catch (error: unknown) {
      if ((error as { name?: string }).name === 'RepositoryNotFoundException') {
        logger.info('Creating ECR repository', { repoName });
        await this.ecrClient.send(new CreateRepositoryCommand({ repositoryName: repoName }));
      } else {
        throw new ContainerBuildError(
          `ECR repository check failed for "${repoName}": ${error instanceof Error ? error.message : String(error)}`,
          'ECR_REPOSITORY_ERROR',
          [
            `Check IAM permissions: ecr:DescribeRepositories and ecr:CreateRepository are required.`,
            `Or set createRepository: false and create the repository manually.`,
          ],
          error instanceof Error ? error : undefined
        );
      }
    }
  }
}
