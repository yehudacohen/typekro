/**
 * Redirect targets, always absolute when a public URL is known.
 *
 * The browser reaches the API through HyperDX's UI, whose `/api/*` route
 * proxies to the API server (`http://127.0.0.1:8000`) with
 * http-proxy-middleware's `autoRewrite`. For a redirect, the proxy resolves the
 * `Location` against the API server's origin and, when the host matches,
 * replaces only the host with the request's `Host` header. A `Host` without a
 * port, which is every request that arrives through a reverse proxy on the
 * default port, keeps the API server's port and scheme: a relative
 * `/api/login/oidc/x` becomes `http://<host>:8000/api/login/oidc/x`, which the
 * browser cannot reach. An absolute `Location` on another host is left alone.
 *
 * So every redirect the plugin issues is built from a configured public base
 * URL. The `Host` header is never used: it is client input, and an absolute
 * redirect built from it would be an open redirect.
 */

/**
 * The first candidate that is a usable public base URL, normalized to origin
 * plus path without a trailing slash; `''` if there is none.
 *
 * Usable means an absolute `http:` or `https:` URL with no credentials, query
 * or fragment. Candidates are operator configuration (HyperDX's
 * `FRONTEND_URL`, the plugin's `redirectBaseUrl`), never request data.
 */
export function publicBase(...candidates: ReadonlyArray<string | undefined>): string {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.trim() === '') continue;
    let url: URL;
    try {
      url = new URL(candidate.trim());
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '')
      continue;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  }
  return '';
}

/**
 * `path` under `base`. With no base (`''`), the relative path: correct when
 * the browser talks to the API's origin directly (HyperDX's inline-API mode),
 * and never an open redirect.
 *
 * `path` must be a same-origin path (`/...`, not `//...` or containing a
 * backslash); anything else becomes `/`, so a caller cannot turn this into a
 * redirect off the public origin.
 */
export function publicUrl(base: string, path: string): string {
  const safePath =
    path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') ? path : '/';
  return `${base}${safePath}`;
}

/** A provider's login route, carrying `returnTo` unless it is the default `/`. */
export function providerLoginPath(loginPath: string, providerId: string, returnTo: string): string {
  const suffix = returnTo === '/' ? '' : `?returnTo=${encodeURIComponent(returnTo)}`;
  return `${loginPath}/${encodeURIComponent(providerId)}${suffix}`;
}
