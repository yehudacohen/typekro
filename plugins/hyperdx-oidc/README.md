# HyperDX OIDC plugin

OpenID Connect sign-in for HyperDX's open-source build. It runs inside the HyperDX API process and joins HyperDX's own authentication path: HyperDX's Passport instance, root router and MongoDB-backed sessions. It needs no fork or rebuild of the HyperDX image.

TypeKro bundles it into the library (`src/factories/clickstack/hyperdx-oidc/plugin-bundle.generated.ts`) and ships it to clusters through the `hyperdxOidc` option of `makeClickstackBootstrap`. User documentation, including the configuration format, is in `docs/api/clickstack/index.md` under "Sign-in with OpenID Connect".

| File | Role |
| --- | --- |
| `src/index.ts` | Preload entry. Activates only in the API process, waits for HyperDX to load its root router, then installs. |
| `src/hyperdx.ts` | Wiring: resolves and self-checks HyperDX internals, Mongo-backed account store, per-provider Passport strategies, routes, session guard, password policy, hot reload. |
| `src/oidc.ts` | One provider at runtime: discovery, and the authorization-code flow with PKCE, `state` and `nonce` (`oauth4webapi`). |
| `src/identity.ts` | Claims to account: allow rules, then find-or-link-or-create by (provider, `sub`). |
| `src/bootstrap.ts` | The one registration `passwordLogin: false` lets through: the `initialUser`'s own, matched against its email and password from the env. |
| `src/config.ts` | Configuration parsing and validation. |
| `src/pages.ts` | The provider chooser and access-denied pages. |

After changing anything here, regenerate the bundle (CI fails if it's stale):

```bash
bun run build:hyperdx-oidc-plugin
```

Tests: `test/plugins/hyperdx-oidc/` (unit) and `test/integration/clickstack/hyperdx-oidc-login.test.ts`, which runs the real HyperDX image with a mock OIDC provider (`bun run test:integration:hyperdx-oidc`).
