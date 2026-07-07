process.env.TYPEKRO_STRICT_CEL = '1';
import { makeClickstackBootstrap } from '/Users/yehudac/workspace/typekro-clickstack/src/factories/clickstack/index.js';
const bs = makeClickstackBootstrap({ values: { clickhouse: { enabled: true }, mongodb: { enabled: true }, fullnameOverride: 'evil', hyperdx: { config: { EXTRA: 'kept' } } } });
const yaml = bs.toYaml();
const rel = yaml.slice(yaml.indexOf('id: clickstackHelmRelease'));
console.log(rel.slice(0, 3000));
