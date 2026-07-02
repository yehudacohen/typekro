/**
 * Strict CEL diagnostics mode resolution.
 *
 * When the JS→CEL analyzer cannot prove an emitted CEL expression
 * type-checks (e.g. a member expression references a resource that is not
 * part of the resource graph), the default behavior is lenient: emit the
 * expression anyway and log a warning. The failure then only surfaces when
 * KRO rejects the ResourceGraphDefinition on a live cluster — potentially
 * long after serialization.
 *
 * In strict mode the conversion throws at analysis/serialization time with
 * the offending expression instead.
 *
 * Strictness is resolved from (highest precedence first):
 *   1. An explicit `strictCelDiagnostics` flag (on the `AnalysisContext`, or
 *      threaded from factory options such as
 *      `.factory('kro', { strictCelDiagnostics: true })`).
 *   2. The `TYPEKRO_STRICT_CEL` environment variable (`1` or `true`).
 *
 * The environment variable is consulted ONLY here so the global default is
 * defined in a single place rather than scattered across diagnostic sites.
 */
export function isStrictCelDiagnosticsEnabled(context?: {
  strictCelDiagnostics?: boolean | undefined;
}): boolean {
  if (context?.strictCelDiagnostics !== undefined) {
    return context.strictCelDiagnostics;
  }
  const env = process.env.TYPEKRO_STRICT_CEL;
  return env === '1' || env === 'true';
}
