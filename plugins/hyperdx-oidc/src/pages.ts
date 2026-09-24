/**
 * The two pages the plugin renders itself: the provider chooser and the
 * access-denied page. Server-rendered HTML from the API, because adding pages
 * to HyperDX's Next.js UI would mean rebuilding its image.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE =
  'body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;min-height:100vh;' +
  'align-items:center;justify-content:center;margin:0}main{max-width:24rem;width:100%;padding:2rem}' +
  'h1{font-size:1.25rem;margin:0 0 1.5rem}a.provider{display:block;padding:.75rem 1rem;margin:.5rem 0;' +
  'border:1px solid #444;border-radius:.5rem;color:#eee;text-decoration:none}a.provider:hover{border-color:#888}' +
  'p{color:#bbb;line-height:1.5}a{color:#8ab4f8}';

function page(title: string, body: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`
  );
}

export function renderChooser(
  providers: ReadonlyArray<{ readonly label: string; readonly href: string }>,
  passwordLoginHref: string | undefined
): string {
  const links = providers
    .map((provider) => `<a class="provider" href="${escapeHtml(provider.href)}">${escapeHtml(provider.label)}</a>`)
    .join('');
  const password =
    passwordLoginHref === undefined
      ? ''
      : `<p><a href="${escapeHtml(passwordLoginHref)}">Sign in with email and password</a></p>`;
  return page('Sign in to HyperDX', `<h1>Sign in to HyperDX</h1>${links}${password}`);
}

const DENIAL_TEXT: Record<string, string> = {
  subjectMissing: 'The identity provider did not return a user identifier.',
  emailMissing: 'The identity provider did not return an email address for your account.',
  emailInvalid: 'Your email address contains characters HyperDX sign-in does not accept.',
  emailInUse: 'A HyperDX account with your email address already belongs to another sign-in. Ask an administrator.',
  instanceNotReady: 'HyperDX is still being set up. Try again in a minute.',
  storeUnavailable: 'HyperDX sign-in is temporarily unavailable. Try again in a minute.',
  unknownProvider: 'That sign-in provider is not configured.',
  emailNotVerified: 'Your email address is not verified with the identity provider.',
  groupNotAllowed: 'Your account is not in a group that is allowed to use HyperDX.',
  emailDomainNotAllowed: "Your email address's domain is not allowed to use HyperDX.",
  noAccount: 'There is no HyperDX account for you, and this provider does not create accounts.',
  providerUnavailable: 'The identity provider could not be reached. Try again in a moment.',
  loginExpired: 'The sign-in took too long. Start again.',
};

export function renderDenied(reason: string, retryHref: string): string {
  const text = DENIAL_TEXT[reason] ?? 'Sign-in failed.';
  return page(
    'Sign-in failed',
    `<h1>Sign-in failed</h1><p>${escapeHtml(text)}</p><p><a href="${escapeHtml(retryHref)}">Try again</a></p>`
  );
}
