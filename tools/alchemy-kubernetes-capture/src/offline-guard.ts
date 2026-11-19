// Installs process-wide guards that fail any attempt to open a network connection,
// resolve a name or issue an HTTP request. Import this module before anything else.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

export interface NetworkAttempt {
  readonly api: string;
  readonly target: string;
}

const attempts: NetworkAttempt[] = [];

export class NetworkBlockedError extends Error {
  constructor(attempt: NetworkAttempt) {
    super(`Network access is blocked during capture: ${attempt.api} ${attempt.target}`);
    this.name = 'NetworkBlockedError';
  }
}

function block(api: string, target: unknown): never {
  const attempt = { api, target: describe(target) };
  attempts.push(attempt);
  if (process.env.TKCAPTURE_DEBUG)
    console.error('[offline-guard] blocked', attempt.api, attempt.target);
  throw new NetworkBlockedError(attempt);
}

function describe(target: unknown): string {
  if (typeof target === 'string') return target;
  if (target instanceof URL) return target.href;
  if (target && typeof target === 'object') {
    const value = target as {
      url?: unknown;
      host?: unknown;
      hostname?: unknown;
      port?: unknown;
      path?: unknown;
    };
    if (typeof value.url === 'string') return value.url;
    const host = value.hostname ?? value.host;
    if (host !== undefined) return `${String(host)}:${String(value.port ?? '')}`;
    if (value.path !== undefined) return String(value.path);
  }
  return String(target);
}

let installed = false;

export function installOfflineGuard(): void {
  if (installed) return;
  installed = true;
  net.Socket.prototype.connect = function connect(...args: unknown[]) {
    return block('net.Socket.connect', args[0]);
  } as typeof net.Socket.prototype.connect;
  net.connect = ((...args: unknown[]) => block('net.connect', args[0])) as typeof net.connect;
  net.createConnection = ((...args: unknown[]) =>
    block('net.createConnection', args[0])) as typeof net.createConnection;
  tls.connect = ((...args: unknown[]) => block('tls.connect', args[0])) as typeof tls.connect;
  http.request = ((...args: unknown[]) => block('http.request', args[0])) as typeof http.request;
  http.get = ((...args: unknown[]) => block('http.get', args[0])) as typeof http.get;
  https.request = ((...args: unknown[]) => block('https.request', args[0])) as typeof https.request;
  https.get = ((...args: unknown[]) => block('https.get', args[0])) as typeof https.get;
  dns.lookup = ((...args: unknown[]) =>
    block('dns.lookup', args[0])) as unknown as typeof dns.lookup;
  dns.resolve = ((...args: unknown[]) =>
    block('dns.resolve', args[0])) as unknown as typeof dns.resolve;
  dns.promises.lookup = ((...args: unknown[]) =>
    block('dns.promises.lookup', args[0])) as typeof dns.promises.lookup;
  globalThis.fetch = ((input: unknown) => {
    try {
      block('fetch', input);
    } catch (error) {
      return Promise.reject(error);
    }
  }) as typeof fetch;
  const bun = (globalThis as { Bun?: Record<string, unknown> }).Bun;
  if (bun) {
    for (const name of ['connect', 'listen', 'serve', 'udpSocket'] as const) {
      if (typeof bun[name] === 'function') {
        bun[name] = (target: unknown) => block(`Bun.${name}`, target);
      }
    }
  }
  (globalThis as { WebSocket?: unknown }).WebSocket = class BlockedWebSocket {
    constructor(url: unknown) {
      block('WebSocket', url);
    }
  };
}

export function networkAttempts(): readonly NetworkAttempt[] {
  return [...attempts];
}
