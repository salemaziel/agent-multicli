import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

describe('config', () => {
  it('uses verbose file logging defaults with a standard log path', () => {
    const config = loadConfig({});

    expect(config.transport).toBe('stdio');
    expect(config.httpHost).toBe('127.0.0.1');
    expect(config.httpPort).toBe(37420);
    expect(config.httpPath).toBe('/mcp');
    expect(config.logLevel).toBe('debug');
    expect(config.stderrLogLevel).toBe('error');
    expect(config.logPath).toBe(
      path.join(os.homedir(), '.multicli', 'logs', 'multicli.log'),
    );
    expect(config.serviceRootDir.toLowerCase()).toContain('multicli');
    expect(config.serviceEnvPath).toContain(config.serviceRootDir);
    expect(config.serviceManifestPath).toBe(
      path.join(config.serviceRootDir, 'manifest.json'),
    );
  });

  it('allows log path and stderr level overrides from the environment', () => {
    const config = loadConfig({
      MULTICLI_LOG_PATH: '/tmp/custom-multicli.log',
      MULTICLI_LOG_LEVEL: 'info',
      MULTICLI_STDERR_LOG_LEVEL: 'silent',
    });

    expect(config.logPath).toBe('/tmp/custom-multicli.log');
    expect(config.logLevel).toBe('info');
    expect(config.stderrLogLevel).toBe('silent');
  });

  it('parses HTTP and service configuration from the environment', () => {
    const config = loadConfig({
      MULTICLI_TRANSPORT: 'http',
      MULTICLI_HTTP_HOST: '127.0.0.1',
      MULTICLI_HTTP_PORT: '40123',
      MULTICLI_HTTP_PATH: 'custom-mcp',
      MULTICLI_HTTP_AUTH_TOKEN: 'secret-token',
      MULTICLI_HTTP_SESSION_IDLE_MS: '60000',
      MULTICLI_SERVICE_ROOT_DIR: '/tmp/multicli-service',
      MULTICLI_SERVICE_MANIFEST_PATH: '/tmp/multicli-service/custom-manifest.json',
    });

    expect(config.transport).toBe('http');
    expect(config.httpHost).toBe('127.0.0.1');
    expect(config.httpPort).toBe(40123);
    expect(config.httpPath).toBe('/custom-mcp');
    expect(config.httpAuthToken).toBe('secret-token');
    expect(config.httpSessionIdleMs).toBe(60000);
    expect(config.serviceRootDir).toBe('/tmp/multicli-service');
    expect(config.serviceLogPath).toBe('/tmp/multicli-service/logs/service.log');
    expect(config.serviceManifestPath).toBe('/tmp/multicli-service/custom-manifest.json');
  });

  it('accepts the legacy runtime-path env var as a manifest-path alias', () => {
    const config = loadConfig({
      MULTICLI_SERVICE_ROOT_DIR: '/tmp/multicli-service',
      MULTICLI_SERVICE_RUNTIME_PATH: '/tmp/multicli-service/legacy-manifest.json',
    });

    expect(config.serviceManifestPath).toBe('/tmp/multicli-service/legacy-manifest.json');
  });
});
