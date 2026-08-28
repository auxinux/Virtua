export interface StorageMountResult {
  node: string;
  ok: boolean;
  error?: string;
}

export function mountFailureMessage(results: StorageMountResult[]): string | null {
  const failures = results.filter((result) => !result.ok);
  if (failures.length === 0) return null;
  return failures.map((result) => `${result.node}: ${result.error || "Mount failed"}`).join("; ");
}
