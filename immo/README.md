# ImmoRadar — aperçu public statique

Publié avec accord explicite de l’utilisateur. Distinct du Lot A privé Next.js + FastAPI + PostgreSQL/PostGIS, conservé dans `viguss/immoradar`.

- 1 000 vraies mutations DVF+ du Paris 11e du 16 mars au 30 juin 2026 ; 234 prix/m² qualifiés selon les règles conservatrices du Lot A.
- Source : export officiel Cerema `DVF_PLUS_2026_2_CSV_R011_ED261.zip`, millésime `2026-2-ED261`, Licence Ouverte 2.0. URL et SHA256 présents dans `transactions.json` et dans la page.
- Sélection : 1 000 mutations géolocalisées les plus récentes de la version active de la base importée, triées par date décroissante puis identifiant source. Les 18 286 mutations importées ne sont pas toutes publiées ici.
- Pas de backend, d’authentification, d’estimation, de mise à jour automatique ni de service payant. Les filtres et la médiane portent uniquement sur l’extrait ; la carte contient tous les résultats filtrés, la liste est paginée par 50.
- Points au centroïde cadastral, pas à l’emplacement exact d’un appartement. Les mutations ambiguës conservent leur prix global et le motif d’exclusion du prix/m².
- MapLibre GL JS 6.15.0 distribué localement dans `vendor/`, licence incluse ; tuiles OSM avec attribution et referrer. Pas de préchargement massif ni de service worker.
- Aucun secret, identifiant de compte, donnée nominative ajoutée ou configuration privée n’est inclus.

Prévisualisation depuis la racine du site : `python3 -m http.server 8080 --bind 127.0.0.1`, puis `/immo/`.
