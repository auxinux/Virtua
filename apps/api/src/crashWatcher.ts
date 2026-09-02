import type Database from "better-sqlite3";
import { callRunner } from "./runnerClient.js";
import {
  auditLog,
  countRecentRestarts,
  getCrashSettings,
  pruneCrashEvents,
  recordCrashEvent,
  resolveGuestCrashPolicy,
  type GuestKind,
} from "./db.js";

/**
 * Surveillant de pannes VM/LXC.
 *
 * Le runner ne pousse aucun événement : il répond aux requêtes. Le nœud
 * interroge donc périodiquement l'état de tous les invités et compare avec
 * l'état du tour précédent. Un passage « running » → « arrêté » qui ne
 * correspond à AUCUNE action demandée depuis Virtua est une panne : elle est
 * journalisée avec sa cause, puis l'invité est redémarré si sa politique
 * l'autorise (avec un garde-fou anti-boucle).
 *
 * La surveillance vit dans l'API et non dans l'interface : une panne doit être
 * détectée et réparée même quand aucun navigateur n'est ouvert.
 */

const DEFAULT_INTERVAL_MS = 15_000;
/** Durée pendant laquelle un arrêt demandé par l'utilisateur reste « attendu ». */
const EXPECTED_TRANSITION_TTL_MS = 5 * 60 * 1000;
/** Nombre de lignes de journal invité jointes à une panne. */
const LOG_TAIL_LINES = 60;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

type GuestStateMap = Map<string, string>;

function key(type: GuestKind, name: string): string {
  return `${type}:${name}`;
}

/**
 * Arrêts déclenchés par Virtua (bouton stop, redémarrage, snapshot, sauvegarde,
 * migration…). Tant que la marque est valide, l'arrêt correspondant n'est pas
 * traité comme une panne.
 */
const expectedTransitions = new Map<string, number>();

/** Signale qu'un arrêt de cet invité est attendu (action utilisateur en cours). */
export function markExpectedTransition(type: GuestKind, name: string, ttlMs = EXPECTED_TRANSITION_TTL_MS): void {
  expectedTransitions.set(key(type, name), Date.now() + ttlMs);
}

/** Consomme la marque si elle existe et n'a pas expiré. */
function consumeExpectedTransition(type: GuestKind, name: string): boolean {
  const k = key(type, name);
  const expiry = expectedTransitions.get(k);
  if (expiry === undefined) return false;
  expectedTransitions.delete(k);
  return expiry > Date.now();
}

function pruneExpectedTransitions(): void {
  const now = Date.now();
  for (const [k, expiry] of expectedTransitions) {
    if (expiry <= now) expectedTransitions.delete(k);
  }
}

/** États dans lesquels l'invité tourne toujours : ce n'est pas un arrêt. */
function isLiveState(state: string): boolean {
  return state === "running" || state === "paused" || state === "suspended" || state === "frozen";
}

/**
 * Traduit la raison d'arrêt rapportée par libvirt.
 *
 * `null` = arrêt propre (extinction demandée par l'invité, sauvegarde d'état,
 * migration) : ce n'est pas une panne et rien n'est journalisé.
 */
function classifyLibvirtReason(raw: string): string | null {
  const reason = raw.toLowerCase();
  // libvirt rapporte « crashed (panicked) » : la panique est la cause précise,
  // elle prime donc sur le mot « crashed » qui l'accompagne toujours.
  if (reason.includes("panicked")) return "panicked";
  if (reason.includes("crashed")) return "crashed";
  if (reason.includes("failed")) return "failed";
  if (reason.includes("destroyed")) return "killed";
  if (reason.includes("shutdown") || reason.includes("saved") || reason.includes("migrated") || reason.includes("snapshot")) {
    return null;
  }
  return "unexpected";
}

async function collectStates(): Promise<{ states: GuestStateMap; families: Set<GuestKind> }> {
  const states: GuestStateMap = new Map();
  const families = new Set<GuestKind>();

  const [vms, containers] = await Promise.all([
    callRunner<Array<{ name: string; state?: string }>>("qemu_vms", {}, 60_000).catch(() => null),
    callRunner<Array<{ name: string; state?: string }>>("lxc_containers", {}, 60_000).catch(() => null),
  ]);

  // Un appel en échec (runner arrêté, hôte surchargé) ne doit JAMAIS être lu
  // comme « tous les invités se sont arrêtés » : la famille est simplement
  // ignorée pour ce tour, son état précédent est conservé.
  if (vms) {
    families.add("vm");
    for (const vm of vms) states.set(key("vm", vm.name), vm.state ?? "unknown");
  }
  if (containers) {
    families.add("lxc");
    for (const ct of containers) states.set(key("lxc", ct.name), ct.state ?? "unknown");
  }
  return { states, families };
}

