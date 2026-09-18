/**
 * Unit tests for src/core/deployment/k8s-helpers.ts
 *
 * Tests error classification, media type extraction, resource patching,
 * and resource enhancement utilities.
 */

import { describe, expect, it, type mock } from 'bun:test';
import {
  classifyApiReadError,
  classifyReadError,
  describeReadError,
  enhanceResourceForEvaluation,
  extractAcceptedMediaTypes,
  isNotFoundError,
  isUnsupportedMediaTypeError,
  patchResourceWithCorrectContentType,
  TLS_CERTIFICATE_CODES,
  TLS_PROTOCOL_CONFIGURATION_CODES,
} from '../../src/core/deployment/k8s-helpers.js';
import { PollTimeoutError, RequestTimeoutError } from '../../src/core/deployment/poll-timeout.js';
import { PrematureCloseError } from '../../src/core/kubernetes/bun-http-library.js';
import type { KubernetesApiError } from '../../src/core/types.js';
import { createK8sError, createMockK8sApi } from '../utils/mock-factories.js';

// =============================================================================
// isNotFoundError
// =============================================================================

describe('isNotFoundError', () => {
  it('returns true when statusCode is 404', () => {
    const error = createK8sError('Not Found', 404);
    expect(isNotFoundError(error)).toBe(true);
  });

  it('returns true when body.code is 404', () => {
    const error: KubernetesApiError = { body: { code: 404 } };
    expect(isNotFoundError(error)).toBe(true);
  });

  it("returns true when the Status body's reason is NotFound", () => {
    // The API server always sets `reason` on a Status; some client paths hand
    // the body on without the numeric code, and a deletion gate that missed
    // this shape would keep polling a resource that is already gone.
    const error: KubernetesApiError = { body: { reason: 'NotFound', message: 'not found' } };
    expect(isNotFoundError(error)).toBe(true);
  });

  it('returns false for a 500 status code', () => {
    const error = createK8sError('Internal Server Error', 500);
    expect(isNotFoundError(error)).toBe(false);
  });

  it('returns false for a 403, so an auth failure never reads as absence', () => {
    const error = createK8sError('Forbidden', 403);
    expect(isNotFoundError(error)).toBe(false);
  });

  it('returns false for a 415 status code', () => {
    const error = createK8sError('Unsupported Media Type', 415);
    expect(isNotFoundError(error)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isNotFoundError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isNotFoundError(undefined)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isNotFoundError('not found')).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isNotFoundError(404)).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isNotFoundError({})).toBe(false);
  });
});

// =============================================================================
// classifyReadError
// =============================================================================

