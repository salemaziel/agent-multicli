import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';

import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { loadConfig, type MultiCliConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import {
  createServerApp,
  createServerRuntime,
  resolveWorkingDirectoryFromRoots,
  type MultiCliRuntime,
  type MultiCliServerApp,
  type MultiCliSessionContext,
} from './serverApp.js';

interface HttpSessionRecord {
  readonly sessionId: string;
  readonly app: MultiCliServerApp;
  readonly transport: StreamableHTTPServerTransport;
  readonly logger: Logger;
  readonly sessionContext: MultiCliSessionContext;
  lastActivityAt: number;
  idleTimer?: NodeJS.Timeout;
  closing: boolean;
}

export interface MultiCliHttpServer {
  readonly config: MultiCliConfig;
  readonly runtime: MultiCliRuntime;
  readonly url: string;
  readonly healthUrl: string;
  close(reason?: string): Promise<void>;
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost';
}

function validateHttpConfig(config: MultiCliConfig): void {
  if (!isLoopbackHost(config.httpHost)) {
    throw new Error(
      `HTTP host must be loopback-only. Received "${config.httpHost}".`,
    );
  }

  if (!config.httpPath.startsWith('/')) {
    throw new Error(`HTTP path must start with "/". Received "${config.httpPath}".`);
  }

  if (!config.httpAuthToken?.trim()) {
    throw new Error(
      'HTTP auth token is required in HTTP mode. Set MULTICLI_HTTP_AUTH_TOKEN or install the managed service first.',
    );
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function createOriginValidationMiddleware(
  logger: Logger,
  host: string,
) {
  return (req: any, res: any, next: any) => {
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }

    try {
      const url = new URL(origin);
      if (url.hostname === host || url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
        next();
        return;
      }
    } catch (error) {
      logger.error('http_origin_invalid', { origin, error });
    }

    logger.error('http_origin_rejected', { origin, host });
    res.status(403).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Invalid Origin header',
      },
      id: null,
    });
  };
}

function createAuthMiddleware(
  logger: Logger,
  token: string,
) {
  return (req: any, res: any, next: any) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      logger.error('http_auth_missing', {
        method: req.method,
        path: req.path,
      });
      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Missing Authorization header',
        },
        id: null,
      });
      return;
    }

    const providedToken = header.slice('Bearer '.length);
    if (!safeEqual(providedToken, token)) {
      logger.error('http_auth_rejected', {
        method: req.method,
        path: req.path,
      });
      res.status(401).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Invalid Authorization header',
        },
        id: null,
      });
      return;
    }

    next();
  };
}

