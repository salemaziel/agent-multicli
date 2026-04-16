export type ToolTimeoutClass = 'ask' | 'help' | 'none';

export interface ToolExecutionContext {
  signal?: AbortSignal;
  onProgress?: (newOutput: string) => void;
  timeoutMs?: number;
  killGraceMs?: number;
  requestId?: string | number;
  taskId?: string;
}
