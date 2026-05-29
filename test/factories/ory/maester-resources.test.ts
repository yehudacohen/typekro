import { describe, expect, it } from 'bun:test';
import { oauth2Client } from '../../../src/factories/ory/resources/oauth2-client.js';
import { oathkeeperRule } from '../../../src/factories/ory/resources/oathkeeper-rule.js';

function requireEvaluator(resource: { readinessEvaluator?: unknown }): (input: unknown) => { ready: boolean; message?: string } {
  expect(resource.readinessEvaluator).toBeDefined();
  expect(typeof resource.readinessEvaluator).toBe('function');
  return resource.readinessEvaluator as (input: unknown) => { ready: boolean; message?: string };
}

describe('Ory Maester resource factories', () => {
  describe('oauth2Client', () => {
    it('Provide typed TypeKro factories for OAuth2Client resources processed by Hydra Maester', () => {
      const client = oauth2Client({
        id: 'consoleOAuth2Client',
        name: 'console',
        namespace: 'ory-system',
        spec: {
          grantTypes: ['authorization_code', 'refresh_token'],
          responseTypes: ['code'],
          redirectUris: ['https://console.example.com/callback'],
          scope: 'openid offline',
          secretName: 'console-oauth2-client',
          tokenEndpointAuthMethod: 'client_secret_basic',
          metadata: { owner: 'platform' },
        },
      });

      expect(client.id).toBe('consoleOAuth2Client');
      expect(client.apiVersion).toBe('hydra.ory.sh/v1alpha1');
      expect(client.kind).toBe('OAuth2Client');
      expect(client.metadata.name).toBe('console');
      expect(client.metadata.namespace).toBe('ory-system');
      expect(client.spec.grantTypes).toEqual(['authorization_code', 'refresh_token']);
      expect(client.spec.secretName).toBe('console-oauth2-client');
    });

    it('Observe Hydra Maester OAuth2Client status as ready when a Ready condition is True', () => {
      const client = oauth2Client({
        name: 'console',
        spec: { grantTypes: ['client_credentials'], secretName: 'console-oauth2-client' },
      });
      const evaluator = requireEvaluator(client);

      const result = evaluator({
        status: {
          conditions: [{ type: 'Ready', status: 'True' }],
          observedGeneration: 1,
        },
      });

      expect(result.ready).toBe(true);
    });

    it('Surface Hydra Maester reconciliation failures as not ready with a safe message', () => {
      const client = oauth2Client({
        name: 'console',
        spec: { grantTypes: ['client_credentials'], secretName: 'console-oauth2-client' },
      });
      const evaluator = requireEvaluator(client);

      const result = evaluator({
        status: {
          reconciliationError: {
            statusCode: '400',
            description: 'invalid redirect uri',
          },
        },
      });

      expect(result.ready).toBe(false);
      expect(result.message).toContain('invalid redirect uri');
      expect(result.message).not.toContain('client-secret');
    });
  });

  describe('oathkeeperRule', () => {
    it('Provide typed TypeKro factories for Rule resources processed by Oathkeeper Maester', () => {
      const rule = oathkeeperRule({
        id: 'apiRule',
        name: 'api-rule',
        namespace: 'ory-system',
        spec: {
          match: { methods: ['GET'], url: 'https://api.example.com/<.*>' },
          upstream: { url: 'http://api.default.svc.cluster.local', preserveHost: true },
          authenticators: [{ handler: 'cookie_session', config: { check_session_url: 'http://kratos-public/sessions/whoami' } }],
          authorizer: { handler: 'allow' },
          mutators: [{ handler: 'id_token', config: { issuer_url: 'https://hydra.example.com' } }],
          errors: [{ handler: 'json' }],
          configMapName: 'oathkeeper-rules',
        },
      });

      expect(rule.id).toBe('apiRule');
      expect(rule.apiVersion).toBe('oathkeeper.ory.sh/v1alpha1');
      expect(rule.kind).toBe('Rule');
      expect(rule.metadata.name).toBe('api-rule');
      expect(rule.metadata.namespace).toBe('ory-system');
      expect(rule.spec.match.methods).toEqual(['GET']);
      expect(rule.spec.upstream?.url).toBe('http://api.default.svc.cluster.local');
    });

    it('Observe Oathkeeper Maester Rule validation as ready when status.validation.valid is true', () => {
      const rule = oathkeeperRule({
        name: 'api-rule',
        spec: { match: { methods: ['GET'], url: 'https://api.example.com/<.*>' } },
      });
      const evaluator = requireEvaluator(rule);

      const result = evaluator({ status: { validation: { valid: true } } });

      expect(result.ready).toBe(true);
    });

    it('Surface Oathkeeper Rule validation errors as not ready', () => {
      const rule = oathkeeperRule({
        name: 'api-rule',
        spec: { match: { methods: ['GET'], url: 'https://api.example.com/<.*>' } },
      });
      const evaluator = requireEvaluator(rule);

      const result = evaluator({
        status: { validation: { valid: false, validationError: 'unknown mutator handler' } },
      });

      expect(result.ready).toBe(false);
      expect(result.message).toContain('unknown mutator handler');
    });
  });
});
