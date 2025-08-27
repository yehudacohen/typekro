/**
 * Hero Section Example - The minimal code shown on the docs homepage
 */

import { type } from 'arktype';
// In production: import { kubernetesComposition, Cel } from 'typekro';
// In production: import { Deployment, Service } from 'typekro/simple';
import { kubernetesComposition, Cel } from '../src/index.js';
import { Deployment, Service } from '../src/factories/simple/index.js';

const webapp = kubernetesComposition(
  {
    name: 'webapp',
    apiVersion: 'example.com/v1',
    kind: 'WebApp',
    spec: type({ replicas: 'number' }),
    status: type({ ready: 'boolean' })
  },
  (spec) => {
    const deployment = Deployment({
      name: 'webapp',
      image: 'nginx',
      replicas: spec.replicas
    });
    
    const _service = Service({
      name: 'webapp-service',
      selector: { app: 'webapp' },
      ports: [{ port: 80 }]
    });

    return {
      ready: Cel.expr<boolean>(deployment.status.readyReplicas, ' > 0')
    };
  }
);

// Example usage (commented out to avoid requiring cluster access)
// await webapp.factory('direct').deploy({ replicas: 3 });

console.log('Hero example compiled successfully!');
console.log('YAML Output:');
console.log(webapp.toYaml());

export { webapp };
