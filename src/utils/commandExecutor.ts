import { spawn } from "child_process";
import { ToolExecutionContext } from "../execution.js";

// Detect Windows platform for shell compatibility
const isWindows = process.platform === "win32";

export type CommandExecutionFailureKind =
  | "cancelled"
  | "timeout"
  | "spawn"
  | "quota"
  | "failed"
  | "no-output";

export class CommandExecutionError extends Error {
  constructor(
    public readonly kind: CommandExecutionFailureKind,
    message: string,
    public readonly details: {
      command: string;
      args: string[];
      exitCode?: number | null;
      stdout?: string;
      stderr?: string;
    },
  ) {
    super(message);
    this.name = "CommandExecutionError";
  }
}

/**
 * Format a single argument for safe use with cmd.exe (shell: true on Windows).
 * Ensures the argument survives cmd.exe parsing as one argv entry.
 *
 * Rules:
 * - Empty strings → `""` (otherwise lost entirely)
 * - Args with whitespace or quotes → wrapped in double quotes
 *   - Inside quotes: `"` → `""`, `%` → `%%`
 *   - Trailing backslashes doubled (prevents `\"` escaping the closing quote)
 *   - Shell operators (&|<>^) are literal inside quotes — no caret needed
 * - Args without whitespace or quotes → unquoted
 *   - `%` → `%%`, shell operators get caret-escaped
 */
