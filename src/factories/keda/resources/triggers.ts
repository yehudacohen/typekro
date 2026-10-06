// The untyped trigger escape hatch. Its result type carries a phantom brand,
// so a known scaler type can't silently fall through to the untyped member of
// the `KedaTrigger` union; the runtime object is a plain trigger.

import type { KedaCustomTrigger, KedaTriggerCommon, KedaTypedTriggerType } from '../types.js';

/**
 * A trigger for a scaler without a typed shape (`kafka`, `rabbitmq`,
 * `azure-servicebus`, ...). Metadata values are strings, as in the CRD.
 *
 * @example
 * ```typescript
 * kedaTrigger('kafka', {
 *   bootstrapServers: 'kafka.messaging.svc:9092',
 *   consumerGroup: 'orders',
 *   topic: 'orders',
 *   lagThreshold: '50',
 * }, { authenticationRef: { name: 'kafka-auth' } });
 * ```
 */
export function kedaTrigger<T extends string>(
  type: T extends KedaTypedTriggerType ? never : T,
  metadata: Record<string, string>,
  options: KedaTriggerCommon = {}
): KedaCustomTrigger {
  return { type, metadata, ...options } as unknown as KedaCustomTrigger;
}
