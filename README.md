# MultiHub

Gestor de serveis web amb múltiples comptes, inspirat en [Ferdium](https://github.com/ferdium/ferdium-app),
amb una novetat principal: **extensions de navegador compartides per tots els serveis**.

## Funcions

- **Comptes il·limitats** de: WhatsApp Web, Instagram, Instagram Missatges Directes, Outlook, RoundCube,
  Yahoo Mail, Claude (claude.ai), YouTube Music, Discord, Gmail, Google Drive, ChatGPT i qualsevol web personalitzada.
  Cada compte té la seva **sessió aïllada** (`persist:service-<uuid>`), així que pots tenir 3 WhatsApp, 2 Gmail, etc.
- **Extensions** (Chrome Web Store, fitxer `.crx`/`.zip` o carpeta descomprimida) que s'activen **a tots els serveis**
  alhora. Opcionalment es poden excloure de serveis concrets.
- Barra d'eines amb els botons de les extensions; el popup (p. ex. Authenticator) s'obre en una **sessió compartida**,
  de manera que les dades de l'extensió són les mateixes per a tots els comptes.
- **Grups** de serveis (p. ex. "Claude" amb tots els comptes de Claude): es pleguen en una sola icona amb miniatures
  i el total de no llegits. Arrossega un servei a sobre d'un grup per afegir-lo, o a l'espai buit per treure'l.
- **Nom de cada servei** sota la seva icona (es pot amagar a Configuració).
- **Contrasenya mestra**: bloqueja l'app (Ctrl+L), automàticament per inactivitat o quan es bloqueja Windows.
  Amb la contrasenya activa, els serveis no es carreguen fins que es desbloqueja.
- **Gestor de descàrregues** (Ctrl+J) per a tots els serveis: progrés, pausa, reprendre, cancel·lar, obrir, mostrar a la carpeta i historial.
- Comptador de no llegits a cada icona, al títol, a la barra de tasques i a la safata del sistema.
- Arrossegar per reordenar, silenciar, desactivar (allibera memòria), zoom per servei, menú contextual, corrector ortogràfic.
- Dreceres: `Ctrl+1…9`, `Ctrl+Tab`, `Ctrl+R`, `Ctrl+N`, `Ctrl+E`, `Ctrl+Shift+M`, `Ctrl+Shift+I`, `Alt+←/→`.
- Tancar a la safata, iniciar minimitzat, instància única.

## Executar i compilar

```bash
npm install
npm start            # executar
npm run dev          # amb DevTools
npm run dist:win     # genera les dues versions portables a dist/
```

Requereix Node.js 18 o superior.

## Versió portable

MultiHub és **100% portable**: no s'instal·la, i tots els comptes, sessions i extensions es desen a la carpeta
`MultiHub-dades`, al costat de l'executable. Si copies la carpeta a un USB o a un altre PC, tot ve amb ella.

| Fitxer a `dist/` | Ús |
|---|---|
| `MultiHub-0.1.0-portable.exe` | Un sol fitxer. Cada vegada que arrenca es descomprimeix a una carpeta temporal (triga uns segons). |
| `MultiHub-0.1.0-win-x64.zip` | Una carpeta amb `MultiHub.exe`. **Arrenca més ràpid**, i és la recomanada per a ús diari. |

Si la carpeta no té permís d'escriptura (p. ex. dins de `C:\Program Files`), l'app fa servir `%APPDATA%\MultiHub`.
Per provar el mode portable amb `npm start`, crea un fitxer buit `portable.txt` a l'arrel del projecte.

## Com funcionen les extensions

```
<userData>/extensions/<id>/      ← una sola còpia de cada extensió
        │
        ├─► sessió compartida "persist:multihub-extensions"
        │      popups de la barra + pàgines d'opcions → chrome.storage COMPARTIT
        │
        └─► sessió de cada servei (WhatsApp 1, WhatsApp 2, Gmail…)
               content scripts injectats a cada web
```

Quan s'instal·la des de la Web Store o des d'un `.crx`, la clau pública del paquet s'escriu al `manifest.json`,
perquè l'extensió tingui el **mateix ID** que a Chrome.

Exemple: Authenticator → enganxa `https://chromewebstore.google.com/detail/authenticator/bhghoamapcdpbohphigoooaddinpkbai`
a *Extensions → Instal·la*.

### Limitacions conegudes

Electron només implementa una part de les API de Chrome per a extensions (`storage`, `runtime`, `i18n`,
`scripting`, `webRequest`, `tabs` en part…). Per tant:

- No hi ha `chrome.identity`, `contextMenus`, `notifications` ni `windows`. Les extensions que les necessitin
  funcionaran només en part. Per exemple, la còpia de seguretat d'Authenticator a Google Drive no funcionarà,
  però afegir i consultar codis sí.
- Des del popup, "escanejar el codi QR de la pàgina" no veu el servei actiu. Afegeix els codis manualment
  o importa'ls.
- Els content scripts de cada servei tenen el seu propi `chrome.storage`. Només el popup i les opcions comparteixen dades.

**Millora futura:** integrar [`electron-chrome-extensions`](https://github.com/samuelmaddock/electron-chrome-extensions)
afegeix `tabs`, `windows`, `contextMenus` i més. Té llicència GPL-3 (o llicència de pagament), cosa que caldria tenir en compte.

### Inici de sessió de Google

Google bloqueja sovint els navegadors incrustats. Per això MultiHub es presenta com a Firefox **només a
`accounts.google.com`**. Aquesta opció es pot desactivar a Configuració.

## Estructura

```
src/main/main.js         finestra, WebContentsView per servei, IPC, menús, safata
src/main/extensions.js   gestor d'extensions (instal·lar, carregar a sessions, popups)
src/main/crx.js          lector de CRX2/CRX3 (zip + clau pública)
src/main/catalog.js      catàleg de serveis (afegir-ne de nous és una línia)
src/main/store.js        configuració persistent (config.json)
src/main/lock.js         contrasenya mestra (hash scrypt, bloqueig automàtic)
src/main/downloads.js    gestor de descàrregues
src/main/identity.js     User-Agent per servei (compatibilitat amb l'inici de sessió de Google)
src/main/icons.js        icones dels serveis (descàrrega i memòria cau local)
src/preload/             pont segur renderer ↔ main
src/renderer/            interfície (barra lateral, modals)
```