/** Extrait de journal de l'invité, joint à l'événement pour expliquer la panne. */
async function readGuestLogTail(type: GuestKind, name: string): Promise<string> {
  const action = type === "vm" ? "qemu_logs" : "lxc_logs";
  const logs = await callRunner<string>(action, { name, tail: LOG_TAIL_LINES }, 30_000).catch(() => "");
  if (typeof logs !== "string" || !logs.trim()) return "";
  const lines = logs.split("\n").filter((line) => line.trim().length > 0);
  return lines.slice(-LOG_TAIL_LINES).join("\n");
}

/**
 * Détermine la cause d'un arrêt inattendu.
 *
 * Pour une VM, libvirt sait distinguer un crash d'une extinction propre
 * (`virsh domstate --reason`) : on lui fait confiance. Pour un conteneur LXC
 * il n'existe pas d'équivalent, l'arrêt non demandé est donc classé
 * « unexpected » et c'est le journal du conteneur qui porte la cause.
 */
async function diagnose(type: GuestKind, name: string, observedState: string): Promise<{ reason: string; detail: string } | null> {
  const detailParts: string[] = [];
  let reason = "unexpected";

  if (type === "vm") {
    const probe = await callRunner<{ raw?: string; reason?: string }>("qemu_stop_reason", { name }, 30_000).catch(() => null);
    const raw = probe?.raw?.trim();
    if (raw) {
      detailParts.push(`État libvirt : ${raw}`);
      const classified = classifyLibvirtReason(probe?.reason || raw);
      // Extinction propre côté invité : ce n'est pas une panne.
      if (classified === null) return null;
      reason = classified;
    } else {
      detailParts.push(`État observé : ${observedState}`);
    }
  } else {
    detailParts.push(`État observé : ${observedState}`);
  }

  const logTail = await readGuestLogTail(type, name);
  if (logTail) detailParts.push(`--- Journal de l'invité (${LOG_TAIL_LINES} dernières lignes) ---\n${logTail}`);

  return { reason, detail: detailParts.join("\n") };
}

export interface CrashWatcherOptions {
  db: Database.Database;
  /** Nom du nœud local, écrit sur chaque événement. */
  getNodeName: () => string;
  /** Démarre un invité (réutilise le chemin de démarrage normal de l'API). */
  startGuest: (type: GuestKind, name: string) => Promise<unknown>;
  intervalMs?: number;
}

async function handleUnexpectedStop(options: CrashWatcherOptions, type: GuestKind, name: string, observedState: string): Promise<void> {
  const { db, getNodeName, startGuest } = options;
  const nodeName = getNodeName();

  const diagnosis = await diagnose(type, name, observedState);
  if (!diagnosis) return; // arrêt propre : rien à signaler

  recordCrashEvent(db, {
    resourceType: type,
    resourceName: name,
    nodeName,
    event: "crash",
    reason: diagnosis.reason,
    detail: diagnosis.detail,
  });
  // Doublé dans le journal d'audit pour que la panne apparaisse aussi dans la
  // chronologie générale du nœud.
  auditLog(db, {
    action: `${type}.crash`,
    resourceType: type,
    resourceName: name,
    result: "error",
    details: `Arrêt inattendu (${diagnosis.reason})`,
  });
  console.warn(`[crash] ${type} ${name}: arrêt inattendu (${diagnosis.reason})`);

  if (!resolveGuestCrashPolicy(db, type, name)) return;

  const { maxAttempts, windowMinutes } = getCrashSettings(db);
  const alreadyTried = countRecentRestarts(db, type, name, windowMinutes);
  if (alreadyTried >= maxAttempts) {
    // Garde-fou anti-boucle : au-delà du quota, on laisse l'invité arrêté
    // plutôt que de le relancer indéfiniment sur une panne persistante.
    recordCrashEvent(db, {
      resourceType: type,
      resourceName: name,
      nodeName,
      event: "gave-up",
      reason: diagnosis.reason,
      attempt: alreadyTried,
      detail: `Abandon : ${alreadyTried} redémarrage(s) déjà tentés en ${windowMinutes} minutes (maximum ${maxAttempts}).`,
    });
    console.warn(`[crash] ${type} ${name}: redémarrage automatique abandonné (${alreadyTried}/${maxAttempts})`);
    return;
  }

  const attempt = alreadyTried + 1;
  try {
    await startGuest(type, name);
    recordCrashEvent(db, {
      resourceType: type,
      resourceName: name,
      nodeName,
      event: "restart",
      reason: diagnosis.reason,
      attempt,
      detail: `Redémarrage automatique après panne (tentative ${attempt}/${maxAttempts}).`,
    });
    console.log(`[crash] ${type} ${name}: redémarré automatiquement (tentative ${attempt}/${maxAttempts})`);
  } catch (err) {
    recordCrashEvent(db, {
      resourceType: type,
      resourceName: name,
      nodeName,
      event: "restart-failed",
      reason: diagnosis.reason,
      attempt,
      detail: err instanceof Error ? err.message : String(err),
    });
    console.error(`[crash] ${type} ${name}: échec du redémarrage automatique:`, err);
  }
}

