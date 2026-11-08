import type { Subprocess } from 'bun';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

export interface Instance {
  name: string;
  port: number;
  url: string;
  proc: Subprocess;
  logs: () => string;
}

/** Sobe um PROCESSO real da aplicação (não um mock) e espera o readiness. */
export async function spawnInstance(name: string, port: number, env: Record<string, string> = {}): Promise<Instance> {
  let output = '';
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      INSTANCE_ID: name,
      LOG_LEVEL: 'warn',
      OUTBOX_POLL_INTERVAL_MS: '200',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '200',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  for (const stream of [proc.stdout, proc.stderr] as ReadableStream<Uint8Array>[]) {
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) output += decoder.decode(chunk);
    })();
  }

  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`${name} exited during startup:\n${output}`);
    try {
      const res = await fetch(`${url}/health/ready`);
      if (res.ok) return { name, port, url, proc, logs: () => output };
    } catch {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill('SIGKILL');
  throw new Error(`${name} did not become ready:\n${output}`);
}

export async function stopInstance(instance: Instance, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
  if (instance.proc.exitCode === null && instance.proc.signalCode === null) instance.proc.kill(signal);
  await instance.proc.exited;
}

export async function http<T = Record<string, unknown>>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}
