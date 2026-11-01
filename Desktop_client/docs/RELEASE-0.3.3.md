# Version 0.3.3

Création rapide Windows 11 : l'ISO du dépôt AuxiNux est de nouveau trouvée.

## Correctif

La 0.3.2 répondait « Aucune ISO Windows 11 disponible sur le dépôt
AuxiNux » alors que `Windows11-FR_CA-25h2.iso` (8,4 Go) y était. La taille
de chaque ISO était lue avec `content_length()` de reqwest, qui donne la
taille du *corps* de la réponse ; une requête HEAD n'en a pas, donc chaque
ISO semblait faire 0 octet et était écartée (moins de 3 Go). La taille vient
maintenant de l'en-tête `Content-Length` du serveur (test de non-régression
avec un serveur HTTP local).

## Mac (ARM64)

La création rapide cherche aussi Windows 11 ARM64 dans le dépôt
(`TEMPLATES/ISO/ARM/`) au lieu de refuser d'emblée : une ISO déposée là
(`Windows11*.iso` ou `Win11*.iso`, plus de 3 Go) est téléchargée comme sur
amd64.

## Quand une page plante

- L'erreur est enregistrée dans
  `~/.local/share/AuxiNux Virtua Desktop/Local/Logs/interface.log` (avec la
  page concernée et la version), y compris les erreurs hors affichage
  (actions, promesses), pour pouvoir la retrouver après « Recharger ».
- Bouton « Copier l'erreur » sur l'écran « Une page de Virtua Desktop a cessé
  de répondre ».
