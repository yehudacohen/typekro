/**
 * Kubernetes API Helpers - Utility functions for K8s API interactions
 *
 * Extracted from engine.ts. Contains error classification, media type handling,
 * and resource patching utilities.
 */

import type * as k8s from '@kubernetes/client-node';
import {
  formatKubernetesError,
  getErrorDetails,
  getErrorStatusCode,
  isRetryableError,
  RETRYABLE_STATUS_CODES,
} from '../kubernetes/errors.js';
import { getComponentLogger } from '../logging/index.js';
import type { KubernetesApiError } from '../types.js';
import { isRequestTimeoutError } from './poll-timeout.js';

const logger = getComponentLogger('k8s-helpers');

/**
 * Check if an error is a "not found" error (HTTP 404)
 */
export function isNotFoundError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    // Cover every shape the @kubernetes/client-node stack surfaces a 404 as:
    // `statusCode` (typed API errors), `body.code` (parsed Status body), the
    // bare `code` some code paths set, and `body.reason` — the Status object's
    // own machine-readable reason, which is what the API server sets and which
    // `kro-readiness.ts` already reads. The KRO teardown reads all of them, so
    // the engine's shared 404 check must too or a gate would miss a real 404.
    const k8sError = error as KubernetesApiError & { code?: number };
    return (
      k8sError.statusCode === 404 ||
      k8sError.response?.statusCode === 404 ||
      k8sError.body?.code === 404 ||
      k8sError.code === 404 ||
      k8sError.body?.reason === 'NotFound' ||
      (typeof k8sError.message === 'string' && k8sError.message.includes('HTTP-Code: 404'))
    );
  }
  return false;
}

/**
 * Check if an error is an HTTP 409 Conflict error — e.g. an optimistic-concurrency
 * failure when a PATCH/PUT carries a `metadata.resourceVersion` that no longer
 * matches the server (the object was modified between read and write), or an
 * AlreadyExists on a create (create-first namespace ownership).
 *
 * Covers ALL four shapes the @kubernetes/client-node stack surfaces a 409 as —
 * `statusCode` (typed API errors), `response.statusCode` (the http-layer error),
 * `body.code` (parsed Status body), and the bare `code` some code paths set —
 * mirroring {@link isNotFoundError} so no gate misses a real 409.
 */
export function isConflictError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const k8sError = error as KubernetesApiError & { code?: number };
    return (
      k8sError.statusCode === 409 ||
      k8sError.response?.statusCode === 409 ||
      k8sError.body?.code === 409 ||
      k8sError.code === 409 ||
      (typeof k8sError.message === 'string' && k8sError.message.includes('HTTP-Code: 409'))
    );
  }
  return false;
}

/**
 * Why a read against the API server did not produce an answer.
 *
 * `notFound` is the only *definitive* outcome in this list: the server answered,
 * and the answer was "that does not exist". Every other member means the
 * question was never actually put to the server, so a caller must not read them
 * as a negative answer. That distinction is what capability discovery keys its
 * `unserved` / `unknown` split on.
 */
export type ApiReadFailure = 'notFound' | 'forbidden' | 'timeout' | 'unreachable' | 'other';

/** Read the HTTP status off any of the shapes the client-node stack uses. */
function apiErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const k8sError = error as KubernetesApiError & { code?: number | string };
  const numericCode = typeof k8sError.code === 'number' ? k8sError.code : undefined;
  return (
    k8sError.statusCode ?? k8sError.response?.statusCode ?? k8sError.body?.code ?? numericCode
  );
}

/** The `code` string Node sets on socket/DNS/TLS errors, when there is one. */
function systemErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EPROTO',
  // TLS: the transport never came up, so the server was never asked. The
  // message keeps the certificate detail for the human reading the log.
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Transport `code`s that describe a connection which may come up on a later attempt: a refused or
 * reset socket, an unreachable route, a DNS blip, a connect timeout.
 *
 * Deliberately NOT {@link UNREACHABLE_CODES}. That set answers a different question — "did the
 * server ever answer?" — and so it also lists the TLS trust codes, which answer "did the transport
 * come up?" with a permanent no. Retrying those for a multi-minute readiness budget only hides a
 * misconfiguration behind a timeout, so the retry policy keeps its own, narrower set.
 */
