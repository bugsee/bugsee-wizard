import { spawn } from 'node:child_process';

const STDERR_TAIL_BYTES = 64 * 1024;

export interface RunChildOptions {
  readonly cwd: string;
  /** Mirror the child's stdout to ours (debug mode). Otherwise it is discarded. */
  readonly forwardStdout: boolean;
  /** Where forwarded child stdout goes (default our stdout). `stderr` keeps a JSON stdout clean. */
  readonly forwardTo?: 'stdout' | 'stderr';
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
  const mode: StdoutMode = !options.forwardStdout
    ? 'ignore'
    : options.forwardTo === 'stderr'
      ? 'forward-stderr'
      : 'forward';
  await spawnChild(cmd, args, options, mode);
}

export interface RunChildOutputOptions {
  readonly cwd: string;
  /** Reject once stdout grows past this many bytes (default 1 MB). */
  readonly maxBytes?: number;
  readonly platform?: NodeJS.Platform;
}

const DEFAULT_OUTPUT_CAP = 1024 * 1024;

/** Like runChild, but resolves with the child's stdout (capped) instead of discarding it. */
export async function runChildOutput(
  cmd: string,
  args: readonly string[],
  options: RunChildOutputOptions,
): Promise<string> {
  return spawnChild(cmd, args, options, { capture: options.maxBytes ?? DEFAULT_OUTPUT_CAP });
}

type StdoutMode = 'ignore' | 'forward' | 'forward-stderr' | { readonly capture: number };

function spawnChild(
  cmd: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly platform?: NodeJS.Platform },
  stdout: StdoutMode,
): Promise<string> {
  const shell = (options.platform ?? process.platform) === 'win32' && SHELL_COMMANDS.has(cmd);
  if (shell) {
    for (const arg of args) {
      if (!SAFE_SHELL_ARG.test(arg)) {
        return Promise.reject(
          new Error(`Refusing to run ${cmd}: unsafe argument ${JSON.stringify(arg)}`),
        );
      }
    }
  }
  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd: options.cwd,
      shell,
      stdio: ['ignore', stdout === 'ignore' ? 'ignore' : 'pipe', 'pipe'],
    });
    // Rolling tail: only the last few lines are ever reported, so never hold
    // more than STDERR_TAIL_BYTES however much the child writes.
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });
    const captured: Buffer[] = [];
    let size = 0;
    let overflow = false;
    if (stdout === 'forward' || stdout === 'forward-stderr') {
      const sink = stdout === 'forward' ? process.stdout : process.stderr;
      child.stdout?.on('data', (chunk: Buffer) => {
        sink.write(chunk);
      });
    } else if (typeof stdout === 'object') {
      child.stdout?.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > stdout.capture) {
          overflow = true;
          child.kill();
          return;
        }
        captured.push(chunk);
      });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (overflow && typeof stdout === 'object') {
        reject(new Error(`${cmd} ${args.join(' ')} wrote more than ${stdout.capture} bytes`));
        return;
      }
      if (code === 0) {
        resolve(Buffer.concat(captured).toString('utf8'));
        return;
      }
      const tail = stderr.trim().split('\n').slice(-10).join('\n');
      reject(
        new Error(`${cmd} ${args.join(' ')} exited with code ${code}${tail ? `\n${tail}` : ''}`),
      );
    });
  });
}
