# Version 0.6.1

Correctif : une VM Windows (création rapide ou mode Unifié) ne démarrait plus
en 0.5.0 / 0.6.0 :

> QEMU a quitté au démarrage… Could not set up host forwarding rule
> 'tcp:127.0.0.1:6301-:3389'

Le port de l'Agent Virtua et le renvoi Bureau à distance du mode Unifié
prenaient la même plage (6301-6399), donc le même port. L'Agent Virtua
utilise maintenant 6401-6499 ; un test vérifie qu'aucune plage de ports ne
chevauche une autre.
