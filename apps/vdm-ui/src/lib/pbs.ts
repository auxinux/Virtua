import type { VdmPbsJobTargets, VdmPbsSnapshot } from "@/types/vdm";

/** JS weekday digits (0 = Sunday), shown Monday first. */
export const PBS_DAYS: Array<[string, string]> = [["1", "Mon"], ["2", "Tue"], ["3", "Wed"], ["4", "Thu"], ["5", "Fri"], ["6", "Sat"], ["0", "Sun"]];

export function describePbsDays(days: string): string {
  if (days.length === 7) return "Every day";
  if (days === "12345") return "Mon–Fri";
  return PBS_DAYS.filter(([d]) => days.includes(d)).map(([, l]) => l).join(", ");
}

export function describePbsTargets(targets: VdmPbsJobTargets): string {
  const parts: string[] = [];
  if (targets.all.includes("vm")) parts.push("all VMs");
  if (targets.all.includes("lxc")) parts.push("all containers");
  if (targets.guests.length) {
    const shown = targets.guests.slice(0, 3).map((g) => g.split(":").filter((_, i) => i !== 1).join("/"));
    parts.push(shown.join(", ") + (targets.guests.length > 3 ? ` +${targets.guests.length - 3}` : ""));
  }
  return parts.join(" + ") || "—";
}

/** The listing is newest first: keep the first snapshot seen per guest. */
export function latestPbsSnapshots(list: VdmPbsSnapshot[]): VdmPbsSnapshot[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const key = `${s.type}/${s.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Same bridge name on the target node (vmbr0 → vmbr0) is the natural default. */
export function defaultPbsBridgeMap(sourceBridges: string[], targetBridges: string[], fallback: string): Record<string, string> {
  const known = new Set(targetBridges);
  return Object.fromEntries(sourceBridges.map((b) => [b, known.has(b) ? b : fallback]));
}

/** Guests' retention / schedule fields arrive as form strings; blank = unset. */
export function optionalCount(value: string): number | undefined {
  const n = Number(value);
  return value.trim() === "" || !Number.isInteger(n) || n < 1 ? undefined : n;
}
