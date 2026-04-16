import { MultiCliLogLevel } from './config.js';

const LEVEL_PRIORITY: Record<MultiCliLogLevel, number> = {
  error: 0,
  info: 1,
  debug: 2,
};

function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, serializeValue(entry)]),
    );
  }

  return value;
}

function formatMeta(meta: Record<string, unknown> | undefined): string {
  if (!meta || Object.keys(meta).length === 0) {
    return '';
  }

  return ` ${JSON.stringify(serializeValue(meta))}`;
}

export interface Logger {
  error(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

export function createLogger(level: MultiCliLogLevel): Logger {
  const minimumPriority = LEVEL_PRIORITY[level];

  const write = (
    currentLevel: MultiCliLogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ) => {
    if (LEVEL_PRIORITY[currentLevel] > minimumPriority) {
      return;
    }

    process.stderr.write(
      `[Multi-CLI] [${currentLevel}] ${message}${formatMeta(meta)}\n`,
    );
  };

  return {
    error: (message, meta) => write('error', message, meta),
    info: (message, meta) => write('info', message, meta),
    debug: (message, meta) => write('debug', message, meta),
  };
}