describe('classifyReadError', () => {
  it('treats a bare 404 as a retryable missing object', () => {
    const assessment = classifyReadError({ statusCode: 404 });

    expect(assessment.classification).toBe('object-not-found');
    expect(assessment.retryable).toBe(true);
    expect(assessment.statusCode).toBe(404);
  });

  it('treats a 404 that names the object as a retryable missing object', () => {
    const assessment = classifyReadError({
      statusCode: 404,
      body: {
        code: 404,
        reason: 'NotFound',
        message: 'services "chart-service" not found',
        details: { name: 'chart-service', kind: 'services' },
      },
    });

    expect(assessment.classification).toBe('object-not-found');
    expect(assessment.retryable).toBe(true);
    expect(assessment.detail).toContain('chart-service');
  });

  it('treats a 404 for an unserved path as a permanent unknown resource type', () => {
    // The API server has no object to name when the type itself is not served.
    const assessment = classifyReadError({
      statusCode: 404,
      body: {
        code: 404,
        reason: 'NotFound',
        message: 'the server could not find the requested resource',
        details: {},
      },
    });

    expect(assessment.classification).toBe('unknown-resource-type');
    expect(assessment.retryable).toBe(false);
  });

  it('treats a structured NotFound that names nothing as a permanent unknown resource type', () => {
    const assessment = classifyReadError({
      statusCode: 404,
      body: { code: 404, reason: 'NotFound', details: {} },
    });

    expect(assessment.classification).toBe('unknown-resource-type');
    expect(assessment.retryable).toBe(false);
  });

  it('treats the client-side discovery miss as a permanent unknown resource type', () => {
    // KubernetesObjectApi refuses to build a URL for a kind missing from discovery, with no status.
    const assessment = classifyReadError(
      new Error('Unrecognized API version and kind: example.com/v1 Widget')
    );

    expect(assessment.classification).toBe('unknown-resource-type');
    expect(assessment.retryable).toBe(false);
    expect(assessment.statusCode).toBeUndefined();
  });

  it.each([401, 403])('fails fast on %i', (statusCode) => {
    const assessment = classifyReadError(createK8sError('Forbidden', statusCode));

    expect(assessment.classification).toBe('permission-denied');
    expect(assessment.retryable).toBe(false);
    expect(assessment.summary).toBe(`permission denied (HTTP ${statusCode})`);
  });

  it.each([400, 405, 422])('fails fast on %i', (statusCode) => {
    const assessment = classifyReadError(createK8sError('Rejected', statusCode));

    expect(assessment.classification).toBe('invalid-request');
    expect(assessment.retryable).toBe(false);
  });

  it.each([408, 429, 500, 502, 503, 504])('retries %i', (statusCode) => {
    const assessment = classifyReadError(createK8sError('Server trouble', statusCode));

    expect(assessment.classification).toBe('transient');
    expect(assessment.retryable).toBe(true);
  });

  it('retries a transport failure that carries no status code', () => {
    const assessment = classifyReadError(new Error('connect ECONNREFUSED 127.0.0.1:6443'));

    expect(assessment.classification).toBe('transient');
    expect(assessment.retryable).toBe(true);
  });

  it('fails fast on a programming error with no Kubernetes shape', () => {
    const assessment = classifyReadError(new TypeError('resourceRef.metadata is undefined'));

    expect(assessment.classification).toBe('not-a-kubernetes-error');
    expect(assessment.retryable).toBe(false);
    expect(assessment.summary).toBe('not a Kubernetes API error');
    expect(assessment.detail).toContain('resourceRef.metadata is undefined');
  });

  // A request that never got an answer is as transient as the HTTP 408 this classifier already
  // retries, however it was spelled. Neither shape below carries a status code, so without explicit
  // recognition both land in `not-a-kubernetes-error` and a retry loop gives up on a blip.
  const unanswered: [string, () => unknown][] = [
    [
      'a bare RequestTimeoutError from the socket timer',
      () => new RequestTimeoutError('HTTP request timeout: GET /api/v1/namespaces/default', 30_000),
    ],
    [
      'a PollTimeoutError from a deadline wrapper',
      () => new PollTimeoutError('read ConfigMap/app-config', 30_000),
    ],
    [
      'a PrematureCloseError from a mid-response disconnect',
      () => new PrematureCloseError('GET', '/api/v1/namespaces/default', 12, 'body truncated'),
    ],
    [
      // Node sets the `code`; the message is just `read ECONNRESET`, which no message sniff matches.
      'a socket reset identified only by its code',
      () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    ],
    [
      'a DNS failure identified only by its code',
      () => Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' }),
    ],
    [
      'a connect timeout identified only by its code',
      () => Object.assign(new Error('connect failed'), { code: 'ETIMEDOUT' }),
    ],
    [
      'a DNS failure Node reported through fetch()',
      () => new TypeError('fetch failed', { cause: { code: 'EAI_AGAIN' } }),
    ],
    [
      // Node's `fetch()` hides every transport failure behind the same opaque message, so the
      // retryable ones must still be found through `cause`.
      'a socket reset Node reported through fetch()',
      () => new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }),
    ],
  ];

  for (const [label, makeError] of unanswered) {
    it(`retries ${label}`, () => {
      const assessment = classifyReadError(makeError());

      expect(assessment.classification).toBe('transient');
      expect(assessment.retryable).toBe(true);
    });
  }

  // -------------------------------------------------------------------------
  // A REJECTED TLS HANDSHAKE IS A CONFIGURATION FACT, NOT A BLIP.
  //
  // The wrong CA bundle, a stale kubeconfig, an expired or misnamed server certificate, a
  // plain-HTTP endpoint addressed as HTTPS: each reads identically on every attempt. Retrying them
  // for a 5–25 minute readiness budget only buries the cause under a timeout, and this classifier
  // is shared with the engine's external-reference resolver, whose policy is fail-fast.
  // -------------------------------------------------------------------------
  const tlsFailures: [string, () => unknown][] = [
    [
      'an expired server certificate',
      () => Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }),
    ],
    [
      'a certificate that does not name the host',
      () =>
        Object.assign(new Error("Hostname/IP does not match certificate's altnames"), {
          code: 'ERR_TLS_CERT_ALTNAME_INVALID',
        }),
    ],
    [
      'a self-signed certificate in the chain',
      () =>
        Object.assign(new Error('self signed certificate in certificate chain'), {
          code: 'SELF_SIGNED_CERT_IN_CHAIN',
        }),
    ],
    [
      // A handshake the two ends cannot perform at all — persistent, not transient.
      'a protocol mismatch',
      () => Object.assign(new Error('write EPROTO'), { code: 'EPROTO' }),
    ],
    [
      // The shape that matters most: Node's `fetch()` reports this as a bare `TypeError` whose
      // message mentions `fetch`, which `isRetryableError` retries. The `cause` code must be read
      // BEFORE that rule or a permanent TLS failure is retried to the deadline.
      'a rejected certificate Node reported through fetch()',
      () => new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } }),
    ],
  ];

  for (const [label, makeError] of tlsFailures) {
    it(`fails fast on ${label}`, () => {
      const assessment = classifyReadError(makeError());

      expect(assessment.classification).toBe('tls-configuration-error');
      expect(assessment.retryable).toBe(false);
      expect(assessment.summary).toBe('TLS configuration error');
    });
  }

  it('names the TLS code and what to check, so `fetch failed` is not the whole diagnosis', () => {
    const assessment = classifyReadError(
      new TypeError('fetch failed', { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } })
    );

    expect(assessment.detail).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(assessment.detail).toContain('check the cluster CA / server certificate');
  });

  it('points a protocol mismatch at the URL and version settings, not at the CA bundle', () => {
    // `ERR_SSL_WRONG_VERSION_NUMBER` means the peer is not speaking TLS at all — an `https://`
    // server URL aimed at a plain-HTTP listener. Telling the operator to check their certificates
    // would send them to the one thing that is not wrong.
    const assessment = classifyReadError(
      new TypeError('fetch failed', { cause: { code: 'ERR_SSL_WRONG_VERSION_NUMBER' } })
    );

    expect(assessment.detail).toContain('ERR_SSL_WRONG_VERSION_NUMBER');
    expect(assessment.detail).toContain('check the server URL scheme / port');
    expect(assessment.detail).not.toContain('cluster CA');
  });

  // Node's own `ERR_TLS_*` namespace is configuration / security-state: `ERR_TLS_DH_PARAM_SIZE` is the
  // peer offering too small a Diffie-Hellman parameter — a server setting, not a passing fault. It is
  // in neither explicit set, so only the `ERR_TLS_` prefix rule keeps it out of the retry loop.
  it('fails fast on a fetch-wrapped ERR_TLS_DH_PARAM_SIZE via the ERR_TLS_ prefix rule', () => {
    const assessment = classifyReadError(
      new TypeError('fetch failed', { cause: { code: 'ERR_TLS_DH_PARAM_SIZE' } })
    );

    expect(assessment.classification).toBe('tls-configuration-error');
    expect(assessment.retryable).toBe(false);
    expect(assessment.detail).toContain('ERR_TLS_DH_PARAM_SIZE');
  });

  // The hint must follow the KIND of TLS failure. A code caught only by the generic `ERR_TLS_`
  // prefix says nothing about a certificate — `ERR_TLS_DH_PARAM_SIZE` is a Diffie-Hellman parameter
  // the peer offered, `ERR_TLS_INVALID_CONTEXT` a local API misuse — so sending the operator to the
  // CA bundle points at the one thing that is not wrong.
  const genericErrTlsCodes = [
    'ERR_TLS_DH_PARAM_SIZE',
    'ERR_TLS_INVALID_CONTEXT',
    'ERR_TLS_PROTOCOL_VERSION_CONFLICT',
  ];

  for (const code of genericErrTlsCodes) {
    it(`points ${code} at the TLS configuration, not at the CA bundle`, () => {
      const assessment = classifyReadError(new TypeError('fetch failed', { cause: { code } }));

      expect(assessment.detail).toContain(code);
      expect(assessment.detail).toContain('check the client/server TLS configuration');
      expect(assessment.detail).not.toContain('cluster CA');
      expect(assessment.detail).not.toContain('server URL scheme');
    });
  }

  // …and the prefix rule must NOT swallow the one `ERR_TLS_*` member that is a passing condition.
  it('keeps a fetch-wrapped ERR_TLS_HANDSHAKE_TIMEOUT retryable', () => {
    const assessment = classifyReadError(
      new TypeError('fetch failed', { cause: { code: 'ERR_TLS_HANDSHAKE_TIMEOUT' } })
    );

    expect(assessment.classification).toBe('transient');
    expect(assessment.retryable).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // The classification must be COMPLETE, not a hand-picked sample.
  //
  // Every one of these arrives from Node's `fetch()` as the same opaque
  // `TypeError: fetch failed` with the real code on `cause`, and `isRetryableError`'s last rule
  // retries ANY `TypeError` mentioning `fetch`. So a code the classifier does not recognise is not
  // merely unclassified — it is actively RETRIED, polling a permanently rejected handshake until
  // the readiness budget expires and then reporting a timeout that hides the cause. The fetch-
  // wrapped shape is therefore the one these are asserted through.
  // ---------------------------------------------------------------------------
  const namedFetchWrappedTlsCodes: [string, string][] = [
    // The code that motivated the round-8 widening: a REVOKED certificate. Node documents it, the
    // original hand-list omitted it, and nothing else in the chain would have stopped it.
    ['CERT_REVOKED', 'a revoked server certificate'],
    // Undici's protocol-mismatch code, likewise absent from the original list.
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'an endpoint that is not speaking TLS'],
  ];

  for (const [code, label] of namedFetchWrappedTlsCodes) {
    it(`fails fast on ${label} (${code}) reported through fetch()`, () => {
      const assessment = classifyReadError(new TypeError('fetch failed', { cause: { code } }));

      expect(assessment.classification).toBe('tls-configuration-error');
      expect(assessment.retryable).toBe(false);
      expect(assessment.detail).toContain(code);
    });
  }

  // Membership is asserted directly, not just through the classifier, because
  // `isTlsConfigurationCode` also has an unknown-`CERT_`-prefix fallback: without these, deleting
  // `CERT_REVOKED` from the explicit set would leave every behavioural test above still passing.
  const mutationSentinels: [ReadonlySet<string>, string][] = [
    [TLS_CERTIFICATE_CODES, 'CERT_REVOKED'],
    [TLS_CERTIFICATE_CODES, 'CRL_HAS_EXPIRED'],
    [TLS_CERTIFICATE_CODES, 'HOSTNAME_MISMATCH'],
    [TLS_CERTIFICATE_CODES, 'ERR_TLS_CERT_ALTNAME_INVALID'],
    [TLS_PROTOCOL_CONFIGURATION_CODES, 'EPROTO'],
    [TLS_PROTOCOL_CONFIGURATION_CODES, 'ERR_SSL_WRONG_VERSION_NUMBER'],
  ];

  for (const [set, code] of mutationSentinels) {
    it(`lists ${code} explicitly, not only via a prefix rule`, () => {
      expect(set.has(code)).toBe(true);
    });
  }

  it('does not treat OpenSSL OUT_OF_MEM as a certificate verdict', () => {
    // It sits in the same doc section, but it reports a resource shortage rather than anything
    // about the certificate — the one member of that section that can read differently next time.
    expect(TLS_CERTIFICATE_CODES.has('OUT_OF_MEM')).toBe(false);
  });

  const everyTlsCode = [...TLS_CERTIFICATE_CODES, ...TLS_PROTOCOL_CONFIGURATION_CODES];

  for (const code of everyTlsCode) {
    it(`never retries ${code}, even behind \`fetch failed\``, () => {
      const assessment = classifyReadError(new TypeError('fetch failed', { cause: { code } }));

      expect(assessment.classification).toBe('tls-configuration-error');
      expect(assessment.retryable).toBe(false);
    });
  }

  it('treats an unrecognised CERT_* code as a certificate verdict', () => {
    // Every `CERT_*` code OpenSSL defines is a verification RESULT, so one this list has not caught
    // up with is better named and failed fast than polled to the deadline.
    const assessment = classifyReadError(
      new TypeError('fetch failed', { cause: { code: 'CERT_SOMETHING_OPENSSL_ADDED_LATER' } })
    );

    expect(assessment.classification).toBe('tls-configuration-error');
    expect(assessment.retryable).toBe(false);
  });

  // Positive controls: the widening must not swallow the genuinely transient transport failures.
  // These share the exact `TypeError: fetch failed` shape, so if the TLS branch were too greedy a
  // dropped socket or a DNS blip would become a hard deployment failure.
  const retryableFetchWrappedCodes = ['ECONNRESET', 'EAI_AGAIN'];

  for (const code of retryableFetchWrappedCodes) {
    it(`still retries ${code} behind \`fetch failed\``, () => {
      const assessment = classifyReadError(new TypeError('fetch failed', { cause: { code } }));

      expect(assessment.classification).toBe('transient');
      expect(assessment.retryable).toBe(true);
    });
  }

  it('still fails fast on a status-bearing error whose `code` is a string', () => {
    // The system-code recognition must not outrank a definitive answer from the server.
    const assessment = classifyReadError(
      Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ECONNRESET' })
    );

    expect(assessment.classification).toBe('permission-denied');
    expect(assessment.retryable).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // AN HTTP STATUS OUTRANKS EVERY TRANSPORT HEURISTIC.
  //
  // If there is a status, the API server ANSWERED — the request reached it and it formed a
  // verdict — so a `code` or a message that merely LOOKS like a transport failure cannot overturn
  // that. Both kinds of evidence really do co-occur: a client can leave a system `code` on a
  // status-bearing error, and Node's `fetch()` shape is a `TypeError` mentioning `fetch`, which
  // `isRetryableError`'s last rule retries regardless of any status it carries. Deciding on the
  // transport evidence first therefore polled requests the server had already REJECTED until the
  // readiness budget expired, and then reported a timeout instead of the rejection.
  // ---------------------------------------------------------------------------
  const statusOutranksTransport: [string, () => unknown][] = [
    [
      'a 422 that also carries a socket-reset `code`',
      () => Object.assign(new Error('read ECONNRESET'), { statusCode: 422, code: 'ECONNRESET' }),
    ],
    [
      // The shape `isRetryableError` retries on its message alone, status or no status.
      'a 400 reported through the opaque `fetch failed` TypeError',
      () => Object.assign(new TypeError('fetch failed'), { statusCode: 400 }),
    ],
  ];

  for (const [label, makeError] of statusOutranksTransport) {
    it(`classifies ${label} by its status, not its transport shape`, () => {
      const assessment = classifyReadError(makeError());

      expect(assessment.classification).toBe('invalid-request');
      expect(assessment.retryable).toBe(false);
    });
  }

  it('still retries a 503 whose message looks like a transport failure', () => {
    // The positive control for the rule above: status-first must not make every status-bearing
    // error permanent — a retryable status stays retryable however the message reads.
    const assessment = classifyReadError(
      Object.assign(new Error('read ECONNRESET'), { statusCode: 503, code: 'ECONNRESET' })
    );

    expect(assessment.classification).toBe('transient');
    expect(assessment.retryable).toBe(true);
  });

  it('retries a 429 rate limit', () => {
    const assessment = classifyReadError(createK8sError('Too Many Requests', 429));

    expect(assessment.classification).toBe('transient');
    expect(assessment.retryable).toBe(true);
  });

  it.each([418, 409])('fails fast on an unlisted 4xx (%i)', (statusCode) => {
    // Every client error the server answered with is the server's verdict on the request, whether
    // or not this classifier has a name for that particular code.
    const assessment = classifyReadError(createK8sError('Client error', statusCode));

    expect(assessment.classification).toBe('invalid-request');
    expect(assessment.retryable).toBe(false);
  });

  it('keeps the TLS verdict for a handshake failure that never produced a status', () => {
    // The status-first rule must not shadow the TLS branch: a rejected handshake has no status at
    // all, so the branch below it is still the one that runs.
    const assessment = classifyReadError(
      new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } })
    );

    expect(assessment.classification).toBe('tls-configuration-error');
    expect(assessment.statusCode).toBeUndefined();
  });
});

