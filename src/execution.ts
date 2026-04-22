import type { Logger } from './logger.js';
import type { ListRootsResult } from '@modelcontextprotocol/sdk/types.js';

export type ToolTimeoutClass = 'ask' | 'help' | 'none';

export interface ToolExecutionContext {
  signal?: AbortSignal;
  onProgress?: (newOutput: string) => void;
  timeoutMs?: number;
  killGraceMs?: number;
  cwd?: string;
  projectRoots?: ListRootsResult['roots'];
  env?: NodeJS.ProcessEnv;
  requestId?: string | number;
  taskId?: string;
  logger?: Logger;
}
