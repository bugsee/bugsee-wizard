import { spawn } from 'node:child_process';

const STDERR_TAIL_BYTES = 64 * 1024;

export interface RunChildOptions {
  readonly cwd: string;
  /** Mirror the child's stdout to ours (debug mode). Otherwise it is discarded. */
  readonly forwardStdout: boolean;
}

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
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd: options.cwd,
      stdio: ['ignore', options.forwardStdout ? 'pipe' : 'ignore', 'pipe'],
    });
    // Rolling tail: only the last few lines are ever reported, so never hold
    // more than STDERR_TAIL_BYTES however much the child writes.
    let stderr = '';
    // Decode via the stream so a multi-byte character split across chunks is
    // reassembled instead of becoming U+FFFD.
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
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