const RETRYABLE_SYSTEM_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Certificate verification failures: one end refused the other's certificate.
 *
 * This is the COMPLETE set of certificate-verification codes Node documents under "OpenSSL error
 * codes" in https://nodejs.org/api/errors.html — every subsection of it (Time Validity, Trust or
 * Chain Related, Basic Extension, Name Related, Usage and Policy, Formatting) — rather than the
 * handful a reader happens to have seen. Completeness is the point: a code missing from this set
 * falls through to {@link isRetryableError}, whose last rule retries ANY `TypeError` mentioning
 * `fetch`, and Node's `fetch()` spells every one of these as exactly that. One omission therefore
 * does not degrade gracefully — it polls a revoked certificate until the deadline and reports a
 * timeout instead of the cause, which is the bug this classification exists to prevent.
 *
 * The one code in that doc section deliberately LEFT OUT is `OUT_OF_MEM`, which lives there because
 * OpenSSL can raise it during verification but describes a resource shortage, not a verdict on the
 * certificate — the only member of the section that can read differently on a later attempt.
 *
 * `ERR_TLS_CERT_ALTNAME_INVALID` is Node's own (it checks the hostname against the certificate's
 * subjectAltNames itself, outside OpenSSL's verifier) and is the same kind of deterministic fact.
 *
 * Also included, and NOT from that doc page: the fatal TLS certificate alerts a PEER sends when it
 * rejects OUR certificate — the mTLS direction a kubeconfig client cert takes. OpenSSL surfaces an
 * incoming alert as its reason string, which Node exposes as `ERR_SSL_` + the uppercased reason, so
 * a server that rejects a stale kubeconfig certificate arrives as `ERR_SSL_TLSV1_ALERT_UNKNOWN_CA`
 * rather than any `CERT_*` code. The alert names are those of RFC 5246 §7.2.2 / RFC 8446 §6.2, and
 * each listed one is a verdict on a certificate that will be reached identically next time.
 *
 * @internal Exported only so the unit tests can assert the membership itself — the prefix fallback
 * in {@link isTlsConfigurationCode} would otherwise let a code silently drop out of this list
 * without a single test noticing. Not re-exported from the package index.
 */
export const TLS_CERTIFICATE_CODES: ReadonlySet<string> = new Set([
  // --- Node, "OpenSSL error codes": Time Validity Errors -----------------------
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CRL_NOT_YET_VALID',
  'CRL_HAS_EXPIRED',
  'CERT_REVOKED',
  // --- Trust or Chain Related Errors -------------------------------------------
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_CHAIN_TOO_LONG',
  'UNABLE_TO_GET_CRL',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_UNTRUSTED',
  // --- Basic Extension Errors ---------------------------------------------------
  'INVALID_CA',
  'PATH_LENGTH_EXCEEDED',
  // --- Name Related Errors ------------------------------------------------------
  'HOSTNAME_MISMATCH',
  // --- Usage and Policy Errors --------------------------------------------------
  'INVALID_PURPOSE',
  'CERT_REJECTED',
  // --- Formatting Errors --------------------------------------------------------
  'CERT_SIGNATURE_FAILURE',
  'CRL_SIGNATURE_FAILURE',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'ERROR_IN_CRL_LAST_UPDATE_FIELD',
  'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  // (`OUT_OF_MEM` is the one member of that section NOT listed — see the note above.)
  // --- Node's own hostname check ------------------------------------------------
  'ERR_TLS_CERT_ALTNAME_INVALID',
  // --- Fatal certificate alerts received FROM the peer (our client cert refused) --
  'ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE',
  'ERR_SSL_SSLV3_ALERT_UNSUPPORTED_CERTIFICATE',
  'ERR_SSL_SSLV3_ALERT_CERTIFICATE_REVOKED',
  'ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED',
  'ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN',
  'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
  'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED',
]);

