import i18n from "i18next";
import { initReactI18next } from "react-i18next";

export interface UiLanguage {
  code: string;
  label: string;
  nativeName: string;
}

const DEFAULT_LANGUAGE = "EN";
const STORAGE_KEY = "auxinux-lang";

const fallbackResources = {
  EN: {
    translation: {
      "brand.name": "AuxiNux",
      "brand.product": "Virtua Control",
      "auth.login": "Login",
      "auth.logout": "Logout",
      "auth.username": "Username",
      "auth.password": "Password",
      "auth.changePassword": "Change Password",
      "auth.newPassword": "New Password",
      "auth.mustChangePassword": "You must change your password before continuing",
      "auth.language": "Language",
      "nav.dashboard": "Dashboard",
      "nav.host": "Host",
      "nav.currentNode": "Current Node",
      "nav.hostShell": "Host Shell",
      "nav.datacenter": "Datacenter",
      "nav.datacenterSettings": "Datacenter Settings",
      "nav.nodeSettings": "Node Settings",
      "nav.storage": "Storage",
      "nav.localStorage": "Local Storage",
      "nav.isos": "ISO / Templates",
      "nav.network": "Network",
      "nav.localNetwork": "Local Network",
      "nav.vms": "Virtual Machines",
      "nav.lxc": "LXC Containers",
      "nav.docker": "Docker",
      "nav.users": "Users",
      "nav.audit": "Logs",
      "logs.title": "Logs",
      "logs.tabTasks": "Tasks",
      "logs.tabAudit": "Audit",
      "logs.tabSecurity": "Security",
      "logs.securityImmutable": "Security events are immutable — they can never be cleared or deleted.",
      "logs.clear": "Clear",
      "logs.confirmClearTasks": "Clear all finished tasks? Running tasks are kept.",
      "logs.confirmClearAudit": "Clear the audit log? Security events are kept.",
      "logs.filterPlaceholder": "Filter by action...",
      "logs.eventsCount": "events",
      "logs.tasksCount": "tasks",
      "logs.colTime": "Time",
      "logs.colUser": "User",
      "logs.colAction": "Action",
      "logs.colResource": "Resource",
      "logs.colResult": "Result",
      "logs.colStatus": "Status",
      "logs.colDetails": "Details",
      "logs.colIp": "IP",
      "logs.noTasks": "No tasks found",
      "logs.noLogs": "No logs found",
      "logs.page": "Page",
      "logs.prev": "Previous",
      "logs.next": "Next",
      "nav.settings": "Settings",
      "nav.about": "About",
      "sidebar.view": "View",
      "sidebar.allView": "ALL",
      "sidebar.datacenterView": "Datacenter View",
      "sidebar.serverView": "Server View",
      "sidebar.storageView": "Storage View",
      "sidebar.libraries": "Libraries",
      "sidebar.noPools": "No pools",
      "sidebar.newOnNode": "New on this node",
      "action.create": "Create",
      "action.open": "Open",
      "action.cancel": "Cancel",
      "action.delete": "Delete",
      "action.save": "Save",
      "action.refresh": "Refresh",
      "action.reset": "Reset",
      "msg.loading": "Loading...",
      "msg.noData": "No data available",
      "res.cpu": "CPU",
      "res.memory": "Memory",
      "storage.backups": "Backups",
      "datacenter.nodes": "Nodes",
      "datacenter.joinTokens": "Join Tokens",
      "datacenter.joinToken": "Join Token",
      "datacenter.createJoinToken": "Create Join Token",
      "datacenter.nodeScoped": "node scope",
      "datacenter.sharedStorage": "Datacenter Storage",
      "datacenter.sharedStorageDesc": "Shared storage is provisioned across every enabled node and is available from the whole datacenter.",
      "datacenter.createSharedStorage": "Create Shared Storage",
      "datacenter.noSharedStorage": "No shared datacenter storage is configured yet.",
      "datacenter.availableOnAllNodes": "all nodes",
      "datacenter.storageType": "Storage Type",
      "datacenter.mountSource": "Mount Source",
      "datacenter.scope": "Scope",
      "datacenter.storagePath": "Mount Path",
      "datacenter.contentTypes": "Content Types",
      "datacenter.domainOptional": "Domain / Workgroup (optional)",
      "storage.pathAutoCreate": "The mount point will be created automatically if needed.",
      "storage.cifsCredentialsHelp": "If a username is provided, Virtua automatically creates a secure credentials file on each node.",
      "storage.pool": "Storage Pool",
      "scope.localNodeTitle": "Current node scope",
      "scope.nodeSettingsDesc": "These settings affect only the local Virtua node and its host services.",
      "scope.datacenterTitle": "Datacenter scope",
      "scope.datacenterSettingsDesc": "These settings affect the datacenter control plane, node registration and global ACL management.",
      "scope.controlPlaneTitle": "Control plane scope",
      "scope.networkNodeDesc": "Bridges, NAT rules and interfaces shown here apply only to the current node.",
      "scope.firewallNodeDesc": "Firewall rules configured here protect and forward traffic only for the current node.",
      "scope.storageNodeDesc": "Disks, RAID and storage pools listed here belong only to the current node.",
      "scope.usersControlPlaneDesc": "Users are managed on the Virtua control plane. They are not per-node accounts.",
      "scope.auditControlPlaneDesc": "Audit logs shown here come from the control plane and tracked actions, not from every node system journal.",
      "datacenter.joinLeave": "Join / Leave",
      "datacenter.joinDatacenter": "Join Datacenter",
      "datacenter.leaveDatacenter": "Leave Datacenter",
      "datacenter.primaryApiUrl": "Primary API URL",
      "datacenter.thisNodeApiUrl": "This Node API URL",
      "datacenter.joinTokenNotePlaceholder": "Node note",
      "datacenter.noJoinTokens": "No active join tokens.",
      "datacenter.noNote": "No note",
      "datacenter.expiresAt": "expires",
      "wizard.new": "New",
      "wizard.continue": "Continue",
      "wizard.remoteReady": "Remote node ready",
      "hostShell.title": "Host Shell",
      "hostShell.subtitle": "Interactive Debian host shell for administration tasks.",
      "storage.cachedTemplatesTitle": "Cached LXC Templates",
      "storage.cachedTemplatesDescription": "Templates already present on the server and ready to use for container creation.",
      "storage.noCachedTemplates": "No cached LXC template is currently available on the server.",
      "storage.remoteSearchHint": "Enter a search term to browse the remote LXC catalog.",
      "storage.vmDiskType": "VM Disk Image",
      "storage.vmDiskLibrary": "VM Disk Image Library",
      "storage.vmDiskLibraryDescription": "Imported virtual disks such as qcow2, raw or vmdk files that can be kept on the host.",
      "storage.localDockerImagesTitle": "Local Docker Images",
      "storage.localDockerImagesDescription": "Images already stored on the server and ready to use for new containers.",
      "storage.noLocalDockerImages": "No local Docker image is currently available on the server.",
      "tasks.title": "Tasks",
      "tasks.id": "Task ID",
      "tasks.initiatedBy": "Initiated By",
      "tasks.action": "Action",
      "tasks.activity": "Activity",
      "tasks.status": "Status",
      "tasks.empty": "No recent tasks",
      "tasks.statusPending": "Pending",
      "tasks.statusRunning": "Running",
      "tasks.statusCompleted": "Completed",
      "tasks.statusFailed": "Failed",
      "tasks.runningCount": "{{count}} active",
      "tasks.idle": "No active tasks",
      "tasks.createdAt": "Created",
      "tasks.updatedAt": "Updated",
      "tasks.progress": "Progress",
      "tasks.close": "Close",
      "tasks.filterAll": "All users",
      "tasks.filterMine": "My tasks"
    },
  },
  FR: {
    translation: {
      "brand.name": "AuxiNux",
      "brand.product": "Contrôle Virtua",
      "auth.login": "Connexion",
      "auth.logout": "Déconnexion",
      "auth.username": "Nom d'utilisateur",
      "auth.password": "Mot de passe",
      "auth.changePassword": "Changer le mot de passe",
      "auth.newPassword": "Nouveau mot de passe",
      "auth.mustChangePassword": "Vous devez changer votre mot de passe avant de continuer",
      "auth.language": "Langue",
      "nav.dashboard": "Tableau de bord",
      "nav.host": "Hôte",
      "nav.currentNode": "Nœud courant",
      "nav.hostShell": "Shell hôte",
      "nav.datacenter": "Datacenter",
      "nav.datacenterSettings": "Paramètres Datacenter",
      "nav.nodeSettings": "Paramètres du nœud",
      "nav.storage": "Stockage",
      "nav.localStorage": "Stockage local",
      "nav.isos": "ISO / Templates",
      "nav.network": "Réseau",
      "nav.localNetwork": "Réseau local",
      "nav.vms": "Machines virtuelles",
      "nav.lxc": "Conteneurs LXC",
      "nav.docker": "Docker",
      "nav.users": "Utilisateurs",
      "nav.audit": "Journaux",
      "logs.title": "Journaux",
      "logs.tabTasks": "Tâches",
      "logs.tabAudit": "Audit",
      "logs.tabSecurity": "Sécurité",
      "logs.securityImmutable": "Les évènements de sécurité sont immuables — ils ne peuvent jamais être effacés ou supprimés.",
      "logs.clear": "Vider",
      "logs.confirmClearTasks": "Vider toutes les tâches terminées ? Les tâches en cours sont conservées.",
      "logs.confirmClearAudit": "Vider le journal d'audit ? Les évènements de sécurité sont conservés.",
      "logs.filterPlaceholder": "Filtrer par action...",
      "logs.eventsCount": "évènements",
      "logs.tasksCount": "tâches",
      "logs.colTime": "Heure",
      "logs.colUser": "Utilisateur",
      "logs.colAction": "Action",
      "logs.colResource": "Ressource",
      "logs.colResult": "Résultat",
      "logs.colStatus": "Statut",
      "logs.colDetails": "Détails",
      "logs.colIp": "IP",
      "logs.noTasks": "Aucune tâche",
      "logs.noLogs": "Aucun journal",
      "logs.page": "Page",
      "logs.prev": "Précédent",
      "logs.next": "Suivant",
      "nav.settings": "Paramètres",
      "nav.about": "À propos",
      "sidebar.view": "Vue",
      "sidebar.allView": "TOUT",
      "sidebar.datacenterView": "Vue Datacenter",
      "sidebar.serverView": "Vue serveur",
      "sidebar.storageView": "Vue stockage",
      "sidebar.libraries": "Bibliothèques",
      "sidebar.noPools": "Aucun pool",
      "sidebar.newOnNode": "Nouveau sur ce nœud",
      "action.create": "Créer",
      "action.open": "Ouvrir",
      "action.cancel": "Annuler",
      "action.delete": "Supprimer",
      "action.save": "Enregistrer",
      "action.refresh": "Actualiser",
      "action.reset": "Réinitialiser",
      "msg.loading": "Chargement...",
      "msg.noData": "Aucune donnée disponible",
      "scope.localNodeTitle": "Portée du nœud courant",
      "scope.nodeSettingsDesc": "Ces paramètres affectent seulement le nœud Virtua local et ses services hôte.",
      "scope.datacenterTitle": "Portée du Datacenter",
      "scope.datacenterSettingsDesc": "Ces paramètres affectent le plan de contrôle du datacenter, l’enregistrement des nœuds et la gestion ACL globale.",
      "scope.controlPlaneTitle": "Portée du plan de contrôle",
      "scope.networkNodeDesc": "Les ponts, règles NAT et interfaces affichés ici s’appliquent uniquement au nœud courant.",
      "scope.firewallNodeDesc": "Les règles firewall configurées ici protègent et redirigent le trafic seulement pour le nœud courant.",
      "scope.storageNodeDesc": "Les disques, RAID et pools de stockage listés ici appartiennent uniquement au nœud courant.",
      "scope.usersControlPlaneDesc": "Les utilisateurs sont gérés sur le plan de contrôle Virtua. Ce ne sont pas des comptes par nœud.",
      "scope.auditControlPlaneDesc": "Les journaux d’audit affichés ici proviennent du plan de contrôle et des tâches suivies, pas du journal système de chaque nœud.",
      "datacenter.nodeScoped": "portée nœud",
      "datacenter.sharedStorage": "Stockage Datacenter",
      "datacenter.sharedStorageDesc": "Le stockage partagé est provisionné sur tous les nœuds actifs et reste disponible depuis l’ensemble du datacenter.",
      "datacenter.createSharedStorage": "Créer un stockage partagé",
      "datacenter.noSharedStorage": "Aucun stockage partagé de datacenter n’est encore configuré.",
      "datacenter.availableOnAllNodes": "tous les nœuds",
      "datacenter.storageType": "Type de stockage",
      "datacenter.mountSource": "Source de montage",
      "datacenter.scope": "Portée",
      "datacenter.storagePath": "Chemin de montage",
      "datacenter.contentTypes": "Types de contenu",
      "datacenter.domainOptional": "Domaine / Groupe de travail (optionnel)",
      "storage.pathAutoCreate": "Le point de montage sera créé automatiquement si nécessaire.",
      "storage.cifsCredentialsHelp": "Si un utilisateur est fourni, Virtua crée automatiquement un fichier credentials sécurisé sur chaque nœud.",
      "storage.pool": "Pool de stockage",
      "res.cpu": "CPU",
      "res.memory": "Mémoire",
      "storage.backups": "Sauvegardes",
      "datacenter.nodes": "Nœuds",
      "datacenter.joinTokens": "Jetons d'association",
      "datacenter.joinToken": "Jeton d'association",
      "datacenter.createJoinToken": "Créer un jeton d'association",
      "datacenter.joinLeave": "Joindre / quitter",
      "datacenter.joinDatacenter": "Joindre le datacenter",
      "datacenter.leaveDatacenter": "Quitter le datacenter",
      "datacenter.primaryApiUrl": "URL API du primaire",
      "datacenter.thisNodeApiUrl": "URL API de ce nœud",
      "datacenter.joinTokenNotePlaceholder": "Note du nœud",
      "datacenter.noJoinTokens": "Aucun jeton d'association actif.",
      "datacenter.noNote": "Aucune note",
      "datacenter.expiresAt": "expire",
      "wizard.new": "Nouveau",
      "wizard.continue": "Continuer",
      "wizard.remoteReady": "Nœud distant prêt",
      "hostShell.title": "Shell hôte",
      "hostShell.subtitle": "Shell interactif du nœud Debian pour les opérations d'administration.",
      "storage.cachedTemplatesTitle": "Templates LXC en cache",
      "storage.cachedTemplatesDescription": "Templates déjà présents sur le serveur et prêts à être utilisés pour créer un conteneur.",
      "storage.noCachedTemplates": "Aucun template LXC en cache n'est actuellement disponible sur le serveur.",
      "storage.remoteSearchHint": "Saisissez une recherche pour parcourir le catalogue LXC distant.",
      "storage.vmDiskType": "Disque de VM",
      "storage.vmDiskLibrary": "Bibliothèque des disques VM",
      "storage.vmDiskLibraryDescription": "Disques virtuels importés comme qcow2, raw ou vmdk conservés sur l'hôte.",
      "storage.localDockerImagesTitle": "Images Docker locales",
      "storage.localDockerImagesDescription": "Images déjà stockées sur le serveur et prêtes à être utilisées pour de nouveaux conteneurs.",
      "storage.noLocalDockerImages": "Aucune image Docker locale n'est actuellement disponible sur le serveur.",
      "tasks.title": "Tâches",
      "tasks.id": "ID tâche",
      "tasks.initiatedBy": "Initié par",
      "tasks.action": "Action",
      "tasks.activity": "Activité",
      "tasks.status": "Statut",
      "tasks.empty": "Aucune tâche récente",
      "tasks.statusPending": "En attente",
      "tasks.statusRunning": "En cours",
      "tasks.statusCompleted": "Terminée",
      "tasks.statusFailed": "Échec",
      "tasks.runningCount": "{{count}} active(s)",
      "tasks.idle": "Aucune tâche active",
      "tasks.createdAt": "Créée",
      "tasks.updatedAt": "Mise à jour",
      "tasks.progress": "Progression",
      "tasks.close": "Fermer",
      "tasks.filterAll": "Tous les utilisateurs",
      "tasks.filterMine": "Mes tâches"
    },
  },
};

