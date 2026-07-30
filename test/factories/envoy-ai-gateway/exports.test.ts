import { describe, expect, test } from 'vitest';
import * as envoyAIGateway from '../../../src/factories/envoy-ai-gateway/index.js';
import * as factories from '../../../src/factories/index.js';

describe('Envoy AI Gateway exports', () => {
  test('exports the integration from its focused entrypoint', () => {
    expect(envoyAIGateway.makeEnvoyAIGateway).toBeTypeOf('function');
    expect(
      envoyAIGateway.makeEnvoyAIGatewayPlatformInstallation,
    ).toBeTypeOf('function');
    expect(envoyAIGateway.envoyMCPRoute).toBeTypeOf('function');
    expect(envoyAIGateway.DEFAULT_ENVOY_AI_GATEWAY_VERSION).toBe('v0.6.0');
  });

  test('exports one discoverable ecosystem namespace from the umbrella factories entrypoint', () => {
    expect(factories.envoyAIGateway.makeEnvoyAIGateway).toBe(
      envoyAIGateway.makeEnvoyAIGateway,
    );
  });
});
