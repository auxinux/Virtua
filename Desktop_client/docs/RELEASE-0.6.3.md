# Version 0.6.3

Mode Unifié sur Mac : les applications Windows s'ouvrent.

FreeRDP (Homebrew) affiche ses fenêtres par XQuartz. Virtua Desktop lui
donnait l'affichage `:0`, où XQuartz n'écoute pas : il passe par une socket
launchd (`/private/tmp/com.apple.launchd.…/org.xquartz:0`) que les apps
ouvertes depuis le Dock ne reçoivent pas. FreeRDP s'arrêtait avec « failed to
open display: :0 ». L'affichage est maintenant pris de `DISPLAY`, de
`launchctl getenv DISPLAY` ou de la socket XQuartz, et XQuartz est démarré
s'il ne l'est pas encore.