const builtinLanguages: UiLanguage[] = [
  { code: "EN", label: "English", nativeName: "English" },
  { code: "FR", label: "French", nativeName: "Français" },
];
const remotelyLoadedLanguages = new Set<string>();

function normalizeLanguageCode(code?: string | null) {
  return (code ?? DEFAULT_LANGUAGE).trim().toUpperCase();
}

async function fetchLanguageBundle(code: string) {
  const response = await fetch(`/api/i18n/${encodeURIComponent(code)}`);
  if (!response.ok) throw new Error(`Unable to load language ${code}`);
  return response.json() as Promise<{ code: string; label: string; nativeName: string; translations: Record<string, string> }>;
}

export async function ensureLanguageLoaded(code: string) {
  const normalized = normalizeLanguageCode(code);
  if (remotelyLoadedLanguages.has(normalized)) return;
  const bundle = await fetchLanguageBundle(normalized);
  i18n.addResourceBundle(normalized, "translation", bundle.translations, true, true);
  remotelyLoadedLanguages.add(normalized);
}

export async function changeAppLanguage(code: string) {
  const normalized = normalizeLanguageCode(code);
  await ensureLanguageLoaded(normalized);
  await i18n.changeLanguage(normalized);
  localStorage.setItem(STORAGE_KEY, normalized);
}