/**
 * Handshake failures that are not about a certificate: the two ends cannot agree on a protocol.
 *
 * Every member is a persistent mismatch between two configurations, so each is listed with the
 * reason it qualifies rather than swept in by an `ERR_SSL_*` prefix — most `ERR_SSL_*` codes are
 * pass-throughs of arbitrary OpenSSL reasons, and some (an allocation failure, a decrypt error on a
 * corrupted record) genuinely can differ on the next attempt.
 *
 * - `EPROTO` — libuv's errno for a handshake OpenSSL aborted. The two ends could not complete a
 *   handshake at all; nothing about asking again changes what they support.
 * - `ERR_SSL_WRONG_VERSION_NUMBER` — the bytes on the wire are not a TLS record. Classically an
 *   `https://` URL pointing at a plain-HTTP listener: an address/scheme fact, fixed in config.
 * - `ERR_SSL_UNKNOWN_PROTOCOL` — the same situation as reported by OpenSSL's older reason string.
 * - `ERR_SSL_UNSUPPORTED_PROTOCOL` — the peer's protocol version is not enabled on this side.
 * - `ERR_SSL_VERSION_TOO_LOW` / `ERR_SSL_VERSION_TOO_HIGH` — the version the peer offers falls
 *   outside this side's configured `minVersion`/`maxVersion` window.
 * - `ERR_SSL_NO_PROTOCOLS_AVAILABLE` — this side's own TLS context has every version disabled, a
 *   purely local configuration error that cannot resolve itself.
 * - `ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION` — the peer's fatal alert (RFC 5246 §7.2.2) stating that
 *   the version we offered is unacceptable to it.
 *
 * Note what is NOT here: generic handshake alerts such as `ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE`,
 * which OpenSSL emits for several unrelated conditions and which therefore cannot be called a
 * persistent mismatch on the strength of the code alone.
 *
 * @internal Exported for the same reason as {@link TLS_CERTIFICATE_CODES}.
 */
export const TLS_PROTOCOL_CONFIGURATION_CODES: ReadonlySet<string> = new Set([
  'EPROTO',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_UNKNOWN_PROTOCOL',
  'ERR_SSL_UNSUPPORTED_PROTOCOL',
  'ERR_SSL_VERSION_TOO_LOW',
  'ERR_SSL_VERSION_TOO_HIGH',
  'ERR_SSL_NO_PROTOCOLS_AVAILABLE',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
]);

/**
 * Whether a transport `code` names a TLS failure that will recur identically on every attempt.
 *
 * The union of {@link TLS_CERTIFICATE_CODES} and {@link TLS_PROTOCOL_CONFIGURATION_CODES}, plus one
 * deliberate catch-all: an UNRECOGNISED code beginning `CERT_` is also treated as a certificate
 * verdict. Every `CERT_*` code OpenSSL defines is a verification result — a statement about the
 * certificate presented, not about the network — so a code this list has not caught up with (a
 * newer OpenSSL, a reason Node has not documented) is far better failed fast and named in the
 * message than polled for a 25-minute budget and then reported as a timeout. The explicit list is
 * kept rather than replaced by the prefix, both because most of the codes above do not start with
 * `CERT_` and so the prefix could never stand alone, and so the tests keep asserting the real
 * membership instead of a pattern that would pass for any invented string.
 */
function isTlsConfigurationCode(code: string): boolean {
  return (
    TLS_CERTIFICATE_CODES.has(code) ||
    TLS_PROTOCOL_CONFIGURATION_CODES.has(code) ||
    code.startsWith('CERT_') ||
    // Node's own `ERR_TLS_*` family (https://nodejs.org/api/errors.html) is configuration, security-state
    // and programming errors: `ERR_TLS_DH_PARAM_SIZE` (the peer offered too small a Diffie-Hellman
    // parameter), `ERR_TLS_INVALID_PROTOCOL_VERSION`, `ERR_TLS_PROTOCOL_VERSION_CONFLICT`,
    // `ERR_TLS_INVALID_CONTEXT`, renegotiation policy, … — none of which a retry a second later can
    // change. The one member that IS a passing condition, `ERR_TLS_HANDSHAKE_TIMEOUT`, is carved out
    // by the caller before this predicate runs.
    (code.startsWith('ERR_TLS_') && code !== TLS_HANDSHAKE_TIMEOUT_CODE)
  );
}

/** Node's one transient `ERR_TLS_*` code: the handshake did not finish in time — ask again. */
const TLS_HANDSHAKE_TIMEOUT_CODE = 'ERR_TLS_HANDSHAKE_TIMEOUT';

/**
 * The transport `code`, following one level of `cause`.
 *
 * Node's `fetch()` — what the 1.x client uses — reports every transport failure as the same opaque
 * `TypeError: fetch failed` and hangs the real error off `cause`. Reading only the top-level `code`
 * therefore sees nothing at all on the shape that matters most, and the failure falls through to
 * the message sniff in {@link isRetryableError}, which retries any `TypeError` mentioning `fetch`.
 */
