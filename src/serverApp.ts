import { fileURLToPath } from 'node:url';

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
  type ServerNotification,
  type ServerRequest,
  type CallToolRequest,
  type ListToolsRequest,
  type ListPromptsRequest,
  type GetPromptRequest,
  type Tool,
  type Prompt,
  type GetPromptResult,
  type CallToolResult,
  type CreateTaskResult,
  type Implementation,
  type ListRootsResult,
} from "@modelcontextprotocol/sdk/types.js";
import { PROTOCOL, ToolArguments } from "./constants.js";
import { MultiCliConfig, loadConfig } from "./config.js";
import { ToolExecutionContext } from "./execution.js";
import { Logger, createLogger } from "./logger.js";
import { ManagedTaskStore } from "./taskStore.js";
import {
  getToolDefinitions,
  getPromptDefinitions,
  executeValidatedTool,
  toolExists,
  getPromptMessage,
  toolRegistry,
  initTools,
  getTool,
  validateToolArguments,
} from "./tools/index.js";
import { importantReadNowTool } from './tools/important-read-now.tool.js';
import { filterToolsForClient, isToolBlockedForClient } from './clientFilter.js';
import { CommandExecutionError } from "./utils/commandExecutor.js";
import type { CliAvailability } from "./utils/cliDetector.js";

type HandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ProgressToken = string | number | undefined;
type TaskExecution = {
  controller: AbortController;
};

export interface MultiCliRuntime {
  availability: CliAvailability;
  initializedAt: string;
}

export interface MultiCliSessionContext {
  cwd?: string;
  rootUri?: string;
  projectRoots?: ListRootsResult['roots'];
  env?: NodeJS.ProcessEnv;
  transport?: 'stdio' | 'http';
  clientName?: string;
  resolveWorkingDirectory?: (
    server: Server,
    logger: Logger,
  ) => Promise<{
    cwd?: string;
    rootUri?: string;
    projectRoots?: ListRootsResult['roots'];
  }>;
}

export interface CreateServerAppOptions {
  runtime?: MultiCliRuntime;
  sessionContext?: MultiCliSessionContext;
  onClientInitialized?: (
    server: Server,
    clientInfo: Implementation | undefined,
    sessionContext: MultiCliSessionContext,
  ) => Promise<void> | void;
}

function buildToolResult(text: string, isError: boolean): CallToolResult {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function buildErrorResult(toolName: string, error: unknown): CallToolResult {
  return buildToolResult(
    `Error executing ${toolName}: ${formatErrorMessage(error)}`,
    true,
  );
}

function extractProgressPreview(chunk: string): string | undefined {
  const lines = chunk
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const preview = lines.at(-1) ?? chunk.trim();
  if (!preview) {
    return undefined;
  }

  return preview.length > 180 ? `${preview.slice(0, 177)}...` : preview;
}

function getTimeoutForTool(toolName: string, config: MultiCliConfig): number | undefined {
  const tool = getTool(toolName);
  switch (tool?.timeoutClass) {
    case 'ask':
      return config.askTimeoutMs;
    case 'help':
      return config.helpTimeoutMs;
    default:
      return undefined;
  }
}

function supportsTaskExecution(toolName: string): boolean {
  const tool = getTool(toolName);
  return tool?.execution?.taskSupport === 'optional' || tool?.execution?.taskSupport === 'required';
}

function getErrorMeta(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof CommandExecutionError) {
    return {
      kind: error.kind,
      exitCode: error.details.exitCode,
      stderr: error.details.stderr,
    };
  }

  if (error instanceof Error) {
    return { error };
  }

  return undefined;
}

export async function createServerRuntime(
  config: MultiCliConfig = loadConfig(),
  rootLogger: Logger = createLogger({
    filePath: config.logPath,
    fileLevel: config.logLevel,
    stderrLevel: config.stderrLogLevel,
    bindings: { component: 'multicli' },
  }),
): Promise<MultiCliRuntime> {
  const logger = rootLogger.child({ component: 'serverRuntime' });
  logger.info('server_runtime_initializing', { config });

  const availability = await initTools({
    cliDetectTimeoutMs: config.cliDetectTimeoutMs,
    logger: rootLogger.child({ component: 'cliDetector' }),
  });

  const runtime: MultiCliRuntime = {
    availability,
    initializedAt: new Date().toISOString(),
  };

  logger.info('server_runtime_initialized', { runtime });
  return runtime;
}