export function sanitizeArgForCmd(arg: string): string {
  if (arg === '') return '""';

  // Newlines act as command separators in cmd.exe even inside double quotes.
  // Replace with spaces to preserve word boundaries safely.
  const sanitized = arg.replace(/[\r\n]+/g, ' ');

  const needsQuotes = /[\s"]/.test(sanitized);

  if (needsQuotes) {
    // Inside double quotes: only % and " need escaping.
    // Shell operators (&|<>^) are treated as literals by cmd.exe inside quotes.
    // Trailing backslashes must be doubled so they don't escape the closing quote
    // in the target process's CommandLineToArgvW parser.
    const escaped = sanitized
      .replace(/%/g, '%%')
      .replace(/"/g, '""')
      .replace(/\\+$/, m => m + m);
    return `"${escaped}"`;
  } else {
    // Unquoted: escape % and caret-escape shell operators (including parentheses)
    return sanitized
      .replace(/%/g, '%%')
      .replace(/[&|<>^()]/g, c => `^${c}`);
  }
}

function terminateWindowsProcessTree(pid: number, force: boolean) {
  const killArgs = ["/pid", String(pid), "/T"];
  if (force) {
    killArgs.push("/F");
  }

  const killer = spawn("taskkill", killArgs, {
    stdio: ["ignore", "ignore", "ignore"],
    shell: false,
  });

  killer.on("error", () => {
    // Best effort cleanup only.
  });
}

function terminateChildProcess(pid: number, force: boolean) {
  if (isWindows) {
    terminateWindowsProcessTree(pid, force);
    return;
  }

  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    // Best effort cleanup only.
  }
}

export async function executeCommand(
  command: string,
  args: string[],
  options: ToolExecutionContext = {},
): Promise<string> {
  const {
    onProgress,
    signal,
    timeoutMs,
    killGraceMs = 5000,
    cwd,
    env,
    logger,
  } = options;

  return new Promise((resolve, reject) => {
    // Use shell: true on Windows to properly execute .cmd files and resolve PATH.
    // Sanitize args to prevent cmd.exe metacharacter injection.
    const safeArgs = isWindows ? args.map(sanitizeArgForCmd) : args;
    logger?.info("command_spawn_requested", {
      command,
      args,
      safeArgs,
      cwd,
      timeoutMs,
      killGraceMs,
      platform: process.platform,
      shell: isWindows,
      detached: !isWindows,
      envKeys: env ? Object.keys(env).sort() : undefined,
    });
    const childProcess = spawn(command, safeArgs, {
      cwd,
      env: env ?? process.env,
      shell: isWindows,
      stdio: ["ignore", "pipe", "pipe"],
      detached: !isWindows,
    });

    let stdout = "";
    let stderr = "";
    let isSettled = false;
    let lastReportedLength = 0;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let terminationStarted = false;
    let stdoutChunkCount = 0;
    let stderrChunkCount = 0;

    logger?.info("command_spawned", {
      command,
      args,
      cwd,
      pid: childProcess.pid,
    });

    const clearRequestTimer = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };

    const clearTerminationTimer = () => {
      if (forceKillTimeoutId) {
        clearTimeout(forceKillTimeoutId);
      }
    };

    const abortListener = () => {
        logger?.error("command_abort_signal_received", {
          command,
          args,
          cwd,
          pid: childProcess.pid,
          signalReason: signal?.reason,
        });
      beginTermination(
        new CommandExecutionError(
          "cancelled",
          "Command cancelled",
          { command, args, stdout, stderr },
        ),
      );
    };

    const settle = (error?: Error, output?: string) => {
      if (isSettled) return;

      isSettled = true;
      clearRequestTimer();
      signal?.removeEventListener("abort", abortListener);

      if (error) {
        reject(error);
      } else {
        resolve(output ?? "");
      }
    };

    const beginTermination = (error: Error) => {
      if (!terminationStarted && childProcess.pid) {
        terminationStarted = true;
        logger?.error("command_termination_started", {
          command,
          args,
          cwd,
          pid: childProcess.pid,
          reason: error.message,
          error,
        });
        terminateChildProcess(childProcess.pid, false);
        forceKillTimeoutId = setTimeout(() => {
          if (childProcess.pid) {
            logger?.error("command_termination_escalated", {
              command,
              args,
              cwd,
              pid: childProcess.pid,
              killGraceMs,
            });
            terminateChildProcess(childProcess.pid, true);
          }
        }, killGraceMs);
      }

      settle(error);
    };

    signal?.addEventListener("abort", abortListener, { once: true });
    if (signal?.aborted) {
      abortListener();
      return;
    }

    if (timeoutMs && timeoutMs > 0) {
      logger?.debug("command_timeout_started", {
        command,
        args,
        cwd,
        timeoutMs,
      });
      timeoutId = setTimeout(() => {
        logger?.error("command_timeout_elapsed", {
          command,
          args,
          cwd,
          pid: childProcess.pid,
          timeoutMs,
        });
        beginTermination(
          new CommandExecutionError(
            "timeout",
            `Command timed out after ${timeoutMs}ms`,
            { command, args, stdout, stderr },
          ),
        );
      }, timeoutMs);
    }

    childProcess.stdout?.on("data", (data) => {
      if (isSettled) return;
      const chunk = data.toString();
      stdout += chunk;
      stdoutChunkCount += 1;
      logger?.debug("command_stdout_chunk", {
        command,
        args,
        cwd,
        pid: childProcess.pid,
        chunkIndex: stdoutChunkCount,
        chunkLength: chunk.length,
        chunk,
      });

      // Report new content if callback provided
      if (onProgress && stdout.length > lastReportedLength) {
        const newContent = stdout.substring(lastReportedLength);
        lastReportedLength = stdout.length;
        onProgress(newContent);
      }
    });


    // CLI level errors
    childProcess.stderr?.on("data", (data) => {
      if (isSettled) return;
      const chunk = data.toString();
      stderr += chunk;
      stderrChunkCount += 1;
      logger?.debug("command_stderr_chunk", {
        command,
        args,
        cwd,
        pid: childProcess.pid,
        chunkIndex: stderrChunkCount,
        chunkLength: chunk.length,
        chunk,
      });

      if (stderr.includes("RESOURCE_EXHAUSTED")) {
        logger?.error("command_quota_exhausted", {
          command,
          args,
          cwd,
          pid: childProcess.pid,
          stderr,
        });
        beginTermination(
          new CommandExecutionError(
            "quota",
            `Command failed due to quota exhaustion: ${stderr.trim()}`,
            { command, args, stdout, stderr },
          ),
        );
      }
    });
    childProcess.on("error", (error) => {
      if (!isSettled) {
        clearRequestTimer();
        clearTerminationTimer();
        signal?.removeEventListener("abort", abortListener);
        logger?.error("command_spawn_failed", {
          command,
          args,
          cwd,
          pid: childProcess.pid,
          error,
        });
        settle(
          new CommandExecutionError(
            "spawn",
            `Failed to spawn command: ${error.message}`,
            { command, args, stdout, stderr },
          ),
        );
      }
    });
    childProcess.on("close", (code) => {
      clearRequestTimer();
      clearTerminationTimer();
      signal?.removeEventListener("abort", abortListener);

       logger?.info("command_closed", {
        command,
        args,
        cwd,
        pid: childProcess.pid,
        exitCode: code,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        stdoutChunkCount,
        stderrChunkCount,
        settledEarly: isSettled,
      });

      if (isSettled) {
        return;
      }

      if (code === 0) {
        const output = stdout.trim();
        if (output || !stderr.trim()) {
          logger?.info("command_completed", {
            command,
            args,
            cwd,
            pid: childProcess.pid,
            exitCode: code,
            resultKind: "success",
            outputLength: output.length,
          });
          settle(undefined, output);
          return;
        }

        logger?.error("command_completed_without_stdout", {
          command,
          args,
          cwd,
          pid: childProcess.pid,
          exitCode: code,
          stderr,
        });
        settle(
          new CommandExecutionError(
            "no-output",
            `Command produced no output. stderr: ${stderr.trim()}`,
            { command, args, exitCode: code, stdout, stderr },
          ),
        );
        return;
      }

      const errorMessage = stderr.trim() || "Unknown error";
      logger?.error("command_failed", {
        command,
        args,
        cwd,
        pid: childProcess.pid,
        exitCode: code,
        stderr,
        stdout,
      });
      settle(
        new CommandExecutionError(
          stderr.includes("RESOURCE_EXHAUSTED") ? "quota" : "failed",
          `Command failed with exit code ${code}: ${errorMessage}`,
          { command, args, exitCode: code, stdout, stderr },
        ),
      );
    });
  });
}
