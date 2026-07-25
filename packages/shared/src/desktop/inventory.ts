// =============================================================================
//  Desktop inventory consistency helpers (pure, browser-safe, testable)
//
//  When a resource is deleted, the underlying hypervisor list (virsh / lxc-ls /
//  docker ps) can momentarily still report it, and an opaque handle could be
//  re-minted on the next listing. To guarantee that GET /api/desktop/resources
//  never returns something a successful DELETE just removed, the server records
//  a short-lived "tombstone" for each deleted (type,node,name) and filters the
//  live listing against it for a small window.
// =============================================================================

/**
 * Validate a proposed resource name for its runtime's naming rules. Used to
 * reject invalid rename targets with a 400 before touching the hypervisor.
 *   vm     → libvirt domain name
 *   lxc    → LXC container name
 *   docker → Docker container name
 */
export function isValidResourceName(type: "vm" | "lxc" | "docker", name: string): boolean {
  if (typeof name !== "string") return false;
  switch (type) {
    case "vm": return /^[a-zA-Z][a-zA-Z0-9_.-]{0,62}$/.test(name);
    case "lxc": return /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(name);
    case "docker": return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name);
    default: return false;
  }
}

export function resourceTombstoneKey(type: string, node: string, name: string): string {
  // NUL separator → the three parts can never collide regardless of content.
  return `${type}\0${node}\0${name}`;
}

export interface TombstonedResource {
  type: string;
  node: string;
  name: string;
}

/**
 * In-memory set of recently-deleted resources with per-entry expiry. Used to
 * mask a deleted resource from the live inventory until the hypervisor list is
 * consistent again. `now` is injectable for deterministic tests.
 */
export class ResourceTombstones {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record that (type,node,name) was just deleted. */
  mark(type: string, node: string, name: string): void {
    this.entries.set(resourceTombstoneKey(type, node, name), this.now() + this.ttlMs);
  }

  /** True while the resource is still tombstoned (auto-expires after the TTL). */
  isDeleted(type: string, node: string, name: string): boolean {
    const key = resourceTombstoneKey(type, node, name);
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) return false;
    if (this.now() >= expiresAt) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  /** Drop expired entries (cheap housekeeping). */
  prune(): void {
    const t = this.now();
    for (const [key, expiresAt] of this.entries) {
      if (t >= expiresAt) this.entries.delete(key);
    }
  }

  /** Number of live (non-expired) tombstones. */
  get size(): number {
    this.prune();
    return this.entries.size;
  }

  /** Remove a tombstone explicitly (e.g. if a create reuses the same name). */
  clear(type: string, node: string, name: string): void {
    this.entries.delete(resourceTombstoneKey(type, node, name));
  }

  /** Return only the rows that are NOT currently tombstoned. */
  filter<T extends TombstonedResource>(rows: T[]): T[] {
    return rows.filter((r) => !this.isDeleted(r.type, r.node, r.name));
  }
}