function transportErrorCode(error: unknown): string | undefined {
  const own = systemErrorCode(error);
  if (own) return own;
  if (!error || typeof error !== 'object') return undefined;
  return systemErrorCode((error as { cause?: unknown }).cause);
}

/**
 * Classify why a read against the API server failed.
 *
 * Deliberately conservative: anything not positively recognised is `other`,
 * which callers treat the same as `unreachable` — "we did not learn the answer"
 * — rather than as a negative answer.
 *
 * Ordered on the same invariant as {@link classifyReadError}: an HTTP status means the server
 * ANSWERED, so it outranks every transport heuristic below it. That matters more here than
 * anywhere, because this taxonomy's whole subject is whether the server was reached: calling a
 * 422 that happens to carry a stale `ECONNRESET` code `unreachable` would state, in a log line
 * about the cluster, the opposite of what the status proves. A status the list below does not
 * name is `other` — the server answered, just not in a way this taxonomy has a word for.
 */
export function classifyApiReadError(error: unknown): ApiReadFailure {
  if (isNotFoundError(error)) return 'notFound';

  const status = apiErrorStatus(error);
  if (status !== undefined) {
    if (status === 401 || status === 403) return 'forbidden';
    if (status === 408 || status === 504) return 'timeout';
    return 'other';
  }

  const code = systemErrorCode(error);
  if (code && TIMEOUT_CODES.has(code)) return 'timeout';
  if (code && UNREACHABLE_CODES.has(code)) return 'unreachable';

  const message = error instanceof Error ? error.message : String(error ?? '');
  const lowered = message.toLowerCase();
  if (error instanceof Error && error.name === 'AbortError') return 'timeout';
  if (lowered.includes('timeout') || lowered.includes('timed out')) return 'timeout';
  if (
    lowered.includes('forbidden') ||
    lowered.includes('unauthorized') ||
    lowered.includes('http-code: 401') ||
    lowered.includes('http-code: 403')
  ) {
    return 'forbidden';
  }
  if (
    lowered.includes('certificate') ||
    lowered.includes('unable to verify') ||
    lowered.includes('econnrefused') ||
    lowered.includes('getaddrinfo') ||
    lowered.includes('socket hang up')
  ) {
    return 'unreachable';
  }

  return 'other';
}

/** Short human phrase for an {@link ApiReadFailure}, for a log line or a reason string. */
export function describeApiReadFailure(failure: ApiReadFailure): string {
  switch (failure) {
    case 'notFound':
      return 'the server answered 404';
    case 'forbidden':
      return 'the request was refused (RBAC)';
    case 'timeout':
      return 'the request timed out';
    case 'unreachable':
      return 'the API server was unreachable';
    default:
      return 'the request failed';
  }
}

/**
 * One-line description of a failed API read: what went wrong, plus the
 * underlying message so the log is actionable.
 */
export function describeApiReadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  return `${describeApiReadFailure(classifyApiReadError(error))}: ${message}`;
}

/**
 * How a failed Kubernetes read should be treated by a loop that polls against a time budget.
 *
 * The two retryable classifications describe a cluster that may still produce the object. The
 * rest describe a request that will fail identically until something outside the deployment
 * changes, so polling them only spends the budget and then reports a timeout that hides the
 * real cause.
 */
export type ReadErrorClassification =
  /** The object is absent but its type is served — it may still appear. */
  | 'object-not-found'
  /** Rate limiting, a server-side fault, or a transport failure. */
  | 'transient'
  /** The apiVersion/kind itself is not served: a wrong reference or an uninstalled CRD. */
  | 'unknown-resource-type'
  /** 401/403 — the deployment's credentials may not read this resource. */
  | 'permission-denied'
  /** 400/405/422 and other client errors — the request itself is malformed or rejected. */
  | 'invalid-request'
  /** The TLS handshake failed on trust, identity or protocol — a client/cluster misconfiguration. */
  | 'tls-configuration-error'
  /** A programming error with no Kubernetes API shape at all. */
  | 'not-a-kubernetes-error';

/** A classified read failure, with the pieces an error message needs. */
export interface ReadErrorAssessment {
  classification: ReadErrorClassification;
  /** Whether reading again could plausibly succeed without anything else changing. */
  retryable: boolean;
  /** Short human-readable form of the classification, e.g. `permission denied (HTTP 403)`. */
  summary: string;
  /** The best available underlying message, never the `[object Object]` a bare status yields. */
  detail: string;
  statusCode: number | undefined;
}

