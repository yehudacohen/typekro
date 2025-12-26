import { test, expect } from 'bun:test';
import type { KubernetesRef } from '../../src/core/types/common.js';
import type { MagicProxy } from '../../src/core/types/references.js';
import type { StatusProxy } from '../../src/core/types/deployment.js';

test('MagicProxy should enable property access on KubernetesRef-wrapped unions', () => {
  type TestObj = { name: string; controller: string };
  type OptionalTestObj = TestObj | undefined;

  type RefWrapped = KubernetesRef<OptionalTestObj>;
  type Proxied = MagicProxy<RefWrapped>;

  type NameType = Proxied['name'];

  const assertType: NameType = 'test' as any;
  expect(assertType).toBeDefined();
});

test('StatusProxy should preserve types through optional chaining', () => {
  interface TestStatus {
    ready: boolean;
    ingressClass?: {
      name: string;
      controller: string;
    };
  }

  type Status = StatusProxy<TestStatus>;
  type IngressClass = Status['ingressClass'];

  type NameAccess = IngressClass extends { name: infer N } ? N : 'FAIL';

  const assertType: NameAccess = 'test' as any;
  expect(assertType).toBeDefined();
});
