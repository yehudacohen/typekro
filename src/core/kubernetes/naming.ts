/**
 * Kubernetes and Helm name-length limits, and the derivation that turns them
 * into a bound on the name a caller hands a composition.
 *
 * A composition rarely uses `spec.name` verbatim and nothing else: it — or the
 * chart it installs, or a controller downstream of it — derives further object
 * names from it by appending a suffix (`<name>-udp`) or by counting up from it
 * (`<name>-<ordinal>`). Each of those derived names has to satisfy a limit of
 * its own, so the real bound on `spec.name` is `min(limit - reserved)` across
 * every name the composition can produce.
 *
 * Writing that minimum into a schema as a literal (`'string <= 40'`) hides
 * which name produced it, so nobody can tell whether the number is still right
 * after a chart bump adds a longer suffix. {@link deriveNameLengthLimit} takes
 * the derived names instead and computes the bound, keeping the reasoning in
 * the source and putting the binding constraint into the validation message.
 *
 * **Only names that can actually FAIL belong in a derivation.** A name the API
 * server produces through `metadata.generateName` — a ReplicaSet's Pods, a
 * Job's Pods — cannot fail on a long prefix: the generator truncates the base
 * to `MaxGeneratedNameLength = 63 - 5` before appending its random suffix, so
 * the result is always within the limit no matter how long the prefix was. See
 * `staging/src/k8s.io/apiserver/pkg/storage/names/generate.go` in
 * kubernetes/kubernetes. Reserving room for a suffix Kubernetes will truncate
 * anyway only makes the schema reject names that would have worked.
 */

/**
 * RFC 1123 (and RFC 1035) DNS label limit.
 *
 * The ceiling for a Service name, for the hostname a Pod gets from its name,
 * and for every `metadata.name` a controller turns into a label.
 */
export const DNS_LABEL_MAX_LENGTH = 63;

/**
 * RFC 1123 DNS subdomain limit — the general `metadata.name` ceiling for
 * objects whose names are not required to be labels.
 */
export const DNS_SUBDOMAIN_MAX_LENGTH = 253;

/**
 * Helm's release-name limit (`releaseNameMaxLen`, `helm.sh/helm/v3/pkg/action`).
 *
 * Tighter than the DNS label limit because Helm reserves room for the suffixes
 * it appends to a release's own bookkeeping Secrets
 * (`sh.helm.release.v1.<release>.v<revision>`).
 */
export const HELM_RELEASE_NAME_MAX_LENGTH = 53;

/**
 * Kubernetes' CronJob name limit (`ValidateCronJobCreate`,
 * `pkg/apis/batch/validation/validation.go`).
 *
 * Tighter than the DNS label limit because the CronJob controller names each
 * Job `<cronjob>-<scheduled-time>` with an 11-character suffix, and a Job name
 * is a 63-character DNS label — so the API server rejects a CronJob whose name
 * is longer than 52 characters at CREATE time ("must be no more than 52
 * characters"). The check is skipped on update, so an existing over-long
 * CronJob can still be edited or deleted.
 */
export const CRONJOB_NAME_MAX_LENGTH = DNS_LABEL_MAX_LENGTH - 11;

/** One name a composition derives from the name its caller supplies. */
export interface GeneratedNameConstraint {
  /**
   * What the derived name is and who generates it, e.g.
   * `'<name>-udp (the chart\'s UDP Service)'`. Quoted in the validation
   * message when this constraint is the binding one.
   */
  readonly describedAs: string;
  /** Literal suffix appended to the caller's name. Omit when there is none. */
  readonly suffix?: string;
  /**
   * Characters a controller appends on top of {@link suffix} that are not a
   * literal — a StatefulSet ordinal, a revision counter, a timestamp.
   *
   * Count characters only where an over-long result would be REJECTED. Names
   * the API server builds with `metadata.generateName` do not qualify: its
   * generator truncates the base to `MaxGeneratedNameLength = 63 - 5` first
   * (`staging/src/k8s.io/apiserver/pkg/storage/names/generate.go`), so those
   * names always fit and reserving for them only over-constrains the caller.
   */
  readonly generatedChars?: number;
  /** Length limit the derived name has to satisfy. */
  readonly limit: number;
}

/** The bound {@link deriveNameLengthLimit} computed, and why. */
export interface DerivedNameLimit {
  /** Longest name a caller may supply. */
  readonly maxLength: number;
  /** The constraint that produced {@link maxLength}. */
  readonly binding: GeneratedNameConstraint;
  /**
   * Validation message naming the limit and the constraint behind it, ready to
   * hand to ArkType's `.configure({ message })`.
   */
  readonly message: string;
}

/** Characters a constraint reserves out of its own limit. */
function reservedBy(constraint: GeneratedNameConstraint): number {
  return (constraint.suffix?.length ?? 0) + (constraint.generatedChars ?? 0);
}

