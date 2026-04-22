#!/usr/bin/env node
import 'dotenv/config';

import { loadConfig } from './config.js';
import { startHttpServer } from './httpServer.js';
import { createLogger } from './logger.js';
import { startServer as startStdioServer } from './serverApp.js';
import { handleServiceCommand } from './service/manager.js';

interface ClosableRuntime {
  close(reason?: string): Promise<void>;
}

function parseCommand(argv: string[]): {
  command: 'serve-stdio' | 'serve-http' | 'service';
  args: string[];
} {
  const [firstArg, ...rest] = argv;

  if (firstArg === 'serve-http') {
    return { command: 'serve-http', args: rest };
  }

  if (firstArg === 'serve-stdio') {
    return { command: 'serve-stdio', args: rest };
  }

  if (firstArg === 'service') {
    return { command: 'service', args: rest };
  }

  return {
    command: loadConfig().transport === 'http' ? 'serve-http' : 'serve-stdio',
    args: argv,
  };
}

async function main() {
  const parsed = parseCommand(process.argv.slice(2));
  const config = loadConfig();
  const rootLogger = createLogger({
    filePath: config.logPath,
    fileLevel: config.logLevel,
    stderrLevel: config.stderrLogLevel,
    bindings: { component: 'multicli' },
  });
  const logger = rootLogger.child({ component: 'index' });

  logger.info('process_bootstrap', {
    config,
    argv: process.argv,
    parsedCommand: parsed.command,
    cwd: process.cwd(),
    nodeVersion: process.version,
    platform: process.platform,
  });

  if (parsed.command === 'service') {
    await handleServiceCommand(parsed.args, config, rootLogger);
    return;
  }

  const runtime: ClosableRuntime = parsed.command === 'serve-http'
    ? await startHttpServer({ ...config, transport: 'http' }, rootLogger)
    : await startStdioServer({ ...config, transport: 'stdio' }, rootLogger);

  const shutdown = async (signalName: string) => {
    logger.info('process_signal_received', { signalName });
    await runtime.close(`Received ${signalName}`);
  };

  const handleFatalError = (event: string, error: unknown) => {
    logger.error(event, { error });
    process.exitCode = 1;
    void runtime.close(event);
    setTimeout(() => {
      process.exit(1);
    }, parsed.command === 'serve-http' ? 250 : 25).unref();
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('beforeExit', (code) => {
    logger.info('process_before_exit', { code });
  });
  process.once('exit', (code) => {
    logger.info('process_exit', { code });
  });
  process.on('warning', (warning) => {
    logger.error('process_warning', { warning });
  });
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    logger.error('process_uncaught_exception_monitor', { error, origin });
  });
  process.on('uncaughtException', (error, origin) => {
    handleFatalError('process_uncaught_exception', { error, origin });
  });
  process.on('unhandledRejection', (reason, promise) => {
    handleFatalError('process_unhandled_rejection', { reason, promise });
  });
}

main().catch((error) => {
  const config = loadConfig();
  const rootLogger = createLogger({
    filePath: config.logPath,
    fileLevel: config.logLevel,
    stderrLevel: config.stderrLogLevel,
    bindings: { component: 'multicli' },
  });
  const logger = rootLogger.child({ component: 'index' });
  logger.error('server_startup_failed', { error });
  process.exit(1);
});
