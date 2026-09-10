/**
 * A machine's display label: the user-chosen override when set, otherwise the
 * real name. Keep every list, sidebar entry and console tab going through this
 * so a relabelled machine reads the same everywhere.
 */
export function resourceLabel(resource: { displayName?: string | null; name?: string | null }, fallback = ""): string {
  const display = resource.displayName?.trim();
  if (display) return display;
  return resource.name?.trim() || fallback;
}

