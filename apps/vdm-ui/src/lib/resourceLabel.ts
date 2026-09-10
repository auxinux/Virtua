/**
 * A machine's display label: the operator-chosen override when set, otherwise
 * the real name. Note this is the *resource's* label — `nodeDisplayName` on the
 * same rows is the label of the node hosting it.
 */
export function resourceLabel(resource: { displayName?: string | null; name?: string | null }, fallback = ""): string {
  const display = resource.displayName?.trim();
  if (display) return display;
  return resource.name?.trim() || fallback;
}
