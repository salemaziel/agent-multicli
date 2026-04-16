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

type HandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ProgressToken = string | number | undefined;
type TaskExecution = {
  controller: AbortController;
};

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
    return { message: error.message };
  }

  return undefined;
}

function createProgressReporter(
  server: Server,
  logger: Logger,
  config: MultiCliConfig,
  progressToken: ProgressToken,
  operationName: string,
) {
  let completed = false;
  let timeout: NodeJS.Timeout | undefined;
  let progress = 0;
  let lastOutputAt = Date.now();
  let lastNotificationAt = 0;
  let latestPreview: string | undefined;
  let flushInFlight = false;

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
      logger.debug('Progress notification failed', {
        operationName,
        error,
      });
    }
  };

  const flushPreview = async (force = false) => {
    if (completed || !latestPreview || flushInFlight) {
      return;
    }

    if (!force && Date.now() - lastNotificationAt < config.progressThrottleMs) {
      return;
    }

    flushInFlight = true;
    const preview = latestPreview;
    latestPreview = undefined;
    progress += 1;
    await sendProgressNotification(progress, preview);
    flushInFlight = false;

    if (latestPreview && !completed) {
      void flushPreview();
    }
  };

  const scheduleHeartbeat = () => {
    timeout = setTimeout(async () => {
      if (completed) {
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

      if (!completed) {
        scheduleHeartbeat();
      }
    }, config.progressIdleHeartbeatMs);
  };

  return {
    start: async () => {
      await sendProgressNotification(0, `Starting ${operationName}`);
      scheduleHeartbeat();
    },
    onOutput: (chunk: string) => {
      if (completed) {
        return;
      }

      lastOutputAt = Date.now();
      const preview = extractProgressPreview(chunk);
      if (!preview) {
        return;
      }

      latestPreview = preview;
      if (Date.now() - lastNotificationAt >= config.progressThrottleMs) {
        void flushPreview(true);
      }
    },
    stop: async (status: 'success' | 'failed' | 'cancelled') => {
      if (latestPreview) {
        await flushPreview(true);
      }

      completed = true;
      if (timeout) {
        clearTimeout(timeout);
      }

      if (status === 'success') {
        await sendProgressNotification(100, `Completed ${operationName}`, 100);
      } else if (status === 'cancelled') {
        await sendProgressNotification(100, `Cancelled ${operationName}`, 100);
      } else {
        await sendProgressNotification(100, `Failed ${operationName}`, 100);
      }
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
): Promise<MultiCliServerApp> {
  await initTools({ cliDetectTimeoutMs: config.cliDetectTimeoutMs });

  const logger = createLogger(config.logLevel);
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

  const abortActiveTasks = (reason: string) => {
    for (const [taskId, taskExecution] of activeTasks.entries()) {
      logger.info('Aborting active task', { taskId, reason });
      taskExecution.controller.abort(new Error(reason));
    }
  };

  server.oninitialized = () => {
    const clientInfo = server.getClientVersion();
    connectedClientName = clientInfo?.name;
    logger.info('Client initialized', {
      clientName: connectedClientName,
    });
  };

  server.onerror = (error) => {
    logger.error('Server error', { error });
  };

  server.onclose = () => {
    logger.info('Server transport closed');
  };

  const executeToolRequest = async (
    toolName: string,
    validatedArgs: ToolArguments,
    progressReporter: ReturnType<typeof createProgressReporter>,
    extra: HandlerExtra,
    taskId?: string,
  ): Promise<string> => {
    const executionContext: ToolExecutionContext = {
      signal: extra.signal,
      onProgress: (newOutput) => progressReporter.onOutput(newOutput),
      timeoutMs: getTimeoutForTool(toolName, config),
      killGraceMs: config.killGraceMs,
      requestId: extra.requestId,
      taskId,
    };

    const tool = getTool(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    return executeValidatedTool(tool, validatedArgs, executionContext);
  };

  server.setRequestHandler(ListToolsRequestSchema, async (_request: ListToolsRequest): Promise<{ tools: Tool[] }> => {
    const visible = filterToolsForClient(toolRegistry, connectedClientName);
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
    const progressReporter = createProgressReporter(server, logger, config, progressToken, toolName);
    const taskParams = (request.params as { task?: { ttl?: number | null; pollInterval?: number } }).task;

    logger.info('Tool request started', {
      requestId: extra.requestId,
      toolName,
      task: !!taskParams,
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
        logger.info('Task cancellation requested', {
          taskId: task.taskId,
          toolName,
          reason,
        });
        controller.abort(new Error(reason ?? 'Task cancelled'));
      });

      const taskExecutionContext: ToolExecutionContext = {
        signal: controller.signal,
        onProgress: (newOutput) => progressReporter.onOutput(newOutput),
        timeoutMs: getTimeoutForTool(toolName, config),
        killGraceMs: config.killGraceMs,
        requestId: extra.requestId,
        taskId: task.taskId,
      };

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
          logger.info('Task completed', {
            toolName,
            taskId: task.taskId,
          });
        } catch (error) {
          const currentTask = await taskStore.getTask(task.taskId);
          if (currentTask?.status === 'cancelled' || controller.signal.aborted) {
            await progressReporter.stop('cancelled');
            logger.info('Task cancelled', {
              toolName,
              taskId: task.taskId,
            });
          } else {
            await extra.taskStore!.storeTaskResult(
              task.taskId,
              'failed',
              buildErrorResult(toolName, error),
            );
            await progressReporter.stop('failed');
            logger.error('Task failed', {
              toolName,
              taskId: task.taskId,
              ...getErrorMeta(error),
            });
          }
        } finally {
          activeTasks.delete(task.taskId);
          taskStore.clearCancelHandler(task.taskId);
        }
      })().catch((error) => {
        logger.error('Unexpected task execution failure', {
          toolName,
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
      logger.info('Tool request completed', {
        requestId: extra.requestId,
        toolName,
      });

      return buildToolResult(result, false);
    } catch (error) {
      const status = error instanceof CommandExecutionError && error.kind === 'cancelled'
        ? 'cancelled'
        : 'failed';
      await progressReporter.stop(status);

      logger.error('Tool request failed', {
        requestId: extra.requestId,
        toolName,
        ...getErrorMeta(error),
      });

      return buildErrorResult(toolName, error);
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async (_request: ListPromptsRequest): Promise<{ prompts: Prompt[] }> => {
    const visible = filterToolsForClient(toolRegistry, connectedClientName);
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
      await server.connect(transport);
    },
    async close(reason = 'Server shutting down') {
      if (closed) {
        return;
      }

      closed = true;
      abortActiveTasks(reason);
      taskStore.cleanup();
      await server.close();
    },
  };
}

export async function startServer(
  config: MultiCliConfig = loadConfig(),
): Promise<MultiCliServerApp> {
  const logger = createLogger(config.logLevel);
  const app = await createServerApp(config);
  const transport = new StdioServerTransport();

  process.stdin.once('end', () => {
    logger.info('stdin ended; closing server');
    void app.close('stdin ended');
  });

  process.stdin.once('close', () => {
    logger.info('stdin closed; closing server');
    void app.close('stdin closed');
  });

  await app.connect(transport);
  return app;
}
