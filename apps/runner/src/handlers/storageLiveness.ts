export interface PoolLivenessDeps {
  isMountpoint: (poolPath: string) => Promise<boolean>;
  readDirectory: (poolPath: string) => Promise<unknown>;
  accessTimeoutMs?: number;
}

export type PoolLiveness =
  | { alive: true }
  | { alive: false; reason: "not-mounted" | "access-timeout" | "access-error" };

const DEFAULT_ACCESS_TIMEOUT_MS = 2_000;

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A healthy pool must be both a real mountpoint and responsive to directory IO.
 * The IO probe is bounded because a dead or disconnected FUSE backend can leave
 * readdir pending indefinitely and otherwise block the privileged runner.
 */
export async function probePoolAlive(poolPath: string, deps: PoolLivenessDeps): Promise<PoolLiveness> {
  let mounted = false;
  try {
    mounted = await deps.isMountpoint(poolPath);
  } catch {
    mounted = false;
  }
  if (!mounted) return { alive: false, reason: "not-mounted" };

  try {
    const access = await settleWithin(deps.readDirectory(poolPath), deps.accessTimeoutMs ?? DEFAULT_ACCESS_TIMEOUT_MS);
    if (access.timedOut) return { alive: false, reason: "access-timeout" };
    return { alive: true };
  } catch {
    return { alive: false, reason: "access-error" };
  }
}