/**
 * Démarre la surveillance. `AUXINUX_CRASH_WATCH_INTERVAL_MS=0` la désactive.
 * Retourne une poignée d'annulation (utile en test).
 */
export function startCrashWatcher(options: CrashWatcherOptions): { stop: () => void } {
  const envInterval = parseInt(process.env.AUXINUX_CRASH_WATCH_INTERVAL_MS ?? "", 10);
  const intervalMs = options.intervalMs
    ?? (Number.isFinite(envInterval) ? envInterval : DEFAULT_INTERVAL_MS);

  if (intervalMs <= 0) {
    console.log("[crash] Surveillance des pannes désactivée");
    return { stop: () => {} };
  }

  // État du tour précédent, par famille : tant qu'une famille n'a pas été lue
  // une première fois, aucune transition n'est déduite (pas de fausse panne au
  // démarrage de l'API pour les invités déjà arrêtés).
  let previous: GuestStateMap | null = null;
  const knownFamilies = new Set<GuestKind>();
  let running = false;

  const tick = async () => {
    if (running) return; // un tour lent ne doit pas se superposer au suivant
    running = true;
    try {
      pruneExpectedTransitions();
      const { states, families } = await collectStates();
      if (families.size === 0) return; // runner injoignable : on retente au tour suivant

      const previousStates = previous ?? new Map<string, string>();
      const pending: Array<{ type: GuestKind; name: string; state: string }> = [];

      for (const [k, state] of states) {
        const [type, ...rest] = k.split(":");
        const name = rest.join(":");
        const before = previousStates.get(k);
        if (!knownFamilies.has(type as GuestKind)) continue; // premier tour de cette famille
        if (before !== "running" || isLiveState(state)) continue;
        if (consumeExpectedTransition(type as GuestKind, name)) continue; // arrêt demandé
        pending.push({ type: type as GuestKind, name, state });
      }

      // L'état de référence est mis à jour AVANT le diagnostic : une même panne
      // ne doit être journalisée qu'une fois, même si l'analyse est lente.
      const merged = new Map(previousStates);
      for (const family of families) {
        for (const k of merged.keys()) {
          if (k.startsWith(`${family}:`) && !states.has(k)) merged.delete(k);
        }
      }
      for (const [k, state] of states) merged.set(k, state);
      previous = merged;
      for (const family of families) knownFamilies.add(family);

      for (const guest of pending) {
        await handleUnexpectedStop(options, guest.type, guest.name, guest.state).catch((err) => {
          console.error(`[crash] Analyse de ${guest.type} ${guest.name} impossible:`, err);
        });
      }
    } catch (err) {
      console.error("[crash] Tour de surveillance en échec:", err);
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => { void tick(); }, intervalMs);
  handle.unref?.();
  void tick();

  const pruneHandle = setInterval(() => {
    try {
      const removed = pruneCrashEvents(options.db);
      if (removed > 0) console.log(`[crash] ${removed} entrée(s) de journal expirée(s) supprimée(s)`);
    } catch (err) {
      console.error("[crash] Purge du journal en échec:", err);
    }
  }, PRUNE_INTERVAL_MS);
  pruneHandle.unref?.();

  console.log(`[crash] Surveillance des pannes active (toutes les ${Math.round(intervalMs / 1000)}s)`);
  return {
    stop: () => {
      clearInterval(handle);
      clearInterval(pruneHandle);
    },
  };
}

/** Exporté pour les tests unitaires. */
export const __testing = { classifyLibvirtReason, isLiveState };
