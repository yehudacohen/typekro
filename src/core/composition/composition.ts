import { simple } from '../../factories/simple/index.js';

import type { WebServiceComponent } from "./types.js";
export function createWebService(config: {
  name: string;
  image: string;
  namespace?: string;
  replicas?: number;
  port: number;
  targetPort?: number;
}): WebServiceComponent {
  const labels = { app: config.name };

  const deployment = simple.Deployment({
    name: config.name,
    image: config.image,
    ...(config.namespace && { namespace: config.namespace }),
    ...(config.replicas && { replicas: config.replicas }),
    ports: [{ containerPort: config.targetPort ?? config.port }],
  });

  const service = simple.Service({
    name: config.name,
    selector: labels,
    ports: [{ port: config.port, targetPort: config.targetPort ?? config.port }],
    ...(config.namespace && { namespace: config.namespace }),
  });

  return { deployment, service };
}