export async function resolveWorkingDirectoryFromRoots(
  server: Server,
  logger: Logger,
): Promise<{
  cwd?: string;
  rootUri?: string;
  projectRoots?: ListRootsResult['roots'];
}> {
  try {
    const rootsResult = await server.listRoots();
    const projectRoots = rootsResult.roots;
    const rootUri = rootsResult.roots.at(0)?.uri;
    if (!rootUri) {
      logger.info('session_roots_empty');
      return { projectRoots };
    }

    if (!rootUri.startsWith('file://')) {
      logger.error('session_root_uri_unsupported', { rootUri });
      return { rootUri, projectRoots };
    }

    const cwd = fileURLToPath(rootUri);
    logger.info('session_working_directory_resolved', {
      cwd,
      rootUri,
      projectRoots,
    });
    return { cwd, rootUri, projectRoots };
  } catch (error) {
    logger.error('session_working_directory_resolution_failed', { error });
    return {};
  }
}

function createProgressReporter(
  server: Server,
  logger: Logger,
  config: MultiCliConfig,
  progressToken: ProgressToken,
  operationName: string,
) {
  let completed = false;
  let stopping = false;
  let timeout: NodeJS.Timeout | undefined;
  let progress = 0;
  let lastOutputAt = Date.now();
  let lastNotificationAt = 0;
  let latestPreview: string | undefined;
  let queuedWork: Promise<void> = Promise.resolve();

  const queueProgressWork = (work: () => Promise<void>) => {
    queuedWork = queuedWork.then(work, work);
    return queuedWork;
  };

  const waitForQueuedWork = async () => {
    try {
      await queuedWork;
    } catch (error) {
      logger.debug('progress_work_failed', {
        operationName,
        error,
      });
    }
  };

  const sendProgressNotification = async (
    currentProgress: number,
    message: string,
    total?: number,
  ) => {
    if (progressToken === undefined || progressToken === null) {
      return;
    }

    try {
      const params: Record<string, unknown> = {
        progressToken,
        progress: currentProgress,
        message,
      };
      if (total !== undefined) {
        params.total = total;
      }

      await server.notification({
        method: PROTOCOL.NOTIFICATIONS.PROGRESS,
        params,
      });
      lastNotificationAt = Date.now();
    } catch (error) {
      logger.debug('progress_notification_failed', {
        operationName,
        error,
      });
    }
  };

  const flushPreview = async (force = false, allowWhileStopping = false) => {
    if (completed || (!allowWhileStopping && stopping) || !latestPreview) {
      return;
    }

    if (!force && Date.now() - lastNotificationAt < config.progressThrottleMs) {
      return;
    }

    const preview = latestPreview;
    latestPreview = undefined;
    progress += 1;
    await sendProgressNotification(progress, preview);
  };

  const scheduleHeartbeat = () => {
    timeout = setTimeout(() => {
      void queueProgressWork(async () => {
        if (completed || stopping) {
          return;
        }

        if (latestPreview) {
          await flushPreview(true);
        } else if (Date.now() - lastOutputAt >= config.progressIdleHeartbeatMs) {
          progress += 1;
          await sendProgressNotification(
            progress,
            `Still running ${operationName}...`,
          );
        }
      }).finally(() => {
        if (!completed && !stopping) {
          scheduleHeartbeat();
        }
      });
    }, config.progressIdleHeartbeatMs);
  };

  return {
    start: async () => {
      await queueProgressWork(async () => {
        await sendProgressNotification(0, `Starting ${operationName}`);
      });
      scheduleHeartbeat();
    },
    onOutput: (chunk: string) => {
      if (completed || stopping) {
        return;
      }

      lastOutputAt = Date.now();
      const preview = extractProgressPreview(chunk);
      if (!preview) {
        return;
      }

      latestPreview = preview;
      if (Date.now() - lastNotificationAt >= config.progressThrottleMs) {
        void queueProgressWork(async () => {
          await flushPreview(true);
        });
      }
    },
    stop: async (status: 'success' | 'failed' | 'cancelled') => {
      if (stopping) {
        await waitForQueuedWork();
        return;
      }

      stopping = true;
      if (timeout) {
        clearTimeout(timeout);
      }

      await queueProgressWork(async () => {
        await flushPreview(true, true);
        completed = true;

        if (status === 'success') {
          await sendProgressNotification(100, `Completed ${operationName}`, 100);
        } else if (status === 'cancelled') {
          await sendProgressNotification(100, `Cancelled ${operationName}`, 100);
        } else {
          await sendProgressNotification(100, `Failed ${operationName}`, 100);
        }
      });

      await waitForQueuedWork();
    },
  };
}