export async function startHttpServer(
  config: MultiCliConfig = loadConfig(),
  rootLogger: Logger = createLogger({
    filePath: config.logPath,
    fileLevel: config.logLevel,
    stderrLevel: config.stderrLogLevel,
    bindings: { component: 'multicli' },
  }),
  runtime?: MultiCliRuntime,
): Promise<MultiCliHttpServer> {
  validateHttpConfig(config);
  const resolvedRuntime = runtime ?? await createServerRuntime(config, rootLogger);

  const logger = rootLogger.child({ component: 'httpServer' });
  const sessions = new Map<string, HttpSessionRecord>();

  const app = createMcpExpressApp({ host: config.httpHost });
  const originValidation = createOriginValidationMiddleware(logger, config.httpHost);
  const authValidation = createAuthMiddleware(logger, config.httpAuthToken!);

  const touchSession = (record: HttpSessionRecord) => {
    record.lastActivityAt = Date.now();
    if (record.idleTimer) {
      clearTimeout(record.idleTimer);
    }

    record.idleTimer = setTimeout(() => {
      void cleanupSession(record.sessionId, 'session idle timeout');
    }, config.httpSessionIdleMs);
    record.idleTimer.unref();
  };

  const cleanupSession = async (sessionId: string, reason: string) => {
    const record = sessions.get(sessionId);
    if (!record || record.closing) {
      return;
    }

    record.closing = true;
    if (record.idleTimer) {
      clearTimeout(record.idleTimer);
      record.idleTimer = undefined;
    }

    sessions.delete(sessionId);
    record.logger.info('http_session_closing', {
      reason,
      lastActivityAt: new Date(record.lastActivityAt).toISOString(),
    });

    try {
      await record.transport.close();
    } catch (error) {
      record.logger.error('http_session_transport_close_failed', { error, reason });
    }

    try {
      await record.app.close(reason);
    } catch (error) {
      record.logger.error('http_session_app_close_failed', { error, reason });
    }
  };

  app.get('/health', (_req: any, res: any) => {
    res.json({
      ok: true,
      transport: 'http',
      sessions: sessions.size,
      path: config.httpPath,
      host: config.httpHost,
      port: config.httpPort,
    });
  });

  app.use(config.httpPath, originValidation, authValidation);

  app.post(config.httpPath, async (req: any, res: any) => {
    const requestLogger = logger.child({
      component: 'httpRequest',
      method: 'POST',
      path: req.path,
      sessionId: req.headers['mcp-session-id'],
    });

    try {
      const rawSessionId = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          requestLogger.error('http_session_missing', { sessionId });
          res.status(404).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Unknown session',
            },
            id: null,
          });
          return;
        }

        touchSession(existing);
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        requestLogger.error('http_initialize_required');
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'A new HTTP session must begin with initialize.',
          },
          id: null,
        });
        return;
      }

      const sessionContext: MultiCliSessionContext = {
        transport: 'http',
        resolveWorkingDirectory: async (server, sessionResolveLogger) => resolveWorkingDirectoryFromRoots(
          server,
          sessionResolveLogger,
        ),
      };
      const sessionLogger = logger.child({
        component: 'httpSession',
      });
      const sessionApp = await createServerApp(config, rootLogger, {
        runtime: resolvedRuntime,
        sessionContext,
        onClientInitialized: async (server, _clientInfo, currentSessionContext) => {
          const resolved = await resolveWorkingDirectoryFromRoots(
            server,
            sessionLogger.child({ component: 'roots' }),
          );
          currentSessionContext.cwd = resolved.cwd ?? currentSessionContext.cwd;
          currentSessionContext.rootUri = resolved.rootUri;
          currentSessionContext.projectRoots = resolved.projectRoots;
        },
      });

      let sessionRecord: HttpSessionRecord | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessionRecord = {
            sessionId: newSessionId,
            app: sessionApp,
            transport,
            logger: sessionLogger.child({ sessionId: newSessionId }),
            sessionContext,
            lastActivityAt: Date.now(),
            closing: false,
          };

          sessions.set(newSessionId, sessionRecord);
          touchSession(sessionRecord);
          sessionRecord.logger.info('http_session_initialized', {
            cwd: sessionContext.cwd,
            rootUri: sessionContext.rootUri,
            projectRoots: sessionContext.projectRoots,
          });
        },
        onsessionclosed: async (closedSessionId) => {
          await cleanupSession(closedSessionId, 'client requested session close');
        },
        retryInterval: 1000,
      });

      await sessionApp.connect(transport);
      await transport.handleRequest(req, res, req.body);

      if (sessionRecord) {
        touchSession(sessionRecord);
      }
    } catch (error) {
      requestLogger.error('http_post_failed', { error });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  app.get(config.httpPath, async (req: any, res: any) => {
    const rawSessionId = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
    if (!sessionId) {
      res.status(400).send('Missing session ID');
      return;
    }

    const record = sessions.get(sessionId);
    if (!record) {
      res.status(404).send('Unknown session');
      return;
    }

    touchSession(record);
    await record.transport.handleRequest(req, res);
  });

  app.delete(config.httpPath, async (req: any, res: any) => {
    const rawSessionId = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
    if (!sessionId) {
      res.status(400).send('Missing session ID');
      return;
    }

    const record = sessions.get(sessionId);
    if (!record) {
      res.status(404).send('Unknown session');
      return;
    }

    touchSession(record);
    await record.transport.handleRequest(req, res);
  });

  const listener = await new Promise<HttpServer>((resolve, reject) => {
    const server = app.listen(config.httpPort, config.httpHost, () => resolve(server));
    server.once('error', reject);
  });

  logger.info('http_server_started', {
    host: config.httpHost,
    port: config.httpPort,
    path: config.httpPath,
  });

  return {
    config,
    runtime: resolvedRuntime,
    url: `http://${config.httpHost}:${config.httpPort}${config.httpPath}`,
    healthUrl: `http://${config.httpHost}:${config.httpPort}/health`,
    async close(reason = 'HTTP server shutting down') {
      logger.info('http_server_closing', {
        reason,
        sessionCount: sessions.size,
      });

      await Promise.all(
        [...sessions.keys()].map((sessionId) => cleanupSession(sessionId, reason)),
      );

      await new Promise<void>((resolve, reject) => {
        listener.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      logger.info('http_server_closed', { reason });
    },
  };
}