const READ_ERROR_SUMMARIES: Record<ReadErrorClassification, string> = {
  'object-not-found': 'not found',
  transient: 'transient API error',
  'unknown-resource-type': 'unknown resource type',
  'permission-denied': 'permission denied',
  'invalid-request': 'invalid request',
  'tls-configuration-error': 'TLS configuration error',
  'not-a-kubernetes-error': 'not a Kubernetes API error',
};

const RETRYABLE_READ_CLASSIFICATIONS: ReadonlySet<ReadErrorClassification> =
  new Set<ReadErrorClassification>(['object-not-found', 'transient']);

/**
 * Distinguish a 404 for the resource *type* from a 404 for the *object*.
 *
 * A 404 for an object the API server knows how to serve always names it: the Status body carries
 * `details.name` and `details.kind` (`services "foo" not found`). A request to a path the server
 * does not serve has no object to name, so it answers only that it could not find the requested
 * resource and leaves `details` empty. The client can also refuse before any request:
 * `KubernetesObjectApi` cannot build a URL for an apiVersion/kind missing from discovery and
 * throws a plain `Error` with no status code at all.
 */
function isUnknownResourceTypeError(error: unknown, statusCode: number | undefined): boolean {
  if (!error || typeof error !== 'object') return false;
  const apiError = error as KubernetesApiError;

  if (
    typeof apiError.message === 'string' &&
    apiError.message.includes('Unrecognized API version and kind')
  ) {
    return true;
  }

  if (statusCode !== 404) return false;

  const body = apiError.body;
  if (
    typeof body?.message === 'string' &&
    /could not find the requested resource/i.test(body.message)
  ) {
    return true;
  }

  // Only treat a structured NotFound as a type miss when the server declined to name an object;
  // a bare `{ statusCode: 404 }` carries no evidence either way and stays retryable.
  const details = body?.details;
  return (
    body?.reason === 'NotFound' &&
    !!details &&
    typeof details === 'object' &&
    !details.name &&
    !details.kind
  );
}

/**
 * The classification, split at the one question that orders everything else: did the API server
 * ANSWER?
 *
 * An HTTP status is proof that it did — the request reached the server, the server formed a
 * verdict, and it sent one back. That verdict therefore OUTRANKS every piece of evidence that the
 * transport failed, because a transport that failed could not have carried a status. The two kinds
 * of evidence do co-occur: a client can attach a system `code` to a status-bearing error (a socket
 * reset while draining an error body, a `code` copied from an earlier attempt), and Node's
 * `fetch()` spells its failures as a `TypeError` whose message `isRetryableError` sniffs for the
 * word `fetch` — which a status-bearing `TypeError` matches just as well. Deciding on the transport
 * evidence first therefore turned a 422 into `transient` and polled a request the server had
 * already rejected until the readiness budget expired.
 *
 * So: while a status exists, only the status is consulted, and no message or `code` heuristic runs
 * at all. Only once there is no status does the "the request never produced an HTTP response"
 * ladder below run — TLS verdict, this repo's own request-timeout types, Node's socket/DNS codes,
 * then the shared retryable predicate's message sniffs.
 */
