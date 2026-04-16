export type MultiCliLogLevel = 'error' | 'info' | 'debug';

export interface MultiCliConfig {
  askTimeoutMs: number;
  helpTimeoutMs: number;
  cliDetectTimeoutMs: number;
  killGraceMs: number;
  taskTtlMs: number;
  taskPollIntervalMs: number;
  progressIdleHeartbeatMs: number;
  progressThrottleMs: number;
  logLevel: MultiCliLogLevel;
}

const DEFAULTS: MultiCliConfig = {
  askTimeoutMs: 15 * 60 * 1000,
  helpTimeoutMs: 30 * 1000,
  cliDetectTimeoutMs: 5 * 1000,
  killGraceMs: 5 * 1000,
  taskTtlMs: 60 * 60 * 1000,
  taskPollIntervalMs: 1000,
  progressIdleHeartbeatMs: 10 * 1000,
  progressThrottleMs: 1000,
  logLevel: 'error',
};

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseLogLevel(
  value: string | undefined,
  fallback: MultiCliLogLevel,
): MultiCliLogLevel {
  switch (value) {
    case 'error':
    case 'info':
    case 'debug':
      return value;
    default:
      return fallback;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MultiCliConfig {
  return {
    askTimeoutMs: parsePositiveInt(env.MULTICLI_ASK_TIMEOUT_MS, DEFAULTS.askTimeoutMs),
    helpTimeoutMs: parsePositiveInt(env.MULTICLI_HELP_TIMEOUT_MS, DEFAULTS.helpTimeoutMs),
    cliDetectTimeoutMs: parsePositiveInt(env.MULTICLI_CLI_DETECT_TIMEOUT_MS, DEFAULTS.cliDetectTimeoutMs),
    killGraceMs: parsePositiveInt(env.MULTICLI_KILL_GRACE_MS, DEFAULTS.killGraceMs),
    taskTtlMs: parsePositiveInt(env.MULTICLI_TASK_TTL_MS, DEFAULTS.taskTtlMs),
    taskPollIntervalMs: parsePositiveInt(env.MULTICLI_TASK_POLL_INTERVAL_MS, DEFAULTS.taskPollIntervalMs),
    progressIdleHeartbeatMs: parsePositiveInt(
      env.MULTICLI_PROGRESS_IDLE_HEARTBEAT_MS,
      DEFAULTS.progressIdleHeartbeatMs,
    ),
    progressThrottleMs: parsePositiveInt(
      env.MULTICLI_PROGRESS_THROTTLE_MS,
      DEFAULTS.progressThrottleMs,
    ),
    logLevel: parseLogLevel(env.MULTICLI_LOG_LEVEL, DEFAULTS.logLevel),
  };
}
