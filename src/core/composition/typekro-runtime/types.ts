import { type } from 'arktype';

export const TypeKroRuntimeSpec = type({
  namespace: 'string',
});

export const TypeKroRuntimeStatus = type({
  phase: '"Pending" | "Installing" | "Ready" | "Failed" | "Upgrading"',
  components: {
    fluxSystem: 'boolean',
    kroSystem: 'boolean',
  },
});

export interface TypeKroRuntimeConfig {
  namespace?: string;
  fluxVersion?: string;
  kroVersion?: string;
}
