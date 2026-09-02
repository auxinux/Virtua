/**
 * Reprise après panne (crash) des invités VM/LXC.
 *
 * Le nœud surveille en continu l'état des VMs et des conteneurs. Quand un
 * invité passe de « running » à « arrêté » SANS qu'une action utilisateur ne
 * l'ait demandé, l'arrêt est considéré comme une panne : il est journalisé
 * avec sa cause, et l'invité est redémarré si sa politique l'autorise.
 */

/** Type d'entrée du journal des pannes. */
export type GuestCrashEventType =
  /** Arrêt inattendu détecté. */
  | "crash"
  /** Redémarrage automatique réussi. */
  | "restart"
  /** La tentative de redémarrage a échoué. */
  | "restart-failed"
  /** Trop de pannes dans la fenêtre : on arrête d'essayer. */
  | "gave-up";

/** Cause normalisée d'un arrêt inattendu. */
export type GuestCrashReason =
  /** libvirt signale explicitement un crash du domaine. */
  | "crashed"
  /** Le processus qemu a échoué au démarrage ou en cours d'exécution. */
  | "failed"
  /** Panique du noyau invité rapportée par libvirt. */
  | "panicked"
  /** Le processus a été détruit/tué sans commande Virtua correspondante. */
  | "killed"
  /** Arrêt inattendu sans cause identifiable (cas LXC le plus fréquent). */
  | "unexpected";

export interface GuestCrashEvent {
  id: number;
  resourceType: "vm" | "lxc";
  resourceName: string;
  nodeName?: string;
  event: GuestCrashEventType;
  /** Cause normalisée (présente sur les entrées « crash »). */
  reason?: GuestCrashReason;
  /** Contexte brut : état libvirt, extrait du journal de l'invité, erreur. */
  detail?: string;
  /** Numéro de la tentative de redémarrage (entrées restart/gave-up). */
  attempt?: number;
  createdAt: string;
}

/** Politique de reprise d'un invité donné. */
export interface GuestCrashPolicy {
  resourceType: "vm" | "lxc";
  resourceName: string;
  /** `null` = aucune politique propre : le défaut global s'applique. */
  restartOnCrash: boolean | null;
}
