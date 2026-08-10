# Statique en réalité mixte — v1.0.0

Application WebXR pour Meta Quest 3. L'étudiant isole une pièce d'un
mécanisme posé sur sa vraie table, trace les vecteurs des actions
mécaniques qu'elle subit, et l'application corrige.

## Lancer l'application

> ⚠️ Ce projet utilise le **port 8080**, comme VR CEC. Ne lance qu'une
> application à la fois. Si l'autre tourne encore, le script te le dira
> et s'arrêtera au lieu de servir le mauvais projet.

1. Double-clique sur **`serveur.bat`**.
2. Une adresse `https://xxxxx.trycloudflare.com` s'affiche.
3. Tape cette adresse dans Wolvic sur le Quest 3.
4. Appuie sur « Entrer en réalité mixte ».

## Utilisation dans le casque

| Action | Commande |
|---|---|
| Poser le mécanisme sur la table | Vise la table, appuie sur la **gâchette** |
| Tracer un vecteur | Place la manette sur un **point bleu**, maintiens la gâchette, tire, relâche |
| Appuyer sur un bouton du panneau | Vise le bouton avec le **rayon bleu**, gâchette |

Le tracé s'accroche automatiquement au point bleu le plus proche et se
projette dans le plan du mécanisme : pas besoin d'être précis en profondeur.

## Ce qui est corrigé

- **Le point d'application** : lequel des 6 points bleus tu as choisi.
  Trois sont pertinents, trois sont des pièges (pièce non isolée, action négligée).
- **La direction et le sens** du vecteur, à ±22° près.
  Entre 22° et 44°, la réponse est comptée « presque ».
- **Les vecteurs en trop** ou manquants.

**La longueur n'est pas corrigée.** Juger une norme à main levée en VR
n'est pas fiable ; les intensités sont traitées dans le texte de correction.

## Ajouter un exercice

Tout se passe dans **`exercices.json`**, sans toucher au code. Le fichier
contient un mode d'emploi détaillé en tête (champ `_lisezmoi`).

Points de vigilance appris en construisant le premier exercice :

- **Point d'application** = l'*origine* du nœud CAO, pas le centre de sa
  boîte englobante. Le câble, par exemple, est un fil de 30 mm dont seule
  l'extrémité touche la lame.
- **Plan du mécanisme** : la normale est l'axe Z de la pièce isolée (l'axe
  du pivot). Ne pas la calculer à partir de trois points d'application :
  l'axe de mâchoire est décalé de 7 mm hors plan, ce qui inclinerait le
  plan de plus de 15°.
- **Bras de levier** ≠ distance au pivot. C'est la distance du pivot à la
  *ligne d'action* de la force.
- Deux points d'application peuvent être proches (3,4 cm ici) : le rayon
  d'accrochage (`RAYON_SNAP` dans `app.js`) doit rester sous la moitié.

## Vérifier un exercice sans casque

Double-clique sur **`test-sur-pc.bat`**. Il démarre le serveur local et
ouvre la page de vérification dans ton navigateur.

> ⚠️ Ne double-clique **pas** sur `test-geometrie.html` directement : en
> mode `file://` le navigateur interdit à la page de lire `exercices.json`
> et `pince.glb`, et tu obtiens « Failed to fetch ».

La page affiche :

- si chaque pièce et chaque point sont bien trouvés dans le `.glb` ;
- les bras de levier et le rapport de levier réels ;
- si le plan calculé est correct ;
- **la somme des forces et la somme des moments de la solution**, qui
  doivent toutes deux être nulles. C'est le garde-fou principal : si elles
  ne le sont pas, les valeurs `norme` du JSON sont fausses.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Page d'accueil |
| `app.js` | Application (tracé, correction, affichage) |
| `exercices.json` | **Définition des exercices — le seul fichier à modifier** |
| `pince.glb` | Modèle 3D |
| `test-geometrie.html` | Vérification sur PC, sans casque |
| `test-sur-pc.bat` | **Lance la vérification sur PC** (serveur seul, sans tunnel) |
| `server.js` / `serveur.bat` | Serveur local + tunnel HTTPS (pour le casque) |

## Limites connues de la v1

- Un seul exercice, une seule pièce isolée.
- Les normes des forces ne sont pas demandées à l'étudiant.
- Le ressort à lame et le poids sont négligés (c'est indiqué dans l'énoncé).
- **La direction de l'action du galet est une hypothèse** : je l'ai prise
  perpendiculaire au levier. La rampe réelle du piston est probablement
  inclinée, ce qui donnerait une composante supplémentaire. À valider et à
  ajuster dans `exercices.json` (champ `dir` de la première force).
