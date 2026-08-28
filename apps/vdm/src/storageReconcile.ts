export interface ReconcileNode {
  name: string;
  status: string;
}

export interface ReconcileStorage {
  name: string;
  enabled: number | boolean;
}

export interface StorageMountFailure {
  node: string;
  storage: string;
  error: string;
}

/**
 * Reconcile storages sequentially per node (avoids concurrent mount operations
 * on the same host), while processing independent nodes in parallel.
 */
export async function reconcileStorageMounts<N extends ReconcileNode, S extends ReconcileStorage>(
  nodes: N[],
  storages: S[],
  mount: (node: N, storage: S) => Promise<unknown>,
): Promise<{ failures: StorageMountFailure[] }> {
  const eligibleNodes = nodes.filter((node) => node.status !== "offline");
  const enabledStorages = storages.filter((storage) => Boolean(storage.enabled));
  const failures: StorageMountFailure[] = [];

  await Promise.all(eligibleNodes.map(async (node) => {
    for (const storage of enabledStorages) {
      try {
        await mount(node, storage);
      } catch (error) {
        failures.push({
          node: node.name,
          storage: storage.name,
          error: error instanceof Error ? error.message : "Mount failed",
        });
      }
    }
  }));

  return { failures };
}
