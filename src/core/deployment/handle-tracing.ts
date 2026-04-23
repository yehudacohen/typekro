interface HandleTraceLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
}

export interface HandleSnapshot {
  label: string;
  timestamp: string;
  activeResources: string[];
  activeHandleTypes: string[];
}

export function isHandleTracingEnabled(): boolean {
  const value = process.env.TYPEKRO_HANDLE_TRACE;
  return value === '1' || value === 'true';
}

export function captureHandleSnapshot(label: string): HandleSnapshot {
  const activeResources = typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo()
    : [];
  const activeHandleTypes = typeof (process as NodeJS.Process & {
    _getActiveHandles?: () => unknown[];
  })._getActiveHandles === 'function'
    ? ((process as NodeJS.Process & { _getActiveHandles: () => unknown[] })._getActiveHandles())
      .map((handle) => {
        if (handle && typeof handle === 'object') {
          return (handle as { constructor?: { name?: string } }).constructor?.name ?? 'object';
        }

        return typeof handle;
      })
    : [];

  return {
    label,
    timestamp: new Date().toISOString(),
    activeResources,
    activeHandleTypes,
  };
}

export function logHandleSnapshot(
  logger: HandleTraceLogger,
  label: string,
  customState?: Record<string, unknown>
): void {
  if (!isHandleTracingEnabled()) {
    return;
  }

  const snapshot = captureHandleSnapshot(label);
  logger.info('Handle snapshot', {
    label: snapshot.label,
    timestamp: snapshot.timestamp,
    activeResources: snapshot.activeResources,
    activeHandleTypes: snapshot.activeHandleTypes,
    ...(customState ?? {}),
  });
}
