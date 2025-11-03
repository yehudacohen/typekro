import { type, type Type } from 'arktype';

export interface TypeKroRuntimeSpecType {
  namespace: string;
}

export interface TypeKroRuntimeStatusType {
  phase: 'Pending' | 'Installing' | 'Ready' | 'Failed' | 'Upgrading';
  components: {
    fluxSystem: boolean;
    kroSystem: boolean;
  };
}

export const TypeKroRuntimeSpec: Type<TypeKroRuntimeSpecType> = type({
  namespace: 'string',
});

export const TypeKroRuntimeStatus: Type<TypeKroRuntimeStatusType> = type({
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
