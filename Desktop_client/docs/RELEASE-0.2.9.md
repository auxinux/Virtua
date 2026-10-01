# Version 0.2.9

Le journal de la console série des VM locales est enregistré.

Le firmware UEFI écrit sur le port série ce qu'il fait au démarrage : options
de démarrage essayées, échecs de chargement, refus Secure Boot, accès TPM.
Rien de tout cela n'apparaît à l'écran — une VM qui reste sur le logo du
firmware n'expliquait donc rien.

Chaque démarrage écrit maintenant `Logs/<VM>-serial.log`, à côté de
`Logs/<VM>-qemu.log` (qui garde les messages de QEMU lui-même). Les deux
fichiers se trouvent dans
`~/Library/Application Support/AuxiNux Virtua Desktop/Local/Logs` sur Mac.
