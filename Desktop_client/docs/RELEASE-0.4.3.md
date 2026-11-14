# Version 0.4.3

Le son des VM en mode local, aussi sur Mac.

Le son passait uniquement par SPICE. Le QEMU de Homebrew (macOS) n'a pas
SPICE : sur un Mac, les VM démarraient **sans carte son**. Quand SPICE n'est
pas là, la VM reçoit maintenant une carte son branchée directement sur le son
de l'ordinateur :

- macOS : CoreAudio ; Linux : PulseAudio / PipeWire ; Windows : DirectSound ;
- VM x86 : carte Intel HD Audio (`intel-hda` + `hda-duplex`) ;
- VM ARM64 : carte **USB audio** (`usb-audio`), dont Windows 11 ARM64 a le
  pilote intégré (HD Audio n'est pas garanti sur ARM).

Avec SPICE (Linux), le son continue de passer par la console, et les VM ARM64
utilisent aussi la carte USB audio. Si QEMU refuse le son, la VM démarre sans,
comme avant.
