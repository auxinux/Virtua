# Version 0.2.7

La souris ne disparaît plus dans l'installeur Windows, et l'émulation
logicielle garde Secure Boot.

## Souris

Quand une VM ARM64 démarrait sur une tentative de repli (notamment en
émulation logicielle, TCG), la tablette USB était retirée. Un PC x86 garde
alors sa souris PS/2, mais la machine ARM `virt` n'en a pas : l'invité se
retrouvait **sans aucun pointeur** — l'installeur Windows ne se pilotait plus
qu'au clavier. Une VM ARM64 a maintenant toujours sa tablette USB (le
contrôleur USB est de toute façon présent pour le clavier et les lecteurs CD).

Les tentatives en émulation gardent aussi la tablette sur x86 : le pointeur
reste aligné avec celui de la console.

## Secure Boot en émulation logicielle

La tentative TCG chargeait le firmware sans ses variables UEFI, ce qui faisait
perdre Secure Boot — et Windows 11 refusait de s'installer. Elle garde
maintenant le magasin de variables; une dernière tentative sans lui ne sert
qu'en ultime recours, et le bandeau le signale.
