# Custom CRD Factory

Create type-safe factory functions for any CRD using `createResource()`.

## Cert-Manager Certificate Example

```typescript
import { createResource, type Enhanced } from 'typekro';

// Define TypeScript types for the CRD
interface CertificateSpec {
  secretName: string;
  issuerRef: { name: string; kind: 'Issuer' | 'ClusterIssuer' };
  dnsNames?: string[];
}
interface CertificateStatus {
  conditions?: Array<{ type: string; status: string }>;
  notAfter?: string;
}

// Create the factory function
export function certificate(config: {
  name: string;
  secretName: string;
  issuerRef: { name: string; kind: 'Issuer' | 'ClusterIssuer' };
  dnsNames?: string[];
  id?: string;
}): Enhanced<CertificateSpec, CertificateStatus> {
  return createResource<CertificateSpec, CertificateStatus>({
    apiVersion: 'cert-manager.io/v1',
    kind: 'Certificate',
    metadata: { name: config.name },
    spec: { secretName: config.secretName, issuerRef: config.issuerRef, dnsNames: config.dnsNames },
    ...(config.id && { id: config.id }),
  });
}
// Usage: cert.status.notAfter → ${webappCert.status.notAfter}
```

## Key Concepts

- **Type definitions**: Define `Spec` and `Status` interfaces matching the CRD schema
- **`createResource<Spec, Status>()`**: Returns `Enhanced` type with magic proxy support
- **`id` parameter**: Enables cross-resource references in CEL expressions

## Next Steps

- [Basic WebApp](./basic-webapp.md) - Factory functions in action
- [Database Integration](./database-app.md) - Cross-resource references
