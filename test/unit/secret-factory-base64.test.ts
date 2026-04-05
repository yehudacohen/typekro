import { describe, expect, it } from 'bun:test';
import { Secret } from '../../src/factories/simple/config/secret.js';

describe('Secret Factory Base64 Encoding', () => {
  it('should convert stringData to base64-encoded data', () => {
    const secretResource = Secret({
      name: 'test-secret',
      namespace: 'test-ns',
      stringData: {
        username: 'admin',
        password: 'secret123',
      },
    });

    expect(secretResource.data).toBeDefined();
    expect(secretResource.data?.username).toBe(Buffer.from('admin').toString('base64'));
    expect(secretResource.data?.password).toBe(Buffer.from('secret123').toString('base64'));

    // Verify the encoded values
    expect(secretResource.data?.username).toBe('YWRtaW4=');
    expect(secretResource.data?.password).toBe('c2VjcmV0MTIz');
  });

  it('should handle empty stringData', () => {
    const secretResource = Secret({
      name: 'test-secret',
      stringData: {},
    });

    expect(secretResource.data).toBeDefined();
    expect(Object.keys(secretResource.data || {})).toHaveLength(0);
  });

  it('should handle AWS credentials encoding', () => {
    // These are AWS's official example keys from documentation — not real credentials
    // See: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html
    const secretResource = Secret({
      name: 'aws-credentials',
      namespace: 'external-dns',
      stringData: {
        'access-key-id': 'AKIAIOSFODNN7EXAMPLE',
        'secret-access-key': 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
    });

    expect(secretResource.data).toBeDefined();
    expect(secretResource.data?.['access-key-id']).toBe(
      Buffer.from('AKIAIOSFODNN7EXAMPLE').toString('base64')
    );
    expect(secretResource.data?.['secret-access-key']).toBe(
      Buffer.from('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY').toString('base64')
    );

    // Verify values can be decoded back
    expect(
      Buffer.from(secretResource.data?.['access-key-id'] || '', 'base64').toString('utf-8')
    ).toBe('AKIAIOSFODNN7EXAMPLE');
    expect(
      Buffer.from(secretResource.data?.['secret-access-key'] || '', 'base64').toString('utf-8')
    ).toBe('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  });

  it('should handle data field directly without encoding', () => {
    const alreadyEncoded = Buffer.from('myvalue').toString('base64');
    const secretResource = Secret({
      name: 'test-secret',
      data: {
        key: alreadyEncoded,
      },
    });

    expect(secretResource.data).toBeDefined();
    expect(secretResource.data?.key).toBe(alreadyEncoded);
  });

  it('should merge stringData and data, with data taking precedence', () => {
    const secretResource = Secret({
      name: 'test-secret',
      stringData: {
        key1: 'value1',
        key2: 'value2',
      },
      data: {
        key2: 'cHJlZW5jb2RlZA==', // pre-encoded "preencoded"
        key3: 'cHJlZW5jb2RlZDM=', // pre-encoded "preencoded3"
      },
    });

    expect(secretResource.data).toBeDefined();
    expect(secretResource.data?.key1).toBe(Buffer.from('value1').toString('base64'));
    expect(secretResource.data?.key2).toBe('cHJlZW5jb2RlZA=='); // data takes precedence
    expect(secretResource.data?.key3).toBe('cHJlZW5jb2RlZDM=');
  });

  it('should handle special characters in stringData', () => {
    const secretResource = Secret({
      name: 'test-secret',
      stringData: {
        special: 'hello@world!#$%^&*()',
        unicode: '你好世界🌍',
        multiline: 'line1\nline2\nline3',
      },
    });

    expect(secretResource.data).toBeDefined();

    // Verify all values are base64 encoded
    expect(secretResource.data?.special).toBe(
      Buffer.from('hello@world!#$%^&*()').toString('base64')
    );
    expect(secretResource.data?.unicode).toBe(Buffer.from('你好世界🌍').toString('base64'));
    expect(secretResource.data?.multiline).toBe(
      Buffer.from('line1\nline2\nline3').toString('base64')
    );

    // Verify they decode correctly
    expect(Buffer.from(secretResource.data?.special || '', 'base64').toString('utf-8')).toBe(
      'hello@world!#$%^&*()'
    );
    expect(Buffer.from(secretResource.data?.unicode || '', 'base64').toString('utf-8')).toBe(
      '你好世界🌍'
    );
    expect(Buffer.from(secretResource.data?.multiline || '', 'base64').toString('utf-8')).toBe(
      'line1\nline2\nline3'
    );
  });

  it('should set proper metadata fields', () => {
    const secretResource = Secret({
      name: 'test-secret',
      namespace: 'test-namespace',
      stringData: {
        key: 'value',
      },
      id: 'mySecretId',
    });

    expect(secretResource.metadata?.name).toBe('test-secret');
    expect(secretResource.metadata?.namespace).toBe('test-namespace');
    expect(secretResource.metadata?.labels?.app).toBe('test-secret');
    expect((secretResource as unknown as Record<string, unknown>).id).toBe('mySecretId');
  });

  it('should handle stringData without namespace', () => {
    const secretResource = Secret({
      name: 'test-secret',
      stringData: {
        key: 'value',
      },
    });

    expect(secretResource.metadata?.name).toBe('test-secret');
    // namespace is a proxy function when not provided, not undefined
  });

  it('should convert non-string values to strings before encoding', () => {
    const secretResource = Secret({
      name: 'test-secret',
      stringData: {
        number: '123' as unknown as string,
        boolean: 'true' as unknown as string,
      },
    });

    expect(secretResource.data).toBeDefined();
    expect(secretResource.data?.number).toBe(Buffer.from('123').toString('base64'));
    expect(secretResource.data?.boolean).toBe(Buffer.from('true').toString('base64'));
  });

  // =========================================================================
  // Proxy-value guard (integration-skill rule #31)
  // =========================================================================
  //
  // simple.Secret must refuse stringData values that are KubernetesRef proxies
  // or that contain __KUBERNETES_REF__ marker tokens. Base64-encoding these
  // at composition time would bake the marker into the final Secret instead
  // of the user's actual secret — a silent and catastrophic failure.
  // Compositions that pass schema.spec references into a Secret should use
  // the low-level `secret()` factory instead.

  describe('Proxy-value guard (rule #31)', () => {
    it('throws a descriptive error when stringData value is a KubernetesRef proxy', async () => {
      const { createSchemaProxy } = await import('../../src/core/references/schema-proxy.js');
      const schema = createSchemaProxy<
        { apiKey: string },
        Record<string, never>
      >();

      expect(() =>
        Secret({
          name: 'api-secret',
          stringData: {
            api_key: schema.spec.apiKey as unknown as string,
          },
        })
      ).toThrow(/simple\.Secret received a KubernetesRef proxy for stringData\["api_key"\]/);
    });

    it('error message points at the low-level `secret()` factory', async () => {
      const { createSchemaProxy } = await import('../../src/core/references/schema-proxy.js');
      const schema = createSchemaProxy<{ token: string }, Record<string, never>>();

      try {
        Secret({
          name: 'token-secret',
          stringData: { token: schema.spec.token as unknown as string },
        });
        throw new Error('expected Secret() to throw');
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain('low-level `secret()` factory');
        expect(msg).toContain('kubernetes/config/secret');
        expect(msg).toContain('rule #31');
      }
    });

    it('throws when stringData contains a string with __KUBERNETES_REF__ markers', () => {
      // Simulate what a template literal containing a schema proxy produces:
      // a real string whose content is the marker token.
      const markerString = '__KUBERNETES_REF___schema___spec.dbPassword__';

      expect(() =>
        Secret({
          name: 'db-secret',
          stringData: {
            password: markerString,
          },
        })
      ).toThrow(/string with __KUBERNETES_REF__ markers for stringData\["password"\]/);
    });

    it('does NOT throw for plain string values (regression guard)', () => {
      expect(() =>
        Secret({
          name: 'plain-secret',
          stringData: {
            username: 'admin',
            password: 'correct-horse-battery-staple',
          },
        })
      ).not.toThrow();
    });

    it('does NOT throw for data (already-base64) values even if they contain "REF"', () => {
      // The guard applies to stringData only — `data` values are already
      // base64-encoded by the caller and bypass the encoding loop.
      expect(() =>
        Secret({
          name: 'data-secret',
          data: {
            content: Buffer.from('__KUBERNETES_REF__fake__').toString('base64'),
          },
        })
      ).not.toThrow();
    });
  });
});
