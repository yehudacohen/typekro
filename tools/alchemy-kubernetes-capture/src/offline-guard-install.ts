// Side-effect import: installs the offline guard before any other module loads.
import { installOfflineGuard } from './offline-guard.ts';

installOfflineGuard();