/**
 * Compute the longest name a caller may supply, given every name derived from
 * it.
 *
 * Ties go to the constraint declared first, so list the constraints in the
 * order a reader should meet them.
 *
 * @param constraints - Every name the composition (or its chart, or a
 *   controller downstream of it) derives from the caller's name. Include the
 *   bare name itself as a constraint with no suffix wherever it is used as-is
 *   under a limit of its own — a Helm release name, say.
 * @returns The bound, the constraint that produced it, and a message naming
 *   both.
 * @throws If `constraints` is empty, or if a constraint reserves at least as
 *   many characters as its own limit, which would leave no name at all.
 */
export function deriveNameLengthLimit(
  constraints: readonly GeneratedNameConstraint[]
): DerivedNameLimit {
  if (constraints.length === 0) {
    throw new Error(
      'deriveNameLengthLimit requires at least one generated-name constraint to derive a limit from.'
    );
  }

  let binding = constraints[0] as GeneratedNameConstraint;
  let maxLength = binding.limit - reservedBy(binding);

  for (const constraint of constraints.slice(1)) {
    const allowed = constraint.limit - reservedBy(constraint);
    if (allowed < maxLength) {
      binding = constraint;
      maxLength = allowed;
    }
  }

  if (maxLength < 1) {
    throw new Error(
      `Generated name ${binding.describedAs} reserves ${reservedBy(binding)} of its ${binding.limit}-character limit, leaving no room for a name.`
    );
  }

  const reserved = reservedBy(binding);
  const reason =
    reserved === 0
      ? `${binding.describedAs} is limited to ${binding.limit} characters`
      : `${binding.describedAs} is limited to ${binding.limit} characters and reserves ${reserved} of them`;

  return {
    maxLength,
    binding,
    message: `at most ${maxLength} characters, because ${reason}`,
  };
}

// ============================================================================
// Secret reference syntax
// ============================================================================

/**
 * The character rule the API server applies to a Secret/ConfigMap **data key**
 * (`IsConfigMapKey`, `staging/src/k8s.io/apimachinery/pkg/util/validation`).
 *
 * The full rule is three separate checks, not one pattern — the reserved path
 * names are excluded by name rather than by character class, which no single
 * anchored regex expresses readably. {@link validateSecretDataKey} applies all
 * three; this constant exists so an error message can quote the character rule.
 */
export const SECRET_DATA_KEY_PATTERN = /^[-._a-zA-Z0-9]+$/;

/**
 * The character rule for an RFC 1123 DNS subdomain — the syntax a Secret's
 * `metadata.name` must satisfy (`IsDNS1123Subdomain`).
 */
export const DNS_SUBDOMAIN_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/**
 * Path names a Secret data key may not take, because a key becomes a FILE NAME
 * when the Secret is projected into a volume. `.` and `..` are the directory
 * entries themselves, and a leading `..` is reserved for the atomic-writer's
 * own `..data` symlink, so the API server rejects all three outright.
 */
const RESERVED_SECRET_DATA_KEYS = new Set(['.', '..']);

/**
 * Validate a Kubernetes Secret (or ConfigMap) **data key** against the API
 * server's real rules, rather than against an approximation of them.
 *
 * WHY A SHARED VALIDATOR. Every caller that takes a `secretKeyRef` from a user
 * needs the same four checks, and a local approximation of them is wrong in a
 * direction nobody notices: a key that passes a hand-rolled character class but
 * exceeds 253 characters, or is literally `..`, is accepted at build time and
 * rejected by the API server at apply time — the failure lands on a cluster
 * instead of in a stack trace next to the call that caused it.
 *
 * @param key - The candidate data key
 * @returns A reason the key is unusable, or `undefined` when it is valid
 */
export function validateSecretDataKey(key: unknown): string | undefined {
  if (typeof key !== 'string' || key.length === 0) {
    return 'must be a non-empty string';
  }
  if (key.length > DNS_SUBDOMAIN_MAX_LENGTH) {
    return `must be at most ${DNS_SUBDOMAIN_MAX_LENGTH} characters, but is ${key.length}`;
  }
  if (!SECRET_DATA_KEY_PATTERN.test(key)) {
    return `must match ${SECRET_DATA_KEY_PATTERN.source}`;
  }
  if (RESERVED_SECRET_DATA_KEYS.has(key) || key.startsWith('..')) {
    // A key is a file name once the Secret is projected into a volume.
    return "must not be '.' or '..', and must not start with '..'";
  }
  return undefined;
}

/**
 * Validate an object name against RFC 1123 DNS subdomain rules — the syntax
 * `metadata.name` takes for a Secret, a ConfigMap and most namespaced objects.
 *
 * @param name - The candidate object name
 * @returns A reason the name is unusable, or `undefined` when it is valid
 */
export function validateDnsSubdomainName(name: unknown): string | undefined {
  if (typeof name !== 'string' || name.length === 0) {
    return 'must be a non-empty string';
  }
  if (name.length > DNS_SUBDOMAIN_MAX_LENGTH) {
    return `must be at most ${DNS_SUBDOMAIN_MAX_LENGTH} characters, but is ${name.length}`;
  }
  if (!DNS_SUBDOMAIN_PATTERN.test(name)) {
    return `must be an RFC 1123 DNS subdomain — ${DNS_SUBDOMAIN_PATTERN.source}`;
  }
  return undefined;
}
