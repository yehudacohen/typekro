// Throwaway PKI for hermetic TLS tests: a private CA, a server certificate for 127.0.0.1 and
// localhost, a client certificate, and a kubeconfig that uses them. Everything is generated at
// test time with the `openssl` CLI (OpenSSL or LibreSSL) in a temporary directory that is removed
// before returning. Nothing here is ever written to the repository.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// LibreSSL takes the subject from the config's [dn] section even when `-subj` is given, so each
// certificate gets its own config with its common name.
const opensslConfig = (commonName) => `
[req]
distinguished_name = dn
prompt = no
[dn]
CN = ${commonName}
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1,DNS:localhost
[client]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = clientAuth
`;

/**
 * Generate a private CA and a server and client certificate it signs.
 *
 * @param {{ clientCommonName?: string }} [options]
 * @returns {{ caCert: string, serverCert: string, serverKey: string, clientCert: string, clientKey: string }}
 */
export function createTestPki(options = {}) {
  const clientCommonName = options.clientCommonName ?? 'typekro-test-client';
  const directory = mkdtempSync(join(tmpdir(), 'typekro-test-pki-'));
  const file = (name) => join(directory, name);
  const openssl = (...args) => execFileSync('openssl', args, { cwd: directory, stdio: 'pipe' });
  try {
    writeFileSync(file('ca.cnf'), opensslConfig('TypeKro Test CA'));
    openssl(
      'req', '-x509', '-new', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-config', 'ca.cnf', '-extensions', 'ca', '-keyout', 'ca.key', '-out', 'ca.crt'
    );
    const issue = (name, commonName, serial) => {
      writeFileSync(file(`${name}.cnf`), opensslConfig(commonName));
      openssl(
        'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-config', `${name}.cnf`,
        '-keyout', `${name}.key`, '-out', `${name}.csr`
      );
      openssl(
        'x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key',
        '-set_serial', serial, '-days', '1', '-extfile', `${name}.cnf`, '-extensions', name,
        '-out', `${name}.crt`
      );
    };
    issue('server', 'localhost', '1001');
    issue('client', clientCommonName, '1002');
    const read = (name) => readFileSync(file(name), 'utf8');
    return {
      caCert: read('ca.crt'),
      serverCert: read('server.crt'),
      serverKey: read('server.key'),
      clientCert: read('client.crt'),
      clientKey: read('client.key'),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * A kubeconfig (YAML) for `server` that trusts `caCert` and, when given, authenticates with the
 * client certificate and key.
 *
 * @param {{ server: string, caCert: string, clientCert?: string, clientKey?: string }} options
 * @returns {string}
 */
export function testKubeconfig({ server, caCert, clientCert, clientKey }) {
  const b64 = (pem) => Buffer.from(pem, 'utf8').toString('base64');
  const user =
    clientCert && clientKey
      ? `    client-certificate-data: ${b64(clientCert)}\n    client-key-data: ${b64(clientKey)}\n`
      : '    {}\n';
  return (
    'apiVersion: v1\n' +
    'kind: Config\n' +
    'clusters:\n' +
    '- name: test\n' +
    '  cluster:\n' +
    `    server: ${server}\n` +
    `    certificate-authority-data: ${b64(caCert)}\n` +
    'users:\n' +
    '- name: test\n' +
    '  user:\n' +
    user +
    'contexts:\n' +
    '- name: test\n' +
    '  context:\n' +
    '    cluster: test\n' +
    '    user: test\n' +
    'current-context: test\n'
  );
}