export interface MultiCliServerApp {
  readonly server: Server;
  readonly config: MultiCliConfig;
  connect(transport: Transport): Promise<void>;
  close(reason?: string): Promise<void>;
}

export async function createServerApp(
  config: MultiCliConfig = loadConfig(),
  rootLogger: Logger = createLogger({
    filePath: config.logPath,
    fileLevel: config.logLevel,
    stderrLevel: config.stderrLogLevel,
    bindings: { component: 'multicli' },
  }),
  options: CreateServerAppOptions = {},
): Promise<MultiCliServerApp> {
  const logger = rootLogger.child({ component: 'serverApp' });
  const sessionContext = options.sessionContext ?? { transport: 'stdio', cwd: process.cwd() };
  const runtime = options.runtime ?? await createServerRuntime(config, rootLogger);

  logger.info('server_app_initializing', {
    config,
    runtime,
    sessionContext,
  });

  const taskStore = new ManagedTaskStore();
  const activeTasks = new Map<string, TaskExecution>();

  const server = new Server(
    {
      name: "Multi-CLI",
      version: process.env.npm_package_version || "1.5.0",
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        tasks: {
          list: {},
          cancel: {},
          requests: {
            tools: {
              call: {},
            },
          },
        },
      },
      taskStore,
      defaultTaskPollInterval: config.taskPollIntervalMs,
    },
  );

  let connectedClientName: string | undefined;
  let closed = false;

  const resolveSessionExecutionContext = async (requestLogger: Logger): Promise<{
    cwd?: string;
    projectRoots?: ListRootsResult['roots'];
  }> => {
    if (sessionContext.cwd || sessionContext.projectRoots) {
      return {
        cwd: sessionContext.cwd,
        projectRoots: sessionContext.projectRoots,
      };
    }

    if (!sessionContext.resolveWorkingDirectory) {
      return {
        cwd: sessionContext.cwd,
        projectRoots: sessionContext.projectRoots,
      };
    }

    const result = await sessionContext.resolveWorkingDirectory(
      server,
      requestLogger.child({ component: 'workingDirectory' }),
    );

    if (result.cwd) {
      sessionContext.cwd = result.cwd;
    }
    if (result.rootUri) {
      sessionContext.rootUri = result.rootUri;
    }
    if (result.projectRoots) {
      sessionContext.projectRoots = result.projectRoots;
    }

    return {
      cwd: sessionContext.cwd,
      projectRoots: sessionContext.projectRoots,
    };
  };

  const abortActiveTasks = (reason: string) => {
    logger.info('active_task_abort_started', {
      reason,
      activeTaskCount: activeTasks.size,
    });
    for (const [taskId, taskExecution] of activeTasks.entries()) {
      logger.info('active_task_aborting', { taskId, reason });
      taskExecution.controller.abort(new Error(reason));
    }
  };

  server.oninitialized = () => {
    const clientInfo = server.getClientVersion();
    connectedClientName = clientInfo?.name;
    sessionContext.clientName = connectedClientName;
    logger.info('client_initialized', {
      client: clientInfo,
      transport: sessionContext.transport,
    });
    void options.onClientInitialized?.(server, clientInfo, sessionContext);
  };

  server.onerror = (error) => {
    logger.error('server_error', { error });
  };

  server.onclose = () => {
    logger.info('server_transport_closed', {
      connectedClientName,
      activeTaskCount: activeTasks.size,
    });
  };

  const executeToolRequest = async (
    toolName: string,
    validatedArgs: ToolArguments,
    progressReporter: ReturnType<typeof createProgressReporter>,
    extra: HandlerExtra,
    taskId?: string,
  ): Promise<string> => {
    const requestLogger = logger.child({
      component: 'toolExecution',
      toolName,
      requestId: extra.requestId,
      ...(taskId ? { taskId } : {}),
    });
    const { cwd, projectRoots } = await resolveSessionExecutionContext(requestLogger);
    const executionContext: ToolExecutionContext = {
      signal: extra.signal,
      onProgress: (newOutput) => progressReporter.onOutput(newOutput),
      timeoutMs: getTimeoutForTool(toolName, config),
      killGraceMs: config.killGraceMs,
      cwd,
      projectRoots,
      env: sessionContext.env,
      requestId: extra.requestId,
      taskId,
      logger: requestLogger,
    };

    const tool = getTool(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    return executeValidatedTool(tool, validatedArgs, executionContext);
  };

  server.setRequestHandler(ListToolsRequestSchema, async (_request: ListToolsRequest): Promise<{ tools: Tool[] }> => {
    const visible = filterToolsForClient(toolRegistry, connectedClientName);
    logger.debug('list_tools_requested', {
      connectedClientName,
      visibleToolNames: visible.map((tool) => tool.name),
    });
    if (visible.length === 0) {
      return { tools: getToolDefinitions([importantReadNowTool]) as unknown as Tool[] };
    }
    return { tools: getToolDefinitions(visible) as unknown as Tool[] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (
    request: CallToolRequest,
    extra: HandlerExtra,
  ): Promise<CallToolResult | CreateTaskResult> => {
    const toolName: string = request.params.name;

    if (toolName === importantReadNowTool.name) {
      const result = await importantReadNowTool.execute({});
      return buildToolResult(result, false);
    }

    const toolEntry = getTool(toolName);
    if (isToolBlockedForClient(toolEntry, connectedClientName)) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    if (!toolExists(toolName)) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    const args: ToolArguments = (request.params.arguments as ToolArguments) || {};
    const validatedArgs = validateToolArguments(toolName, args);
    const progressToken = (request.params as { _meta?: { progressToken?: ProgressToken } })._meta?.progressToken;
    const requestLogger = logger.child({
      component: 'toolRequest',
      requestId: extra.requestId,
      toolName,
    });
    const progressReporter = createProgressReporter(server, requestLogger, config, progressToken, toolName);
    const taskParams = (request.params as { task?: { ttl?: number | null; pollInterval?: number } }).task;

    requestLogger.info('tool_request_started', {
      task: !!taskParams,
      taskParams,
      progressToken,
      arguments: validatedArgs,
    });

    if (taskParams) {
      if (!supportsTaskExecution(toolName)) {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Tool "${toolName}" does not support task augmentation.`,
        );
      }

      if (!extra.taskStore) {
        throw new McpError(
          ErrorCode.InternalError,
          `Task store not configured for task execution.`,
        );
      }

      const task = await extra.taskStore.createTask({
        ttl: taskParams.ttl ?? config.taskTtlMs,
        pollInterval: taskParams.pollInterval ?? config.taskPollIntervalMs,
      });

      const controller = new AbortController();
      activeTasks.set(task.taskId, { controller });
      taskStore.registerCancelHandler(task.taskId, (reason) => {
        requestLogger.info('task_cancellation_requested', {
          taskId: task.taskId,
          reason,
        });
        controller.abort(new Error(reason ?? 'Task cancelled'));
      });

      const taskLogger = requestLogger.child({
        component: 'taskExecution',
        taskId: task.taskId,
      });
      const { cwd, projectRoots } = await resolveSessionExecutionContext(taskLogger);
      const taskExecutionContext: ToolExecutionContext = {
        signal: controller.signal,
        onProgress: (newOutput) => progressReporter.onOutput(newOutput),
        timeoutMs: getTimeoutForTool(toolName, config),
        killGraceMs: config.killGraceMs,
        cwd,
        projectRoots,
        env: sessionContext.env,
        requestId: extra.requestId,
        taskId: task.taskId,
        logger: taskLogger,
      };

      requestLogger.info('task_created', {
        taskId: task.taskId,
        taskParams,
      });

      void (async () => {
        await progressReporter.start();
        try {
          const tool = getTool(toolName);
          if (!tool) {
            throw new Error(`Unknown tool: ${toolName}`);
          }

          const result = await executeValidatedTool(tool, validatedArgs, taskExecutionContext);
          await extra.taskStore!.storeTaskResult(
            task.taskId,
            'completed',
            buildToolResult(result, false),
          );
          await progressReporter.stop('success');
          taskLogger.info('task_completed', {
            taskId: task.taskId,
            resultLength: result.length,
          });
        } catch (error) {
          const currentTask = await taskStore.getTask(task.taskId);
          if (currentTask?.status === 'cancelled' || controller.signal.aborted) {
            await progressReporter.stop('cancelled');
            taskLogger.info('task_cancelled', {
              taskId: task.taskId,
            });
          } else {
            await extra.taskStore!.storeTaskResult(
              task.taskId,
              'failed',
              buildErrorResult(toolName, error),
            );
            await progressReporter.stop('failed');
            taskLogger.error('task_failed', {
              ...getErrorMeta(error),
            });
          }
        } finally {
          activeTasks.delete(task.taskId);
          taskStore.clearCancelHandler(task.taskId);
        }
      })().catch((error) => {
        requestLogger.error('task_execution_unexpected_failure', {
          taskId: task.taskId,
          error,
        });
      });

      return { task };
    }

    await progressReporter.start();

    try {
      const result = await executeToolRequest(
        toolName,
        validatedArgs,
        progressReporter,
        extra,
      );

      await progressReporter.stop('success');
      requestLogger.info('tool_request_completed', {
        resultLength: result.length,
      });

      return buildToolResult(result, false);
    } catch (error) {
      const status = error instanceof CommandExecutionError && error.kind === 'cancelled'
        ? 'cancelled'
        : 'failed';
      await progressReporter.stop(status);

      requestLogger.error('tool_request_failed', {
        ...getErrorMeta(error),
      });

      return buildErrorResult(toolName, error);
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async (_request: ListPromptsRequest): Promise<{ prompts: Prompt[] }> => {
    const visible = filterToolsForClient(toolRegistry, connectedClientName);
    logger.debug('list_prompts_requested', {
      connectedClientName,
      visiblePromptNames: visible.filter((tool) => tool.prompt).map((tool) => tool.name),
    });
    return { prompts: getPromptDefinitions(visible) as unknown as Prompt[] };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request: GetPromptRequest): Promise<GetPromptResult> => {
    const promptName = request.params.name;
    const promptEntry = getTool(promptName);
    if (isToolBlockedForClient(promptEntry, connectedClientName)) {
      throw new Error(`Unknown prompt: ${promptName}`);
    }

    const args = request.params.arguments || {};
    const promptMessage = getPromptMessage(promptName, args);

    if (!promptMessage) {
      throw new Error(`Unknown prompt: ${promptName}`);
    }

    logger.debug('get_prompt_requested', {
      promptName,
      arguments: args,
    });

    return {
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: promptMessage,
        },
      }],
    };
  });

  return {
    server,
    config,
    async connect(transport: Transport) {
      logger.info('server_connect_started', {
        transport: transport.constructor.name,
      });
      await server.connect(transport);
      logger.info('server_connect_completed', {
        transport: transport.constructor.name,
      });
    },
    async close(reason = 'Server shutting down') {
      if (closed) {
        logger.debug('server_close_ignored', { reason });
        return;
      }

      closed = true;
      logger.info('server_close_started', {
        reason,
        activeTaskCount: activeTasks.size,
      });
      abortActiveTasks(reason);
      taskStore.cleanup();
      await server.close();
      logger.info('server_close_completed', { reason });
    },
  };
}

export async function startServer(
  config: MultiCliConfig = loadConfig(),
  rootLogger: Logger = createLogger({
    filePath: config.logPath,
    fileLevel: config.logLevel,
    stderrLevel: config.stderrLogLevel,
    bindings: { component: 'multicli' },
  }),
): Promise<MultiCliServerApp> {
  const logger = rootLogger.child({ component: 'startServer' });
  logger.info('stdio_server_starting', { config });
  const runtime = await createServerRuntime(config, rootLogger);
  const app = await createServerApp(config, rootLogger, {
    runtime,
    sessionContext: {
      transport: 'stdio',
      cwd: process.cwd(),
    },
    onClientInitialized: async (server, _clientInfo, sessionContext) => {
      const resolved = await resolveWorkingDirectoryFromRoots(
        server,
        rootLogger.child({ component: 'stdioSession' }),
      );
      sessionContext.cwd = resolved.cwd ?? sessionContext.cwd;
      sessionContext.rootUri = resolved.rootUri;
      sessionContext.projectRoots = resolved.projectRoots;
    },
  });
  const transport = new StdioServerTransport();

  process.stdin.once('end', () => {
    logger.info('stdin_ended');
    void app.close('stdin ended');
  });

  process.stdin.once('close', () => {
    logger.info('stdin_closed');
    void app.close('stdin closed');
  });

  process.stdin.once('error', (error) => {
    logger.error('stdin_error', { error });
    void app.close('stdin error');
  });

  await app.connect(transport);
  logger.info('stdio_server_started', {
    transport: transport.constructor.name,
  });
  return app;
}
