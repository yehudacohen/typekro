// A minimal Kubernetes-shaped HTTPS server that requires a client certificate, for hermetic TLS
// tests. It answers `GET /api/v1/namespaces/default` and streams one event for a watch on
// `/api/v1/namespaces/default/events`, and records the client certificate CN of every request.
//
// Imported, `startMtlsTestServer(pki)` runs it in-process. Run as a script (`node
// mtls-test-server.mjs`), it reads the PKI as JSON on stdin, prints `{"port":N}` once listening and
// `{"path":...,"clientCn":...}` per request on stdout, and exits when stdin closes. Bun tests use
// the script form so the server side is Node's own TLS stack.
import * as https from 'node:https';
import { fileURLToPath } from 'node:url';

function handle(req, res, onRequest) {
  const subject = req.socket.getPeerCertificate()?.subject;
  const url = new URL(req.url ?? '/', 'https://127.0.0.1');
  onRequest({ path: url.pathname, clientCn: subject?.CN });
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/api/v1/namespaces/default' && url.searchParams.get('watch') !== 'true') {
    res.end(JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'default' } }));
    return;
  }
  if (url.pathname === '/api/v1/namespaces/default/events' && url.searchParams.get('watch')) {
    const event = { kind: 'Event', metadata: { name: 'scheduled', namespace: 'default' } };
    res.end(`${JSON.stringify({ type: 'ADDED', object: event })}\n`);
    return;
  }
  res.statusCode = 404;
  res.end('{"kind":"Status","code":404}');
}

/**
 * @param {{ caCert: string, serverCert: string, serverKey: string }} pki
 * @param {(request: { path: string, clientCn: string | undefined }) => void} [onRequest]
 * @returns {Promise<{ url: string, port: number, seen: Array<{ path: string, clientCn: string | undefined }>, close: () => Promise<void> }>}
 */
export async function startMtlsTestServer(pki, onRequest = () => {}) {
  const seen = [];
  const server = https.createServer(
    {
      key: pki.serverKey,
      cert: pki.serverCert,
      ca: pki.caCert,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) =>
      handle(req, res, (request) => {
        seen.push(request);
        onRequest(request);
      })
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `https://127.0.0.1:${port}`,
    port,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = '';
  let started;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    const newline = input.indexOf('\n');
    if (started || newline < 0) return;
    started = startMtlsTestServer(JSON.parse(input.slice(0, newline)), (request) =>
      process.stdout.write(`${JSON.stringify(request)}\n`)
    ).then((running) => {
      process.stdout.write(`${JSON.stringify({ port: running.port })}\n`);
      return running;
    });
  });
  process.stdin.on('end', async () => {
    await (await started)?.close();
    process.exit(0);
  });
}
