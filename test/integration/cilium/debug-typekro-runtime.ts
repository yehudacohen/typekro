/**
 * Debug test to check if TypeKro runtime bootstrap also gets the status builder error
 */

import { typeKroRuntimeBootstrap } from '../../../src/compositions/typekro-runtime/index.js';

console.log('🧪 Testing TypeKro runtime bootstrap...');

try {
  const bootstrap = typeKroRuntimeBootstrap({
    namespace: 'flux-system',
    fluxVersion: 'v2.4.0',
    kroVersion: '0.9.1',
  });

  console.log('✅ TypeKro runtime bootstrap created successfully');
  console.log('Bootstrap name:', bootstrap.name);
} catch (error) {
  console.error('❌ TypeKro runtime bootstrap creation failed:', error);
}
