process.env.TYPEKRO_STRICT_CEL = '1';
import { clickstackBootstrap, clickstackK8sTelemetry, makeClickstackBootstrap } from '/Users/yehudac/workspace/typekro-clickstack/src/factories/clickstack/index.js';

try {
  const yaml = clickstackBootstrap.toYaml();
  console.log('=== bootstrap OK, length', yaml.length);
  const statusSection = yaml.slice(yaml.indexOf('status:'), yaml.indexOf('resources:'));
  console.log('--- status section ---');
  console.log(statusSection);
} catch (e) { console.log('BOOTSTRAP FAILED:', (e as Error).message); }

try {
  const yaml2 = clickstackK8sTelemetry.toYaml();
  console.log('=== telemetry OK, length', yaml2.length);
} catch (e) { console.log('TELEMETRY FAILED:', (e as Error).message); }

try {
  const ext = makeClickstackBootstrap({ mongo: { mode: 'external' } });
  const yaml3 = ext.toYaml();
  console.log('=== external-mongo OK, length', yaml3.length);
} catch (e) { console.log('EXTERNAL FAILED:', (e as Error).message); }
