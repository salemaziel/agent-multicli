import { spawn } from "child_process";
import { CLI } from "../constants.js";

const isWindows = process.platform === "win32";

/**
 * Check if a command exists on the system PATH.
 * Uses `which` on Unix/macOS, `where` on Windows.
 * Always resolves to a boolean — never rejects.
 */
export async function commandExists(command: string, timeoutMs?: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const checker = isWindows ? "where" : "which";
      const child = spawn(checker, [command], {
        stdio: ["ignore", "ignore", "ignore"],
        shell: isWindows,
      });
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      };

      if (timeoutMs && timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          child.kill('SIGTERM');
          resolve(false);
        }, timeoutMs);
      }

      child.on("error", () => {
        cleanup();
        resolve(false);
      });

      child.on("close", (code) => {
        cleanup();
        resolve(code === 0);
      });
    } catch {
      resolve(false);
    }
  });
}

export interface CliAvailability {
  gemini: boolean;
  codex: boolean;
  claude: boolean;
  opencode: boolean;
}

/**
 * Detect which of the four supported CLIs are available on the system.
 * Runs all four checks in parallel for speed.
 */
export async function detectAvailableClis(timeoutMs?: number): Promise<CliAvailability> {
  if (process.env.QA_NO_CLIS === 'true') {
    return { gemini: false, codex: false, claude: false, opencode: false };
  }

  const [gemini, codex, claude, opencode] = await Promise.all([
    commandExists(CLI.COMMANDS.GEMINI, timeoutMs),
    commandExists(CLI.COMMANDS.CODEX, timeoutMs),
    commandExists(CLI.COMMANDS.CLAUDE, timeoutMs),
    commandExists(CLI.COMMANDS.OPENCODE, timeoutMs),
  ]);

  const availability: CliAvailability = { gemini, codex, claude, opencode };

  return availability;
}
