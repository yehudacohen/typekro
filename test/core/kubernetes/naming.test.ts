/**
 * Tests for the derived name-length limit.
 *
 * The point of `deriveNameLengthLimit` is that a composition never has to write
 * the bound on its `name` field as a literal — a literal hides which generated
 * name produced it, and goes stale the moment a chart adds a longer suffix.
 * These tests pin the arithmetic, the choice of binding constraint, and the
 * message the schema hands the caller.
 */
import { describe, expect, it } from 'bun:test';
import {
  deriveNameLengthLimit,
  DNS_LABEL_MAX_LENGTH,
  DNS_SUBDOMAIN_MAX_LENGTH,
  HELM_RELEASE_NAME_MAX_LENGTH,
} from '../../../src/core/kubernetes/naming.js';

/**
 * `-<ordinal>` on a StatefulSet's Pods, for the `generatedChars` case.
 *
 * A StatefulSet names its Pods `<name>-<ordinal>` DETERMINISTICALLY, so an
 * over-long one is rejected — which is what makes it a legitimate reservation.
 * A Deployment's Pods are not: those go through `metadata.generateName`, which
 * truncates the base before appending its suffix.
 */
const STATEFULSET_ORDINAL_RESERVED = 3;

describe('deriveNameLengthLimit', () => {
  it('subtracts a literal suffix from that name\'s own limit', () => {
    const limit = deriveNameLengthLimit([
      { describedAs: 'the metadata ConfigMap `<name>-typekro-metadata`', suffix: '-typekro-metadata', limit: DNS_LABEL_MAX_LENGTH },
    ]);

    expect(limit.maxLength).toBe(DNS_LABEL_MAX_LENGTH - '-typekro-metadata'.length);
  });

  it('takes the tightest constraint, not the first or the longest suffix', () => {
    // The suffix-free Helm release name is tighter than a 4-character suffix
    // under the DNS label limit, so it has to win despite reserving nothing.
    const limit = deriveNameLengthLimit([
      { describedAs: 'the UDP Service `<name>-udp`', suffix: '-udp', limit: DNS_LABEL_MAX_LENGTH },
      { describedAs: 'the Helm release name', limit: HELM_RELEASE_NAME_MAX_LENGTH },
    ]);

    expect(limit.maxLength).toBe(HELM_RELEASE_NAME_MAX_LENGTH);
    expect(limit.binding.describedAs).toBe('the Helm release name');
  });

  it('counts generated characters alongside a literal suffix', () => {
    const limit = deriveNameLengthLimit([
      {
        describedAs: 'a Pod of the worker StatefulSet `<name>-worker-<ordinal>`',
        suffix: '-worker',
        generatedChars: STATEFULSET_ORDINAL_RESERVED,
        limit: DNS_LABEL_MAX_LENGTH,
      },
    ]);

    expect(limit.maxLength).toBe(
      DNS_LABEL_MAX_LENGTH - '-worker'.length - STATEFULSET_ORDINAL_RESERVED
    );
  });

  it('names the limit and the constraint behind it in the message', () => {
    const limit = deriveNameLengthLimit([
      { describedAs: 'the UDP Service `<name>-udp`', suffix: '-udp', limit: DNS_LABEL_MAX_LENGTH },
    ]);

    expect(limit.message).toContain(String(limit.maxLength));
    expect(limit.message).toContain('the UDP Service `<name>-udp`');
    expect(limit.message).toContain(String(DNS_LABEL_MAX_LENGTH));
  });

  it('drops the "reserves" clause when nothing is appended', () => {
    const limit = deriveNameLengthLimit([
      { describedAs: 'the object name', limit: DNS_SUBDOMAIN_MAX_LENGTH },
    ]);

    expect(limit.maxLength).toBe(DNS_SUBDOMAIN_MAX_LENGTH);
    expect(limit.message).not.toContain('reserves');
  });

  it('refuses to derive a limit from nothing', () => {
    expect(() => deriveNameLengthLimit([])).toThrow(/at least one generated-name constraint/);
  });

  it('refuses a constraint that leaves no room for a name at all', () => {
    expect(() =>
      deriveNameLengthLimit([
        { describedAs: 'an over-long derived name', generatedChars: 63, limit: DNS_LABEL_MAX_LENGTH },
      ])
    ).toThrow(/leaving no room for a name/);
  });
});