export async function getAvailableLanguages(): Promise<UiLanguage[]> {
  try {
    const response = await fetch("/api/i18n/languages");
    if (!response.ok) throw new Error("Unable to list languages");
    const languages = await response.json() as UiLanguage[];
    const merged = new Map<string, UiLanguage>();
    for (const language of [...builtinLanguages, ...languages]) {
      merged.set(normalizeLanguageCode(language.code), {
        code: normalizeLanguageCode(language.code),
        label: language.label,
        nativeName: language.nativeName,
      });
    }
    return [...merged.values()].sort((a, b) => a.code.localeCompare(b.code));
  } catch {
    return builtinLanguages;
  }
}

export async function initializeI18n() {
  const savedLanguage = normalizeLanguageCode(localStorage.getItem(STORAGE_KEY));

  await i18n
    .use(initReactI18next)
    .init({
      resources: fallbackResources,
      lng: DEFAULT_LANGUAGE,
      fallbackLng: DEFAULT_LANGUAGE,
      interpolation: { escapeValue: false },
    });

  await ensureLanguageLoaded("EN").catch(() => undefined);
  await ensureLanguageLoaded("FR").catch(() => undefined);

  if (savedLanguage !== DEFAULT_LANGUAGE) {
    await changeAppLanguage(savedLanguage).catch(() => {
      localStorage.setItem(STORAGE_KEY, DEFAULT_LANGUAGE);
    });
  }
}

export default i18n;
