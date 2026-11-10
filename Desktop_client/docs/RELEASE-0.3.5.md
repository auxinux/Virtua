# Version 0.3.5

Correctifs de la préparation des bases Debian (VM jetables) et de
l'installation Debian sur ARM64 (Mac).

- **Base Debian bloquée en fin d'installation** : l'étape qui généralise la
  base (machine-id, clés SSH) écrivait sur le canal interne de
  l'installateur Debian (`systemctl enable` affiche un message) ; le menu
  devenait illisible et l'installation s'arrêtait sur « Continuer sans
  programme de démarrage ». Ses messages vont maintenant au journal de
  l'installateur.
- **Debian sur ARM64** : avec UEFI + ACPI, le port série restait la console
  préférée (table ACPI SPCR) malgré `console=tty0` ; l'installateur y
  tournait, ne proposait que la langue « C » et s'arrêtait sur « Select a
  language ». Il démarre avec `acpi=nospcr console=tty0` et s'affiche à
  l'écran.

## Connexion Cloud

- « Serveur Virtua injoignable … error sending request for url » ne disait
  pas pourquoi. Virtua Desktop diagnostique maintenant la connexion et
  affiche la vraie raison : port fermé (API arrêtée sur le nœud), aucune
  réponse (adresse, machine éteinte, pare-feu), pas de route, nom introuvable,
  ou port qui n'est pas l'API Virtua.
- **http / https** : si le port parle l'autre protocole (http:// saisi pour
  un nœud en HTTPS, ou l'inverse), la requête est refaite automatiquement
  avec le bon, et l'adresse corrigée est retenue. Certificat refusé : le
  message le dit.
- **macOS** : l'application déclare l'accès au réseau local
  (`NSLocalNetworkUsageDescription`). Sans cette déclaration, macOS 15+
  bloquait toute connexion à un nœud en 192.168.x.x sans même afficher la
  demande d'autorisation. Si l'accès a été refusé : Réglages Système →
  Confidentialité et sécurité → Réseau local → autoriser « AuxiNux Virtua
  Desktop Client » ; le message d'erreur l'indique.
