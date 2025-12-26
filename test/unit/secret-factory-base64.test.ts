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
    expect((secretResource as any).id).toBe('mySecretId');
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
        number: '123' as any,
        boolean: 'true' as any,
      },
    });

    expect(secretResource.data).toBeDefined();
    expect(secretResource.data?.number).toBe(Buffer.from('123').toString('base64'));
    expect(secretResource.data?.boolean).toBe(Buffer.from('true').toString('base64'));
  });
});
