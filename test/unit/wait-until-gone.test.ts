/**
 * Unit tests for the integration suites' absence poller.
 *
 * `waitUntilGone` gates every deletion assertion in the Traefik/Gateway API
 * suites, so its error classification is pinned here rather than only being
 * exercised when a cluster happens to be available. The bug these guard
 * against: a poller that returned `true` for ANY thrown error, which passed a
 * deletion assertion on a 5xx, a timeout or an auth failure.
 */
import { describe, expect, it } from 'bun:test';

import { waitUntilGone } from '../integration/shared-absence.js';

/** A `@kubernetes/client-node` API error as the client surfaces it. */
function apiError(statusCode: number, reason: string): Error & { statusCode: number } {
  return Object.assign(new Error(`HTTP request failed: ${reason}`), {
    statusCode,
    body: { code: statusCode, reason },
  });
}

describe('waitUntilGone', () => {
  it('reports gone on a 404', async () => {
    expect(await waitUntilGone(() => Promise.reject(apiError(404, 'NotFound')), 1_000)).toBe(true);
  });

  it('reports gone on a Status body whose reason is NotFound but carries no code', async () => {
    const error = Object.assign(new Error('resources.kro.run "x" not found'), {
      body: { reason: 'NotFound', message: 'not found' },
    });

    expect(await waitUntilGone(() => Promise.reject(error), 1_000)).toBe(true);
  });

  it('re-throws a 500 instead of passing the deletion assertion', async () => {
    const error = apiError(500, 'InternalError');

    await expect(waitUntilGone(() => Promise.reject(error), 1_000)).rejects.toBe(error);
  });

  it('re-throws a 403 instead of reading an auth failure as absence', async () => {
    const error = apiError(403, 'Forbidden');

    await expect(waitUntilGone(() => Promise.reject(error), 1_000)).rejects.toBe(error);
  });

  it('re-throws a transport failure that carries no status code', async () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:6443');

    await expect(waitUntilGone(() => Promise.reject(error), 1_000)).rejects.toBe(error);
  });

  it('re-throws immediately, without waiting out the poll interval', async () => {
    const error = apiError(500, 'InternalError');
    const started = Date.now();

    await expect(
      waitUntilGone(() => Promise.reject(error), 60_000, { pollIntervalMs: 30_000 })
    ).rejects.toBe(error);

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('keeps polling while the read resolves, then reports still-present on timeout', async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return { metadata: { name: 'still-here' } };
    };

    expect(await waitUntilGone(read, 60, { pollIntervalMs: 1 })).toBe(false);
    // More than one read is what distinguishes polling from a single check.
    expect(reads).toBeGreaterThan(1);
  });

  it('reports gone as soon as a resolving read starts rejecting with a 404', async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      if (reads < 3) return { metadata: { name: 'terminating' } };
      throw apiError(404, 'NotFound');
    };

    expect(await waitUntilGone(read, 10_000, { pollIntervalMs: 1 })).toBe(true);
    expect(reads).toBe(3);
  });
});