// =============================================================================
// classifyApiReadError
// =============================================================================

describe('classifyApiReadError', () => {
  // The answer/no-answer taxonomy is ordered on the SAME invariant as `classifyReadError`: a
  // status means the server answered, so no transport heuristic may overturn it. The stake is
  // higher here, because "was the server reached?" is this taxonomy's entire subject — calling a
  // status-bearing rejection `unreachable` puts the opposite of what the status proves into a log
  // line about the cluster, and into capability discovery's record of why a lookup failed.
  it('reports a status-bearing rejection as an answer, not as an unreachable server', () => {
    const failure = classifyApiReadError(
      Object.assign(new Error('read ECONNRESET'), { statusCode: 422, code: 'ECONNRESET' })
    );

    expect(failure).toBe('other');
  });

  it('does not let a `fetch failed` message overturn a 400', () => {
    expect(
      classifyApiReadError(Object.assign(new TypeError('fetch failed'), { statusCode: 400 }))
    ).toBe('other');
  });

  it('does not let a timeout-shaped message overturn a 500', () => {
    const failure = classifyApiReadError(
      Object.assign(new Error('operation timed out'), { statusCode: 500 })
    );

    expect(failure).toBe('other');
  });

  // The statuses the taxonomy DOES name still win, and the transport ladder still runs for the
  // errors that carry no status at all.
  it.each([401, 403])('still reports %i as forbidden', (statusCode) => {
    expect(classifyApiReadError(createK8sError('Forbidden', statusCode))).toBe('forbidden');
  });

  it.each([408, 504])('still reports %i as a timeout', (statusCode) => {
    expect(classifyApiReadError(createK8sError('Timeout', statusCode))).toBe('timeout');
  });

  it('still reports a 404 as the one definitive answer', () => {
    expect(classifyApiReadError(createK8sError('Not Found', 404))).toBe('notFound');
  });

  it('still reads the transport `code` when there is no status at all', () => {
    expect(
      classifyApiReadError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
    ).toBe('unreachable');
  });

  it('still reads the message when there is neither a status nor a code', () => {
    expect(classifyApiReadError(new Error('socket hang up'))).toBe('unreachable');
  });
});

