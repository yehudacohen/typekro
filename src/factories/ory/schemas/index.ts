/** Ory schema contract barrel for chart, CRD, and dependency-source interfaces. */
export type * from './chart-values.js';
export type * from './hydra.js';
export type * from './kratos.js';
export type * from './keto.js';
export type * from './oathkeeper.js';
export type * from './hydra-maester.js';
export type * from './oathkeeper-maester.js';

/** Names of the physically split Ory schema modules. */
export type OrySchemaModuleName =
  | 'hydra'
  | 'kratos'
  | 'keto'
  | 'oathkeeper'
  | 'hydra-maester'
  | 'oathkeeper-maester';

/** Required physical schema-module layout for the Ory source-of-truth contracts. */
export interface OrySchemaModuleLayout {
  hydra: './hydra.js';
  kratos: './kratos.js';
  keto: './keto.js';
  oathkeeper: './oathkeeper.js';
  'hydra-maester': './hydra-maester.js';
  'oathkeeper-maester': './oathkeeper-maester.js';
}
