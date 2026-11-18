// The in-cluster RivetKit probe pods: one with the real token, one with a wrong token.
// Printed as a Kubernetes List for `kubectl apply -f -`.
const NAMESPACE = 'typekro-rivet-spike';
export const PROBE_IMAGE = 'typekro-rivetkit-probe:spike';

function pod(name: string, token: Record<string, unknown>, timeoutMs: number) {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: NAMESPACE,
      labels: { 'typekro.dev/spike': 'alchemy-kubernetes-capture' },
    },
    spec: {
      restartPolicy: 'Never',
      containers: [
        {
          name: 'probe',
          image: PROBE_IMAGE,
          imagePullPolicy: 'Never',
          env: [
            { name: 'RIVET_ENDPOINT', value: `http://rivet.${NAMESPACE}.svc.cluster.local:6420` },
            { name: 'RIVET_NAMESPACE', value: 'default' },
            { name: 'RIVET_POOL', value: 'default' },
            { name: 'PROBE_TIMEOUT_MS', value: String(timeoutMs) },
            { name: 'RIVET_TOKEN', ...token },
          ],
        },
      ],
    },
  };
}

const which = process.argv[2];
const items =
  which === 'good'
    ? [
        pod(
          'rivetkit-probe',
          { valueFrom: { secretKeyRef: { name: 'rivet-token', key: 'token' } } },
          120_000
        ),
      ]
    : [pod('rivetkit-probe-wrong-token', { value: 'not-the-engine-token' }, 45_000)];
console.log(JSON.stringify({ apiVersion: 'v1', kind: 'List', items }));