function classifyReadErrorKind(
  error: unknown,
  statusCode: number | undefined
): ReadErrorClassification {
  // First regardless: the API resource itself not being served is recognised both from a 404 whose
  // Status body names no object and, with no status at all, from the client's own discovery miss.
  if (isUnknownResourceTypeError(error, statusCode)) return 'unknown-resource-type';

  // ---- The server answered. Its answer decides, and nothing else is consulted. ----
  if (statusCode !== undefined) {
    if (statusCode === 401 || statusCode === 403) return 'permission-denied';
    if (statusCode === 404) return 'object-not-found';
    if (RETRYABLE_STATUS_CODES.has(statusCode)) return 'transient';
    if (statusCode >= 400 && statusCode < 500) return 'invalid-request';
    // Any other status the server produced — a 5xx outside the retryable list, or anything the
    // client turned into an error without a 4xx/5xx code. The server is up and talking, so the
    // conservative reading is "ask again", not "this is permanently broken".
    return 'transient';
  }

  // ---- No status: the request never produced an HTTP response. ----
  // The transport `code` is read BEFORE `isRetryableError`, and a permanent TLS failure is
  // recognised before any retryable shape, because that predicate's last resort is a message sniff:
  // it retries ANY `TypeError` whose message mentions `fetch`. Node's `fetch()` reports a rejected
  // server certificate as exactly that — `TypeError: fetch failed` with the real code on `cause` —
  // so consulting the code first is the whole of what keeps a misconfigured CA bundle out of the
  // retry loop instead of burning the readiness budget on it.
  const transportCode = transportErrorCode(error);
  // A handshake that merely ran out of time is the one TLS-namespaced failure that is transient.
  if (transportCode === TLS_HANDSHAKE_TIMEOUT_CODE) {
    return 'transient';
  }
  if (transportCode && isTlsConfigurationCode(transportCode)) {
    return 'tls-configuration-error';
  }
  // The two "the request never got an answer" shapes `isRetryableError` does not recognise, both of
  // which are as transient as the 408 it does recognise — ask again and the server may well answer:
  //   1. This repo's own timing layers. A bare `RequestTimeoutError` (the Bun HTTP library's socket
  //      timer) and its subclasses `PollTimeoutError` / `PrematureCloseError` carry no HTTP status,
  //      so without this they land in `not-a-kubernetes-error` and a retry loop gives up on a blip.
  //   2. Node's socket/DNS `code`s. `isRetryableError` only sniffs MESSAGES, so `ECONNRESET` whose
  //      message is the bare `read ECONNRESET` is missed.
  if (isRequestTimeoutError(error)) return 'transient';
  if (transportCode && RETRYABLE_SYSTEM_CODES.has(transportCode)) return 'transient';

  // Connection resets, DNS failures and fetch-level TypeErrors, recognised by message.
  if (isRetryableError(error)) return 'transient';
  return 'not-a-kubernetes-error';
}

/**
 * Classify a failed Kubernetes read as worth retrying or permanently broken.
 *
 * Built on the shared predicates in `../kubernetes/errors.js` — {@link getErrorStatusCode} for the
 * status across every client-version error shape, and {@link isRetryableError} for the transient
 * set — so this adds a retry policy rather than a second error taxonomy. It additionally recognises
 * the transport shapes those predicates miss: {@link isRequestTimeoutError} and Node's socket/DNS
 * `code`s make "the request never got an answer" `transient` however it was spelled, while a TLS
 * trust/protocol `code` — including one buried in a `fetch failed` `cause` — is separated out as
 * the permanent misconfiguration it is.
 *
 * Shared with the engine's external-reference resolver, whose policy is that a permanent failure
 * fails immediately, so a classification is only `retryable` when asking again could plausibly
 * succeed with nothing else changing.
 */
export function classifyReadError(error: unknown): ReadErrorAssessment {
  const statusCode = getErrorStatusCode(error);
  const classification = classifyReadErrorKind(error, statusCode);
  const label = READ_ERROR_SUMMARIES[classification];
  const detail = describeReadError(error);
  // `TypeError: fetch failed` says nothing an operator can act on, so a TLS failure names the code
  // and what to look at. Everything else already carries its own message.
  const tlsCode =
    classification === 'tls-configuration-error' ? transportErrorCode(error) : undefined;

  return {
    classification,
    retryable: RETRYABLE_READ_CLASSIFICATIONS.has(classification),
    summary: statusCode === undefined ? label : `${label} (HTTP ${statusCode})`,
    detail: tlsCode ? `${detail} (${tlsCode}: ${tlsDiagnosticHint(tlsCode)})` : detail,
    statusCode,
  };
}

/**
 * Where to send the operator for a given TLS failure code.
 *
 * The three groups {@link isTlsConfigurationCode} accepts fail for different reasons and are fixed
 * in different places, so each gets its own hint rather than one catch-all:
 *
 * - A certificate VERDICT — a member of {@link TLS_CERTIFICATE_CODES}, or an unrecognised `CERT_`
 *   code — is about the trust material: the CA bundle in the kubeconfig, or the certificate the
 *   API server presents.
 * - A PROTOCOL mismatch — a member of {@link TLS_PROTOCOL_CONFIGURATION_CODES} — is about what is
 *   at the other end of the address and which TLS versions each side allows.
 * - Anything else here reached the classification through the generic `ERR_TLS_` prefix rule:
 *   `ERR_TLS_DH_PARAM_SIZE`, `ERR_TLS_INVALID_CONTEXT`, `ERR_TLS_PROTOCOL_VERSION_CONFLICT` and
 *   the rest of Node's own namespace. These say nothing about a certificate, so pointing at the CA
 *   bundle would send the operator to the one thing that is not wrong; the honest hint is the TLS
 *   configuration on either side, which is what those codes actually describe.
 */