// =============================================================================
// describeReadError
// =============================================================================

describe('describeReadError', () => {
  it('prefers the Status body message', () => {
    expect(
      describeReadError({
        statusCode: 403,
        message: 'HTTP request failed',
        body: { code: 403, message: 'configmaps "secrets" is forbidden' },
      })
    ).toBe('configmaps "secrets" is forbidden');
  });

  it('never yields the useless stringification of a bare status object', () => {
    // `ensureError({ statusCode: 403 })` produces `[object Object]`, which tells an operator nothing.
    const detail = describeReadError({ statusCode: 403 });

    expect(detail).not.toContain('[object Object]');
    expect(detail).toContain('403');
  });
});

// =============================================================================
// isUnsupportedMediaTypeError
// =============================================================================

describe('isUnsupportedMediaTypeError', () => {
  it('returns true when statusCode is 415', () => {
    const error = createK8sError('Unsupported Media Type', 415);
    expect(isUnsupportedMediaTypeError(error)).toBe(true);
  });

  it('returns true when response.statusCode is 415', () => {
    const error: KubernetesApiError = { response: { statusCode: 415 } };
    expect(isUnsupportedMediaTypeError(error)).toBe(true);
  });

  it('returns true when body.code is 415', () => {
    const error: KubernetesApiError = { body: { code: 415 } };
    expect(isUnsupportedMediaTypeError(error)).toBe(true);
  });

  it('returns false for a 404 status code', () => {
    const error = createK8sError('Not Found', 404);
    expect(isUnsupportedMediaTypeError(error)).toBe(false);
  });

  it('returns false for a 500 status code', () => {
    const error = createK8sError('Internal Server Error', 500);
    expect(isUnsupportedMediaTypeError(error)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isUnsupportedMediaTypeError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isUnsupportedMediaTypeError(undefined)).toBe(false);
  });

  it('returns false for a non-object', () => {
    expect(isUnsupportedMediaTypeError('error')).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isUnsupportedMediaTypeError({})).toBe(false);
  });
});

