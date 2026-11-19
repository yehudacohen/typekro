// The capture must run with no network: every socket, DNS lookup and HTTP call is refused.
import '../src/offline-guard-install.ts';
import { describe, expect, it } from 'bun:test';
import net from 'node:net';
import { CONTROL_PLANE_PARAMS, captureControlPlaneValues } from '../src/generate.ts';
import { NetworkBlockedError, networkAttempts } from '../src/offline-guard.ts';

const baseValues = Object.fromEntries(
  CONTROL_PLANE_PARAMS.map((param) => [
    param.name,
    param.kind === 'string' ? param.sentinel : param.base,
  ])
);

describe('offline capture', () => {
  it('the guard refuses sockets, DNS and fetch', async () => {
    expect(() => net.connect(443, 'example.com')).toThrow(NetworkBlockedError);
    await expect(fetch('https://example.com')).rejects.toBeInstanceOf(NetworkBlockedError);
  });

  it("captures Alchemy's control-plane layer without any network attempt", async () => {
    const before = networkAttempts().length;
    const capture = await captureControlPlaneValues(baseValues);
    expect(capture.manifests.map((item) => item.logicalId)).toEqual([
      'RivetApiService',
      'RivetEngines',
      'RivetPeerService',
      'RivetTokenSecret',
    ]);
    expect(networkAttempts().slice(before)).toEqual([]);
  });
});
