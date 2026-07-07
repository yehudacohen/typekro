import { describe, expect, it } from 'bun:test';
import {
  assignZonesRoundRobin,
  compileZonePinnedLayout,
  ZONE_TOPOLOGY_KEY,
  zoneNodeAffinity,
  zonePodTemplateName,
} from '../../../src/factories/clickhouse/utils/zone-layout.js';

describe('ClickHouse zone layout helpers', () => {
  describe('assignZonesRoundRobin', () => {
    it('assigns one zone per replica when counts match', () => {
      expect(assignZonesRoundRobin(2, ['us-east-2a', 'us-east-2b'])).toEqual([
        'us-east-2a',
        'us-east-2b',
      ]);
    });

    it('round-robins zones when replicas exceed zones', () => {
      expect(assignZonesRoundRobin(5, ['a', 'b', 'c'])).toEqual([
        'a',
        'b',
        'c',
        'a',
        'b',
      ]);
    });

    it('uses only the leading zones when replicas are fewer than zones', () => {
      expect(assignZonesRoundRobin(1, ['a', 'b', 'c'])).toEqual(['a']);
    });

    it('rejects an empty zone list', () => {
      expect(() => assignZonesRoundRobin(1, [])).toThrow(/at least one zone/);
    });

    it('rejects non-positive replica counts', () => {
      expect(() => assignZonesRoundRobin(0, ['a'])).toThrow(/positive integer/);
      expect(() => assignZonesRoundRobin(-1, ['a'])).toThrow(/positive integer/);
      expect(() => assignZonesRoundRobin(1.5, ['a'])).toThrow(/positive integer/);
    });
  });

  describe('zoneNodeAffinity', () => {
    it('emits a required nodeAffinity on the zone topology key', () => {
      const affinity = zoneNodeAffinity('us-east-2a') as {
        nodeAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: {
            nodeSelectorTerms: {
              matchExpressions: { key: string; operator: string; values: string[] }[];
            }[];
          };
        };
      };

      const expression =
        affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution
          .nodeSelectorTerms[0]?.matchExpressions[0];
      expect(expression).toEqual({
        key: ZONE_TOPOLOGY_KEY,
        operator: 'In',
        values: ['us-east-2a'],
      });
      expect(ZONE_TOPOLOGY_KEY).toBe('topology.kubernetes.io/zone');
    });
  });

  describe('compileZonePinnedLayout', () => {
    it('emits one pod template per distinct zone and one replica entry per replica', () => {
      const layout = compileZonePinnedLayout({
        replicaCount: 5,
        zones: ['a', 'b'],
        podTemplateBaseName: 'clickhouse',
        podSpec: { containers: [{ name: 'clickhouse', image: 'x' }] },
      });

      // 5 replicas over 2 zones → 2 distinct pod templates, 5 replica entries.
      expect(layout.podTemplates.map((t) => t.name)).toEqual([
        'clickhouse-a',
        'clickhouse-b',
      ]);
      expect(layout.replicas.map((r) => r.templates?.podTemplate)).toEqual([
        'clickhouse-a',
        'clickhouse-b',
        'clickhouse-a',
        'clickhouse-b',
        'clickhouse-a',
      ]);
    });

    it('merges the shared pod spec with the per-zone affinity', () => {
      const layout = compileZonePinnedLayout({
        replicaCount: 1,
        zones: ['us-east-2a'],
        podTemplateBaseName: 'clickhouse',
        podSpec: { containers: [{ name: 'clickhouse', image: 'img:1' }] },
      });

      const template = layout.podTemplates[0];
      expect(template?.name).toBe(zonePodTemplateName('clickhouse', 'us-east-2a'));
      expect(template?.spec?.containers).toEqual([
        { name: 'clickhouse', image: 'img:1' },
      ]);
      expect(JSON.stringify(template?.spec?.affinity)).toContain('us-east-2a');
    });
  });
});