// =============================================================================
// extractAcceptedMediaTypes
// =============================================================================

describe('extractAcceptedMediaTypes', () => {
  it('extracts media types from error message with "accepted media types include:" pattern', () => {
    const error: KubernetesApiError = {
      message:
        'the body of the request was in an unknown format - accepted media types include: application/json-patch+json, application/merge-patch+json',
    };
    expect(extractAcceptedMediaTypes(error)).toEqual([
      'application/json-patch+json',
      'application/merge-patch+json',
    ]);
  });

  it('extracts media types from body.message when message is absent', () => {
    const error: KubernetesApiError = {
      body: {
        message:
          'the body of the request was in an unknown format - accepted media types include: application/merge-patch+json, application/apply-patch+yaml',
      },
    };
    expect(extractAcceptedMediaTypes(error)).toEqual([
      'application/merge-patch+json',
      'application/apply-patch+yaml',
    ]);
  });

  it('returns default types when message does not match the pattern', () => {
    const error: KubernetesApiError = { message: 'some other error' };
    expect(extractAcceptedMediaTypes(error)).toEqual([
      'application/json-patch+json',
      'application/merge-patch+json',
      'application/apply-patch+yaml',
    ]);
  });

  it('returns default types for null input', () => {
    expect(extractAcceptedMediaTypes(null)).toEqual([
      'application/json-patch+json',
      'application/merge-patch+json',
      'application/apply-patch+yaml',
    ]);
  });

  it('returns default types for undefined input', () => {
    expect(extractAcceptedMediaTypes(undefined)).toEqual([
      'application/json-patch+json',
      'application/merge-patch+json',
      'application/apply-patch+yaml',
    ]);
  });

  it('returns default types for an empty object', () => {
    expect(extractAcceptedMediaTypes({})).toEqual([
      'application/json-patch+json',
      'application/merge-patch+json',
      'application/apply-patch+yaml',
    ]);
  });

  it('extracts a single media type', () => {
    const error: KubernetesApiError = {
      message: 'accepted media types include: application/strategic-merge-patch+json',
    };
    expect(extractAcceptedMediaTypes(error)).toEqual(['application/strategic-merge-patch+json']);
  });
});