function tlsDiagnosticHint(code: string): string {
  if (TLS_CERTIFICATE_CODES.has(code) || code.startsWith('CERT_')) {
    return 'check the cluster CA / server certificate';
  }
  if (TLS_PROTOCOL_CONFIGURATION_CODES.has(code)) {
    return 'check the server URL scheme / port and the TLS version settings';
  }
  return 'check the client/server TLS configuration';
}

/**
 * Best available human-readable description of a read failure.
 *
 * `ensureError` on a bare `{ statusCode: 403 }` yields `[object Object]`, which tells an operator
 * nothing, so fall back to the formatted API error when neither the Status body nor the error
 * itself carries a message.
 */
export function describeReadError(error: unknown): string {
  const { message } = getErrorDetails(error);
  if (typeof message === 'string' && message.length > 0 && message !== '[object Object]') {
    return message;
  }
  return formatKubernetesError(error);
}

/**
 * Check if an error is an HTTP 415 Unsupported Media Type error
 */
export function isUnsupportedMediaTypeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const apiError = error as KubernetesApiError;
  return (
    apiError.statusCode === 415 ||
    apiError.response?.statusCode === 415 ||
    apiError.body?.code === 415
  );
}

/**
 * Extract accepted media types from HTTP 415 error message
 */
export function extractAcceptedMediaTypes(error: unknown): string[] {
  const defaultTypes = [
    'application/json-patch+json',
    'application/merge-patch+json',
    'application/apply-patch+yaml',
  ];

  try {
    const apiError = error as KubernetesApiError;
    const message = apiError.message || apiError.body?.message || '';
    const match = message.match(/accepted media types include: ([^"]+)/);

    if (match?.[1]) {
      return match[1].split(', ').map((type: string) => type.trim());
    }
  } catch (err: unknown) {
    logger.debug('Failed to extract media types from error, using defaults', { err });
  }

  return defaultTypes;
}

/**
 * Patch a resource with the correct Content-Type header for merge patch operations.
 * Fixes HTTP 415 "Unsupported Media Type" errors.
 */
export async function patchResourceWithCorrectContentType(
  k8sApi: k8s.KubernetesObjectApi,
  resource: k8s.KubernetesObject,
  patchType: 'merge' | 'strategic' = 'merge'
): Promise<k8s.KubernetesObject> {
  // Log Secret resource metadata (sensitive fields redacted)
  if (resource.kind === 'Secret') {
    logger.debug('Patching Secret resource', {
      name: resource.metadata?.name,
      namespace: resource.metadata?.namespace,
      hasData: 'data' in resource,
      hasStringData: 'stringData' in resource,
      dataKeyCount: (resource as { data?: Record<string, string> }).data
        ? Object.keys((resource as { data: Record<string, string> }).data).length
        : 0,
    });
  }

  return await k8sApi.patch(
    resource,
    undefined, // pretty
    undefined, // dryRun
    undefined, // fieldManager
    undefined, // force
    patchType === 'strategic'
      ? 'application/strategic-merge-patch+json'
      : 'application/merge-patch+json'
  );
}

/**
 * Enhance a resource for evaluation by applying kind-specific logic.
 * This allows generic evaluators to work correctly without needing special cases.
 */
export function enhanceResourceForEvaluation(
  resource: {
    spec?: unknown;
    status?: {
      conditions?: Array<{ type: string; status: string; message?: string; reason?: string }>;
    };
    metadata?: { generation?: number; resourceVersion?: string };
  },
  kind: string
): typeof resource {
  // For HelmRepository resources, handle OCI special case
  if (kind === 'HelmRepository') {
    const spec = resource.spec as { type?: string } | undefined;
    const isOciRepository = spec?.type === 'oci';
    const hasBeenProcessed = resource.metadata?.generation && resource.metadata?.resourceVersion;

    if (
      isOciRepository &&
      hasBeenProcessed &&
      !resource.status?.conditions?.some((c) => c.type === 'Ready')
    ) {
      return {
        ...resource,
        status: {
          ...resource.status,
          conditions: [
            ...(resource.status?.conditions || []),
            {
              type: 'Ready',
              status: 'True',
              message: 'OCI repository is functional',
              reason: 'OciRepositoryProcessed',
            },
          ],
        },
      };
    }
  }

  return resource;
}
