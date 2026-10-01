# Version 0.2.8

Les VM ARM64 avec TPM 2.0 démarrent avec l'accélération matérielle du Mac
(HVF) au lieu de l'émulation logicielle.

## Cause

Sur la machine ARM `virt`, QEMU n'accepte qu'un TPM « sysbus »
(`tpm-tis-device`). Celui-ci expose une page Physical Presence (PPI) de 1 Kio
en mémoire vive, alors que HVF ne sait projeter que des zones alignées sur
16 Kio. QEMU s'arrêtait net :

```
-device tpm-tis-device,tpmdev=virtua-tpm: Error: ret = HV_BAD_ARGUMENT
```

Toutes les tentatives accélérées échouaient, et la VM finissait en TCG —
beaucoup plus lente, sur toute VM ARM64 avec TPM 2.0.

## Correctif

- Le TPM ARM64 est créé avec `ppi=off`. La PPI ne sert qu'à demander au
  firmware d'effacer le TPM depuis l'OS; le TPM lui-même (mesures, clés,
  BitLocker, contrôles de Windows 11) n'est pas touché.
- Si le QEMU installé fournit `tpm-crb-device` (cas du fork de UTM), il est
  préféré : c'est l'interface CRB que pilote Windows sur ARM.
- Un QEMU trop ancien pour l'option `ppi` garde son TPM : l'option est retirée
  à la tentative suivante.

## À vérifier après installation

Avec le QEMU officiel (Homebrew), Windows ARM voit un TPM à interface TIS.
Les contrôles d'installation de Windows 11 le reconnaissent; vérifier dans
Windows avec `tpm.msc` que le TPM est « prêt à l'emploi ». Si ce n'est pas le
cas, c'est la limite du QEMU officiel, pas de la VM : seule l'interface CRB
(fork UTM) l'expose alors à Windows.
