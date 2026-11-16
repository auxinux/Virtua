# Version 0.7.2

Correctif : « Une page de Virtua Desktop a cessé de répondre » en quittant la
console graphique d'une VM (ou en changeant de VM), avec l'erreur
`null is not an object (evaluating 'document.getElementById(this.parent.screen_id).removeChild')`.

La bibliothèque SPICE retire ses images de l'écran de la console quand elle
se ferme ; quand l'écran avait déjà quitté la page, elle plantait, et toute la
page tombait sur l'écran d'erreur. La fermeture de SPICE est maintenant
protégée : la connexion se ferme de toute façon, la page reste.
