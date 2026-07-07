process.env.TYPEKRO_STRICT_CEL = '1';
import { clickstackBootstrap } from '/Users/yehudac/workspace/typekro-clickstack/src/factories/clickstack/index.js';
const yaml = clickstackBootstrap.toYaml();
console.log(yaml);
