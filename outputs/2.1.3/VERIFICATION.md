# Veille Immo 2.1.3 - verification du 8 septembre 2026

## Produit

- PWA, EXE Windows NSIS, APK Android 2.1.3.
- Relais public : https://veille-immo-actualisation.lmpg110312.chatgpt.site
- Depot distinct du relais : services/refresh ; revision fe3815331a555b8c84e5c6ca327d25235cadd8ad.
- Secret GitHub conserve uniquement dans l'environnement serveur du relais.
- Aucun changement Java du wrapper Android, aucune nouvelle popup.

## Teste avec succes

- Transport de collecte : redirection HTTP, reponse tronquee, expiration et taille excessive ; node --test scripts/test-fetch-source-page.mjs.
- Relais : calendrier Europe/Brussels, jour deja collecte sans declenchement, rattachement au traitement actif, attente de publication apres collecte reussie sans relance, declenchement sur donnees anciennes, erreur sans divulgation du secret ; npm test --prefix services/refresh.
- Relais public reel : POST /refresh depuis Android et Windows retourne le traitement GitHub actif 34168749608. Le declenchement GitHub a ete accepte avec HTTP 204.
- Verrou GitHub reel : deux mises a jour concurrentes de la branche de verrou ; seconde refusee avec HTTP 422.
- Navigateur Chrome : scripts/verify-daily-refresh-pwa.mjs. Bandeau actif, communes cliquables pendant la collecte, conservation des cartes en echec, bouton de reprise, reception de donnees du jour, absence de nouveau POST au retour visible le meme jour, largeur mobile 390 px. Ce test utilise explicitement des reponses simulees pour les transitions de collecte et la date du jour.
- Nouveautes : scripts/verify-newness-sources-pwa.mjs. Snapshot precedent precharge, compteur, filtre, badges Nouveau, etoiles et couleurs des sources ; 6 nouvelles annonces attendues et rendues dans le scenario maisons, 2 dans le scenario terrains. Un premier essai terrains a rencontre le rechargement initial du service worker ; le test attend desormais son activation avant les assertions et passe.
- EXE : contenu extrait de l'installateur final et application extraite executee. 578 cartes et 578 marqueurs charges, commune cliquable, version pwa-2026-09-08-01, bandeau reel de recherche en cours. Voir windows-installer-test.json et windows-refresh.png.
- Android : APK installe et lance sur emulateur Pixel 7 API 35, serial emulator-5570. Apres un echec reseau initial, le bouton Reessayer rejoint effectivement la collecte et affiche le bandeau actif. Voir android-refresh.png.
- APK : package be.veilleimmo.mobile.v2, versionCode 213 (precedent 212), versionName 2.1.3, signatures v1 et v2 valides, resources.arsc stocke sans compression (1056 octets).
- Recherche textuelle dans les ressources applicatives : aucune popup Sources complementaires ni reference aux marches publics.
- Fin de collecte REELLE : traitement GitHub 34168749608 termine avec succes en 50 min 47 s. Sans fermer les applications, Windows passe de 578 a 584 cartes et Android de 35 a 34 terrains ; les deux affichent l'etat current. Voir windows-live-refresh.json, android-live-refresh.json et les captures updated.
- Donnees effectivement recues : maisons 2026-09-07T23:41:53.252Z, terrains 2026-09-07T23:54:25.704Z, soit le 8 septembre a 01:41 et 01:54 en Belgique. L'emulateur Android est configure en UTC et affiche l'heure locale UTC ; le controle de jour utilise Europe/Brussels.

## Reserves et controles restants

- Le package stable de la serie 2.x est be.veilleimmo.mobile.v2, et non l'ancien identifiant be.veilleimmo.mobile. Il est conserve pour ne pas creer une autre application.
- L'assistant d'installation NSIS n'a pas ete installe dans le profil utilisateur : son contenu a ete extrait et execute pour ne pas remplacer l'installation personnelle durant les tests.
- Test Android sur emulateur, pas sur le telephone physique de l'utilisateur.
- Le scenario navigateur de panne et de reprise est simule ; la fin de collecte a aussi ete verifiee reellement sur EXE et APK. Les liens publics de livraison doivent encore etre controles apres publication.
- Les fichiers embarques de secours datent du 4 septembre. L'application doit recuperer les donnees distantes ; elle conserve et indique cette ancienne date si le reseau echoue.
- Donnees presentes avant la nouvelle collecte : maisons Immoweb 539, Immovlan 35, agences 4 ; terrains Immoweb 35. Zimmo bloque et particuliers filtres : aucune annonce de ces sources n'a ete inventee.
- Nouvelle collecte : maisons Immoweb 543, Immovlan 39, agences 2 ; terrains Immoweb 34. Ce correctif ne pretend pas debloquer Zimmo ou integrer de faux particuliers.
- Limite connue : la collecte complete reste lente (50 min 47 s mesures). Le correctif permet son lancement et son suivi quotidien, il ne rend pas instantanee l'extraction des sites.

## Rangement

- Creations : services/refresh, vendor/leaflet, scripts de test et transport, outputs/2.1.3 et rapport preflight.
- Aucun deplacement de source existante. AGENTS.md utilisateur laisse intact.
- Le repertoire temporaire d'essai doit etre supprime a la fin des verifications.
