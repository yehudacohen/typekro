import { describe, expect, it } from 'bun:test';

const read = (path: string): Promise<string> => Bun.file(path).text();

describe('Effect runtime architecture boundary', () => {
  it('lets Alchemy host provider effects without a nested TypeKro runtime', async () => {
    const provider = await read('src/alchemy/resource-registration.ts');

    expect(provider).toContain('ProviderMod.effect');
    expect(provider).toContain('Effect.tryPromise');
    expect(provider).not.toMatch(/Effect\.run(?:Promise|Fork|Sync)/);
    expect(provider).not.toContain('ManagedRuntime');
  });

  it('keeps the standalone Effect runtime lazy and behind factory facades', async () => {
    const runtime = await read('src/core/runtime/standalone-operation.ts');
    const directFactory = await read('src/core/deployment/direct-factory.ts');
    const kroFactory = await read('src/core/deployment/kro-factory.ts');

    expect(runtime).toContain("await import('effect')");
    expect(runtime).not.toMatch(/^import .* from ['"]effect['"];?$/m);
    expect(directFactory).toContain('runStandaloneOperation(');
    expect(kroFactory).toContain('runStandaloneOperation(');
  });

  it('does not expose Effect through the semantic frontend', async () => {
    const semanticFiles = [
      'src/core/composition/imperative.ts',
      'src/core/expressions/factory/status-builder-analyzer.ts',
      'src/core/planning/compiler.ts',
      'src/core/planning/values.ts',
      'src/core/serialization/status-analysis-pipeline.ts',
    ];

    for (const file of semanticFiles) {
      const source = await read(file);
      expect(source).not.toMatch(/from ['"]effect(?:\/[^'"]*)?['"]/);
      expect(source).not.toMatch(/import\(['"]effect(?:\/[^'"]*)?['"]\)/);
    }
  });
});
