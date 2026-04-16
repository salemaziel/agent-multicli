import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../src/utils/cliDetector.js', () => ({
  detectAvailableClis: vi.fn(),
}));

vi.mock('../src/utils/commandExecutor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/commandExecutor.js')>();
  return {
    ...actual,
    executeCommand: vi.fn(),
  };
});

import { detectAvailableClis } from '../src/utils/cliDetector.js';
import { executeCommand, CommandExecutionError } from '../src/utils/commandExecutor.js';
import { createServerApp } from '../src/serverApp.js';
import type { MultiCliServerApp } from '../src/serverApp.js';
import type { MultiCliConfig } from '../src/config.js';

const TEST_CONFIG: MultiCliConfig = {
  askTimeoutMs: 1000,
  helpTimeoutMs: 500,
  cliDetectTimeoutMs: 100,
  killGraceMs: 50,
  taskTtlMs: 60_000,
  taskPollIntervalMs: 5,
  progressIdleHeartbeatMs: 25,
  progressThrottleMs: 1,
  logLevel: 'error',
};

async function createConnectedPair() {
  vi.mocked(detectAvailableClis).mockResolvedValue({
    gemini: false,
    codex: false,
    claude: true,
    opencode: false,
  });

  const app = await createServerApp(TEST_CONFIG);
  const client = new Client(
    { name: 'integration-test-client', version: '1.0.0' },
    {
      capabilities: {
        tasks: {
          list: {},
          cancel: {},
        },
      },
    },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    app.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { app, client };
}

describe('serverApp', () => {
  let app: MultiCliServerApp | undefined;
  let client: Client | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await client?.close();
    await app?.close();
    app = undefined;
    client = undefined;
  });

  it('exposes optional task execution metadata for Ask tools', async () => {
    ({ app, client } = await createConnectedPair());

    const result = await client.listTools();
    const askClaude = result.tools.find(tool => tool.name === 'Ask-Claude');
    const helpTool = result.tools.find(tool => tool.name === 'Claude-Help');

    expect(askClaude?.execution).toEqual({ taskSupport: 'optional' });
    expect(helpTool?.execution).toBeUndefined();
  });

  it('returns a structured tool error when a sync Ask tool times out', async () => {
    ({ app, client } = await createConnectedPair());
    vi.mocked(executeCommand).mockRejectedValue(
      new CommandExecutionError('timeout', 'Command timed out after 1000ms', {
        command: 'claude',
        args: [],
      }),
    );

    const result = await client.callTool(
      {
        name: 'Ask-Claude',
        arguments: {
          prompt: 'hello',
          model: 'claude-sonnet-4-6',
        },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('timed out');
  });

  it('streams progress notifications derived from subprocess output', async () => {
    ({ app, client } = await createConnectedPair());
    vi.mocked(executeCommand).mockImplementation(async (_command, _args, options) => {
      options?.onProgress?.('first line\nsecond line');
      return 'done';
    });

    const onprogress = vi.fn();
    const result = await client.callTool(
      {
        name: 'Ask-Claude',
        arguments: {
          prompt: 'hello',
          model: 'claude-sonnet-4-6',
        },
      },
      CallToolResultSchema,
      { onprogress },
    );

    expect(result.isError).toBe(false);
    expect(
      onprogress.mock.calls.some(([progress]) =>
        String(progress.message).includes('second line'),
      ),
    ).toBe(true);
  });

  it('propagates client cancellation to the running sync subprocess', async () => {
    ({ app, client } = await createConnectedPair());

    let aborted = false;
    vi.mocked(executeCommand).mockImplementation((_command, _args, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new CommandExecutionError('cancelled', 'Command cancelled', {
            command: 'claude',
            args: [],
          }));
        }, { once: true });
      }),
    );

    const controller = new AbortController();
    const pending = client.callTool(
      {
        name: 'Ask-Claude',
        arguments: {
          prompt: 'hello',
          model: 'claude-sonnet-4-6',
        },
      },
      CallToolResultSchema,
      { signal: controller.signal },
    );

    await vi.waitFor(() => {
      expect(executeCommand).toHaveBeenCalled();
    });
    controller.abort();

    await expect(pending).rejects.toThrow();
    expect(aborted).toBe(true);
  });

  it('supports task-based Ask execution and returns the eventual result', async () => {
    ({ app, client } = await createConnectedPair());
    vi.mocked(executeCommand).mockImplementation(async (_command, _args, options) => {
      options?.onProgress?.('thinking...');
      return 'mock response';
    });

    await client.listTools();

    const messages: Array<{ type: string; [key: string]: unknown }> = [];
    for await (const message of client.experimental.tasks.callToolStream(
      {
        name: 'Ask-Claude',
        arguments: {
          prompt: 'hello',
          model: 'claude-sonnet-4-6',
        },
      },
      CallToolResultSchema,
    )) {
      messages.push(message as { type: string; [key: string]: unknown });
    }

    expect(messages.some(message => message.type === 'taskCreated')).toBe(true);
    const resultMessage = messages.find(message => message.type === 'result');
    expect(resultMessage).toBeDefined();
    expect((resultMessage as { result: { content: Array<{ text: string }> } }).result.content[0].text)
      .toContain('Claude response:\nmock response');
  });

  it('cancels task-backed Ask execution and aborts the subprocess', async () => {
    ({ app, client } = await createConnectedPair());

    let aborted = false;
    vi.mocked(executeCommand).mockImplementation((_command, _args, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new CommandExecutionError('cancelled', 'Command cancelled', {
            command: 'claude',
            args: [],
          }));
        }, { once: true });
      }),
    );

    await client.listTools();
    const stream = client.experimental.tasks.callToolStream(
      {
        name: 'Ask-Claude',
        arguments: {
          prompt: 'hello',
          model: 'claude-sonnet-4-6',
        },
      },
      CallToolResultSchema,
    );

    const iterator = stream[Symbol.asyncIterator]();
    const firstMessage = await iterator.next();

    expect(firstMessage.value?.type).toBe('taskCreated');
    const taskId = firstMessage.value?.task.taskId as string;

    await client.experimental.tasks.cancelTask(taskId);
    const task = await client.experimental.tasks.getTask(taskId);

    expect(task.status).toBe('cancelled');
    expect(aborted).toBe(true);

    await iterator.return?.();
  });
});
