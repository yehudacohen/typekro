import { describe, expect, it } from 'bun:test';
import { load } from 'js-yaml';
import { certManagerBootstrap } from '../../../src/factories/cert-manager/compositions/cert-manager-bootstrap.js';

describe('cert-manager bootstrap composition status', () => {
  it('gates every HelmRelease readiness projection on the current generation', () => {
    const yaml = certManagerBootstrap.toYaml();
    const document = load(yaml) as {
      spec: { schema: { status: Record<string, string> } };
    };
    const generationAwareReady =
      '${has(certManagerHelmRelease.status.observedGeneration) && certManagerHelmRelease.status.observedGeneration >= certManagerHelmRelease.metadata.generation';

    for (const field of ['ready', 'controllerReady', 'webhookReady', 'cainjectorReady']) {
      expect(document.spec.schema.status[field]).toStartWith(generationAwareReady);
    }
  });
});
