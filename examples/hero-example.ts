/**
 * Hero Section Example - The minimal code shown on the docs homepage
 */

import { type } from 'arktype';
import { kubernetesComposition, simple, Cel } from '../src/index.js';

const webapp = kubernetesComposition(
  {
    name: 'webapp',
    apiVersion: 'example.com/v1',
    kind: 'WebApp',
    spec: type({ replicas: 'number' }),
    status: type({ ready: 'boolean' })
  },
  (spec) => {
    const deployment = simple.Deployment({
      name: 'webapp',
      image: 'nginx',
      replicas: spec.replicas
    });
    
    const _service = simple.Service({
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
