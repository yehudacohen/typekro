/**
 * One OIDC provider at runtime: discovery, the authorization request, and the
 * callback — the authorization-code flow with PKCE, `state` and `nonce`.
 *
 * Protocol work is delegated to `oauth4webapi` (spec-compliant, no
 * dependencies). ID tokens arrive from the token endpoint over TLS in exchange
 * for client authentication, so their claims are validated (issuer, audience,
 * expiry, nonce, azp) but — as OIDC Core §3.1.3.7 permits for this flow — the
 * JWS signature is not re-verified.
 */

import * as oauth from 'oauth4webapi';
import type { OidcProviderConfig } from './config.js';

/** Flow state kept in the HyperDX session between the redirect and the callback. */
export interface PendingLogin {
  readonly provider: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly returnTo: string;
  readonly createdAt: number;
}

/** A pending login older than this is refused. */
export const PENDING_LOGIN_TTL_MS = 10 * 60_000;

/** Discovered metadata is refreshed after this long. */
const METADATA_TTL_MS = 24 * 3_600_000;
/** After a failed discovery, wait this long before trying again. */
const DISCOVERY_RETRY_MS = 15_000;

export class OidcFlowError extends Error {
  constructor(
    readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = 'OidcFlowError';
  }
}

export class ProviderRuntime {
  private metadata: Promise<oauth.AuthorizationServer> | undefined;
  private metadataFetchedAt = 0;
  private lastDiscoveryFailureAt = 0;

  constructor(
    readonly config: OidcProviderConfig,
    readonly redirectUri: string,
    private readonly allowInsecureHttp: boolean
  ) {}

  private get client(): oauth.Client {
    return { client_id: this.config.clientId };
  }

  private get clientAuth(): oauth.ClientAuth {
    return this.config.tokenEndpointAuthMethod === 'client_secret_post'
      ? oauth.ClientSecretPost(this.config.clientSecret)
      : oauth.ClientSecretBasic(this.config.clientSecret);
  }

  private requestOptions() {
    return this.allowInsecureHttp ? { [oauth.allowInsecureRequests]: true } : {};
  }

  /** Discovered authorization-server metadata, cached and refreshed. */
  async authorizationServer(): Promise<oauth.AuthorizationServer> {
    const now = Date.now();
    if (this.metadata !== undefined && now - this.metadataFetchedAt < METADATA_TTL_MS) {
      return this.metadata;
    }
    if (this.metadata === undefined && now - this.lastDiscoveryFailureAt < DISCOVERY_RETRY_MS) {
      throw new OidcFlowError(
        'providerUnavailable',
        `discovery for provider ${this.config.id} failed recently; retrying shortly`
      );
    }
    const issuer = new URL(this.config.issuer);
    const pending = oauth
      .discoveryRequest(issuer, { algorithm: 'oidc', ...this.requestOptions() })
      .then((response) => oauth.processDiscoveryResponse(issuer, response));
    this.metadata = pending;
    this.metadataFetchedAt = now;
    try {
      return await pending;
    } catch (error) {
      this.metadata = undefined;
      this.lastDiscoveryFailureAt = Date.now();
      throw new OidcFlowError(
        'providerUnavailable',
        `discovery for provider ${this.config.id} (${this.config.issuer}) failed: ${(error as Error).message}`
      );
    }
  }

  /** Build the authorization request; the returned pending state goes in the session. */
  async begin(returnTo: string): Promise<{ url: string; pending: PendingLogin }> {
    const as = await this.authorizationServer();
    if (as.authorization_endpoint === undefined) {
      throw new OidcFlowError('providerMisconfigured', `provider ${this.config.id} has no authorization_endpoint`);
    }
    const codeVerifier = oauth.generateRandomCodeVerifier();
    const pending: PendingLogin = {
      provider: this.config.id,
      state: oauth.generateRandomState(),
      nonce: oauth.generateRandomNonce(),
      codeVerifier,
      returnTo,
      createdAt: Date.now(),
    };
    const url = new URL(as.authorization_endpoint);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', this.config.scopes.join(' '));
    url.searchParams.set('state', pending.state);
    url.searchParams.set('nonce', pending.nonce);
    url.searchParams.set('code_challenge', await oauth.calculatePKCECodeChallenge(codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.href, pending };
  }

  /**
   * Complete the flow from the callback URL: check `state`, exchange the code
   * (with the PKCE verifier), validate the ID token, and return its claims.
   */
  async complete(callbackUrl: URL, pending: PendingLogin): Promise<Record<string, unknown>> {
    if (pending.provider !== this.config.id) {
      throw new OidcFlowError('stateMismatch', 'the pending login belongs to a different provider');
    }
    if (Date.now() - pending.createdAt > PENDING_LOGIN_TTL_MS) {
      throw new OidcFlowError('loginExpired', 'the login took too long; start again');
    }
    const as = await this.authorizationServer();
    let params: URLSearchParams;
    try {
      params = oauth.validateAuthResponse(as, this.client, callbackUrl, pending.state);
    } catch (error) {
      throw new OidcFlowError('authorizationFailed', (error as Error).message);
    }
    const response = await oauth.authorizationCodeGrantRequest(
      as,
      this.client,
      this.clientAuth,
      params,
      this.redirectUri,
      pending.codeVerifier,
      this.requestOptions()
    );
    let result: oauth.TokenEndpointResponse;
    try {
      result = await oauth.processAuthorizationCodeResponse(as, this.client, response, {
        expectedNonce: pending.nonce,
        requireIdToken: true,
      });
    } catch (error) {
      throw new OidcFlowError('tokenExchangeFailed', (error as Error).message);
    }
    const claims = oauth.getValidatedIdTokenClaims(result);
    if (claims === undefined) throw new OidcFlowError('tokenExchangeFailed', 'no ID token in the token response');
    return claims as Record<string, unknown>;
  }
}

/** Only same-origin relative paths are accepted as post-login destinations. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/';
  }
  return value;
}
