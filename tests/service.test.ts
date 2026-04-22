import os from 'node:os';
import path from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { MultiCliConfig } from '../src/config.js';
import { getServiceKind, getServicePaths } from '../src/service/paths.js';
import { loadServiceEnvironment } from '../src/service/bootstrap.js';
import { isMatchingClaudeConfigOutput } from '../src/service/manager.js';
import {
  buildServiceEnvFileContents,
  createServiceManifest,
} from '../src/service/runtime.js';
import {
  renderLaunchAgent,
  renderPosixLauncher,
  renderSystemdUnit,
  renderWindowsLauncher,
  renderWindowsTaskXml,
} from '../src/service/renderers.js';

function createConfig(overrides: Partial<MultiCliConfig> = {}): MultiCliConfig {
  const serviceRootDir = path.join(os.tmpdir(), 'multicli-service-test');

  return {
    transport: 'http',
    askTimeoutMs: 1_000,
    helpTimeoutMs: 500,
    cliDetectTimeoutMs: 100,
    killGraceMs: 50,
    taskTtlMs: 60_000,
    taskPollIntervalMs: 5,
    progressIdleHeartbeatMs: 25,
    progressThrottleMs: 1,
    httpHost: '127.0.0.1',
    httpPort: 37420,
    httpPath: '/mcp',
    httpAuthToken: 'token',
    httpSessionIdleMs: 60_000,
    logPath: path.join(serviceRootDir, 'multicli.log'),
    logLevel: 'debug',
    stderrLogLevel: 'silent',
    serviceRootDir,
    serviceLogPath: path.join(serviceRootDir, 'logs', 'service.log'),
    serviceEnvPath: path.join(serviceRootDir, 'env'),
    serviceManifestPath: path.join(serviceRootDir, 'manifest.json'),
    ...overrides,
  };
}

describe('service paths', () => {
  it('selects the expected service kind for each platform', () => {
    expect(getServiceKind('darwin')).toBe('launchd');
    expect(getServiceKind('linux')).toBe('systemd-user');
    expect(getServiceKind('win32')).toBe('windows-task');
  });

  it('renders platform-specific service definition paths', () => {
    const config = createConfig();

    expect(getServicePaths(config, 'darwin').serviceDefinition).toContain('LaunchAgents');
    expect(getServicePaths(config, 'linux').serviceDefinition).toContain('systemd/user');
    expect(getServicePaths(config, 'win32').serviceDefinition).toContain('task.xml');
  });

  it('uses a recognizable launcher filename on macOS', () => {
    const config = createConfig();

    expect(path.basename(getServicePaths(config, 'darwin').launcher)).toBe('Multi-CLI.sh');
    expect(path.basename(getServicePaths(config, 'linux').launcher)).toBe('launcher.sh');
  });
});

describe('service runtime', () => {
  it('builds a manifest with the expected transport metadata', () => {
    const manifest = createServiceManifest(createConfig(), 'token-value', 'darwin');

    expect(manifest.transport.url).toBe('http://127.0.0.1:37420/mcp');
    expect(manifest.transport.healthUrl).toBe('http://127.0.0.1:37420/health');
    expect(manifest.transport.token).toBe('token-value');
    expect(manifest.runtime.bootstrapPath).toContain('bootstrap.');
  });

  it('renders a JSON env file with PATH and managed Multi-CLI variables', () => {
    const manifest = createServiceManifest(createConfig(), 'token-value', 'darwin');
    const contents = buildServiceEnvFileContents(manifest, {
      PATH: '/usr/local/bin:/usr/bin',
      OPENAI_API_KEY: 'secret',
    });

    const parsed = JSON.parse(contents) as Record<string, string>;

    expect(parsed.PATH).toBe('/usr/local/bin:/usr/bin');
    expect(parsed.OPENAI_API_KEY).toBe('secret');
    expect(parsed.MULTICLI_TRANSPORT).toBe('http');
    expect(parsed.MULTICLI_HTTP_AUTH_TOKEN).toBe('token-value');
    expect(parsed.MULTICLI_LOG_PATH).toBe(manifest.paths.logFile);
    expect(parsed.MULTICLI_SERVICE_MANIFEST_PATH).toBe(manifest.paths.manifest);
    expect(parsed.MULTICLI_SERVICE_RUNTIME_PATH).toBeUndefined();
  });

  it('loads the JSON env file into process environment entries', () => {
    const envFile = path.join(os.tmpdir(), `multicli-service-env-${process.pid}.json`);
    writeFileSync(envFile, JSON.stringify({ PATH: '/tmp/bin', MULTICLI_HTTP_AUTH_TOKEN: 'token-value' }), 'utf8');

    try {
      const env = loadServiceEnvironment(envFile, {});
      expect(env.PATH).toBe('/tmp/bin');
      expect(env.MULTICLI_HTTP_AUTH_TOKEN).toBe('token-value');
    } finally {
      rmSync(envFile, { force: true });
    }
  });
});

describe('service renderers', () => {
  it('renders a POSIX launcher that boots the service bootstrap', () => {
    const manifest = createServiceManifest(createConfig(), 'token-value', 'darwin');
    const script = renderPosixLauncher(manifest);

    expect(script).toContain(manifest.paths.envFile);
    expect(script).toContain(manifest.runtime.nodePath);
    expect(script).toContain(manifest.runtime.bootstrapPath);
    expect(script).toContain('serve-http');
  });

  it('renders a Windows launcher that boots the service bootstrap', () => {
    const manifest = createServiceManifest(createConfig(), 'token-value', 'win32');
    const script = renderWindowsLauncher(manifest);

    expect(script).toContain(manifest.paths.envFile);
    expect(script).toContain(manifest.runtime.nodePath);
    expect(script).toContain(manifest.runtime.bootstrapPath);
    expect(script).toContain('serve-http');
  });

  it('renders native service definitions for each platform', () => {
    const manifest = createServiceManifest(createConfig(), 'token-value', 'darwin');
    expect(renderLaunchAgent(manifest)).toContain('<key>Label</key>');
    expect(renderSystemdUnit(createServiceManifest(createConfig(), 'token-value', 'linux')))
      .toContain('ExecStart=');
    expect(renderWindowsTaskXml(createServiceManifest(createConfig(), 'token-value', 'win32')))
      .toContain('<LogonTrigger>');
  });
});

describe('service manager', () => {
  it('matches Claude MCP output only for the managed HTTP config', () => {
    const manifest = createServiceManifest(createConfig(), 'token-value', 'darwin');

    const matchingOutput = [
      'Multi-CLI:',
      '  Scope: User config (available in all your projects)',
      '  Status: ✓ Connected',
      '  Type: http',
      `  URL: ${manifest.transport.url}`,
      '  Headers:',
      `    Authorization: Bearer ${manifest.transport.token}`,
    ].join('\n');

    const stdioOutput = [
      'Multi-CLI:',
      '  Scope: User config (available in all your projects)',
      '  Status: ✓ Connected',
      '  Type: stdio',
      '  Command: node',
      '  Args: /Users/arlogilbert/Repos/multicli/dist/index.js',
    ].join('\n');

    expect(isMatchingClaudeConfigOutput(matchingOutput, manifest)).toBe(true);
    expect(isMatchingClaudeConfigOutput(stdioOutput, manifest)).toBe(false);
  });
});
