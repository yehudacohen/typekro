export interface TestPki {
  caCert: string;
  serverCert: string;
  serverKey: string;
  clientCert: string;
  clientKey: string;
}

export function createTestPki(options?: { clientCommonName?: string }): TestPki;

export function testKubeconfig(options: {
  server: string;
  caCert: string;
  clientCert?: string;
  clientKey?: string;
}): string;
