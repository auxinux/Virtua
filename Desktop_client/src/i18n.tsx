import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";

export type Language = "fr" | "en";

type Dictionary = Record<string, string>;

const translations: Record<Language, Dictionary> = {
  fr: {
    // Layout
    "nav.console": "Console",
    "nav.dashboard": "Dashboard",
    "nav.inventory": "Inventaire",
    "nav.vm": "VM",
    "nav.lxc": "LXC",
    "nav.docker": "Docker",
    "nav.tasks": "Tâches",
    "nav.settings": "Connexion",
    "nav.local_settings": "Configuration",
    "nav.storage": "Stockage",
    "layout.nodes": "Noeuds",
    "layout.no_connection": "Aucune connexion",
    "layout.local_mode": "Virtua Local",
    "layout.remote_mode": "Mode frame local",
    "layout.subtitle_local": "sync",
    "layout.subtitle_remote": "Console texte et graphique pour Docker, LXC et VM",
    "layout.active_operations": "opération(s) active(s)",
    "layout.logout": "Déconnexion",
    "layout.back_choice": "Retour au choix",
    "layout.expand": "Agrandir",
    "layout.collapse": "Réduire",

    // General
    "general.cancel": "Annuler",
    "general.search": "Rechercher...",
    "general.all": "Tout",
    "general.address": "Adresse",
    "general.owner": "Propriétaire",
    "general.uptime": "Uptime",
    "general.cpu": "CPU",
    "general.ram": "RAM",
    "general.storage": "Stockage",
    "general.unknown": "inconnu",
    "general.yes": "Oui",
    "general.no": "Non",
    "general.authorized": "autorisé",
    "general.denied": "refusé",

    // Dashboard
    "dash.title": "Vue d'ensemble",
    "dash.desc_local": "État local de cet ordinateur et des VM gérées par Virtua Desktop.",
    "dash.desc_remote": "Pilotage des ressources Virtua accessibles à cette session.",
    "dash.session": "Session",
    "dash.offline": "hors ligne",
    "dash.nodes_avail": "noeuds disponibles",
    "dash.vms": "machines virtuelles",
    "dash.lxcs": "conteneurs système",
    "dash.dockers": "conteneurs applicatifs",
    "dash.node_state": "État des noeuds",
    "dash.local_node_state": "État du noeud local",
    "dash.computer": "Ordinateur",
    "dash.cores": "Cores",
    "dash.recent_tasks": "Dernières tâches",
    "dash.no_tasks": "Aucune tâche récente.",

    // Console
    "console.title": "Consoles",
    "console.admin_access": "ADMIN / accès complet",
    "console.user_access": "Machines associées",
    "console.guest_agent": "Agent invité",
    "console.term_text": "Terminal texte",
    "console.term_graphical": "Console graphique",
    "console.no_perm": "Vous n'avez pas la permission console sur cette machine.",
    "console.no_machine": "Aucune machine accessible.",
    "console.start": "Démarrer",
    "console.stop": "Arrêter",
    "console.restart": "Redémarrer",
    "console.config": "Configuration",
    "console.power": "Alimentation",
    "console.stop_title": "Arrêter",
    "console.stop_desc": "Choisis comment Virtua Desktop doit arrêter cette machine.",
    "console.stop_os": "Envoyer un signal à l'OS",
    "console.stop_os_desc": "Demande un arrêt propre. L'OS invité peut prendre quelques secondes.",
    "console.stop_force": "Fermer la machine maintenant",
    "console.stop_force_desc": "Force la fermeture QEMU. Équivalent à couper le courant.",
    "console.connected": "Connecté",
    "console.disconnected": "Déconnecté",
    "console.error": "Erreur WebSocket console",

    // Auth / Usage Mode
    "auth.connect": "Se connecter",
    "auth.username": "Nom d'utilisateur",
    "auth.password": "Mot de passe",
    "auth.endpoint": "Adresse du serveur",
    "mode.title": "Comment voulez-vous utiliser Virtua ?",
    "mode.local": "Mode Local",
    "mode.local_desc": "Gérer les machines virtuelles de cet ordinateur",
    "mode.remote": "Mode Client",
    "mode.remote_desc": "Se connecter à un serveur Virtua distant",
    "mode.not_avail": "Non disponible sur cet appareil",

    // Resources / Inventory
    "res.inventory": "Inventaire",
    "res.add": "Ajouter",
    "res.delete": "Supprimer",
    "res.state": "État",
    "res.name": "Nom",
    "res.node": "Noeud",
    "res.ip": "IP",
    "res.kind": "Type",
    "res.actions": "Actions",

    // Statuses
    "status.online": "En ligne",
    "status.offline": "Hors ligne",
    "status.running": "En cours",
    "status.stopped": "Arrêté",
  },
  en: {
    // Layout
    "nav.console": "Console",
    "nav.dashboard": "Dashboard",
    "nav.inventory": "Inventory",
    "nav.vm": "VM",
    "nav.lxc": "LXC",
    "nav.docker": "Docker",
    "nav.tasks": "Tasks",
    "nav.settings": "Connection",
    "nav.local_settings": "Configuration",
    "nav.storage": "Storage",
    "layout.nodes": "Nodes",
    "layout.no_connection": "No connection",
    "layout.local_mode": "Virtua Local",
    "layout.remote_mode": "Local frame mode",
    "layout.subtitle_local": "sync",
    "layout.subtitle_remote": "Text and graphical console for Docker, LXC and VM",
    "layout.active_operations": "active operation(s)",
    "layout.logout": "Logout",
    "layout.back_choice": "Back to choice",
    "layout.expand": "Expand",
    "layout.collapse": "Collapse",

    // General
    "general.cancel": "Cancel",
    "general.search": "Search...",
    "general.all": "All",
    "general.address": "Address",
    "general.owner": "Owner",
    "general.uptime": "Uptime",
    "general.cpu": "CPU",
    "general.ram": "RAM",
    "general.storage": "Storage",
    "general.unknown": "unknown",
    "general.yes": "Yes",
    "general.no": "No",
    "general.authorized": "authorized",
    "general.denied": "denied",

    // Dashboard
    "dash.title": "Overview",
    "dash.desc_local": "Local state of this computer and VMs managed by Virtua Desktop.",
    "dash.desc_remote": "Management of Virtua resources accessible to this session.",
    "dash.session": "Session",
    "dash.offline": "offline",
    "dash.nodes_avail": "available nodes",
    "dash.vms": "virtual machines",
    "dash.lxcs": "system containers",
    "dash.dockers": "application containers",
    "dash.node_state": "Nodes State",
    "dash.local_node_state": "Local Node State",
    "dash.computer": "Computer",
    "dash.cores": "Cores",
    "dash.recent_tasks": "Recent tasks",
    "dash.no_tasks": "No recent tasks.",

    // Console
    "console.title": "Consoles",
    "console.admin_access": "ADMIN / full access",
    "console.user_access": "Associated machines",
    "console.guest_agent": "Guest Agent",
    "console.term_text": "Text terminal",
    "console.term_graphical": "Graphical console",
    "console.no_perm": "You do not have console permission on this machine.",
    "console.no_machine": "No accessible machine.",
    "console.start": "Start",
    "console.stop": "Stop",
    "console.restart": "Restart",
    "console.config": "Configuration",
    "console.power": "Power",
    "console.stop_title": "Stop",
    "console.stop_desc": "Choose how Virtua Desktop should stop this machine.",
    "console.stop_os": "Send OS signal",
    "console.stop_os_desc": "Requests a clean shutdown. The guest OS may take a few seconds.",
    "console.stop_force": "Close machine now",
    "console.stop_force_desc": "Forces QEMU closure. Equivalent to pulling the plug.",
    "console.connected": "Connected",
    "console.disconnected": "Disconnected",
    "console.error": "Console WebSocket error",

    // Auth / Usage Mode
    "auth.connect": "Connect",
    "auth.username": "Username",
    "auth.password": "Password",
    "auth.endpoint": "Server Address",
    "mode.title": "How do you want to use Virtua?",
    "mode.local": "Local Mode",
    "mode.local_desc": "Manage virtual machines on this computer",
    "mode.remote": "Client Mode",
    "mode.remote_desc": "Connect to a remote Virtua server",
    "mode.not_avail": "Not available on this device",

    // Resources / Inventory
    "res.inventory": "Inventory",
    "res.add": "Add",
    "res.delete": "Delete",
    "res.state": "State",
    "res.name": "Name",
    "res.node": "Node",
    "res.ip": "IP",
    "res.kind": "Kind",
    "res.actions": "Actions",

    // Statuses
    "status.online": "Online",
    "status.offline": "Offline",
    "status.running": "Running",
    "status.stopped": "Stopped",
  },
};

type LanguageContextType = {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string, fallback?: string) => string;
};

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLangState] = useState<Language>(() => {
    const stored = localStorage.getItem("virtua-lang");
    if (stored === "fr" || stored === "en") return stored;
    return navigator.language.startsWith("fr") ? "fr" : "en";
  });

  const setLanguage = (lang: Language) => {
    localStorage.setItem("virtua-lang", lang);
    setLangState(lang);
  };

  const t = (key: string, fallback?: string) => {
    return translations[language][key] || fallback || key;
  };

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage must be used within a LanguageProvider");
  }
  return context;
}
