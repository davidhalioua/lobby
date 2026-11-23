# Lobby — ton client LoL dans la poche

Accepter la file, bannir, choisir, changer de runes et de sorts depuis ton téléphone.
Usage perso entre potes : chacun lance Lobby sur son propre PC.

## Pour tes potes : Lobby.exe

1. Télécharge `Lobby.exe` (page Releases du dépôt GitHub) et double-clique dessus.
2. Si Windows SmartScreen prévient : « Informations complémentaires » › « Exécuter quand même ».
   Si le pare-feu demande : autoriser sur les **réseaux privés**.
3. Une page s'ouvre avec un QR code : scanne-le avec ton téléphone (**même Wi-Fi que le PC**),
   puis « Ajouter à l'écran d'accueil ».

C'est tout. Lobby se lance tout seul au démarrage de Windows, en arrière-plan, et se met à jour tout seul.
Pour revoir le QR code ou quitter Lobby : menu Démarrer › **Lobby**.

Sur iPhone, touche l'écran une fois après l'ouverture pour autoriser le son de « partie trouvée ».

## Pour le développement

```
cd companion
npm install
npm start          # lance depuis les sources
npm run build      # fabrique dist/Lobby.exe
```

### Publier une mise à jour

Change `"version"` dans `companion/package.json` (ex. `0.6.1`) et pousse sur `main`.
GitHub Actions construit `Lobby.exe`, crée le tag et la release ; les Lobby installés se mettent à jour
dans les 6 heures (jamais pendant une file ou une sélection).

## Le relais en ligne (une seule fois, pour toute la bande)

Le relais permet d'utiliser Lobby **hors de chez soi** et de recevoir **« Partie trouvée » téléphone verrouillé**.
Il tourne gratuitement sur Cloudflare Workers.

```
cd relay
npm install
npx wrangler login      # crée/ouvre ton compte Cloudflare gratuit dans le navigateur
npm run deploy          # affiche l'adresse : https://lobby-relay.<toi>.workers.dev
npm run vapid           # clés des notifications (une seule fois)
```

Puis mets cette adresse dans `companion/package.json` → `"lobby": { "relayUrl": "https://…" }`
(ou dans la variable GitHub `LOBBY_RELAY_URL` : Settings › Secrets and variables › Actions › Variables),
et publie une nouvelle version. Les Lobby installés passent alors tout seuls par le relais.

Notifications : sur iPhone, il faut ouvrir Lobby depuis l'icône de l'écran d'accueil (iOS 16.4+),
puis toucher « Activer les notifications ». Sur Android, ça marche aussi depuis Chrome, avec un bouton « Accepter » dans la notification.

## Ce qui marche

- Lancer une partie : choix du mode, des postes, lancer / annuler la recherche
- Partie trouvée : accepter / refuser avec compte à rebours, auto-accept minuté (15 min, 1 h, 3 h)
- Sélection : bans et picks avec recherche, portraits officiels (Data Dragon)
- Ton équipe et les bans en direct
- Choix de la page de runes, sorts D/F (et inversion)

## Sécurité

- Lobby n'écoute que sur ton réseau local, et seul un téléphone qui a le jeton du QR code peut le piloter.
- Ne partage pas le lien. Pour révoquer tous les téléphones : `npm start -- --new-token` (ou supprime `%LOCALAPPDATA%\Lobby\config.json`).
- Lobby utilise l'API locale du client (LCU), que Riot tolère sans la supporter officiellement.
  Il n'automatise rien en jeu et ne révèle aucune information cachée.

## Builds OP.GG (en cours)

Le schéma exact de l'API OP.GG n'est pas documenté publiquement. Pour le brancher :
```
npm run opgg:probe -- Viego JUNGLE
```
Ça crée `opgg-probe.json` avec le schéma et une vraie réponse : il suffit de l'envoyer à Claude pour finaliser l'import automatique (runes + sorts + set d'objets).

## Problèmes courants

- **« Client LoL fermé » alors qu'il est ouvert** : installation dans un dossier inhabituel ? Lance avec
  `set LOL_LOCKFILE=E:\Jeux\Riot Games\League of Legends\lockfile` (Windows) puis `npm start`.
- **Le téléphone ne charge pas la page** : vérifie qu'il est sur le même Wi-Fi, et le pare-feu Windows.
- **Port déjà utilisé** : `set LOBBY_PORT=8080` puis `npm start`.

## Modes ARAM (ARAM, ARAM du chaos…)

En ARAM, l'écran de sélection affiche ton champion, le banc (touche pour échanger) et le bouton de relance.
Si un mode s'affiche mal, lance `set LOBBY_DEBUG=1` puis `npm start` (PowerShell : `$env:LOBBY_DEBUG=1; npm start`) :
la sélection est enregistrée dans `lobby-debug.json`, à envoyer à Claude.

---

Lobby a été créé dans le cadre de la politique « Legal Jibber Jabber » de Riot Games en utilisant des éléments appartenant à Riot Games. Riot Games ne soutient ni ne parraine ce projet.
