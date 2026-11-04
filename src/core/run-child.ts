import { spawn } from 'node:child_process';

const STDERR_TAIL_BYTES = 64 * 1024;

export interface RunChildOptions {
  readonly cwd: string;
  /** Mirror the child's stdout to ours (debug mode). Otherwise it is discarded. */
  readonly forwardStdout: boolean;
  /** Override the host platform (tests); defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

// On Windows the package managers are `.cmd` shims that cannot be spawned without a
// shell (ENOENT, or EINVAL for `npm.cmd`). Only this closed set gets a shell, and
// only with arguments that carry no cmd.exe metacharacters.
const SHELL_COMMANDS: ReadonlySet<string> = new Set(['npm', 'yarn', 'pnpm', 'bun', 'deno']);
const SAFE_SHELL_ARG = /^[\w@./:=+~-]+$/;

/**
 * Run `cmd args…` to completion. Resolves on exit code 0; rejects with the
 * exit code plus the tail of stderr otherwise.
 *
 * stdout is ALWAYS drained: when not forwarded it is sent to `'ignore'`
 * (/dev/null) rather than left as an unread pipe, which would block a chatty
 * child (`pod install`, `npm install`) forever once the pipe buffer fills.
 */
export async function runChild(
  cmd: string,
  args: readonly string[],
  options: RunChildOptions,
): Promise<void> {
  const shell = (options.platform ?? process.platform) === 'win32' && SHELL_COMMANDS.has(cmd);
  if (shell) {
    for (const arg of args) {
      if (!SAFE_SHELL_ARG.test(arg)) {
        throw new Error(`Refusing to run ${cmd}: unsafe argument ${JSON.stringify(arg)}`);
      }
    }
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd: options.cwd,
      shell,
      stdio: ['ignore', options.forwardStdout ? 'pipe' : 'ignore', 'pipe'],
    });
    // Rolling tail: only the last few lines are ever reported, so never hold
    // more than STDERR_TAIL_BYTES however much the child writes.
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });
    if (options.forwardStdout) {
      child.stdout?.on('data', (chunk: Buffer) => {
        process.stdout.write(chunk);
      });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderr.trim().split('\n').slice(-10).join('\n');
      reject(
        new Error(`${cmd} ${args.join(' ')} exited with code ${code}${tail ? `\n${tail}` : ''}`),
      );
    });
  });
}