// =============================================================================
// patchResourceWithCorrectContentType
// =============================================================================

describe('patchResourceWithCorrectContentType', () => {
  it('calls k8sApi.patch with the resource and merge-patch content type', async () => {
    const patchedResource = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'test-cm', namespace: 'default' },
    };
    const k8sApi = createMockK8sApi({ patchResult: patchedResource });

    const resource = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'test-cm', namespace: 'default' },
    };

    const result = await patchResourceWithCorrectContentType(k8sApi, resource);

    expect(result).toEqual(patchedResource);

    const patchFn = k8sApi.patch as ReturnType<typeof mock>;
    expect(patchFn).toHaveBeenCalledTimes(1);
    expect(patchFn.mock.calls[0]).toEqual([
      resource,
      undefined,
      undefined,
      undefined,
      undefined,
      'application/merge-patch+json',
    ]);
  });

  it('logs Secret metadata without exposing data', async () => {
    const k8sApi = createMockK8sApi();

    const secretResource = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'my-secret', namespace: 'test-ns' },
      data: { password: 'c2VjcmV0' },
    };

    // Should not throw — the logger.debug call should handle Secret metadata
    await patchResourceWithCorrectContentType(k8sApi, secretResource);

    const patchFn = k8sApi.patch as ReturnType<typeof mock>;
    expect(patchFn).toHaveBeenCalledTimes(1);
    // Verify the resource was passed through to patch
    expect(patchFn.mock.calls[0]?.[0]).toBe(secretResource);
  });

  it('handles non-Secret resources without special logging', async () => {
    const k8sApi = createMockK8sApi();

    const resource = {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'my-deploy', namespace: 'default' },
    };

    await patchResourceWithCorrectContentType(k8sApi, resource);

    const patchFn = k8sApi.patch as ReturnType<typeof mock>;
    expect(patchFn).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// enhanceResourceForEvaluation
// =============================================================================

describe('enhanceResourceForEvaluation', () => {
  it('adds Ready condition for OCI HelmRepository with metadata', () => {
    const resource = {
      spec: { type: 'oci' },
      status: { conditions: [] },
      metadata: { generation: 1, resourceVersion: '12345' },
    };

    const result = enhanceResourceForEvaluation(resource, 'HelmRepository');

    expect(result.status?.conditions).toHaveLength(1);
    expect(result.status?.conditions?.[0]).toEqual({
      type: 'Ready',
      status: 'True',
      message: 'OCI repository is functional',
      reason: 'OciRepositoryProcessed',
    });
  });

  it('preserves existing conditions when adding Ready', () => {
    const resource = {
      spec: { type: 'oci' },
      status: {
        conditions: [{ type: 'Stalled', status: 'False' }],
      },
      metadata: { generation: 2, resourceVersion: '67890' },
    };

    const result = enhanceResourceForEvaluation(resource, 'HelmRepository');

    expect(result.status?.conditions).toHaveLength(2);
    expect(result.status?.conditions?.[0]).toEqual({
      type: 'Stalled',
      status: 'False',
    });
    expect(result.status?.conditions?.[1]).toEqual({
      type: 'Ready',
      status: 'True',
      message: 'OCI repository is functional',
      reason: 'OciRepositoryProcessed',
    });
  });

  it('returns unchanged for non-OCI HelmRepository', () => {
    const resource = {
      spec: { type: 'default' },
      status: { conditions: [] },
      metadata: { generation: 1, resourceVersion: '12345' },
    };

    const result = enhanceResourceForEvaluation(resource, 'HelmRepository');

    expect(result).toBe(resource);
  });

  it('returns unchanged for HelmRepository without spec.type', () => {
    const resource = {
      spec: {},
      status: { conditions: [] },
      metadata: { generation: 1, resourceVersion: '12345' },
    };

    const result = enhanceResourceForEvaluation(resource, 'HelmRepository');

    expect(result).toBe(resource);
  });

  it('returns unchanged for non-HelmRepository kinds', () => {
    const resource = {
      spec: { type: 'oci' },
      status: { conditions: [] },
      metadata: { generation: 1, resourceVersion: '12345' },
    };

    const result = enhanceResourceForEvaluation(resource, 'Deployment');

    expect(result).toBe(resource);
  });

  it('returns unchanged when Ready condition already exists', () => {
    const resource = {
      spec: { type: 'oci' },
      status: {
        conditions: [{ type: 'Ready', status: 'True' }],
      },
      metadata: { generation: 1, resourceVersion: '12345' },
    };

    const result = enhanceResourceForEvaluation(resource, 'HelmRepository');

    expect(result).toBe(resource);
  });

  it('returns unchanged for OCI HelmRepository without generation', () => {
    const resource = {
      spec: { type: 'oci' },
      status: { conditions: [] },
      metadata: { resourceVersion: '12345' },
    };

    const result = enhanceResourceForEvaluation(resource, 'HelmRepository');

    expect(result).toBe(resource);
  });

  it('returns unchanged for OCI HelmRepository without resourceVersion', () => {
    const resource = {
      spec: { type: 'oci' },
      status: { conditions: [] },
      metadata: { generation: 1 },
    };

    const result = enhanceResourceForEvaluation(resource, 'HelmRepository');

    expect(result).toBe(resource);
  });

  it('returns unchanged for OCI HelmRepository without metadata', () => {
    const resource = {
      spec: { type: 'oci' },
      status: { conditions: [] },
    };

    const result = enhanceResourceForEvaluation(resource, 'HelmRepository');

    expect(result).toBe(resource);
  });

  it('does not mutate the original resource', () => {
    const resource = {
      spec: { type: 'oci' },
      status: { conditions: [] },
      metadata: { generation: 1, resourceVersion: '12345' },
    };

    const result = enhanceResourceForEvaluation(resource, 'HelmRepository');

    // Result is a new object
    expect(result).not.toBe(resource);
    // Original is not mutated
    expect(resource.status.conditions).toHaveLength(0);
  });
});
