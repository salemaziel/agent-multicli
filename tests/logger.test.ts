import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '../src/logger.js';

describe('logger', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes structured JSON lines with child bindings and serialized errors', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'multicli-logger-'));
    tempDirs.push(dir);
    const logPath = path.join(dir, 'multicli.log');
    const logger = createLogger({
      filePath: logPath,
      fileLevel: 'debug',
      stderrLevel: 'silent',
      bindings: { component: 'testRoot' },
    }).child({
      component: 'childComponent',
      requestId: 'req-123',
    });

    logger.error('structured_event', {
      error: new Error('boom'),
      prompt: 'FULL PROMPT BODY',
    });

    const [line] = readFileSync(logPath, 'utf8').trim().split('\n');
    const parsed = JSON.parse(line);

    expect(parsed.event).toBe('structured_event');
    expect(parsed.component).toBe('childComponent');
    expect(parsed.requestId).toBe('req-123');
    expect(parsed.meta.prompt).toBe('FULL PROMPT BODY');
    expect(parsed.meta.error.message).toBe('boom');
    expect(parsed.sessionId).toBeTruthy();
    expect(parsed.pid).toBe(process.pid);
  });
});
