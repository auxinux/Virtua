# Version 0.2.10

Mode Cloud : quand le serveur Virtua ne répond pas, l'application le dit au
lieu d'afficher « Action impossible ».

Le module HTTP de Tauri signale une connexion refusée, un certificat refusé ou
un délai dépassé par une simple chaîne de caractères, que l'interface
remplaçait par « Action impossible ». Le message affiché est maintenant
« Serveur Virtua injoignable (hôte:port) : <raison> ».
