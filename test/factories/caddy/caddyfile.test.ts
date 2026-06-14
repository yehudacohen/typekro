import { describe, expect, it } from 'bun:test';
import { renderCaddyfile } from '../../../src/factories/caddy/index.js';

describe('renderCaddyfile', () => {
  it('renders a tls-internal site block for a single route (default)', () => {
    const out = renderCaddyfile([
      { host: 'dagster-dev.acme.internal', upstream: 'dagster.dagster-platform-dev.svc:80' },
    ]);
    expect(out).toContain('dagster-dev.acme.internal {');
    expect(out).toContain('\ttls internal');
    expect(out).toContain('\treverse_proxy dagster.dagster-platform-dev.svc:80');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('renders an http:// address with no tls when tls is off', () => {
    const out = renderCaddyfile([{ host: 'signoz.acme.internal', upstream: 'signoz.svc:3301' }], {
      tls: 'off',
    });
    expect(out).toContain('http://signoz.acme.internal {');
    expect(out).not.toContain('tls internal');
    expect(out).toContain('\treverse_proxy signoz.svc:3301');
  });

  it('renders one block per route, separated by a blank line', () => {
    const out = renderCaddyfile([
      { host: 'a.acme.internal', upstream: 'a.svc:80' },
      { host: 'b.acme.internal', upstream: 'b.svc:80' },
    ]);
    expect(out).toContain('a.acme.internal {');
    expect(out).toContain('b.acme.internal {');
    expect(out).toContain('}\n\nb.acme.internal {');
    expect((out.match(/tls internal/g) ?? []).length).toBe(2);
  });

  it('renders an empty string (just a newline) for no routes', () => {
    expect(renderCaddyfile([])).toBe('\n');
  });
});
