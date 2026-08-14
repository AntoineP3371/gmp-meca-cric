// =====================================================================
//  Editeur de liaisons - v5.0.0
//  Exercice complet de statique graphique sur le cric rouleur, en
//  realite mixte (Meta Quest 3) :
//   1. Coloriage des classes d'equivalence cinematique (corrige par
//      classes.json).
//   2. Placement des liaisons (points A a H).
//   3. Isolement de la chape (poids, directions, triangle des forces).
//   4. Isolement du bras superieur (meme methode).
//   5. Bilan anime + evaluation de competence (3 competences, niveau
//      base sur les reussites/essais/questions sautees, sans note
//      chiffree).
//  Chaque question suit le meme schema de boutons : < PRECEDENT,
//  VALIDER, RECOMMENCER, SAUTER LA QUESTION (sauf etape 2, qui n'a pas
//  de bonne/mauvaise reponse a verifier).
// =====================================================================

window.addEventListener('load', function () {

var status  = document.getElementById('status');
var overlay = document.getElementById('overlay');
var canvas  = document.getElementById('c');
var errbox  = document.getElementById('errbox');
function erreur(txt) { errbox.textContent = txt; }

// V1 : cric-v1.glb, sans excentrique ni plateforme (charge directe sur la
// chape, etude dans le plan median). cric.glb (complet) servira pour la V2.
var MODELE        = 'cric-v1.glb';
var TAILLE_MODELE = 0.55;   // plus grande dimension du cric affiche, en metres

// --- Tailles des traits/points affiches (regroupees ici pour reglage
// facile : les pieces du cric sont petites, un trait trop epais les cache).
var RAYON_MARQUEUR_POINT = 0.006;    // spheres des points (liaisons, concours)
var RAYON_FLECHE_FORCE   = 0.0028;   // fleche du vecteur force (etape 3 + solution)
var RAYON_TRAIT_DIRECTION = 0.0018;  // droite de direction (etape 4)
var RAYON_LIGNE_GUIDE    = 0.0011;   // droite de guidage revelee apres validation

if (typeof THREE === 'undefined') { status.textContent = 'Erreur : Three.js non charge'; return; }

if (!navigator.xr) {
  status.textContent = 'WebXR non disponible sur ce navigateur';
} else {
  navigator.xr.isSessionSupported('immersive-ar').then(function (ok) {
    status.textContent = ok ? 'Pret !' : 'Realite mixte non supportee';
    if (!ok) document.getElementById('btnCommencer').disabled = true;
  });
}

// --- Rendu ------------------------------------------------------------
var gl = canvas.getContext('webgl2', { xrCompatible: true }) ||
         canvas.getContext('webgl',  { xrCompatible: true });
var renderer = new THREE.WebGLRenderer({ canvas: canvas, context: gl, alpha: true, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');

var scene  = new THREE.Scene();
var camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);
scene.add(new THREE.AmbientLight(0xffffff, 1.6));
var dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
dirLight.position.set(1, 2, 1);
scene.add(dirLight);

// Taille du canvas : sans effet une fois en VR (le casque impose sa propre
// resolution), mais necessaire pour que l'apercu 3D s'affiche correctement
// sur la page d'accueil, avant l'entree en realite mixte.
function ajusterTailleCanvas() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
ajusterTailleCanvas();
window.addEventListener('resize', ajusterTailleCanvas);

// --- Etat global --------------------------------------------------------
var anchor       = new THREE.Group();
var anchorPlaced = false;
var modeleCharge = false;
var racine       = null;   // gltf.scene : les positions enregistrees sont
                            // exprimees dans SON repere local (= repere du
                            // fichier .glb d'origine, independant de l'echelle
                            // et de la position sur la table).
var meshesModele = [];     // pour le raycast de placement/visee (toutes les pieces)

anchor.visible = false;
scene.add(anchor);

// --- Annulation (pile LIFO, partagee entre les deux etapes) -------------
var pileAnnulation = [];
function pousserAnnulation(fn) {
  pileAnnulation.push(fn);
  if (pileAnnulation.length > 50) pileAnnulation.shift();
}
function annulerDerniere() {
  if (!pileAnnulation.length) {
    if (etape === 'coloriage') majPanneauColoriage('Rien a annuler.');
    else majPanneau('Rien a annuler.');
    return;
  }
  pileAnnulation.pop()();
}

// --- Etapes : 'coloriage' (si classes.json est charge) puis 'liaisons' -
var etape = 'coloriage';

// --- Etape coloriage ----------------------------------------------------
var classesDef    = null;    // contenu de classes.json (ou null si absent/en erreur)
var piecesModele   = [];     // { nomBase, meshes:[...], couleur: hex|null }
var couleurActive  = null;   // hex de la couleur actuellement selectionnee dans la palette

// 12 couleurs (aucun gris : le gris est deja pris par l'etat "pas colorie").
var PALETTE = [
  { hex: 0xe6194b, nom: 'rouge' },
  { hex: 0xf58231, nom: 'orange' },
  { hex: 0xffe119, nom: 'jaune' },
  { hex: 0x3cb44b, nom: 'vert' },
  { hex: 0x42d4f4, nom: 'cyan' },
  { hex: 0x4363d8, nom: 'bleu' },
  { hex: 0x911eb4, nom: 'violet' },
  { hex: 0xf032e6, nom: 'magenta' },
  { hex: 0xff6bc0, nom: 'rose' },
  { hex: 0x9a6324, nom: 'marron' },
  { hex: 0xfa8072, nom: 'corail' },
  { hex: 0x469990, nom: 'turquoise' }
];

fetch('classes.json?v=' + Date.now())
  .then(function (r) { if (!r.ok) throw new Error('absent'); return r.json(); })
  .then(function (d) { classesDef = d; })
  .catch(function () { classesDef = null; });   // pas de coloriage : on passe direct aux liaisons

// Nom de base d'un noeud glTF : enleve le suffixe "_<...>" ajoute a l'export.
function baseName(nom) { return nom ? nom.split('_<')[0].split(' <')[0] : nom; }

// Normalise un mot pour le comparer aux id de classes.json : minuscules,
// espaces -> underscores, accents retires (ex: "bras superieur" -> "bras_superieur").
var ACCENTS = { 'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e', 'à': 'a', 'â': 'a', 'î': 'i', 'ï': 'i', 'ô': 'o', 'û': 'u', 'ù': 'u', 'ç': 'c' };
function normaliserToken(s) {
  return s.trim().toLowerCase().replace(/[éèêëàâîïôûùç]/g, function (c) { return ACCENTS[c]; }).replace(/\s+/g, '_');
}

// --- Liste des points a placer (liaisons A a H, confirmee et figee) -----
// Format : "LETTRE : cote1 / cote2" (ex: "C : chape / bras superieur").
// cotes[] sert a rattacher chaque point aux classes de classes.json, pour
// tracer ensuite la structure filaire de chaque solide colorie.
var points = [];   // { nom, lettre, cotes:[id,id], pos: THREE.Vector3|null, meshProche: string|null }
var courant = 0;

var LISTE_POINTS =
  'A : bati / bras superieur\n' +
  'B : bati / bras inferieur\n' +
  'C : chape / bras superieur\n' +
  'D : chape / bras inferieur\n' +
  'E : verin / bati\n' +
  'F : verin / levier\n' +
  'G : levier / bras superieur\n' +
  'H : charge / chape';

(function initListe() {
  LISTE_POINTS.split('\n').map(function (l) { return l.trim(); }).filter(Boolean)
    .forEach(function (nom) {
      var lettre = nom.split(':')[0].trim();
      var reste = nom.indexOf(':') >= 0 ? nom.slice(nom.indexOf(':') + 1) : nom;
      var cotes = reste.split('/').map(normaliserToken).filter(Boolean);
      points.push({ nom: nom, lettre: lettre, cotes: cotes, pos: null, meshProche: null });
    });
})();

// =====================================================================
//  PANNEAU (texture canvas), meme principe que app.js
// =====================================================================
// Le panneau d'instructions et la palette de couleurs sont regroupes dans
// UN SEUL objet (groupePanneaux), independant du systeme : attraper l'un
// ou l'autre au grip deplace les DEUX ensemble, sans jamais toucher au
// systeme (et attraper le systeme ne deplace jamais les panneaux).
var groupePanneaux = new THREE.Group();
scene.add(groupePanneaux);

var PW = 1024, PH = 880;
var pc = document.createElement('canvas'); pc.width = PW; pc.height = PH;
var px = pc.getContext('2d');
var ptex = new THREE.CanvasTexture(pc);
var panneau = new THREE.Mesh(
  new THREE.PlaneGeometry(0.60, 0.60 * PH / PW),
  new THREE.MeshBasicMaterial({ map: ptex, transparent: true })
);
panneau.visible = false;
groupePanneaux.add(panneau);

var boutons = [];
var curseursPanneau = [];

// --- Curseurs d'epaisseur (traits/points), affiches sur les panneaux des
// etapes 2 a 5 (pas le coloriage, qui n'a ni trait ni point). Reglage
// global, partage entre toutes les etapes. ------------------------------
var FACTEUR_EPAISSEUR_MIN = 0.15, FACTEUR_EPAISSEUR_MAX = 2.5;
var facteurTrait = 1, facteurPoint = 1;
var curseurActif = [null, null];   // par manette : null | curseur en cours de glissement

function curseur(x1, y1, x2, y2, min, max, valeur, label, onChange) {
  return { x1: x1, y1: y1, x2: x2, y2: y2, min: min, max: max, valeur: valeur, label: label, onChange: onChange };
}

function dessinerCurseur(c) {
  var yMid = (c.y1 + c.y2) / 2;
  px.strokeStyle = '#3a4a5a'; px.lineWidth = 6; px.lineCap = 'round';
  px.beginPath(); px.moveTo(c.x1, yMid); px.lineTo(c.x2, yMid); px.stroke();

  var t = (c.valeur - c.min) / (c.max - c.min);
  var xPoignee = c.x1 + t * (c.x2 - c.x1);
  px.fillStyle = '#00aeef';
  px.beginPath(); px.arc(xPoignee, yMid, 16, 0, Math.PI * 2); px.fill();

  px.fillStyle = '#cfd8e6';
  px.font = '24px sans-serif';
  px.textAlign = 'left'; px.textBaseline = 'bottom';
  px.fillText(c.label + '  ×' + c.valeur.toFixed(1), c.x1, c.y1 - 8);
  px.textAlign = 'left'; px.textBaseline = 'top';
}

// Redessine le panneau tel qu'il est actuellement affiche (ecran d'accueil
// d'une etape ou ecran de resultat/validation), pour faire apparaitre la
// nouvelle valeur/poignee d'un curseur qu'on est en train de glisser, sans
// changer d'ecran. dessinerPanneau garde en memoire son dernier appel pour
// ca (voir plus bas) : on ne peut demarrer un glissement que depuis un
// panneau qui affiche deja des curseurs, donc pas besoin de re-verifier ici.
function redessinerPanneauActif() {
  if (!dernierConfigPanneau) return;
  // Ne rajoute des curseurs que si l'ecran en affichait deja (ex: pas sur
  // l'ecran de coloriage ou un ecran d'aide).
  if (dernierConfigPanneau.curseurs) dernierConfigPanneau.curseurs = curseursEpaisseurStandard();
  dessinerPanneau(dernierConfigPanneau);
}

function onChangeFacteurTrait(v) { facteurTrait = v; rafraichirEpaisseurs(); redessinerPanneauActif(); }
function onChangeFacteurPoint(v) { facteurPoint = v; rafraichirEpaisseurs(); redessinerPanneauActif(); }

// Meme emplacement sur tous les panneaux des etapes 2 a 5 : sous les
// boutons (qui s'arretent a y=650), en bas du panneau. Marge large entre
// les boutons et le 1er curseur, et entre les 2 curseurs : le libelle
// (dessine au-dessus de la piste, voir dessinerCurseur) a besoin de place
// sans chevaucher ce qui est au-dessus.
function curseursEpaisseurStandard() {
  return [
    curseur(44, 712, PW - 44, 732, FACTEUR_EPAISSEUR_MIN, FACTEUR_EPAISSEUR_MAX, facteurTrait, 'Épaisseur des traits', onChangeFacteurTrait),
    curseur(44, 812, PW - 44, 832, FACTEUR_EPAISSEUR_MIN, FACTEUR_EPAISSEUR_MAX, facteurPoint, 'Taille des points', onChangeFacteurPoint)
  ];
}

// Repercute facteurTrait/facteurPoint sur tout ce qui est deja affiche, en
// pokant directement les echelles des objets existants (voir plus bas :
// pas de reconstruction). Les CREATIONS futures (nouveau point, nouvelle
// droite...) reprennent le facteur courant toutes seules, voir majMarqueur/
// creerBarre/creerLigneDeplacable : le rayon de base est fige dans la
// geometrie, seul le facteur passe par scale.x/z (ou scale uniforme pour
// les points), jamais touche ailleurs, donc sans risque d'interference.
function rafraichirEpaisseurs() {
  // Poke direct des echelles deja en place (pas de reconstruction : appelee
  // a chaque frame pendant un glissement de curseur, rafraichirTousMarqueurs
  // /majProjectionEtFilaire recreeraient etiquettes/geometries a chaque
  // fois, bien trop couteux a cette frequence).
  marqueurs.forEach(function (m) {
    if (!m) return;
    m.sphere.scale.setScalar(facteurPoint);
    // Repositionne l'etiquette (juste sa position, pas de recreation de
    // texture) pour qu'elle reste au-dessus du point meme pendant le
    // glissement du curseur, sans le cout d'une reconstruction complete.
    m.etiquette.position.copy(m.sphere.position).add(new THREE.Vector3(0, RAYON_MARQUEUR_POINT * facteurPoint + 0.016, 0));
  });
  groupeFilaire.children.forEach(function (barre) { barre.scale.x = barre.scale.z = facteurTrait; });

  [guideBD, guideCConcours, guideFG, guideAConcours].forEach(function (m) { if (m) { m.scale.x = m.scale.z = facteurTrait; } });
  [traceD, traceC, traceG, traceA].forEach(function (t) { if (t) { t.fleche.scale.x = t.fleche.scale.z = facteurTrait; } });
  [traceForce, traceEffortD, traceEffortC, traceEffortG, traceEffortA].forEach(function (t) {
    if (t) { t.fleche.userData.corps.scale.x = t.fleche.userData.corps.scale.z = facteurTrait;
             t.fleche.userData.tete.scale.x  = t.fleche.userData.tete.scale.z  = facteurTrait; }
  });
  [flecheSolutionForce, flechePTriangle, flecheCorrigeD, flecheCorrigeC,
   flecheReactionC, flecheCorrigeG, flecheCorrigeA].forEach(function (f) {
    if (f) { f.userData.corps.scale.x = f.userData.corps.scale.z = facteurTrait;
             f.userData.tete.scale.x  = f.userData.tete.scale.z  = facteurTrait; }
  });
  if (ligneD) { ligneD.mesh.scale.x = ligneD.mesh.scale.z = facteurTrait; ligneD.poignee.scale.setScalar(facteurPoint); }
  if (ligneC) { ligneC.mesh.scale.x = ligneC.mesh.scale.z = facteurTrait; ligneC.poignee.scale.setScalar(facteurPoint); }
  if (ligneG) { ligneG.mesh.scale.x = ligneG.mesh.scale.z = facteurTrait; ligneG.poignee.scale.setScalar(facteurPoint); }
  if (ligneA) { ligneA.mesh.scale.x = ligneA.mesh.scale.z = facteurTrait; ligneA.poignee.scale.setScalar(facteurPoint); }

  if (marqueurConcours) marqueurConcours.scale.setScalar(facteurPoint);
  if (marqueurSommet) marqueurSommet.scale.setScalar(facteurPoint);
  if (marqueurConcoursBrasSup) marqueurConcoursBrasSup.scale.setScalar(facteurPoint);
  if (marqueurSommetBrasSup) marqueurSommetBrasSup.scale.setScalar(facteurPoint);

  // Etape 8 (bilan) : mêmes pokes, sauf sur un objet en cours d'animation
  // (sa propre progression pilote deja son echelle, voir animationBilan).
  var enAnimation = animationBilan ? animationBilan.objets.map(function (o) { return o.mesh; }) : [];
  [bilanGuideBD, bilanGuideCConcours, bilanGuideFG, bilanGuideAConcours].forEach(function (m) {
    if (m && enAnimation.indexOf(m) < 0) { m.scale.x = m.scale.z = facteurTrait; }
  });
  [bilanFlecheP, bilanFlecheEffortD, bilanFlecheEffortC, bilanFlecheEffortG, bilanFlecheEffortA].forEach(function (f) {
    if (f && enAnimation.indexOf(f) < 0) {
      f.userData.corps.scale.x = f.userData.corps.scale.z = facteurTrait;
      f.userData.tete.scale.x  = f.userData.tete.scale.z  = facteurTrait;
    }
  });
  [bilanMarqueurConcours, bilanMarqueurConcoursBS].forEach(function (m) {
    if (m && enAnimation.indexOf(m) < 0) { m.scale.setScalar(facteurPoint); }
  });
}

function coinsArrondis(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y,     x + w, y + h, r);
  c.arcTo(x + w, y + h, x,     y + h, r);
  c.arcTo(x,     y + h, x,     y,     r);
  c.arcTo(x,     y,     x + w, y,     r);
  c.closePath();
}

function couper(c, texte, maxW) {
  var sortie = [];
  texte.split('\n').forEach(function (paragraphe) {
    if (paragraphe === '') { sortie.push(''); return; }
    var mots = paragraphe.split(' ');
    var ligne = '';
    mots.forEach(function (mot) {
      var essai = ligne ? ligne + ' ' + mot : mot;
      if (c.measureText(essai).width > maxW && ligne) { sortie.push(ligne); ligne = mot; }
      else ligne = essai;
    });
    if (ligne) sortie.push(ligne);
  });
  return sortie;
}

// --- Petites icones tracees au trait (pas d'emoji : rendu fiable sur toute
// police/plateforme dans une texture canvas). ----------------------------
function dessinerCoche(cx, cy, taille, couleur) {
  px.strokeStyle = couleur; px.lineWidth = taille * 0.16;
  px.lineCap = 'round'; px.lineJoin = 'round';
  px.beginPath();
  px.moveTo(cx - taille * 0.45, cy + taille * 0.02);
  px.lineTo(cx - taille * 0.12, cy + taille * 0.32);
  px.lineTo(cx + taille * 0.45, cy - taille * 0.32);
  px.stroke();
}
function dessinerCroix(cx, cy, taille, couleur) {
  px.strokeStyle = couleur; px.lineWidth = taille * 0.16; px.lineCap = 'round';
  px.beginPath();
  px.moveTo(cx - taille * 0.32, cy - taille * 0.32); px.lineTo(cx + taille * 0.32, cy + taille * 0.32);
  px.moveTo(cx + taille * 0.32, cy - taille * 0.32); px.lineTo(cx - taille * 0.32, cy + taille * 0.32);
  px.stroke();
}
function dessinerIconeMaison(cx, cy, taille, couleur) {
  px.strokeStyle = couleur; px.lineWidth = taille * 0.13;
  px.lineCap = 'round'; px.lineJoin = 'round';
  px.beginPath();
  px.moveTo(cx - taille * 0.5, cy + taille * 0.06);
  px.lineTo(cx, cy - taille * 0.42);
  px.lineTo(cx + taille * 0.5, cy + taille * 0.06);
  px.stroke();
  px.strokeRect(cx - taille * 0.32, cy + taille * 0.04, taille * 0.64, taille * 0.46);
}

// Quitte la session de realite mixte (retour a la page d'accueil 2D) :
// bouton ACCUEIL present sur tous les panneaux. Reentrer en VR ensuite
// relance l'exercice depuis le debut (choix assume, voir echange avec
// l'utilisateur) : aucune sauvegarde de progression n'existe.
function retourAccueil() {
  var session = renderer.xr.getSession();
  if (session) session.end();
}

// =====================================================================
//  PANNEAU : systeme unifie (config objet), commun aux 4 types d'ecran
//  (question, aide, reponse, action). Chaque ecran passe un sous-ensemble
//  de ces champs :
//   - eyebrow    : "Étape 3 — Isolement de la chape" (numero + nom d'etape)
//   - titre      : nom de la question/sous-etape en cours
//   - sousTitre  : ligne secondaire optionnelle (ex. progression)
//   - statut     : { ok:bool, titre, detail } -> badge juste/faux (ecran reponse)
//   - corps      : texte principal (question, aide, recap...)
//   - aide       : function ou null -> si presente, affiche un lien
//                  "Besoin d'aide ?" qui l'appelle au clic
//   - boutons    : grille de boutons (voir bouton()/boutonLarge())
//   - curseurs   : curseurs d'epaisseur (voir curseursEpaisseurStandard())
//   - accueil    : false pour masquer la pastille ACCUEIL (par defaut visible)
// =====================================================================
var dernierConfigPanneau = null;

function dessinerPanneau(cfg) {
  dernierConfigPanneau = cfg;
  boutons = (cfg.boutons || []).slice();
  curseursPanneau = cfg.curseurs || [];

  px.clearRect(0, 0, PW, PH);
  px.fillStyle = 'rgba(12,14,20,0.94)';
  coinsArrondis(px, 0, 0, PW, PH, 36); px.fill();
  px.strokeStyle = '#00aeef'; px.lineWidth = 4;
  coinsArrondis(px, 2, 2, PW - 4, PH - 4, 36); px.stroke();

  var afficherAccueil = cfg.accueil !== false;
  if (afficherAccueil) {
    var pa = { x1: PW - 216, y1: 30, x2: PW - 40, y2: 74 };
    px.fillStyle = 'rgba(255,255,255,0.07)';
    coinsArrondis(px, pa.x1, pa.y1, pa.x2 - pa.x1, pa.y2 - pa.y1, 22); px.fill();
    px.strokeStyle = 'rgba(255,255,255,0.18)'; px.lineWidth = 1.5;
    coinsArrondis(px, pa.x1, pa.y1, pa.x2 - pa.x1, pa.y2 - pa.y1, 22); px.stroke();
    dessinerIconeMaison(pa.x1 + 26, (pa.y1 + pa.y2) / 2, 20, '#9fb3c4');
    px.fillStyle = '#9fb3c4';
    px.font = 'bold 18px sans-serif';
    px.textAlign = 'left'; px.textBaseline = 'middle';
    px.fillText('ACCUEIL', pa.x1 + 46, (pa.y1 + pa.y2) / 2 + 1);
    boutons.push({ x1: pa.x1, y1: pa.y1, x2: pa.x2, y2: pa.y2, texte: '', couleur: '', action: retourAccueil });
  }

  var y = 34;
  var largeurHaut = PW - 88 - (afficherAccueil ? 200 : 0);

  px.textAlign = 'left'; px.textBaseline = 'top';
  if (cfg.eyebrow) {
    px.fillStyle = '#00aeef';
    px.font = 'bold 21px sans-serif';
    couper(px, cfg.eyebrow, largeurHaut).forEach(function (l) { px.fillText(l, 44, y); y += 27; });
    y += 6;
  }
  if (cfg.titre) {
    px.fillStyle = '#eef3f8';
    px.font = 'bold 36px sans-serif';
    couper(px, cfg.titre, largeurHaut).forEach(function (l) { px.fillText(l, 44, y); y += 42; });
  }
  if (cfg.sousTitre) {
    px.fillStyle = '#8fa3b8';
    px.font = '20px sans-serif';
    px.fillText(cfg.sousTitre, 44, y + 4);
    y += 30;
  }
  y += 16;
  px.strokeStyle = 'rgba(255,255,255,0.09)'; px.lineWidth = 2;
  px.beginPath(); px.moveTo(44, y); px.lineTo(PW - 44, y); px.stroke();
  y += 28;

  if (cfg.statut) {
    var cx = 44 + 30, cy = y + 28, rB = 30;
    px.fillStyle = cfg.statut.ok ? 'rgba(61,220,132,0.14)' : 'rgba(255,106,106,0.14)';
    px.beginPath(); px.arc(cx, cy, rB, 0, Math.PI * 2); px.fill();
    px.strokeStyle = cfg.statut.ok ? '#3ddc84' : '#ff6a6a'; px.lineWidth = 2.5;
    px.beginPath(); px.arc(cx, cy, rB, 0, Math.PI * 2); px.stroke();
    if (cfg.statut.ok) dessinerCoche(cx, cy, 26, '#3ddc84'); else dessinerCroix(cx, cy, 26, '#ff6a6a');

    px.fillStyle = cfg.statut.ok ? '#3ddc84' : '#ff6a6a';
    px.font = 'bold 23px sans-serif';
    px.fillText(cfg.statut.titre, 44 + 76, y + 4);
    if (cfg.statut.detail) {
      px.fillStyle = '#8fa3b8';
      px.font = '18px sans-serif';
      px.fillText(cfg.statut.detail, 44 + 76, y + 34);
    }
    y += 82;
  }

  px.font = '27px sans-serif';
  (cfg.corps || []).forEach(function (item) {
    var txt     = (typeof item === 'string') ? item : item.texte;
    var couleur = (typeof item === 'string') ? '#e8e8e8' : item.couleur;
    px.fillStyle = couleur;
    couper(px, txt, PW - 88).forEach(function (l) {
      if (y < 430) { px.fillText(l, 44, y); y += 33; }
    });
  });

  if (cfg.aide) {
    var la = { x1: 44, y1: 452, x2: 44 + 280, y2: 452 + 36 };
    px.fillStyle = 'rgba(58,198,246,0.12)';
    coinsArrondis(px, la.x1, la.y1, la.x2 - la.x1, la.y2 - la.y1, 18); px.fill();
    px.strokeStyle = 'rgba(58,198,246,0.4)'; px.lineWidth = 1.5;
    coinsArrondis(px, la.x1, la.y1, la.x2 - la.x1, la.y2 - la.y1, 18); px.stroke();
    px.fillStyle = '#8fe0ff';
    px.font = 'bold 18px sans-serif';
    px.textAlign = 'left'; px.textBaseline = 'middle';
    px.fillText('?  Besoin d’aide ?', la.x1 + 18, (la.y1 + la.y2) / 2 + 1);
    boutons.push({ x1: la.x1, y1: la.y1, x2: la.x2, y2: la.y2, texte: '', couleur: '', action: cfg.aide });
  }

  px.textAlign = 'center'; px.textBaseline = 'middle';
  (cfg.boutons || []).forEach(function (b) {
    px.fillStyle = b.couleur;
    coinsArrondis(px, b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1, 16); px.fill();
    px.fillStyle = '#fff';
    px.font = 'bold 22px sans-serif';
    var lignesBouton = couper(px, b.texte, b.x2 - b.x1 - 24);
    var yBase = (b.y1 + b.y2) / 2 - (lignesBouton.length - 1) * 13;
    lignesBouton.forEach(function (l, i) { px.fillText(l, (b.x1 + b.x2) / 2, yBase + i * 26); });
  });
  px.textAlign = 'left'; px.textBaseline = 'top';

  curseursPanneau.forEach(dessinerCurseur);

  ptex.needsUpdate = true;
}

// Grille de boutons : ligne 0 ou 1, colonne 0 a 2.
function emplacement(ligne, col) {
  var larg = 290, marge = 44, ecart = 37;
  var y1 = 480 + ligne * 100, y2 = y1 + 70;
  return { x1: marge + col * (larg + ecart), y1: y1, x2: marge + col * (larg + ecart) + larg, y2: y2 };
}
function bouton(ligne, col, texte, couleur, action) {
  var e = emplacement(ligne, col);
  return { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, texte: texte, couleur: couleur, action: action };
}
// Bouton pleine largeur (une ligne entiere de la grille) : pour un libelle
// long (ex. "REVENIR À LA QUESTION PRÉCÉDENTE") ou une action mise en avant.
function boutonLarge(ligne, texte, couleur, action) {
  var marge = 44;
  var y1 = 480 + ligne * 100, y2 = y1 + 70;
  return { x1: marge, y1: y1, x2: PW - marge, y2: y2, texte: texte, couleur: couleur, action: action };
}

// =====================================================================
//  CHARGEMENT DU MODELE
// =====================================================================
var loader = new THREE.GLTFLoader();

function ajusterTaille(objet, cible) {
  var box = new THREE.Box3().setFromObject(objet);
  var t = new THREE.Vector3(); box.getSize(t);
  var m = Math.max(t.x, t.y, t.z);
  if (m > 0) objet.scale.setScalar(cible / m);
  return m > 0 ? cible / m : 1;
}

var COULEUR_NEUTRE = 0x9aa4b5;   // gris : piece pas encore coloriee

// Regroupe les meshes par sous-ensemble de premier niveau (chaque piece
// physique du cric), avec un materiau CLONE par piece pour pouvoir la
// peindre independamment des autres.
function construirePieces() {
  piecesModele = [];
  var racineSousEns = racine.children[0] && racine.children[0].children.length
    ? racine.children[0].children : racine.children;

  racineSousEns.forEach(function (noeud) {
    var meshes = [];
    noeud.traverse(function (n) {
      if (!n.isMesh) return;
      n.material = new THREE.MeshStandardMaterial({ color: COULEUR_NEUTRE, metalness: 0.15, roughness: 0.7 });
      meshes.push(n);
    });
    if (!meshes.length) return;
    var idx = piecesModele.length;
    meshes.forEach(function (m) { m.userData.piece = idx; });
    piecesModele.push({ nomBase: baseName(noeud.name), noeud: noeud, meshes: meshes, couleur: null });
  });
}

function demarrerEtape() {
  if (classesDef && classesDef.classes && classesDef.classes.length) passerEnColoriage();
  else passerEnPlacement();
}

// Charge le modele une seule fois, des l'arrivee sur la page d'accueil (pas
// besoin d'etre en VR) : il sert tout de suite d'apercu qui tourne devant
// l'utilisateur (voir la rotation dans la boucle de rendu). Si la session VR
// a deja demarre au moment ou le chargement se termine (reseau lent), on
// enchaine directement sur le placement devant l'utilisateur.
var sessionEnCours = false;

function chargerModeleUnique() {
  if (modeleCharge || racine) return;
  loader.load(MODELE, function (gltf) {
    racine = gltf.scene;
    ajusterTaille(racine, TAILLE_MODELE);
    anchor.add(racine);
    racine.position.set(0, 0.01, 0);
    racine.updateMatrixWorld(true);

    construirePieces();
    meshesModele = [];
    piecesModele.forEach(function (p) { meshesModele = meshesModele.concat(p.meshes); });
    calculerPlanMedian();

    // Position d'apercu sur la page d'accueil : devant la camera par defaut.
    anchor.position.set(0, -0.05, -0.9);
    anchor.quaternion.identity();

    modeleCharge = true;
    anchor.visible = true;

    if (sessionEnCours) placerSystemeDevantUtilisateur();
  }, undefined, function (e) { erreur('Erreur GLB : ' + e); });
}
chargerModeleUnique();   // des le chargement de la page, pour l'apercu

// Repositionne le systeme devant l'utilisateur au moment ou il entre en
// realite mixte (pas de mode de placement separe) : il suffit ensuite de
// l'attraper au grip pour le repositionner ou le tourner comme on veut, a
// tout moment (voir squeezestart/squeezeend).
function placerSystemeDevantUtilisateur() {
  // Position de depart : devant l'utilisateur, orientation neutre
  // (Y vertical) pour ne pas apparaitre incline si le regard est baisse.
  var pCam = new THREE.Vector3(), qCam = new THREE.Quaternion();
  camera.getWorldPosition(pCam);
  camera.getWorldQuaternion(qCam);
  anchor.position.copy(pCam).add(new THREE.Vector3(0, -0.15, -0.6).applyQuaternion(qCam));
  anchor.quaternion.identity();

  // Le groupe de panneaux demarre pres du systeme, mais n'est plus jamais
  // repositionne automatiquement ensuite (seul le grip le deplace).
  groupePanneaux.position.copy(anchor.position).add(new THREE.Vector3(0, 0.55, 0));

  anchorPlaced = true;
  demarrerEtape();
}

// =====================================================================
//  PLAN MEDIAN (etude plane) + STRUCTURE FILAIRE
//
//  Le cric est symetrique par rapport a un plan : on le retrouve a partir
//  d'une paire de pieces jumelles connues (Bras_inferieur, present 2 fois
//  de part et d'autre), leur milieu donne un point du plan de symetrie.
//  La normale du plan est l'axe Z local du modele (etabli par mesure :
//  toutes les pieces jumelles ne different que par leur coordonnee Z).
// =====================================================================
var medianZ_local = null;   // coordonnee Z (repere local de racine) du plan de symetrie

function calculerPlanMedian() {
  var paire = piecesModele.filter(function (p) { return p.nomBase === 'Bras_inférieur'; });
  if (paire.length !== 2) { erreur('Plan median : paire "Bras_inferieur" introuvable (symetrie non calculee).'); return; }
  var a = new THREE.Vector3(), b = new THREE.Vector3();
  paire[0].noeud.getWorldPosition(a);
  paire[1].noeud.getWorldPosition(b);
  racine.worldToLocal(a); racine.worldToLocal(b);
  medianZ_local = (a.z + b.z) / 2;
}

// Projette un point du repere local de racine sur le plan median : dans ce
// repere le plan est simplement "z = medianZ_local" (voir calculerPlanMedian),
// pas besoin de maths de plan generales.
function projeterLocal(pLocalRacine) {
  return new THREE.Vector3(pLocalRacine.x, pLocalRacine.y, medianZ_local);
}

// Convertit un point du repere local de racine vers le repere local de
// l'ancre : racine.matrix encode sa position/echelle DANS l'ancre, fixees
// une fois pour toutes au chargement (jamais modifiees ensuite), donc cette
// conversion reste valable meme si l'ancre est ensuite deplacee/tournee/
// zoomee. Les marqueurs et le filaire sont enfants de l'ancre (et non de
// racine, qui porte l'echelle "ajusterTaille" du modele) pour garder une
// taille de trait/etiquette stable independamment de cette echelle interne.
function versAncre(pLocalRacine) {
  return pLocalRacine.clone().applyMatrix4(racine.matrix);
}

// --- Affichage : structure filaire par solide, enfant de l'ancre pour
// suivre le systeme quand on le deplace/tourne/zoome au grip. ------------
var groupeFilaire = new THREE.Group();
anchor.add(groupeFilaire);

function viderGroupe(g) {
  while (g.children.length) {
    var c = g.children.pop();
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
  }
}

// Barre 3D entre deux points (meme repere que le groupe qui la reçoit) :
// un cylindre, pas une THREE.Line, dont le "linewidth" n'est pas respecte
// par la plupart des GPU.
var RAYON_FILAIRE = 0.0022;
function creerBarre(p1, p2, couleur, rayon) {
  var longueur = p1.distanceTo(p2);
  if (longueur < 1e-5) return null;
  var barre = new THREE.Mesh(
    new THREE.CylinderGeometry(rayon, rayon, longueur, 10),
    new THREE.MeshBasicMaterial({ color: couleur, depthTest: false })
  );
  barre.position.copy(p1).lerp(p2, 0.5);
  barre.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p2.clone().sub(p1).normalize());
  barre.scale.x = barre.scale.z = facteurTrait;
  barre.renderOrder = 880;
  return barre;
}

// Reconstruit la structure filaire a partir des points actuellement places
// (deja affiches sur leur projection par majMarqueur). Appelee a chaque
// point pose et a chaque changement de couleur (le filaire reprend la
// couleur de chaque solide).
function majProjectionEtFilaire() {
  viderGroupe(groupeFilaire);
  if (medianZ_local === null || !racine) return;

  var projAncre = {};   // lettre -> Vector3 (position projetee, repere ANCRE)
  points.forEach(function (pt) {
    if (!pt.pos) return;
    projAncre[pt.lettre] = versAncre(projeterLocal(pt.pos));
  });

  // Pour chaque solide deja colorie de façon homogene, relier (par des
  // segments deux a deux) tous ses points projetes : une pièce a 2 points
  // devient une barre, une pièce a 3 points un triangle, etc.
  if (classesDef && classesDef.classes) {
    classesDef.classes.forEach(function (c) {
      var couleur = couleurDeClasse(c.id);
      if (couleur === null) return;

      var lettres = points.filter(function (pt) {
        return pt.pos && pt.cotes.indexOf(c.id) >= 0;
      }).map(function (pt) { return pt.lettre; });

      for (var i = 0; i < lettres.length; i++) {
        for (var j = i + 1; j < lettres.length; j++) {
          var barre = creerBarre(projAncre[lettres[i]], projAncre[lettres[j]], couleur, RAYON_FILAIRE);
          if (barre) groupeFilaire.add(barre);
        }
      }
    });
  }
}

// =====================================================================
//  ETAPE 1 : COLORIAGE (classes d'equivalence cinematique)
//
//  Correction PAR EQUIVALENCE : la couleur exacte choisie n'a pas
//  d'importance, seul le regroupement compte (memes pieces = meme
//  couleur, pieces d'un autre solide = couleur differente).
// =====================================================================

// --- Petit panneau-palette, a part du panneau principal -----------------
// 2 rangees de 6 couleurs.
var PPW = 1024, PPH = 420;
var ppc = document.createElement('canvas'); ppc.width = PPW; ppc.height = PPH;
var ppx = ppc.getContext('2d');
var pptex = new THREE.CanvasTexture(ppc);
var panneauPalette = new THREE.Mesh(
  new THREE.PlaneGeometry(0.60, 0.60 * PPH / PPW),
  new THREE.MeshBasicMaterial({ map: pptex, transparent: true })
);
panneauPalette.visible = false;
panneauPalette.position.set(0, -0.40, 0);   // sous le panneau principal, dans le meme groupe
groupePanneaux.add(panneauPalette);

var boutonsPalette = [];
var PALETTE_COLS = 6;

function dessinerPalette() {
  boutonsPalette = [];
  ppx.clearRect(0, 0, PPW, PPH);
  ppx.fillStyle = 'rgba(12,14,20,0.94)';
  coinsArrondis(ppx, 0, 0, PPW, PPH, 24); ppx.fill();
  ppx.strokeStyle = '#00aeef'; ppx.lineWidth = 3;
  coinsArrondis(ppx, 2, 2, PPW - 4, PPH - 4, 24); ppx.stroke();

  ppx.fillStyle = '#cfd8e6';
  ppx.font = '24px sans-serif';
  ppx.textAlign = 'left'; ppx.textBaseline = 'top';
  ppx.fillText('Couleur active :', 36, 24);

  var cols = PALETTE_COLS, marge = 36, taille = 140,
      ecart = (PPW - 2 * marge - cols * taille) / (cols - 1);
  PALETTE.forEach(function (c, i) {
    var col = i % cols, ligne = Math.floor(i / cols);
    var x = marge + col * (taille + ecart), y = 64 + ligne * (taille + 30);
    ppx.fillStyle = '#' + c.hex.toString(16).padStart(6, '0');
    coinsArrondis(ppx, x, y, taille, taille, 14); ppx.fill();
    if (couleurActive === c.hex) {
      ppx.strokeStyle = '#ffffff'; ppx.lineWidth = 6;
      coinsArrondis(ppx, x - 4, y - 4, taille + 8, taille + 8, 16); ppx.stroke();
    }
    boutonsPalette.push({ x1: x, y1: y, x2: x + taille, y2: y + taille, action: (function (hex) {
      return function () { selectionnerCouleur(hex); };
    })(c.hex) });
  });

  pptex.needsUpdate = true;
}

function selectionnerCouleur(hex) {
  couleurActive = hex;
  dessinerPalette();
  majPanneauColoriage(null);
}

function peindrePiece(idx) {
  if (couleurActive === null) { majPanneauColoriage('Choisis d\'abord une couleur dans la palette, en bas.'); return; }
  var piece = piecesModele[idx];
  var ancienneCouleur = piece.couleur;
  pousserAnnulation(function () {
    piece.couleur = ancienneCouleur;
    piece.meshes.forEach(function (m) { m.material.color.setHex(ancienneCouleur === null ? COULEUR_NEUTRE : ancienneCouleur); });
    majPanneauColoriage(null);
    majProjectionEtFilaire();
  });
  piece.couleur = couleurActive;
  piece.meshes.forEach(function (m) { m.material.color.setHex(couleurActive); });
  majPanneauColoriage(null);
  majProjectionEtFilaire();
}

function nbPiecesColoriees() { return piecesModele.filter(function (p) { return p.couleur !== null; }).length; }

function effacerColoriageTout() {
  var etatPrecedent = piecesModele.map(function (p) { return p.couleur; });
  pousserAnnulation(function () {
    piecesModele.forEach(function (p, i) {
      p.couleur = etatPrecedent[i];
      p.meshes.forEach(function (m) { m.material.color.setHex(etatPrecedent[i] === null ? COULEUR_NEUTRE : etatPrecedent[i]); });
    });
    majPanneauColoriage(null);
    majProjectionEtFilaire();
  });
  piecesModele.forEach(function (p) { p.couleur = null; p.meshes.forEach(function (m) { m.material.color.setHex(COULEUR_NEUTRE); }); });
  majPanneauColoriage(null);
  majProjectionEtFilaire();
}

// Compare le regroupement de l'etudiant a classes.json, par equivalence :
// peu importe la couleur exacte, seul le regroupement compte.
// nomBase de piece -> id de classe (classes.json). Partagee par la
// correction du coloriage et le trace de la structure filaire.
function mappeClasseAttendue() {
  var m = {};
  classesDef.classes.forEach(function (c) { c.pieces.forEach(function (nb) { m[nb] = c.id; }); });
  return m;
}

// Couleur (hex) d'une classe si toutes ses pieces sont coloriees a
// l'identique, sinon null (coloriage incomplet ou heterogene).
function couleurDeClasse(id) {
  var classeAttendue = mappeClasseAttendue();
  var membres = piecesModele.filter(function (p) { return classeAttendue[p.nomBase] === id; });
  if (!membres.length) return null;
  var c0 = membres[0].couleur;
  if (c0 === null) return null;
  return membres.every(function (m) { return m.couleur === c0; }) ? c0 : null;
}

function evaluerColoriage() {
  var classeAttendue = mappeClasseAttendue();

  var parClasse = {};   // id classe -> liste des couleurs (ou null) de ses pieces
  piecesModele.forEach(function (p) {
    var cid = classeAttendue[p.nomBase];
    if (!cid) return;   // piece non repertoriee dans classes.json : ignoree
    (parClasse[cid] = parClasse[cid] || []).push(p.couleur);
  });

  var idsClasses = Object.keys(parClasse);
  var monochrome = {};   // id -> couleur commune, ou null si incomplet/heterogene
  idsClasses.forEach(function (id) {
    var couleurs = parClasse[id];
    var toutesColoriees = couleurs.every(function (c) { return c !== null; });
    var identiques = toutesColoriees && couleurs.every(function (c) { return c === couleurs[0]; });
    monochrome[id] = identiques ? couleurs[0] : null;
  });

  var parCouleur = {};   // couleur -> classes qui l'utilisent (en monochrome)
  idsClasses.forEach(function (id) {
    if (monochrome[id] === null) return;
    (parCouleur[monochrome[id]] = parCouleur[monochrome[id]] || []).push(id);
  });

  function nomClasse(id) { return classesDef.classes.filter(function (c) { return c.id === id; })[0].nom; }

  var classesOK = [], problemes = [];
  idsClasses.forEach(function (id) {
    if (monochrome[id] === null) {
      var incomplet = parClasse[id].some(function (c) { return c === null; });
      problemes.push(nomClasse(id) + (incomplet
        ? ' : il manque encore des pieces a colorier.'
        : ' : plusieurs couleurs differentes dans ce solide, elles devraient etre identiques.'));
    } else if (parCouleur[monochrome[id]].length > 1) {
      var autres = parCouleur[monochrome[id]].filter(function (x) { return x !== id; }).map(nomClasse);
      problemes.push(nomClasse(id) + ' a la meme couleur que ' + autres.join(', ') + ', alors que ce sont des solides differents.');
    } else {
      classesOK.push(nomClasse(id));
    }
  });

  return { total: idsClasses.length, ok: classesOK.length, problemes: problemes };
}

var EYEBROW_COLORIAGE = 'Étape 1 — Recherche des classes d’équivalence';

// Sauter la question fait passer par le meme ecran "juste" que reussir
// vraiment (le coloriage est corrige avant l'appel) : ce drapeau permet
// de quand meme noter 'saute' plutot que 'parfait' cote competence.
var coloriageFutSaute = false;

function validerColoriage() {
  var r = evaluerColoriage();
  var juste = r.ok === r.total;
  var corps = [
    { texte: r.ok + ' / ' + r.total + ' solides correctement regroupes.', couleur: juste ? '#3ddc84' : '#ffb020' }
  ];
  r.problemes.slice(0, 4).forEach(function (p) { corps.push({ texte: '• ' + p, couleur: '#ff9f4a' }); });

  if (juste) {
    noterResultat('coloriage', coloriageFutSaute ? 'saute' : undefined);
  } else {
    noterEchec('coloriage');
  }
  coloriageFutSaute = false;

  dessinerPanneau({
    eyebrow: EYEBROW_COLORIAGE,
    titre: 'Réponse',
    statut: juste
      ? { ok: true, titre: 'Regroupement correct' }
      : { ok: false, titre: 'Pas encore juste', detail: (r.total - r.ok) + ' solide(s) a corriger' },
    corps: corps,
    boutons: juste ? [
      bouton(0, 0, 'RECOLORIER', '#3a5f8a', function () { majPanneauColoriage(null); }),
      bouton(0, 1, 'CONTINUER',  '#2f7d4f', passerEnPlacement)
    ] : [
      bouton(0, 0, 'RÉESSAYER',       '#2f7d4f', function () { majPanneauColoriage(null); }),
      bouton(0, 1, 'VOIR LE CORRIGÉ', '#3a5f8a', function () { noterResultat('coloriage', 'aide'); appliquerCorrigeColoriage(); passerEnPlacement(); })
    ]
  });
}

// Applique directement le bon regroupement (une couleur par classe
// d'equivalence) : utilise pour "sauter" la question (voir sauterColoriage)
// et pour VOIR LE CORRIGÉ depuis l'ecran de reponse fausse.
function appliquerCorrigeColoriage() {
  var classeAttendue = mappeClasseAttendue();
  var couleurParClasse = {};
  classesDef.classes.forEach(function (c, i) { couleurParClasse[c.id] = PALETTE[i % PALETTE.length].hex; });
  piecesModele.forEach(function (p) {
    var cid = classeAttendue[p.nomBase];
    if (!cid) return;
    p.couleur = couleurParClasse[cid];
    p.meshes.forEach(function (m) { m.material.color.setHex(p.couleur); });
  });
  majProjectionEtFilaire();
}

function sauterColoriage() {
  coloriageFutSaute = true;
  appliquerCorrigeColoriage();
  validerColoriage();
}

function afficherAideColoriage() {
  dessinerPanneau({
    eyebrow: EYEBROW_COLORIAGE,
    titre: 'Aide',
    corps: [
      'Deux pieces appartiennent a la meme classe si elles ne bougent JAMAIS l\'une par rapport a l\'autre, quel que soit le mouvement du cric.',
      '',
      { texte: 'Ex. : si tu imagines bouger une piece a la main, est-ce qu\'une autre la suit exactement ? Si oui, meme couleur.', couleur: '#9fd0ff' }
    ],
    boutons: [ boutonLarge(0, 'RETOUR À LA QUESTION', '#2f7d4f', function () { majPanneauColoriage(null); }) ]
  });
}

function majPanneauColoriage(message) {
  var corps = [ classesDef.consigne, '',
    { texte: 'Pieces coloriees : ' + nbPiecesColoriees() + ' / ' + piecesModele.length, couleur: '#9fd0ff' }
  ];
  if (message) corps.push({ texte: message, couleur: '#ff9f4a' });

  dessinerPanneau({
    eyebrow: EYEBROW_COLORIAGE,
    titre: 'Question',
    corps: corps,
    aide: afficherAideColoriage,
    boutons: [
      bouton(0, 0, 'VALIDER',      '#2f7d4f', validerColoriage),
      bouton(0, 1, 'TOUT EFFACER', '#7d4f2f', effacerColoriageTout),
      bouton(1, 0, 'ANNULER',      '#3a5f8a', annulerDerniere),
      bouton(1, 1, 'SAUTER LA QUESTION', '#4a4a4a', sauterColoriage)
    ]
  });
}

function passerEnColoriage() {
  etape = 'coloriage';
  panneau.visible = true;
  panneauPalette.visible = true;
  dessinerPalette();
  majPanneauColoriage(null);
}

// =====================================================================
//  MARQUEURS DES POINTS DEJA PLACES
// =====================================================================
var marqueurs = [];   // parallele a "points" : { sphere, etiquette } ou null

function creerEtiquette(texte, couleur) {
  var c = document.createElement('canvas'); c.width = 512; c.height = 96;
  var x = c.getContext('2d');
  x.font = 'bold 40px sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.lineWidth = 8; x.strokeStyle = 'rgba(0,0,0,0.85)';
  x.strokeText(texte, 256, 48);
  x.fillStyle = couleur;
  x.fillText(texte, 256, 48);
  var s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), transparent: true, depthTest: false
  }));
  s.scale.set(0.14, 0.026, 1);
  s.renderOrder = 999;
  return s;
}

// Le marqueur d'un point est affiche directement SUR sa projection dans le
// plan median (etude plane), pas a l'endroit brut vise sur le modele 3D.
// Enfant de l'ancre : suit le systeme quand on le deplace/tourne/zoome.
function majMarqueur(i) {
  var ancien = marqueurs[i];
  if (ancien) { anchor.remove(ancien.sphere); anchor.remove(ancien.etiquette); marqueurs[i] = null; }
  var pt = points[i];
  if (!pt.pos || !racine || medianZ_local === null) return;

  var pAncre = versAncre(projeterLocal(pt.pos));

  var estCourant = (i === courant);
  var couleur = estCourant ? 0xffd400 : 0x3ddc84;
  var sphere = new THREE.Mesh(
    new THREE.SphereGeometry(RAYON_MARQUEUR_POINT, 14, 14),
    new THREE.MeshBasicMaterial({ color: couleur, depthTest: false, transparent: true, opacity: 0.92 })
  );
  sphere.renderOrder = 900;
  sphere.position.copy(pAncre);
  sphere.scale.setScalar(facteurPoint);
  anchor.add(sphere);

  // Decalage proportionnel a la taille actuelle du point (RAYON_MARQUEUR_POINT
  // * facteurPoint) : sinon un point agrandi via le curseur finit par passer
  // par-dessus sa propre etiquette (decalage fixe insuffisant).
  var etq = creerEtiquette(pt.lettre || (i + 1) + '', estCourant ? '#ffe37a' : '#9dffc0');
  etq.position.copy(pAncre).add(new THREE.Vector3(0, RAYON_MARQUEUR_POINT * facteurPoint + 0.016, 0));
  anchor.add(etq);

  marqueurs[i] = { sphere: sphere, etiquette: etq };
  majProjectionEtFilaire();
}

function rafraichirTousMarqueurs() {
  for (var i = 0; i < points.length; i++) majMarqueur(i);
}

// =====================================================================
//  NAVIGATION DANS LA LISTE
// =====================================================================
function nbPlaces() { return points.filter(function (p) { return p.pos; }).length; }

function pointSuivantNonPlace(depart) {
  for (var k = 1; k <= points.length; k++) {
    var i = (depart + k) % points.length;
    if (!points[i].pos) return i;
  }
  return (depart + 1) % points.length;
}

function allerA(i) {
  var precedent = courant;
  courant = ((i % points.length) + points.length) % points.length;
  majMarqueur(precedent);
  majMarqueur(courant);
  majPanneau(null);
}

function precedent() { allerA(courant - 1); }
function suivant()   { allerA(courant + 1); }

// Valide le point courant (pas de bonne/mauvaise reponse a verifier : la
// position choisie fait foi). Avance au prochain point non place, ou
// termine l'etape (enregistrement + passage a l'etape 3) si c'etait le
// dernier.
function validerPoint() {
  if (!points[courant].pos) { majPanneau('Vise et pose ce point avant de valider.'); return; }
  if (nbPlaces() >= points.length) { enregistrer(); return; }
  allerA(pointSuivantNonPlace(courant));
}

// =====================================================================
//  ENREGISTREMENT
//  POST vers le serveur local s'il existe (usage avec serveur.bat), sinon
//  telechargement direct du fichier depuis le navigateur (hebergement
//  statique type GitHub Pages, qui n'a pas de serveur pour repondre).
// =====================================================================
function telechargerJSON(nomFichier, donnees) {
  var blob = new Blob([JSON.stringify(donnees, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = nomFichier;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
}

function enregistrer() {
  var donnees = {
    modele: MODELE,
    date: new Date().toISOString(),
    repere: 'Positions exprimees dans le repere local du fichier .glb ' +
            '(identique aux translations des noeuds dans le fichier source).',
    points: points.map(function (p) {
      return {
        nom: p.nom,
        placee: !!p.pos,
        position: p.pos ? { x: round4(p.pos.x), y: round4(p.pos.y), z: round4(p.pos.z) } : null,
        meshProche: p.meshProche
      };
    })
  };

  majPanneau('Enregistrement...');
  fetch('/enregistrer-points', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(donnees)
  }).then(function (r) {
    var typeContenu = r.headers.get('content-type') || '';
    if (!r.ok || typeContenu.indexOf('json') < 0) throw new Error('pas de serveur local');
    return r.json();
  }).then(function (r) {
    if (r.ok) {
      majPanneau(nbPlaces() + ' / ' + points.length + ' points enregistres dans\npoints-liaisons.json.');
      afficherResultatFinal();
    } else {
      majPanneau('Erreur d\'enregistrement : ' + r.erreur);
    }
  }).catch(function () {
    // Pas de serveur local (ex: GitHub Pages) : on telecharge le fichier.
    telechargerJSON('points-liaisons.json', donnees);
    majPanneau(nbPlaces() + ' / ' + points.length + ' points enregistres.\nFichier telecharge : points-liaisons.json\n(regarde les telechargements du navigateur)');
    afficherResultatFinal();
  });
}

function round4(v) { return Math.round(v * 10000) / 10000; }

// Une fois les points enregistres, on efface le modele reel (juste garde
// comme repere tres estompe) pour laisser voir clairement la structure
// filaire, qui est le vrai resultat de l'exercice.
var OPACITE_MODELE_ESTOMPE = 0.10;
function afficherResultatFinal() {
  piecesModele.forEach(function (p) {
    p.meshes.forEach(function (m) {
      m.material.transparent = true;
      m.material.opacity = OPACITE_MODELE_ESTOMPE;
      m.material.depthWrite = false;   // evite qu'il masque le filaire derriere lui
    });
  });
  passerEnForces();
}

// =====================================================================
//  ETAPE 3 : MODELISATION DES FORCES
//
//  L'etudiant trace au grossier, a la gachette, le vecteur representant le
//  poids de la charge : depuis le point H (charge/chape), vers le bas.
//  Corrige sur la DIRECTION uniquement (vertical local du modele, pas la
//  verticale reelle : le systeme peut avoir ete tourne au grip). La longueur
//  du trace de l'etudiant n'a pas d'importance ("trait grossier") ; la
//  fleche de la solution, elle, respecte l'echelle des forces donnee.
// =====================================================================
// Numerotation unifiee : "Isolement de la chape" regroupe ce qui suit
// (poids, isolement, triangle des forces) sous UNE seule etape numerotee,
// declinee en sous-parties dans le titre de chaque panneau.
var EYEBROW_CHAPE = 'Étape 3 — Isolement de la chape';

var MASSE_CHARGE_KG      = 500;
var G                    = 9.81;
var ECHELLE_FORCE_M_PAR_N = 0.01 / 200;   // 200 N pour 1 cm
var TOL_ANGLE_FORCE      = 12;            // degres
var LONGUEUR_MIN_FORCE   = 0.020;         // trace en dessous : trop court, on l'ignore

function pointParLettre(lettre) {
  return points.filter(function (p) { return p.lettre === lettre; })[0] || null;
}

// "Vers le bas" exprime dans le repere de l'ancre (donc suit une eventuelle
// rotation du systeme au grip, puisque calcule a partir de racine.matrix
// a chaque appel plutot que fige une fois pour toutes).
function directionBasAncre() {
  return new THREE.Vector3(0, -1, 0).transformDirection(racine.matrix).normalize();
}

// Fleche 3D (cylindre + cone), comme dans app.js. Positions attendues dans
// le repere de l'objet parent (ici toujours l'ancre, pour suivre le systeme).
function creerFleche(couleur, rayon) {
  var g = new THREE.Group();
  var mat = new THREE.MeshBasicMaterial({ color: couleur, depthTest: false, transparent: true, opacity: 1 });
  var corps = new THREE.Mesh(new THREE.CylinderGeometry(rayon, rayon, 1, 10), mat);
  var tete = new THREE.Mesh(new THREE.ConeGeometry(rayon * 2.8, rayon * 8, 12), mat);
  corps.renderOrder = 890; tete.renderOrder = 890;
  g.add(corps); g.add(tete);
  g.userData = { corps: corps, tete: tete, mat: mat, rayon: rayon };
  return g;
}
function majFleche(f, depuis, vers) {
  var dir = vers.clone().sub(depuis);
  var longueur = dir.length();
  if (longueur < 1e-5) { f.visible = false; return; }
  f.visible = true;
  dir.normalize();
  var d = f.userData;
  var lTete = Math.min(d.rayon * 8, longueur * 0.45);
  var lCorps = longueur - lTete;
  d.corps.scale.set(facteurTrait, Math.max(lCorps, 1e-4), facteurTrait);
  d.corps.position.set(0, lCorps / 2, 0);
  d.tete.scale.set(facteurTrait, lTete / (d.rayon * 8), facteurTrait);
  d.tete.position.set(0, lCorps + lTete / 2, 0);
  f.position.copy(depuis);
  f.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
}

// Trait simple (sans pointe), pour les DIRECTIONS (etape 4) : a ce stade on
// ne connait qu'une ligne d'action, pas encore le sens de l'effort. La
// fleche (avec pointe) reste reservee aux vrais vecteurs force (etape 3).
function creerTraitSimple(couleur, rayon) {
  var mat = new THREE.MeshBasicMaterial({ color: couleur, depthTest: false, transparent: true, opacity: 1 });
  var mesh = new THREE.Mesh(new THREE.CylinderGeometry(rayon, rayon, 1, 10), mat);
  mesh.userData = { mat: mat };
  mesh.renderOrder = 890;
  return mesh;
}
function majTraitSimple(mesh, depuis, vers) {
  var dir = vers.clone().sub(depuis);
  var longueur = dir.length();
  if (longueur < 1e-5) { mesh.visible = false; return; }
  mesh.visible = true;
  dir.normalize();
  mesh.scale.set(facteurTrait, longueur, facteurTrait);
  mesh.position.copy(depuis).lerp(vers, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
}

var traceForce         = null;   // { fleche, origine, direction } pendant/apres le trace
var manetteActiveForce = -1;
var flecheSolutionForce = null, etiquetteSolutionForce = null;

function recommencerForce() {
  if (traceForce) { anchor.remove(traceForce.fleche); traceForce = null; }
  if (flecheSolutionForce) { anchor.remove(flecheSolutionForce); flecheSolutionForce = null; }
  if (etiquetteSolutionForce) { anchor.remove(etiquetteSolutionForce); etiquetteSolutionForce = null; }
  manetteActiveForce = -1;
  majPanneauForces(null);
}

function validerForce() {
  if (!traceForce || !traceForce.direction) {
    majPanneauForces('Trace d\'abord le vecteur : vise le point H, gachette maintenue, tire vers le bas, relache.');
    return;
  }
  var attendue = directionBasAncre();
  var cos = THREE.MathUtils.clamp(traceForce.direction.dot(attendue), -1, 1);
  var angle = THREE.MathUtils.radToDeg(Math.acos(cos));
  var juste = angle <= TOL_ANGLE_FORCE;
  var presque = !juste && angle <= TOL_ANGLE_FORCE * 2;

  // Correct : on affiche directement la solution exacte (le trace de
  // l'etudiant, lui, reste visible mais estompe) plutot que d'attendre un
  // clic supplementaire sur VOIR LA SOLUTION - c'est ce vecteur exact qui
  // doit rester en place pour la suite, pas le trace approximatif.
  if (juste) {
    afficherSolutionForce();
    return;
  }

  var corps = [];
  if (presque) {
    traceForce.fleche.userData.mat.color.set(0xffb020);
  } else {
    traceForce.fleche.userData.mat.color.set(0xff5f5f);
    corps.push({ texte: 'Le poids d\'une charge est toujours vertical, dirige vers le bas.', couleur: '#9fd0ff' });
  }

  dessinerPanneau({
    eyebrow: EYEBROW_CHAPE,
    titre: 'Réponse — Placement du poids de la charge',
    statut: { ok: false, titre: presque ? 'Presque' : 'Pas encore juste', detail: 'Ecart de ' + Math.round(angle) + '° avec la verticale' },
    corps: corps,
    boutons: [
      bouton(0, 0, 'RÉESSAYER',       '#2f7d4f', recommencerForce),
      bouton(0, 1, 'VOIR LE CORRIGÉ', '#3a5f8a', afficherSolutionForce)
    ],
    curseurs: curseursEpaisseurStandard()
  });
}

function afficherSolutionForce() {
  if (traceForce) { traceForce.fleche.userData.mat.opacity = 0.35; }
  if (flecheSolutionForce) { anchor.remove(flecheSolutionForce); }
  if (etiquetteSolutionForce) { anchor.remove(etiquetteSolutionForce); }

  var pt = pointParLettre('H');
  if (!pt || !pt.pos) return;
  var origine = versAncre(projeterLocal(pt.pos));
  var dir = directionBasAncre();
  var poidsN = MASSE_CHARGE_KG * G;
  var longueur = poidsN * ECHELLE_FORCE_M_PAR_N;
  var bout = origine.clone().add(dir.clone().multiplyScalar(longueur));

  flecheSolutionForce = creerFleche(0x3ddc84, RAYON_FLECHE_FORCE);
  anchor.add(flecheSolutionForce);
  majFleche(flecheSolutionForce, origine, bout);

  etiquetteSolutionForce = creerEtiquette('P ≈ ' + Math.round(poidsN) + ' N', '#7dffb0');
  etiquetteSolutionForce.position.copy(bout).add(new THREE.Vector3(0.035, 0, 0));
  anchor.add(etiquetteSolutionForce);

  dessinerPanneau({
    eyebrow: EYEBROW_CHAPE,
    titre: 'Corrigé — Placement du poids de la charge',
    statut: { ok: true, titre: 'Poids correctement placé' },
    corps: [
      { texte: 'P = m·g = ' + MASSE_CHARGE_KG + ' × ' + G + ' ≈ ' + Math.round(poidsN) + ' N', couleur: '#dfeaf5' },
      { texte: 'Vecteur vertical, vers le bas, applique au point H (charge sur la chape).', couleur: '#dfeaf5' },
      { texte: 'Echelle des forces : 1 cm = 200 N.', couleur: '#9fd0ff' }
    ],
    boutons: [
      bouton(0, 0, 'RECOMMENCER', '#7d4f2f', recommencerForce),
      bouton(0, 1, 'CONTINUER',   '#2f7d4f', passerEnIsolementChape)
    ],
    curseurs: curseursEpaisseurStandard()
  });
}

function afficherAideForces() {
  dessinerPanneau({
    eyebrow: EYEBROW_CHAPE,
    titre: 'Aide — Placement du poids de la charge',
    corps: [
      'Le poids d\'une charge s\'exerce toujours a la verticale, vers le bas (c\'est la gravite).',
      '',
      { texte: 'Vise le point H (ou la charge touche la chape), gachette maintenue, tire vers le bas, relache. Seule la direction compte ici : la longueur de ton trace n\'a pas d\'importance.', couleur: '#9fd0ff' }
    ],
    boutons: [ boutonLarge(0, 'RETOUR À LA QUESTION', '#2f7d4f', function () { majPanneauForces(null); }) ]
  });
}

function majPanneauForces(message) {
  var corps = [
    { texte: 'Il faut maintenant placer l\'effort connu, le poids de la charge. Vous le dessinerez par un vecteur. Vise le point d\'application, clic long et deplace le vecteur dans le sens voulu. Relache la gachette pour poser le vecteur.' },
    { texte: (traceForce && traceForce.direction) ? 'Vecteur trace.' : 'Pas encore trace.', couleur: '#9fd0ff' },
    { texte: 'Echelle des forces : 1 cm = 200 N.', couleur: '#9fd0ff' }
  ];
  if (message) corps.push('', { texte: message, couleur: '#ff9f4a' });

  dessinerPanneau({
    eyebrow: EYEBROW_CHAPE,
    titre: 'Placement du poids de la charge',
    sousTitre: '1 / 5 dans cette étape',
    corps: corps,
    aide: afficherAideForces,
    boutons: [
      bouton(0, 0, 'VALIDER',     '#2f7d4f', validerForce),
      bouton(0, 1, 'RECOMMENCER', '#7d4f2f', recommencerForce),
      bouton(1, 0, 'SAUTER LA QUESTION', '#4a4a4a', afficherSolutionForce)
    ],
    curseurs: curseursEpaisseurStandard()
  });
}

function passerEnForces() {
  etape = 'forces';
  panneauPalette.visible = false;
  panneau.visible = true;
  majPanneauForces(null);
}

// =====================================================================
//  ETAPE 4 : ISOLEMENT DE LA CHAPE (directions des efforts)
//
//  3 forces sur la chape : P en H (connue, etape 3), la reaction du bras
//  inferieur en D, la reaction du bras superieur en C. Methode des 3
//  forces concourantes :
//   1. Le bras inferieur n'a que 2 points (B, D) : piece a 2 forces, sa
//      direction est portee par (BD). L'etudiant la trace en s'alignant
//      sur B et D deja places.
//   2. Pour une piece a 3 forces non paralleles en equilibre, les 3
//      lignes d'action sont concourantes : l'etudiant identifie donc le
//      point de concours, intersection de (BD) et de la verticale par H.
//   3. La direction en C est alors portee par (C -> point de concours),
//      que l'etudiant trace en s'alignant dessus.
//  Les lignes de guidage ne sont revelees qu'APRES une reponse jugee
//  juste, jamais avant (sinon ca fait l'exercice a la place de l'etudiant).
// =====================================================================
var TOL_DISTANCE_CONCOURS = 0.025;   // 2,5 cm : tolerance de pointage du point de concours

var etapeChape        = null;   // 'direction_D' | 'concours' | 'direction_C' | 'fini'
var traceD             = null, traceC = null;   // { fleche, origine, direction } comme traceForce
var manetteActiveChape = -1;
var pointConcoursVrai  = null;  // Vector3 ancre-local, calcule (pas affiche avant validation)
var pointConcoursTrouve = null; // Vector3 ancre-local, pose par l'etudiant une fois juste
var guideBD = null, guideCConcours = null, marqueurConcours = null;

// Position ancre-locale du marqueur deja affiche pour une lettre donnee
// (reutilise ce qui a ete calcule a l'etape 2, evite tout recalcul).
function positionMarqueurAncre(lettre) {
  for (var i = 0; i < points.length; i++) {
    if (points[i].lettre === lettre && marqueurs[i]) return marqueurs[i].sphere.position.clone();
  }
  return null;
}

// Intersection de 2 droites du plan (x,y du repere ancre ; z suppose identique
// pour les deux, ce qui est le cas ici puisque tout vient de versAncre(projeterLocal(...))).
function intersectionDroites(P1, D1, P2, D2) {
  var denom = D1.x * D2.y - D1.y * D2.x;
  if (Math.abs(denom) < 1e-9) return null;   // paralleles
  var dx = P2.x - P1.x, dy = P2.y - P1.y;
  var t = (dx * D2.y - dy * D2.x) / denom;
  return new THREE.Vector3(P1.x + t * D1.x, P1.y + t * D1.y, P1.z);
}

// Ligne de guidage fine (plus discrete que le filaire), prolongee des 2
// cotes pour bien montrer l'alignement.
function creerLigneGuide(p1, p2, couleur) {
  var dir = p2.clone().sub(p1).normalize();
  var ext = 0.08;
  return creerBarre(p1.clone().sub(dir.clone().multiplyScalar(ext)), p2.clone().add(dir.clone().multiplyScalar(ext)), couleur, RAYON_LIGNE_GUIDE);
}

// Fait ressortir UNE piece (opacite pleine) en remettant toutes les autres
// tres estompees (etat de depart regle par afficherResultatFinal a l'etape
// 3) : reutilisee a chaque isolement (chape, puis bras superieur).
function mettreEnEvidence(nomBase) {
  piecesModele.forEach(function (p) {
    p.meshes.forEach(function (m) { m.material.opacity = (p.nomBase === nomBase) ? 1 : OPACITE_MODELE_ESTOMPE; });
  });
}

function calculerGeometrieChape() {
  var pB = positionMarqueurAncre('B'), pD = positionMarqueurAncre('D');
  var pH = positionMarqueurAncre('H');
  if (!pB || !pD || !pH) return false;
  var dirBD = pD.clone().sub(pB).normalize();
  pointConcoursVrai = intersectionDroites(pD, dirBD, pH, directionBasAncre());
  return !!pointConcoursVrai;
}

function passerEnIsolementChape() {
  etape = 'isolement_chape';
  if (!calculerGeometrieChape()) {
    majPanneau('Impossible de calculer la geometrie (points B, D ou H manquants).');
    return;
  }
  mettreEnEvidence('chape_2');
  etapeChape = 'direction_D';
  panneauPalette.visible = false;
  panneau.visible = true;
  majPanneauChape(null);
}

function recommencerChape() {
  if (traceD) { anchor.remove(traceD.fleche); traceD = null; }
  if (traceC) { anchor.remove(traceC.fleche); traceC = null; }
  if (guideBD) { anchor.remove(guideBD); guideBD = null; }
  if (guideCConcours) { anchor.remove(guideCConcours); guideCConcours = null; }
  if (marqueurConcours) { anchor.remove(marqueurConcours); marqueurConcours = null; }
  pointConcoursTrouve = null;
  manetteActiveChape = -1;
  etapeChape = 'direction_D';
  majPanneauChape(null);
}

// Ordre des sous-parties de cette mini-sequence (voir precedentChape).
var SEQUENCE_CHAPE = ['direction_D', 'concours', 'direction_C', 'fini'];
function precedentChape() {
  var i = SEQUENCE_CHAPE.indexOf(etapeChape);
  if (i > 0) { etapeChape = SEQUENCE_CHAPE[i - 1]; majPanneauChape(null); return; }
  // 1ere sous-partie de ce mini-parcours : revient a la sous-partie
  // precedente du chapitre (le placement du poids).
  etape = 'forces';
  majPanneauForces(null);
}

// Ecran de reponse generique pour une validation d'angle/distance ratee :
// propose de reessayer, ou de voir directement le corrige (qui execute la
// suite "reussite" et avance) plutot que de rester bloque.
function afficherReponseEchecChape(id, titreSousEtape, detail, actionReessayer, actionVoirCorrige) {
  noterEchec(id);
  dessinerPanneau({
    eyebrow: EYEBROW_CHAPE,
    titre: 'Réponse — ' + titreSousEtape,
    statut: { ok: false, titre: 'Pas encore juste', detail: detail },
    boutons: [
      bouton(0, 0, 'RÉESSAYER',       '#2f7d4f', actionReessayer),
      bouton(0, 1, 'VOIR LE CORRIGÉ', '#3a5f8a', function () { noterResultat(id, 'aide'); actionVoirCorrige(); }),
      bouton(0, 2, '< PRÉCÉDENT',     '#4a4a4a', precedentChape)
    ],
    curseurs: curseursEpaisseurStandard()
  });
}

function reussirDirectionD() {
  var pB = positionMarqueurAncre('B'), pD = positionMarqueurAncre('D');
  if (traceD) traceD.fleche.userData.mat.opacity = 0.35;
  if (!guideBD) { guideBD = creerLigneGuide(pB, pD, 0x00aeef); anchor.add(guideBD); }
  etapeChape = 'concours';
  majPanneauChape(null);
}
function validerDirectionD() {
  if (!traceD || !traceD.direction) { majPanneauChape('Trace d\'abord la direction en D.'); return; }
  var pB = positionMarqueurAncre('B'), pD = positionMarqueurAncre('D');
  var attendue = pD.clone().sub(pB).normalize();
  // Une droite n'a pas de sens : on compare a la direction ou a son opposee.
  var cos = Math.abs(THREE.MathUtils.clamp(traceD.direction.dot(attendue), -1, 1));
  var angle = THREE.MathUtils.radToDeg(Math.acos(cos));

  if (angle <= TOL_ANGLE_FORCE) { noterResultat('direction_D'); reussirDirectionD(); return; }
  traceD.fleche.userData.mat.color.set(0xff5f5f);
  afficherReponseEchecChape('direction_D', 'Direction de l’effort en D', 'Écart de ' + Math.round(angle) + '° avec la droite (B, D)',
    function () { majPanneauChape(null); }, reussirDirectionD);
}

function reussirConcours() {
  if (!marqueurConcours) {
    marqueurConcours = new THREE.Mesh(
      new THREE.SphereGeometry(RAYON_MARQUEUR_POINT, 14, 14),
      new THREE.MeshBasicMaterial({ color: 0xffd400, depthTest: false })
    );
    marqueurConcours.scale.setScalar(facteurPoint);
    anchor.add(marqueurConcours);
  }
  pointConcoursTrouve = pointConcoursVrai.clone();
  marqueurConcours.position.copy(pointConcoursVrai);
  marqueurConcours.material.color.set(0x3ddc84);
  etapeChape = 'direction_C';
  majPanneauChape(null);
}
function validerConcours() {
  if (!pointConcoursTrouve) { majPanneauChape('Vise l\'intersection des deux droites et appuie sur la gachette.'); return; }
  var d = pointConcoursTrouve.distanceTo(pointConcoursVrai);
  if (d <= TOL_DISTANCE_CONCOURS) { noterResultat('concours_chape'); reussirConcours(); return; }
  anchor.remove(marqueurConcours);
  marqueurConcours = null;
  pointConcoursTrouve = null;
  afficherReponseEchecChape('concours_chape', 'Point de concours', 'Écart de ' + Math.round(d * 100) + ' cm avec le croisement exact',
    function () { majPanneauChape(null); }, reussirConcours);
}

function reussirDirectionC() {
  var pC = positionMarqueurAncre('C');
  if (traceC) traceC.fleche.userData.mat.opacity = 0.35;
  if (!guideCConcours) { guideCConcours = creerLigneGuide(pC, pointConcoursVrai, 0x00aeef); anchor.add(guideCConcours); }
  etapeChape = 'fini';
  majPanneauChape(null);
}
function validerDirectionC() {
  if (!traceC || !traceC.direction) { majPanneauChape('Trace d\'abord la direction en C.'); return; }
  var pC = positionMarqueurAncre('C');
  var attendue = pointConcoursVrai.clone().sub(pC).normalize();
  var cos = Math.abs(THREE.MathUtils.clamp(traceC.direction.dot(attendue), -1, 1));
  var angle = THREE.MathUtils.radToDeg(Math.acos(cos));

  if (angle <= TOL_ANGLE_FORCE) { noterResultat('direction_C'); reussirDirectionC(); return; }
  traceC.fleche.userData.mat.color.set(0xff5f5f);
  afficherReponseEchecChape('direction_C', 'Direction de l’effort en C', 'Écart de ' + Math.round(angle) + '° avec la droite (C, concours)',
    function () { majPanneauChape(null); }, reussirDirectionC);
}

function afficherAideChape() {
  var corps;
  if (etapeChape === 'direction_D') {
    corps = [
      'Le bras inferieur ne touche le reste du mecanisme qu\'en 2 points (B et D) : c\'est une piece a 2 forces.',
      '',
      { texte: 'Pour qu\'elle reste en equilibre, ces 2 forces sont forcement portees par la meme droite : celle qui passe par B et D.', couleur: '#9fd0ff' }
    ];
  } else if (etapeChape === 'concours') {
    corps = [
      'Une piece soumise a exactement 3 forces non paralleles, en equilibre, a forcement ses 3 lignes d\'action concourantes (qui se croisent en 1 seul point).',
      '',
      { texte: 'Tu connais deja 2 de ces lignes : la droite (B, D) et la verticale du poids, par H. Leur croisement donne le point cherche.', couleur: '#9fd0ff' }
    ];
  } else {
    corps = [
      'La 3e ligne d\'action (l\'effort en C) doit, elle aussi, passer par ce point de concours (meme principe qu\'a l\'etape precedente).',
      '',
      { texte: 'Elle passe aussi par C, ou elle s\'applique : aligne-toi sur ces deux points, C et le concours.', couleur: '#9fd0ff' }
    ];
  }
  dessinerPanneau({
    eyebrow: EYEBROW_CHAPE,
    titre: 'Aide',
    corps: corps,
    boutons: [ boutonLarge(0, 'RETOUR À LA QUESTION', '#2f7d4f', function () { majPanneauChape(null); }) ]
  });
}

var TITRES_SOUS_CHAPE = {
  direction_D: 'Direction de l’effort en D',
  concours:    'Point de concours',
  direction_C: 'Direction de l’effort en C',
  fini:        'Isolement de la chape terminé'
};
var PROGRESSION_SOUS_CHAPE = { direction_D: '2 / 5', concours: '3 / 5', direction_C: '4 / 5', fini: '5 / 5' };

function majPanneauChape(message) {
  var corps = [];
  if (etapeChape === 'direction_D') {
    corps.push('Pour etablir graphiquement l\'isolement de la chape, nous remarquons qu\'elle est soumise a 3 forces. Vous etablirez donc un triangle des forces. Pour ce faire, il faut identifier la direction de l\'effort en D. Vise le point d\'application, clic long et deplace la droite dans la direction voulue. Relache la gachette pour poser la droite.');
  } else if (etapeChape === 'concours') {
    corps.push('Il faut maintenant determiner la direction de l\'effort en C. Les directions des trois forces doivent etre concourantes en un point. Vise ce point et clic avec la gachette pour le placer.');
  } else if (etapeChape === 'direction_C') {
    corps.push('Il faut maintenant tracer la direction de l\'effort en C. Clic long en C puis deplace la droite dans la direction voulue. Relache la gachette pour poser la droite.');
  } else {
    corps.push({ texte: 'Les 3 directions (P, D, C) sont determinees.', couleur: '#3ddc84' });
  }
  if (message) corps.push('', { texte: message, couleur: '#ff9f4a' });

  var boutons2 = [];
  if (etapeChape !== 'fini') boutons2.push(bouton(0, 0, '< PRÉCÉDENT', '#3a5f8a', precedentChape));
  boutons2.push(bouton(0, 1, 'RECOMMENCER', '#7d4f2f', recommencerChape));
  if (etapeChape === 'direction_D') {
    boutons2.push(bouton(1, 0, 'VALIDER', '#2f7d4f', validerDirectionD));
    boutons2.push(bouton(1, 1, 'SAUTER LA QUESTION', '#4a4a4a', function () { noterResultat('direction_D', 'saute'); reussirDirectionD(); }));
  } else if (etapeChape === 'concours') {
    boutons2.push(bouton(1, 0, 'VALIDER', '#2f7d4f', validerConcours));
    boutons2.push(bouton(1, 1, 'SAUTER LA QUESTION', '#4a4a4a', function () { noterResultat('concours_chape', 'saute'); reussirConcours(); }));
  } else if (etapeChape === 'direction_C') {
    boutons2.push(bouton(1, 0, 'VALIDER', '#2f7d4f', validerDirectionC));
    boutons2.push(bouton(1, 1, 'SAUTER LA QUESTION', '#4a4a4a', function () { noterResultat('direction_C', 'saute'); reussirDirectionC(); }));
  } else boutons2.push(bouton(0, 0, 'CONTINUER', '#2f7d4f', passerEnTriangle));

  dessinerPanneau({
    eyebrow: EYEBROW_CHAPE,
    titre: TITRES_SOUS_CHAPE[etapeChape],
    sousTitre: PROGRESSION_SOUS_CHAPE[etapeChape] + ' dans cette étape',
    corps: corps,
    aide: etapeChape !== 'fini' ? afficherAideChape : null,
    boutons: boutons2,
    curseurs: curseursEpaisseurStandard()
  });
}

// =====================================================================
//  ETAPE 5 : TRIANGLE DES FORCES
//
//  Construction graphique classique, en 3 temps :
//   1. Les 2 droites d'action (etablies a l'etape 4, directions D et C)
//      reapparaissent a leur emplacement REEL sur le systeme, deplacables
//      au grip (translation uniquement, orientation figee). L'etudiant les
//      amene jusqu'aux 2 extremites du vecteur poids P (deja trace) : la
//      droite D par la pointe de P, la droite C par son talon.
//   2. Une fois bien placees, elles se croisent : l'etudiant vise ce
//      croisement (le "point de resolution" du triangle) et le marque a la
//      gachette, comme le point de concours de l'etape 4.
//   3. L'etudiant surligne alors (gachette maintenue, glisser-relacher)
//      les 2 segments qui representent les efforts reels, dans le bon
//      sens : de la pointe de P vers le point de resolution (effort D),
//      puis du point de resolution vers le talon de P (effort C). Comme le
//      point de resolution est deja fixe, un trace au bon endroit et dans
//      le bon sens donne directement la bonne longueur : rien a "fermer"
//      soi-meme, juste a identifier le bon segment.
// =====================================================================
var TOL_LIGNE_TRIANGLE   = 0.020;   // ecart accepte droite/extremite de P, en m
var TOL_EFFORT_TRIANGLE  = 0.025;   // ecart accepte pour l'extremite d'un trace d'effort, en m
var LONGUEUR_LIGNE_TRIANGLE = 0.30; // demi-longueur affichee des droites deplacables

var etapeTriangle = null;   // 'placer_droites' | 'concours' | 'effort_D' | 'effort_C' | 'fini'
var triangleInfo  = null;   // { origineTriangle, pointeP, poidsN, sommet, forceD_N, forceC_N }
var flechePTriangle = null;

var ligneD = null, ligneC = null;   // { mesh, poignee, ancrage: Vector3, direction: Vector3 }
var glissement = [null, null];      // par manette : null | 'D' | 'C'

var marqueurSommet = null;   // point de resolution (place automatiquement)

var traceEffortD = null, traceEffortC = null;   // { fleche, origine, direction, arrivee }
var manetteActiveEffort = -1;

var flecheCorrigeD = null, flecheCorrigeC = null;   // corrige exact, affiche une fois le triangle juste

// Point de resolution du triangle : intersection de la droite (issue de la
// pointe de P, direction D) et de la droite (issue du talon de P, direction
// C). Directions reprises telles quelles de l'etape 4 (une droite n'a pas
// de sens propre, seul le trace final de l'effort en a un).
function calculerTriangle() {
  var pB = positionMarqueurAncre('B'), pD = positionMarqueurAncre('D'), pC = positionMarqueurAncre('C');
  var pH = positionMarqueurAncre('H');
  if (!pB || !pD || !pC || !pH || !pointConcoursVrai) return null;

  var origineTriangle = pH.clone();
  var dirBasT = directionBasAncre();
  var poidsN = MASSE_CHARGE_KG * G;
  var longueurP = poidsN * ECHELLE_FORCE_M_PAR_N;
  var pointeP = origineTriangle.clone().add(dirBasT.clone().multiplyScalar(longueurP));

  var dirD = pD.clone().sub(pB).normalize();
  var dirC = pointConcoursVrai.clone().sub(pC).normalize();

  var sommet = intersectionDroites(pointeP, dirD, origineTriangle, dirC);
  if (!sommet) return null;

  var longueurD = pointeP.distanceTo(sommet);
  var longueurC = origineTriangle.distanceTo(sommet);

  return {
    origineTriangle: origineTriangle, pointeP: pointeP, poidsN: poidsN, sommet: sommet,
    forceD_N: longueurD / ECHELLE_FORCE_M_PAR_N,
    forceC_N: longueurC / ECHELLE_FORCE_M_PAR_N
  };
}

// Distance d'un point a une droite (definie par un point et une direction
// unitaire), dans le plan median (tout est deja projete en amont).
function distancePointDroite(p, origineDroite, direction) {
  var v = p.clone().sub(origineDroite);
  var proj = direction.clone().multiplyScalar(v.dot(direction));
  return v.clone().sub(proj).length();
}

function creerLigneDeplacable(couleur, ancrage, direction) {
  var mesh = creerTraitSimple(couleur, RAYON_TRAIT_DIRECTION);
  anchor.add(mesh);
  var poignee = new THREE.Mesh(
    new THREE.SphereGeometry(RAYON_MARQUEUR_POINT * 1.4, 14, 14),
    new THREE.MeshBasicMaterial({ color: couleur, depthTest: false })
  );
  poignee.scale.setScalar(facteurPoint);
  anchor.add(poignee);
  var l = { mesh: mesh, poignee: poignee, ancrage: ancrage.clone(), direction: direction.clone().normalize() };
  majLigneDeplacable(l);
  return l;
}

function majLigneDeplacable(l) {
  var demi = l.direction.clone().multiplyScalar(LONGUEUR_LIGNE_TRIANGLE);
  majTraitSimple(l.mesh, l.ancrage.clone().sub(demi), l.ancrage.clone().add(demi));
  l.poignee.position.copy(l.ancrage);
}

function supprimerLigneDeplacable(l) {
  if (!l) return;
  anchor.remove(l.mesh);
  anchor.remove(l.poignee);
}

// (Re)cree les objets modifiables de l'etape 5 dans leur position initiale
// (emplacement REEL des droites sur le systeme) : partage entre l'entree
// dans l'etape et RECOMMENCER.
function reinitialiserObjetsTriangle() {
  supprimerLigneDeplacable(ligneD);
  supprimerLigneDeplacable(ligneC);
  if (marqueurSommet) { anchor.remove(marqueurSommet); marqueurSommet = null; }
  if (traceEffortD) { anchor.remove(traceEffortD.fleche); traceEffortD = null; }
  if (traceEffortC) { anchor.remove(traceEffortC.fleche); traceEffortC = null; }
  if (flecheCorrigeD) { anchor.remove(flecheCorrigeD); flecheCorrigeD = null; }
  if (flecheCorrigeC) { anchor.remove(flecheCorrigeC); flecheCorrigeC = null; }
  glissement = [null, null];
  manetteActiveEffort = -1;

  var pB = positionMarqueurAncre('B'), pD = positionMarqueurAncre('D'), pC = positionMarqueurAncre('C');
  ligneD = creerLigneDeplacable(0xffd400, pD, pD.clone().sub(pB));
  ligneC = creerLigneDeplacable(0xffd400, pC, triangleInfo.sommet.clone().sub(pC));

  etapeTriangle = 'placer_droites';
}

function passerEnTriangle() {
  triangleInfo = calculerTriangle();
  if (!triangleInfo) { majPanneauChape('Impossible de calculer le triangle (etape 4 incomplete).'); return; }

  etape = 'triangle';
  panneauPalette.visible = false;
  panneau.visible = true;

  // On efface les traces de l'etape 4 (droites de direction, point de
  // concours) : elles reapparaissent juste apres, deplacables (voir
  // reinitialiserObjetsTriangle), plutot que d'etre une simple suite
  // visuelle figee de l'isolement.
  if (traceD) { anchor.remove(traceD.fleche); traceD = null; }
  if (traceC) { anchor.remove(traceC.fleche); traceC = null; }
  if (guideBD) { anchor.remove(guideBD); guideBD = null; }
  if (guideCConcours) { anchor.remove(guideCConcours); guideCConcours = null; }
  if (marqueurConcours) { anchor.remove(marqueurConcours); marqueurConcours = null; }

  flechePTriangle = creerFleche(0x3ddc84, RAYON_FLECHE_FORCE);
  anchor.add(flechePTriangle);
  majFleche(flechePTriangle, triangleInfo.origineTriangle, triangleInfo.pointeP);

  reinitialiserObjetsTriangle();
  majPanneauTriangle(null);
}

function recommencerTriangle() {
  reinitialiserObjetsTriangle();
  majPanneauTriangle(null);
}

var SEQUENCE_TRIANGLE = ['placer_droites', 'effort_D', 'effort_C', 'fini'];
function precedentTriangle() {
  var i = SEQUENCE_TRIANGLE.indexOf(etapeTriangle);
  if (i > 0) { etapeTriangle = SEQUENCE_TRIANGLE[i - 1]; majPanneauTriangle(null); return; }
  etape = 'isolement_chape';
  etapeChape = 'fini';
  majPanneauChape(null);
}

function afficherReponseEchecTriangle(id, titreSousEtape, detail, actionReessayer, actionVoirCorrige) {
  noterEchec(id);
  dessinerPanneau({
    eyebrow: EYEBROW_CHAPE,
    titre: 'Réponse — ' + titreSousEtape,
    statut: { ok: false, titre: 'Pas encore juste', detail: detail },
    boutons: [
      bouton(0, 0, 'RÉESSAYER',       '#2f7d4f', actionReessayer),
      bouton(0, 1, 'VOIR LE CORRIGÉ', '#3a5f8a', function () { noterResultat(id, 'aide'); actionVoirCorrige(); }),
      bouton(0, 2, '< PRÉCÉDENT',     '#4a4a4a', precedentTriangle)
    ],
    curseurs: curseursEpaisseurStandard()
  });
}

function reussirLignesTriangle() {
  ligneD.ancrage.copy(triangleInfo.pointeP);
  majLigneDeplacable(ligneD);
  ligneC.ancrage.copy(triangleInfo.origineTriangle);
  majLigneDeplacable(ligneC);
  ligneD.mesh.userData.mat.color.set(0x3ddc84);
  ligneC.mesh.userData.mat.color.set(0x3ddc84);
  ligneD.poignee.material.color.set(0x3ddc84);
  ligneC.poignee.material.color.set(0x3ddc84);

  // Le point de resolution (croisement des 2 droites) est desormais place
  // automatiquement, sans etape de pointage manuel (sur demande de
  // l'utilisateur) : sa position est deja connue exactement (triangleInfo.sommet).
  if (marqueurSommet) { anchor.remove(marqueurSommet); }
  marqueurSommet = new THREE.Mesh(
    new THREE.SphereGeometry(RAYON_MARQUEUR_POINT, 14, 14),
    new THREE.MeshBasicMaterial({ color: 0x3ddc84, depthTest: false })
  );
  marqueurSommet.position.copy(triangleInfo.sommet);
  marqueurSommet.scale.setScalar(facteurPoint);
  anchor.add(marqueurSommet);

  etapeTriangle = 'effort_D';
  majPanneauTriangle(null);
}
function validerLignesTriangle() {
  var dD = distancePointDroite(triangleInfo.pointeP, ligneD.ancrage, ligneD.direction);
  var dC = distancePointDroite(triangleInfo.origineTriangle, ligneC.ancrage, ligneC.direction);
  if (dD <= TOL_LIGNE_TRIANGLE && dC <= TOL_LIGNE_TRIANGLE) { noterResultat('triangle_chape_droites'); reussirLignesTriangle(); return; }
  var probleme = (dD > TOL_LIGNE_TRIANGLE && dC > TOL_LIGNE_TRIANGLE) ? 'Les deux droites ne passent pas encore par les extremites de P'
    : (dD > TOL_LIGNE_TRIANGLE) ? 'La droite D ne passe pas encore par la pointe de P'
    : 'La droite C ne passe pas encore par le talon de P';
  afficherReponseEchecTriangle('triangle_chape_droites', 'Placement des droites', probleme, function () { majPanneauTriangle(null); }, reussirLignesTriangle);
}

// Cree/complete traceEffortD si besoin (ex: SAUTER LA QUESTION sans essai
// prealable, ou l'etudiant n'a jamais grippe la gachette) : sans ca la
// suite (couleur, majPanneauTriangle) crasherait sur un objet inexistant.
function reussirEffortD() {
  if (!traceEffortD) {
    var fED = creerFleche(0x3ddc84, RAYON_FLECHE_FORCE);
    anchor.add(fED);
    traceEffortD = { fleche: fED, origine: triangleInfo.pointeP.clone(), direction: null, arrivee: null };
  }
  majFleche(traceEffortD.fleche, traceEffortD.origine, triangleInfo.sommet);
  traceEffortD.arrivee = triangleInfo.sommet.clone();
  traceEffortD.direction = triangleInfo.sommet.clone().sub(traceEffortD.origine).normalize();
  traceEffortD.fleche.userData.mat.color.set(0x3ddc84);
  etapeTriangle = 'effort_C';
  majPanneauTriangle(null);
}
function validerEffortD() {
  if (!traceEffortD || !traceEffortD.direction) { majPanneauTriangle('Trace d\'abord l\'effort en D : gachette depuis la pointe de P, jusqu\'au point de resolution.'); return; }
  var d = traceEffortD.arrivee.distanceTo(triangleInfo.sommet);
  if (d <= TOL_EFFORT_TRIANGLE) { noterResultat('triangle_chape_effort_D'); reussirEffortD(); return; }
  traceEffortD.fleche.userData.mat.color.set(0xff5f5f);
  afficherReponseEchecTriangle('triangle_chape_effort_D', 'Effort en D', 'Écart de ' + Math.round(d * 100) + ' cm avec le point de resolution',
    function () { majPanneauTriangle(null); }, reussirEffortD);
}

function reussirEffortC() {
  if (!traceEffortC) {
    var fEC = creerFleche(0x3ddc84, RAYON_FLECHE_FORCE);
    anchor.add(fEC);
    traceEffortC = { fleche: fEC, origine: triangleInfo.sommet.clone(), direction: null, arrivee: null };
  }
  majFleche(traceEffortC.fleche, traceEffortC.origine, triangleInfo.origineTriangle);
  traceEffortC.arrivee = triangleInfo.origineTriangle.clone();
  traceEffortC.direction = triangleInfo.origineTriangle.clone().sub(traceEffortC.origine).normalize();
  traceEffortC.fleche.userData.mat.color.set(0x3ddc84);
  etapeTriangle = 'fini';
  afficherResultatTriangle();
}
function validerEffortC() {
  if (!traceEffortC || !traceEffortC.direction) { majPanneauTriangle('Trace d\'abord l\'effort en C : gachette depuis le point de resolution, jusqu\'au talon de P.'); return; }
  var d = traceEffortC.arrivee.distanceTo(triangleInfo.origineTriangle);
  if (d <= TOL_EFFORT_TRIANGLE) { noterResultat('triangle_chape_effort_C'); reussirEffortC(); return; }
  traceEffortC.fleche.userData.mat.color.set(0xff5f5f);
  afficherReponseEchecTriangle('triangle_chape_effort_C', 'Effort en C', 'Écart de ' + Math.round(d * 100) + ' cm avec le talon de P',
    function () { majPanneauTriangle(null); }, reussirEffortC);
}

function afficherAideTriangle() {
  var corps;
  if (etapeTriangle === 'placer_droites') {
    corps = [
      'P est deja trace (vert), a l\'echelle 1 cm = 200 N.',
      '',
      { texte: 'Attrape (grip) chaque droite jaune par sa poignee et fais-la glisser, sans la faire pivoter, jusqu\'a une extremite de P : la droite D par la pointe, la droite C par le talon.', couleur: '#9fd0ff' }
    ];
  } else if (etapeTriangle === 'effort_D') {
    corps = [
      'Le point de resolution (croisement des 2 droites) est deja marque : le bon trace donne directement la bonne longueur, pas besoin de "fermer" quoi que ce soit toi-meme.',
      '',
      { texte: 'Vise le point origine du vecteur dans le triangle, clic long et deplace le vecteur dans le sens voulu. Relache la gachette pour poser le vecteur.', couleur: '#9fd0ff' }
    ];
  } else {
    corps = [
      { texte: 'Meme principe pour l\'effort en C, mais dans l\'autre sens : depuis le point de resolution, jusqu\'au talon de P (l\'origine du poids).', couleur: '#9fd0ff' }
    ];
  }
  dessinerPanneau({
    eyebrow: EYEBROW_CHAPE,
    titre: 'Aide',
    corps: corps,
    boutons: [ boutonLarge(0, 'RETOUR À LA QUESTION', '#2f7d4f', function () { majPanneauTriangle(null); }) ]
  });
}

// Affiche un corrige exact (le vrai triangle, tel que calcule) une fois les
// 2 efforts correctement traces : le trace "grossier" de l'etudiant est
// estompe, comme la solution de l'etape 3.
function afficherCorrigeTriangle() {
  if (traceEffortD) traceEffortD.fleche.userData.mat.opacity = 0.35;
  if (traceEffortC) traceEffortC.fleche.userData.mat.opacity = 0.35;

  flecheCorrigeD = creerFleche(0x3ddc84, RAYON_FLECHE_FORCE);
  anchor.add(flecheCorrigeD);
  majFleche(flecheCorrigeD, triangleInfo.pointeP, triangleInfo.sommet);

  flecheCorrigeC = creerFleche(0x3ddc84, RAYON_FLECHE_FORCE);
  anchor.add(flecheCorrigeC);
  majFleche(flecheCorrigeC, triangleInfo.sommet, triangleInfo.origineTriangle);
}

function afficherResultatTriangle() {
  afficherCorrigeTriangle();
  dessinerPanneau({
    eyebrow: EYEBROW_CHAPE,
    titre: 'Triangle des forces — résultat',
    statut: { ok: true, titre: 'Triangle complet : les 3 forces s’équilibrent' },
    corps: [
      { texte: 'P = ' + Math.round(triangleInfo.poidsN) + ' N', couleur: '#dfeaf5' },
      { texte: 'Effort en D (bras inferieur) ≈ ' + Math.round(triangleInfo.forceD_N) + ' N', couleur: '#dfeaf5' },
      { texte: 'Effort en C (bras superieur) ≈ ' + Math.round(triangleInfo.forceC_N) + ' N', couleur: '#dfeaf5' },
      { texte: 'Echelle : 1 cm = 200 N.', couleur: '#9fd0ff' }
    ],
    boutons: [
      bouton(0, 0, 'RECOMMENCER', '#7d4f2f', recommencerTriangle),
      bouton(0, 1, 'CONTINUER',   '#2f7d4f', passerEnIsolementBrasSup)
    ],
    curseurs: curseursEpaisseurStandard()
  });
}

var TITRES_SOUS_TRIANGLE = {
  placer_droites: 'Triangle des forces — placement des droites',
  effort_D:       'Triangle des forces — effort en D',
  effort_C:       'Triangle des forces — effort en C'
};
var PROGRESSION_SOUS_TRIANGLE = { placer_droites: '5 / 5', effort_D: '5 / 5', effort_C: '5 / 5' };

function majPanneauTriangle(message) {
  var corps = [];
  if (etapeTriangle === 'placer_droites') {
    corps.push('Il faut maintenant construire le triangle des forces a partir du vecteur force connu et des deux droites determinees precedemment. Clic long sur la manette des droites et deplace-les pour former ce triangle autour du vecteur force (qui reste immobile).');
  } else if (etapeTriangle === 'effort_D') {
    corps.push('Il faut identifier l\'effort en D dans le triangle. Vise le point origine du vecteur dans le triangle, clic long et deplace le vecteur dans le sens voulu. Relache la gachette pour poser le vecteur.');
  } else if (etapeTriangle === 'effort_C') {
    corps.push('Il faut identifier l\'effort en C dans le triangle. Vise le point origine du vecteur dans le triangle, clic long et deplace le vecteur dans le sens voulu. Relache la gachette pour poser le vecteur.');
  }
  corps.push({ texte: 'Echelle des forces : 1 cm = 200 N.', couleur: '#9fd0ff' });
  if (message) corps.push('', { texte: message, couleur: '#ff9f4a' });

  var boutons2 = [
    bouton(0, 0, '< PRÉCÉDENT', '#3a5f8a', precedentTriangle),
    bouton(0, 1, 'RECOMMENCER', '#7d4f2f', recommencerTriangle)
  ];
  if (etapeTriangle === 'placer_droites') {
    boutons2.push(bouton(1, 0, 'VALIDER', '#2f7d4f', validerLignesTriangle));
    boutons2.push(bouton(1, 1, 'SAUTER LA QUESTION', '#4a4a4a', function () { noterResultat('triangle_chape_droites', 'saute'); reussirLignesTriangle(); }));
  } else if (etapeTriangle === 'effort_D') {
    boutons2.push(bouton(1, 0, 'VALIDER', '#2f7d4f', validerEffortD));
    boutons2.push(bouton(1, 1, 'SAUTER LA QUESTION', '#4a4a4a', function () { noterResultat('triangle_chape_effort_D', 'saute'); reussirEffortD(); }));
  } else if (etapeTriangle === 'effort_C') {
    boutons2.push(bouton(1, 0, 'VALIDER', '#2f7d4f', validerEffortC));
    boutons2.push(bouton(1, 1, 'SAUTER LA QUESTION', '#4a4a4a', function () { noterResultat('triangle_chape_effort_C', 'saute'); reussirEffortC(); }));
  }

  dessinerPanneau({
    eyebrow: EYEBROW_CHAPE,
    titre: TITRES_SOUS_TRIANGLE[etapeTriangle],
    sousTitre: PROGRESSION_SOUS_TRIANGLE[etapeTriangle] + ' dans cette étape',
    corps: corps,
    aide: afficherAideTriangle,
    boutons: boutons2,
    curseurs: curseursEpaisseurStandard()
  });
}

// =====================================================================
//  ETAPE 6 : ISOLEMENT DU BRAS SUPERIEUR (directions des efforts)
//
//  Meme methode qu'a l'etape 4 (3 forces concourantes), appliquee cette
//  fois au bras superieur (points A, C, G) :
//   - En C, la reaction de la chape sur le bras superieur est desormais
//     completement connue (action/reaction avec l'effort en C calcule a
//     l'etape 5 : meme ligne d'action, meme intensite, sens oppose).
//   - Le levier n'a que 2 points (F, G) : piece a 2 forces, sa direction
//     en G est donc portee par (FG), comme le bras inferieur portait la
//     direction en D a l'etape 4.
//   - Point de concours : intersection de (FG) et de la ligne d'action en
//     C deja etablie a l'etape 4 (une ligne d'action ne depend pas du sens
//     de la force qu'elle porte, elle vaut pour l'action ET la reaction).
//   - La direction en A est alors portee par (A -> point de concours).
// =====================================================================
var etapeBrasSup = null;   // 'direction_G' | 'concours' | 'direction_A' | 'fini'
var traceG = null, traceA = null;   // { fleche, origine, direction } comme traceD/traceC
var manetteActiveBrasSup = -1;
var pointConcoursVraiBrasSup = null;
var pointConcoursTrouveBrasSup = null;
var guideFG = null, guideAConcours = null, marqueurConcoursBrasSup = null;

function calculerGeometrieBrasSup() {
  var pF = positionMarqueurAncre('F'), pG = positionMarqueurAncre('G');
  var pC = positionMarqueurAncre('C');
  if (!pF || !pG || !pC || !pointConcoursVrai) return false;
  var dirFG = pG.clone().sub(pF).normalize();
  var dirLigneActionC = pointConcoursVrai.clone().sub(pC).normalize();
  pointConcoursVraiBrasSup = intersectionDroites(pG, dirFG, pC, dirLigneActionC);
  return !!pointConcoursVraiBrasSup;
}

function passerEnIsolementBrasSup() {
  etape = 'isolement_bras_sup';
  if (!calculerGeometrieBrasSup()) {
    majPanneauTriangle('Impossible de calculer la geometrie (points F, G ou C manquants).');
    return;
  }

  // On efface les objets de l'etape 5 (poids, droites, resultat) : l'etape
  // 6 ouvre un nouveau schema (le bras superieur), pas une suite visuelle
  // figee du triangle de la chape. Meme principe qu'entre l'etape 4 et 5.
  if (flechePTriangle) { anchor.remove(flechePTriangle); flechePTriangle = null; }
  supprimerLigneDeplacable(ligneD); ligneD = null;
  supprimerLigneDeplacable(ligneC); ligneC = null;
  if (marqueurSommet) { anchor.remove(marqueurSommet); marqueurSommet = null; }
  if (traceEffortD) { anchor.remove(traceEffortD.fleche); traceEffortD = null; }
  if (traceEffortC) { anchor.remove(traceEffortC.fleche); traceEffortC = null; }
  if (flecheCorrigeD) { anchor.remove(flecheCorrigeD); flecheCorrigeD = null; }
  if (flecheCorrigeC) { anchor.remove(flecheCorrigeC); flecheCorrigeC = null; }

  // La reaction en C est connue (action/reaction avec l'etape 5), mais
  // jusqu'ici seulement par le calcul : rien ne la montrait a l'ecran, ce
  // qui rendait impossible de viser son intersection avec la droite (FG)
  // (bug remonte par l'utilisateur). On la trace ici, comme P etait trace
  // et reste visible tout au long de l'etape 4.
  var pC6 = positionMarqueurAncre('C');
  var dirReactionC6 = triangleInfo.origineTriangle.clone().sub(triangleInfo.sommet).normalize().negate();
  var longueurReactionC6 = triangleInfo.forceC_N * ECHELLE_FORCE_M_PAR_N;
  flecheReactionC = creerFleche(0x3ddc84, RAYON_FLECHE_FORCE);
  anchor.add(flecheReactionC);
  majFleche(flecheReactionC, pC6, pC6.clone().add(dirReactionC6.multiplyScalar(longueurReactionC6)));

  mettreEnEvidence('bras_assemblé');
  etapeBrasSup = 'direction_G';
  panneauPalette.visible = false;
  panneau.visible = true;
  majPanneauBrasSup(null);
}

var EYEBROW_BRASSUP = 'Étape 4 — Isolement du bras supérieur';

function recommencerBrasSup() {
  if (traceG) { anchor.remove(traceG.fleche); traceG = null; }
  if (traceA) { anchor.remove(traceA.fleche); traceA = null; }
  if (guideFG) { anchor.remove(guideFG); guideFG = null; }
  if (guideAConcours) { anchor.remove(guideAConcours); guideAConcours = null; }
  if (marqueurConcoursBrasSup) { anchor.remove(marqueurConcoursBrasSup); marqueurConcoursBrasSup = null; }
  pointConcoursTrouveBrasSup = null;
  manetteActiveBrasSup = -1;
  etapeBrasSup = 'direction_G';
  majPanneauBrasSup(null);
}

var SEQUENCE_BRASSUP = ['direction_G', 'concours', 'direction_A', 'fini'];
function precedentBrasSup() {
  var i = SEQUENCE_BRASSUP.indexOf(etapeBrasSup);
  if (i > 0) { etapeBrasSup = SEQUENCE_BRASSUP[i - 1]; majPanneauBrasSup(null); return; }
  // 1ere sous-partie : revient a la sous-partie precedente du chapitre
  // precedent (le triangle des forces de la chape, deja termine).
  etape = 'triangle';
  etapeTriangle = 'fini';
  majPanneauTriangle(null);
}

function afficherReponseEchecBrasSup(id, titreSousEtape, detail, actionReessayer, actionVoirCorrige) {
  noterEchec(id);
  dessinerPanneau({
    eyebrow: EYEBROW_BRASSUP,
    titre: 'Réponse — ' + titreSousEtape,
    statut: { ok: false, titre: 'Pas encore juste', detail: detail },
    boutons: [
      bouton(0, 0, 'RÉESSAYER',       '#2f7d4f', actionReessayer),
      bouton(0, 1, 'VOIR LE CORRIGÉ', '#3a5f8a', function () { noterResultat(id, 'aide'); actionVoirCorrige(); }),
      bouton(0, 2, '< PRÉCÉDENT',     '#4a4a4a', precedentBrasSup)
    ],
    curseurs: curseursEpaisseurStandard()
  });
}

function reussirDirectionG() {
  var pF = positionMarqueurAncre('F'), pG = positionMarqueurAncre('G');
  if (traceG) traceG.fleche.userData.mat.opacity = 0.35;
  if (!guideFG) { guideFG = creerLigneGuide(pF, pG, 0x00aeef); anchor.add(guideFG); }
  etapeBrasSup = 'concours';
  majPanneauBrasSup(null);
}
function validerDirectionG() {
  if (!traceG || !traceG.direction) { majPanneauBrasSup('Trace d\'abord la direction en G.'); return; }
  var pF = positionMarqueurAncre('F'), pG = positionMarqueurAncre('G');
  var attendue = pG.clone().sub(pF).normalize();
  var cos = Math.abs(THREE.MathUtils.clamp(traceG.direction.dot(attendue), -1, 1));
  var angle = THREE.MathUtils.radToDeg(Math.acos(cos));

  if (angle <= TOL_ANGLE_FORCE) { noterResultat('direction_G'); reussirDirectionG(); return; }
  traceG.fleche.userData.mat.color.set(0xff5f5f);
  afficherReponseEchecBrasSup('direction_G', 'Direction de l’effort en G', 'Écart de ' + Math.round(angle) + '° avec la droite (F, G)',
    function () { majPanneauBrasSup(null); }, reussirDirectionG);
}

function reussirConcoursBrasSup() {
  if (!marqueurConcoursBrasSup) {
    marqueurConcoursBrasSup = new THREE.Mesh(
      new THREE.SphereGeometry(RAYON_MARQUEUR_POINT, 14, 14),
      new THREE.MeshBasicMaterial({ color: 0xffd400, depthTest: false })
    );
    marqueurConcoursBrasSup.scale.setScalar(facteurPoint);
    anchor.add(marqueurConcoursBrasSup);
  }
  pointConcoursTrouveBrasSup = pointConcoursVraiBrasSup.clone();
  marqueurConcoursBrasSup.position.copy(pointConcoursVraiBrasSup);
  marqueurConcoursBrasSup.material.color.set(0x3ddc84);
  etapeBrasSup = 'direction_A';
  majPanneauBrasSup(null);
}
function validerConcoursBrasSup() {
  if (!pointConcoursTrouveBrasSup) { majPanneauBrasSup('Vise l\'intersection des deux droites et appuie sur la gachette.'); return; }
  var d = pointConcoursTrouveBrasSup.distanceTo(pointConcoursVraiBrasSup);
  if (d <= TOL_DISTANCE_CONCOURS) { noterResultat('concours_brasSup'); reussirConcoursBrasSup(); return; }
  anchor.remove(marqueurConcoursBrasSup);
  marqueurConcoursBrasSup = null;
  pointConcoursTrouveBrasSup = null;
  afficherReponseEchecBrasSup('concours_brasSup', 'Point de concours', 'Écart de ' + Math.round(d * 100) + ' cm avec le croisement exact',
    function () { majPanneauBrasSup(null); }, reussirConcoursBrasSup);
}

function reussirDirectionA() {
  var pA = positionMarqueurAncre('A');
  if (traceA) traceA.fleche.userData.mat.opacity = 0.35;
  if (!guideAConcours) { guideAConcours = creerLigneGuide(pA, pointConcoursVraiBrasSup, 0x00aeef); anchor.add(guideAConcours); }
  etapeBrasSup = 'fini';
  majPanneauBrasSup(null);
}
function validerDirectionA() {
  if (!traceA || !traceA.direction) { majPanneauBrasSup('Trace d\'abord la direction en A.'); return; }
  var pA = positionMarqueurAncre('A');
  var attendue = pointConcoursVraiBrasSup.clone().sub(pA).normalize();
  var cos = Math.abs(THREE.MathUtils.clamp(traceA.direction.dot(attendue), -1, 1));
  var angle = THREE.MathUtils.radToDeg(Math.acos(cos));

  if (angle <= TOL_ANGLE_FORCE) { noterResultat('direction_A'); reussirDirectionA(); return; }
  traceA.fleche.userData.mat.color.set(0xff5f5f);
  afficherReponseEchecBrasSup('direction_A', 'Direction de l’effort en A', 'Écart de ' + Math.round(angle) + '° avec la droite (A, concours)',
    function () { majPanneauBrasSup(null); }, reussirDirectionA);
}

function afficherAideBrasSup() {
  var corps;
  if (etapeBrasSup === 'direction_G') {
    corps = [
      'Le levier ne touche le reste du mecanisme qu\'en 2 points (F et G) : c\'est une piece a 2 forces, comme le bras inferieur a l\'etape precedente.',
      '',
      { texte: 'Ses 2 forces sont donc portees par la meme droite : celle qui passe par F et G.', couleur: '#9fd0ff' }
    ];
  } else if (etapeBrasSup === 'concours') {
    corps = [
      'Meme principe qu\'a l\'etape precedente : 3 forces non paralleles en equilibre ont des lignes d\'action concourantes.',
      '',
      { texte: 'Tu connais deja 2 de ces lignes : la droite (F, G), et la ligne d\'action en C (deja tracee, la reaction connue). Leur croisement donne le point cherche.', couleur: '#9fd0ff' }
    ];
  } else {
    corps = [
      'La 3e ligne d\'action (l\'effort en A) passe par ce meme point de concours, et par A lui-meme, ou elle s\'applique (la liaison avec le bati).',
      '',
      { texte: 'Aligne-toi sur ces deux points, A et le concours.', couleur: '#9fd0ff' }
    ];
  }
  dessinerPanneau({
    eyebrow: EYEBROW_BRASSUP,
    titre: 'Aide',
    corps: corps,
    boutons: [ boutonLarge(0, 'RETOUR À LA QUESTION', '#2f7d4f', function () { majPanneauBrasSup(null); }) ]
  });
}

var TITRES_SOUS_BRASSUP = {
  direction_G: 'Direction de l’effort en G',
  concours:    'Point de concours',
  direction_A: 'Direction de l’effort en A',
  fini:        'Isolement du bras supérieur terminé'
};
var PROGRESSION_SOUS_BRASSUP = { direction_G: '1 / 4', concours: '2 / 4', direction_A: '3 / 4', fini: '4 / 4' };

function majPanneauBrasSup(message) {
  var corps = [];
  if (etapeBrasSup === 'direction_G') {
    corps.push('La reaction de la chape sur le bras superieur en C est maintenant connue. Il faut effectuer les memes etapes de resolution sur le bras superieur. Trace la direction de l\'effort en G.');
  } else if (etapeBrasSup === 'concours') {
    corps.push('Identifie le point d\'intersection des directions des forces.');
  } else if (etapeBrasSup === 'direction_A') {
    corps.push('Trace la direction de l\'effort en A.');
  } else {
    corps.push({ texte: 'Les 3 directions (reaction en C, G, A) sont determinees.', couleur: '#3ddc84' });
  }
  if (message) corps.push('', { texte: message, couleur: '#ff9f4a' });

  var boutons2 = [];
  if (etapeBrasSup !== 'fini') boutons2.push(bouton(0, 0, '< PRÉCÉDENT', '#3a5f8a', precedentBrasSup));
  boutons2.push(bouton(0, 1, 'RECOMMENCER', '#7d4f2f', recommencerBrasSup));
  if (etapeBrasSup === 'direction_G') {
    boutons2.push(bouton(1, 0, 'VALIDER', '#2f7d4f', validerDirectionG));
    boutons2.push(bouton(1, 1, 'SAUTER LA QUESTION', '#4a4a4a', function () { noterResultat('direction_G', 'saute'); reussirDirectionG(); }));
  } else if (etapeBrasSup === 'concours') {
    boutons2.push(bouton(1, 0, 'VALIDER', '#2f7d4f', validerConcoursBrasSup));
    boutons2.push(bouton(1, 1, 'SAUTER LA QUESTION', '#4a4a4a', function () { noterResultat('concours_brasSup', 'saute'); reussirConcoursBrasSup(); }));
  } else if (etapeBrasSup === 'direction_A') {
    boutons2.push(bouton(1, 0, 'VALIDER', '#2f7d4f', validerDirectionA));
    boutons2.push(bouton(1, 1, 'SAUTER LA QUESTION', '#4a4a4a', function () { noterResultat('direction_A', 'saute'); reussirDirectionA(); }));
  } else boutons2.push(bouton(0, 0, 'CONTINUER', '#2f7d4f', passerEnTriangleBrasSup));

  dessinerPanneau({
    eyebrow: EYEBROW_BRASSUP,
    titre: TITRES_SOUS_BRASSUP[etapeBrasSup],
    sousTitre: PROGRESSION_SOUS_BRASSUP[etapeBrasSup] + ' dans cette étape',
    corps: corps,
    aide: etapeBrasSup !== 'fini' ? afficherAideBrasSup : null,
    boutons: boutons2,
    curseurs: curseursEpaisseurStandard()
  });
}

// =====================================================================
//  ETAPE 7 : TRIANGLE DES FORCES (BRAS SUPERIEUR)
//
//  Meme construction qu'a l'etape 5, mais la force de depart n'est plus le
//  poids : c'est la reaction en C (action/reaction avec l'effort calcule a
//  l'etape 5), une force desormais COMPLETEMENT connue (intensite ET
//  direction, plus seulement une ligne d'action).
// =====================================================================
var etapeTriangleBrasSup = null;   // 'placer_droites' | 'concours' | 'effort_G' | 'effort_A' | 'fini'
var triangleInfoBrasSup  = null;   // { origineTriangle, pointeP, poidsN, sommet, forceG_N, forceA_N }
var flecheReactionC = null;   // force de depart connue (reaction en C), joue le role de P

var ligneG = null, ligneA = null;
var glissementBrasSup = [null, null];

var marqueurSommetBrasSup = null;

var traceEffortG = null, traceEffortA = null;
var manetteActiveEffortBrasSup = -1;

var flecheCorrigeG = null, flecheCorrigeA = null;

function calculerTriangleBrasSup() {
  var pA = positionMarqueurAncre('A'), pF = positionMarqueurAncre('F'), pG = positionMarqueurAncre('G'), pC = positionMarqueurAncre('C');
  if (!pA || !pF || !pG || !pC || !pointConcoursVraiBrasSup || !triangleInfo) return null;

  // Reaction en C (chape sur bras superieur) : action/reaction de l'effort
  // en C calcule a l'etape 5 (sur la chape) - meme intensite, meme ligne
  // d'action, sens oppose.
  var origineTriangle2 = pC.clone();
  var dirReactionC = triangleInfo.origineTriangle.clone().sub(triangleInfo.sommet).normalize().negate();
  var reactionC_N = triangleInfo.forceC_N;
  var longueurReactionC = reactionC_N * ECHELLE_FORCE_M_PAR_N;
  var pointeReactionC = origineTriangle2.clone().add(dirReactionC.clone().multiplyScalar(longueurReactionC));

  var dirG = pG.clone().sub(pF).normalize();
  var dirA = pointConcoursVraiBrasSup.clone().sub(pA).normalize();

  var sommet2 = intersectionDroites(pointeReactionC, dirG, origineTriangle2, dirA);
  if (!sommet2) return null;

  var longueurG = pointeReactionC.distanceTo(sommet2);
  var longueurA = origineTriangle2.distanceTo(sommet2);

  return {
    origineTriangle: origineTriangle2, pointeP: pointeReactionC, poidsN: reactionC_N, sommet: sommet2,
    forceG_N: longueurG / ECHELLE_FORCE_M_PAR_N,
    forceA_N: longueurA / ECHELLE_FORCE_M_PAR_N
  };
}

function reinitialiserObjetsTriangleBrasSup() {
  supprimerLigneDeplacable(ligneG);
  supprimerLigneDeplacable(ligneA);
  if (marqueurSommetBrasSup) { anchor.remove(marqueurSommetBrasSup); marqueurSommetBrasSup = null; }
  if (traceEffortG) { anchor.remove(traceEffortG.fleche); traceEffortG = null; }
  if (traceEffortA) { anchor.remove(traceEffortA.fleche); traceEffortA = null; }
  if (flecheCorrigeG) { anchor.remove(flecheCorrigeG); flecheCorrigeG = null; }
  if (flecheCorrigeA) { anchor.remove(flecheCorrigeA); flecheCorrigeA = null; }
  glissementBrasSup = [null, null];
  manetteActiveEffortBrasSup = -1;

  var pF = positionMarqueurAncre('F'), pG = positionMarqueurAncre('G'), pA = positionMarqueurAncre('A');
  ligneG = creerLigneDeplacable(0xffd400, pG, pG.clone().sub(pF));
  ligneA = creerLigneDeplacable(0xffd400, pA, triangleInfoBrasSup.sommet.clone().sub(pA));

  etapeTriangleBrasSup = 'placer_droites';
}

function passerEnTriangleBrasSup() {
  triangleInfoBrasSup = calculerTriangleBrasSup();
  if (!triangleInfoBrasSup) { majPanneauBrasSup('Impossible de calculer le triangle (etape 6 incomplete).'); return; }

  etape = 'triangle_bras_sup';
  panneauPalette.visible = false;
  panneau.visible = true;

  if (traceG) { anchor.remove(traceG.fleche); traceG = null; }
  if (traceA) { anchor.remove(traceA.fleche); traceA = null; }
  if (guideFG) { anchor.remove(guideFG); guideFG = null; }
  if (guideAConcours) { anchor.remove(guideAConcours); guideAConcours = null; }
  if (marqueurConcoursBrasSup) { anchor.remove(marqueurConcoursBrasSup); marqueurConcoursBrasSup = null; }

  // flecheReactionC existe deja (tracee des l'entree dans l'etape 6, voir
  // passerEnIsolementBrasSup) : on se contente de la reactualiser plutot
  // que d'en recreer une, pour qu'elle reste le meme reperage visuel d'un
  // bout a l'autre de l'isolement du bras superieur.
  if (!flecheReactionC) { flecheReactionC = creerFleche(0x3ddc84, RAYON_FLECHE_FORCE); anchor.add(flecheReactionC); }
  majFleche(flecheReactionC, triangleInfoBrasSup.origineTriangle, triangleInfoBrasSup.pointeP);

  reinitialiserObjetsTriangleBrasSup();
  majPanneauTriangleBrasSup(null);
}

function recommencerTriangleBrasSup() {
  reinitialiserObjetsTriangleBrasSup();
  majPanneauTriangleBrasSup(null);
}

var SEQUENCE_TRIANGLE_BRASSUP = ['placer_droites', 'effort_G', 'effort_A', 'fini'];
function precedentTriangleBrasSup() {
  var i = SEQUENCE_TRIANGLE_BRASSUP.indexOf(etapeTriangleBrasSup);
  if (i > 0) { etapeTriangleBrasSup = SEQUENCE_TRIANGLE_BRASSUP[i - 1]; majPanneauTriangleBrasSup(null); return; }
  etape = 'isolement_bras_sup';
  etapeBrasSup = 'fini';
  majPanneauBrasSup(null);
}

function afficherReponseEchecTriangleBrasSup(id, titreSousEtape, detail, actionReessayer, actionVoirCorrige) {
  noterEchec(id);
  dessinerPanneau({
    eyebrow: EYEBROW_BRASSUP,
    titre: 'Réponse — ' + titreSousEtape,
    statut: { ok: false, titre: 'Pas encore juste', detail: detail },
    boutons: [
      bouton(0, 0, 'RÉESSAYER',       '#2f7d4f', actionReessayer),
      bouton(0, 1, 'VOIR LE CORRIGÉ', '#3a5f8a', function () { noterResultat(id, 'aide'); actionVoirCorrige(); }),
      bouton(0, 2, '< PRÉCÉDENT',     '#4a4a4a', precedentTriangleBrasSup)
    ],
    curseurs: curseursEpaisseurStandard()
  });
}

function reussirLignesTriangleBrasSup() {
  ligneG.ancrage.copy(triangleInfoBrasSup.pointeP);
  majLigneDeplacable(ligneG);
  ligneA.ancrage.copy(triangleInfoBrasSup.origineTriangle);
  majLigneDeplacable(ligneA);
  ligneG.mesh.userData.mat.color.set(0x3ddc84);
  ligneA.mesh.userData.mat.color.set(0x3ddc84);
  ligneG.poignee.material.color.set(0x3ddc84);
  ligneA.poignee.material.color.set(0x3ddc84);

  // Point de resolution place automatiquement, meme principe qu'a l'etape 3.
  if (marqueurSommetBrasSup) { anchor.remove(marqueurSommetBrasSup); }
  marqueurSommetBrasSup = new THREE.Mesh(
    new THREE.SphereGeometry(RAYON_MARQUEUR_POINT, 14, 14),
    new THREE.MeshBasicMaterial({ color: 0x3ddc84, depthTest: false })
  );
  marqueurSommetBrasSup.position.copy(triangleInfoBrasSup.sommet);
  marqueurSommetBrasSup.scale.setScalar(facteurPoint);
  anchor.add(marqueurSommetBrasSup);

  etapeTriangleBrasSup = 'effort_G';
  majPanneauTriangleBrasSup(null);
}
function validerLignesTriangleBrasSup() {
  var dG = distancePointDroite(triangleInfoBrasSup.pointeP, ligneG.ancrage, ligneG.direction);
  var dA = distancePointDroite(triangleInfoBrasSup.origineTriangle, ligneA.ancrage, ligneA.direction);
  if (dG <= TOL_LIGNE_TRIANGLE && dA <= TOL_LIGNE_TRIANGLE) { noterResultat('triangle_brasSup_droites'); reussirLignesTriangleBrasSup(); return; }
  var probleme = (dG > TOL_LIGNE_TRIANGLE && dA > TOL_LIGNE_TRIANGLE) ? 'Les deux droites ne passent pas encore par les extremites de la reaction en C'
    : (dG > TOL_LIGNE_TRIANGLE) ? 'La droite G ne passe pas encore par la pointe de la reaction en C'
    : 'La droite A ne passe pas encore par le talon de la reaction en C';
  afficherReponseEchecTriangleBrasSup('triangle_brasSup_droites', 'Placement des droites', probleme, function () { majPanneauTriangleBrasSup(null); }, reussirLignesTriangleBrasSup);
}

function reussirEffortG() {
  if (!traceEffortG) {
    var fEG = creerFleche(0x3ddc84, RAYON_FLECHE_FORCE);
    anchor.add(fEG);
    traceEffortG = { fleche: fEG, origine: triangleInfoBrasSup.pointeP.clone(), direction: null, arrivee: null };
  }
  majFleche(traceEffortG.fleche, traceEffortG.origine, triangleInfoBrasSup.sommet);
  traceEffortG.arrivee = triangleInfoBrasSup.sommet.clone();
  traceEffortG.direction = triangleInfoBrasSup.sommet.clone().sub(traceEffortG.origine).normalize();
  traceEffortG.fleche.userData.mat.color.set(0x3ddc84);
  etapeTriangleBrasSup = 'effort_A';
  majPanneauTriangleBrasSup(null);
}
function validerEffortG() {
  if (!traceEffortG || !traceEffortG.direction) { majPanneauTriangleBrasSup('Trace d\'abord l\'effort en G : gachette depuis la pointe de la reaction en C, jusqu\'au point de resolution.'); return; }
  var d = traceEffortG.arrivee.distanceTo(triangleInfoBrasSup.sommet);
  if (d <= TOL_EFFORT_TRIANGLE) { noterResultat('triangle_brasSup_effort_G'); reussirEffortG(); return; }
  traceEffortG.fleche.userData.mat.color.set(0xff5f5f);
  afficherReponseEchecTriangleBrasSup('triangle_brasSup_effort_G', 'Effort en G', 'Écart de ' + Math.round(d * 100) + ' cm avec le point de resolution',
    function () { majPanneauTriangleBrasSup(null); }, reussirEffortG);
}

function reussirEffortA() {
  if (!traceEffortA) {
    var fEA = creerFleche(0x3ddc84, RAYON_FLECHE_FORCE);
    anchor.add(fEA);
    traceEffortA = { fleche: fEA, origine: triangleInfoBrasSup.sommet.clone(), direction: null, arrivee: null };
  }
  majFleche(traceEffortA.fleche, traceEffortA.origine, triangleInfoBrasSup.origineTriangle);
  traceEffortA.arrivee = triangleInfoBrasSup.origineTriangle.clone();
  traceEffortA.direction = triangleInfoBrasSup.origineTriangle.clone().sub(traceEffortA.origine).normalize();
  traceEffortA.fleche.userData.mat.color.set(0x3ddc84);
  etapeTriangleBrasSup = 'fini';
  afficherResultatTriangleBrasSup();
}
function validerEffortA() {
  if (!traceEffortA || !traceEffortA.direction) { majPanneauTriangleBrasSup('Trace d\'abord l\'effort en A : gachette depuis le point de resolution, jusqu\'au talon de la reaction en C.'); return; }
  var d = traceEffortA.arrivee.distanceTo(triangleInfoBrasSup.origineTriangle);
  if (d <= TOL_EFFORT_TRIANGLE) { noterResultat('triangle_brasSup_effort_A'); reussirEffortA(); return; }
  traceEffortA.fleche.userData.mat.color.set(0xff5f5f);
  afficherReponseEchecTriangleBrasSup('triangle_brasSup_effort_A', 'Effort en A', 'Écart de ' + Math.round(d * 100) + ' cm avec le talon de la reaction en C',
    function () { majPanneauTriangleBrasSup(null); }, reussirEffortA);
}

// Affiche un corrige exact (le vrai triangle, tel que calcule) une fois les
// 2 efforts correctement traces : meme principe qu'a l'etape 5.
function afficherCorrigeTriangleBrasSup() {
  if (traceEffortG) traceEffortG.fleche.userData.mat.opacity = 0.35;
  if (traceEffortA) traceEffortA.fleche.userData.mat.opacity = 0.35;

  flecheCorrigeG = creerFleche(0x3ddc84, RAYON_FLECHE_FORCE);
  anchor.add(flecheCorrigeG);
  majFleche(flecheCorrigeG, triangleInfoBrasSup.pointeP, triangleInfoBrasSup.sommet);

  flecheCorrigeA = creerFleche(0x3ddc84, RAYON_FLECHE_FORCE);
  anchor.add(flecheCorrigeA);
  majFleche(flecheCorrigeA, triangleInfoBrasSup.sommet, triangleInfoBrasSup.origineTriangle);
}

function afficherResultatTriangleBrasSup() {
  afficherCorrigeTriangleBrasSup();
  dessinerPanneau({
    eyebrow: EYEBROW_BRASSUP,
    titre: 'Triangle des forces — résultat',
    statut: { ok: true, titre: 'Triangle complet : les 3 forces s’équilibrent' },
    corps: [
      { texte: 'Reaction en C ≈ ' + Math.round(triangleInfoBrasSup.poidsN) + ' N', couleur: '#dfeaf5' },
      { texte: 'Effort en G (levier) ≈ ' + Math.round(triangleInfoBrasSup.forceG_N) + ' N', couleur: '#dfeaf5' },
      { texte: 'Effort en A (bati) ≈ ' + Math.round(triangleInfoBrasSup.forceA_N) + ' N', couleur: '#dfeaf5' },
      { texte: 'Echelle : 1 cm = 200 N.', couleur: '#9fd0ff' }
    ],
    boutons: [
      bouton(0, 0, 'RECOMMENCER', '#7d4f2f', recommencerTriangleBrasSup),
      bouton(0, 1, 'VOIR LE BILAN', '#2f7d4f', passerEnBilan)
    ],
    curseurs: curseursEpaisseurStandard()
  });
}

function afficherAideTriangleBrasSup() {
  var corps;
  if (etapeTriangleBrasSup === 'placer_droites') {
    corps = [
      'La reaction en C est deja tracee (verte), a l\'echelle 1 cm = 200 N.',
      '',
      { texte: 'Attrape (grip) chaque droite jaune par sa poignee et fais-la glisser, sans la faire pivoter, jusqu\'a une extremite de cette reaction : la droite G par la pointe, la droite A par le talon.', couleur: '#9fd0ff' }
    ];
  } else if (etapeTriangleBrasSup === 'effort_G') {
    corps = [{ texte: 'Le point de resolution (croisement des 2 droites) est deja marque. Gachette maintenue depuis la pointe de la reaction en C, tire jusqu\'a ce point, relache. Le sens compte.', couleur: '#9fd0ff' }];
  } else {
    corps = [{ texte: 'Meme principe pour l\'effort en A, dans l\'autre sens : depuis le point de resolution, jusqu\'au talon de la reaction en C.', couleur: '#9fd0ff' }];
  }
  dessinerPanneau({
    eyebrow: EYEBROW_BRASSUP,
    titre: 'Aide',
    corps: corps,
    boutons: [ boutonLarge(0, 'RETOUR À LA QUESTION', '#2f7d4f', function () { majPanneauTriangleBrasSup(null); }) ]
  });
}

var TITRES_SOUS_TRIANGLE_BRASSUP = {
  placer_droites: 'Triangle des forces — placement des droites',
  effort_G:       'Triangle des forces — effort en G',
  effort_A:       'Triangle des forces — effort en A'
};

function majPanneauTriangleBrasSup(message) {
  var corps = [];
  if (etapeTriangleBrasSup === 'placer_droites') {
    corps.push('Forme le triangle des forces.');
  } else if (etapeTriangleBrasSup === 'effort_G') {
    corps.push('Trace le vecteur de l\'effort en G sur le triangle des forces.');
  } else if (etapeTriangleBrasSup === 'effort_A') {
    corps.push('Trace le vecteur de l\'effort en A sur le triangle des forces.');
  }
  corps.push({ texte: 'Echelle des forces : 1 cm = 200 N.', couleur: '#9fd0ff' });
  if (message) corps.push('', { texte: message, couleur: '#ff9f4a' });

  var boutons2 = [
    bouton(0, 0, '< PRÉCÉDENT', '#3a5f8a', precedentTriangleBrasSup),
    bouton(0, 1, 'RECOMMENCER', '#7d4f2f', recommencerTriangleBrasSup)
  ];
  if (etapeTriangleBrasSup === 'placer_droites') {
    boutons2.push(bouton(1, 0, 'VALIDER', '#2f7d4f', validerLignesTriangleBrasSup));
    boutons2.push(bouton(1, 1, 'SAUTER LA QUESTION', '#4a4a4a', function () { noterResultat('triangle_brasSup_droites', 'saute'); reussirLignesTriangleBrasSup(); }));
  } else if (etapeTriangleBrasSup === 'effort_G') {
    boutons2.push(bouton(1, 0, 'VALIDER', '#2f7d4f', validerEffortG));
    boutons2.push(bouton(1, 1, 'SAUTER LA QUESTION', '#4a4a4a', function () { noterResultat('triangle_brasSup_effort_G', 'saute'); reussirEffortG(); }));
  } else if (etapeTriangleBrasSup === 'effort_A') {
    boutons2.push(bouton(1, 0, 'VALIDER', '#2f7d4f', validerEffortA));
    boutons2.push(bouton(1, 1, 'SAUTER LA QUESTION', '#4a4a4a', function () { noterResultat('triangle_brasSup_effort_A', 'saute'); reussirEffortA(); }));
  }

  dessinerPanneau({
    eyebrow: EYEBROW_BRASSUP,
    titre: TITRES_SOUS_TRIANGLE_BRASSUP[etapeTriangleBrasSup],
    sousTitre: '4 / 4 dans cette étape',
    corps: corps,
    aide: afficherAideTriangleBrasSup,
    boutons: boutons2,
    curseurs: curseursEpaisseurStandard()
  });
}

// =====================================================================
//  SUIVI DE COMPETENCE
//
//  Pas de note chiffree : pour chaque question suivie, on retient juste
//  comment elle s'est terminee (reussie du premier coup, reussie apres
//  au moins un echec, corrige affiche sans avoir reussi, ou sautee),
//  puis on en tire un niveau par competence (0 a 5, rouge -> vert),
//  regroupe en 3 messages : "necessite de revoir le cours" (0-1),
//  "necessite de l'entrainement" (2-3), "competence maitrisee" (4-5).
// =====================================================================
var statsQuestions = {};   // id -> { essais: 0, resultat: null|'parfait'|'reessaye'|'aide'|'saute' }

function noterEchec(id) {
  if (!statsQuestions[id]) statsQuestions[id] = { essais: 0, resultat: null };
  statsQuestions[id].essais++;
}
// force omis : deduit des essais deja notes (reussite du premier coup ou apres coup).
function noterResultat(id, force) {
  if (!statsQuestions[id]) statsQuestions[id] = { essais: 0, resultat: null };
  var s = statsQuestions[id];
  s.resultat = force || (s.essais > 0 ? 'reessaye' : 'parfait');
}

var COMPETENCES = [
  { cle: 'liaisons',  nom: 'Classes d\'équivalence et liaisons',
    questions: ['coloriage'] },
  { cle: 'isolement', nom: 'Isolement et directions des efforts',
    questions: ['direction_D', 'concours_chape', 'direction_C', 'direction_G', 'concours_brasSup', 'direction_A'] },
  { cle: 'triangle',  nom: 'Triangle des forces',
    questions: ['triangle_chape_droites', 'triangle_chape_effort_D', 'triangle_chape_effort_C',
                'triangle_brasSup_droites', 'triangle_brasSup_effort_G', 'triangle_brasSup_effort_A'] }
];

function pointsQuestion(id) {
  var s = statsQuestions[id];
  if (!s || !s.resultat) return 0;   // jamais atteinte (ex: etape sautee via un chemin plus haut)
  if (s.resultat === 'parfait')  return 2;
  if (s.resultat === 'reessaye') return 1;
  return 0;   // 'aide' (corrige vu apres un echec) ou 'saute' : jamais reussie par l'etudiant lui-meme
}

// Niveau 0 (rouge, a revoir) a 5 (vert, maitrise) : 6 teintes degradees,
// 2 par message ("a revoir" / "entrainement" / "maitrisee").
var COULEURS_NIVEAU = ['#ff4d4d', '#ff8c42', '#ffb020', '#ffd93d', '#8bd450', '#3ddc84'];
var LIBELLES_NIVEAU = [
  'Nécessite de revoir le cours', 'Nécessite de revoir le cours',
  'Nécessite de l\'entraînement', 'Nécessite de l\'entraînement',
  'Compétence maîtrisée', 'Compétence maîtrisée'
];

function niveauCompetence(competence) {
  var total = competence.questions.reduce(function (acc, id) { return acc + pointsQuestion(id); }, 0);
  var moyenne = total / competence.questions.length;   // 0 a 2
  return Math.min(5, Math.floor((moyenne / 2) * 6));
}

// =====================================================================
//  ETAPE 8 : BILAN
//
//  Revue guidee (SUIVANT/PRECEDENT, pas de gachette a utiliser) des 5
//  grandes phases du raisonnement, chacune avec les tracés qui apparaissent
//  en s'animant (grandissent depuis leur origine). Tout est recalcule a
//  partir des donnees deja connues (points, pointConcoursVrai, triangleInfo,
//  pointConcoursVraiBrasSup, triangleInfoBrasSup) : aucune dependance aux
//  objets des etapes 4 a 7, qui ont deja ete effaces en cours de route.
// =====================================================================
var DUREE_ANIMATION_BILAN = 800;   // ms
var etapeBilan = 0;
var animationBilan = null;   // { debut, duree, objets:[{type, mesh, origine, cible}] }

var bilanFlecheP = null;
var bilanGuideBD = null, bilanMarqueurConcours = null, bilanGuideCConcours = null;
var bilanFlecheEffortD = null, bilanFlecheEffortC = null;
var bilanGuideFG = null, bilanMarqueurConcoursBS = null, bilanGuideAConcours = null;
var bilanFlecheEffortG = null, bilanFlecheEffortA = null;

var EYEBROW_BILAN = 'Étape 5 — Bilan';
var TITRES_BILAN = [
  '1. Le poids de la charge',
  '2. Isolement de la chape',
  '3. Triangle des forces (chape)',
  '4. Isolement du bras supérieur',
  '5. Triangle des forces (bras supérieur)',
  'Vue d\'ensemble',
  'Compétences'
];
var ETAPE_BILAN_COMPETENCES = TITRES_BILAN.length - 1;

function restaurerOpaciteComplete() {
  piecesModele.forEach(function (p) { p.meshes.forEach(function (m) { m.material.opacity = 1; }); });
}

function supprimerObjetsBilan() {
  [bilanFlecheP, bilanGuideBD, bilanMarqueurConcours, bilanGuideCConcours,
   bilanFlecheEffortD, bilanFlecheEffortC, bilanGuideFG, bilanMarqueurConcoursBS,
   bilanGuideAConcours, bilanFlecheEffortG, bilanFlecheEffortA].forEach(function (o) { if (o) anchor.remove(o); });
  bilanFlecheP = null;
  bilanGuideBD = null; bilanMarqueurConcours = null; bilanGuideCConcours = null;
  bilanFlecheEffortD = null; bilanFlecheEffortC = null;
  bilanGuideFG = null; bilanMarqueurConcoursBS = null; bilanGuideAConcours = null;
  bilanFlecheEffortG = null; bilanFlecheEffortA = null;
  animationBilan = null;
}

function demarrerAnimationPhase(objets) {
  // Si une animation precedente etait encore en cours (clic rapide sur
  // SUIVANT), on la termine instantanement plutot que de laisser un trace
  // fige a moitie grandi.
  if (animationBilan) {
    animationBilan.objets.forEach(function (o) {
      if (o.type === 'fleche') majFleche(o.mesh, o.origine, o.cible);
      else if (o.type === 'trait') majTraitSimple(o.mesh, o.origine, o.cible);
      else if (o.type === 'point') o.mesh.scale.setScalar(facteurPoint);
    });
  }
  animationBilan = { debut: performance.now(), duree: DUREE_ANIMATION_BILAN, objets: objets };
}

// Cree (si besoin) et anime les objets propres a la phase etapeBilan.
function reveelerPhaseBilan() {
  if (etapeBilan === 0) {
    restaurerOpaciteComplete();
    bilanFlecheP = creerFleche(0x3ddc84, RAYON_FLECHE_FORCE);
    anchor.add(bilanFlecheP);
    demarrerAnimationPhase([
      { type: 'fleche', mesh: bilanFlecheP, origine: triangleInfo.origineTriangle, cible: triangleInfo.pointeP }
    ]);
  } else if (etapeBilan === 1) {
    mettreEnEvidence('chape_2');
    var pB1 = positionMarqueurAncre('B'), pD1 = positionMarqueurAncre('D'), pC1 = positionMarqueurAncre('C');
    bilanGuideBD = creerTraitSimple(0x00aeef, RAYON_LIGNE_GUIDE);
    anchor.add(bilanGuideBD);
    bilanGuideCConcours = creerTraitSimple(0x00aeef, RAYON_LIGNE_GUIDE);
    anchor.add(bilanGuideCConcours);
    bilanMarqueurConcours = new THREE.Mesh(
      new THREE.SphereGeometry(RAYON_MARQUEUR_POINT, 14, 14),
      new THREE.MeshBasicMaterial({ color: 0x00aeef, depthTest: false })
    );
    bilanMarqueurConcours.position.copy(pointConcoursVrai);
    bilanMarqueurConcours.scale.setScalar(0);
    anchor.add(bilanMarqueurConcours);
    demarrerAnimationPhase([
      { type: 'trait', mesh: bilanGuideBD, origine: pB1, cible: pD1 },
      { type: 'trait', mesh: bilanGuideCConcours, origine: pC1, cible: pointConcoursVrai },
      { type: 'point', mesh: bilanMarqueurConcours }
    ]);
  } else if (etapeBilan === 2) {
    bilanFlecheEffortD = creerFleche(0x3ddc84, RAYON_FLECHE_FORCE);
    anchor.add(bilanFlecheEffortD);
    bilanFlecheEffortC = creerFleche(0x3ddc84, RAYON_FLECHE_FORCE);
    anchor.add(bilanFlecheEffortC);
    demarrerAnimationPhase([
      { type: 'fleche', mesh: bilanFlecheEffortD, origine: triangleInfo.pointeP, cible: triangleInfo.sommet },
      { type: 'fleche', mesh: bilanFlecheEffortC, origine: triangleInfo.sommet, cible: triangleInfo.origineTriangle }
    ]);
  } else if (etapeBilan === 3) {
    mettreEnEvidence('bras_assemblé');
    var pF3 = positionMarqueurAncre('F'), pG3 = positionMarqueurAncre('G'), pA3 = positionMarqueurAncre('A');
    bilanGuideFG = creerTraitSimple(0x00aeef, RAYON_LIGNE_GUIDE);
    anchor.add(bilanGuideFG);
    bilanGuideAConcours = creerTraitSimple(0x00aeef, RAYON_LIGNE_GUIDE);
    anchor.add(bilanGuideAConcours);
    bilanMarqueurConcoursBS = new THREE.Mesh(
      new THREE.SphereGeometry(RAYON_MARQUEUR_POINT, 14, 14),
      new THREE.MeshBasicMaterial({ color: 0x00aeef, depthTest: false })
    );
    bilanMarqueurConcoursBS.position.copy(pointConcoursVraiBrasSup);
    bilanMarqueurConcoursBS.scale.setScalar(0);
    anchor.add(bilanMarqueurConcoursBS);
    demarrerAnimationPhase([
      { type: 'trait', mesh: bilanGuideFG, origine: pF3, cible: pG3 },
      { type: 'trait', mesh: bilanGuideAConcours, origine: pA3, cible: pointConcoursVraiBrasSup },
      { type: 'point', mesh: bilanMarqueurConcoursBS }
    ]);
  } else if (etapeBilan === 4) {
    bilanFlecheEffortG = creerFleche(0x3ddc84, RAYON_FLECHE_FORCE);
    anchor.add(bilanFlecheEffortG);
    bilanFlecheEffortA = creerFleche(0x3ddc84, RAYON_FLECHE_FORCE);
    anchor.add(bilanFlecheEffortA);
    demarrerAnimationPhase([
      { type: 'fleche', mesh: bilanFlecheEffortG, origine: triangleInfoBrasSup.pointeP, cible: triangleInfoBrasSup.sommet },
      { type: 'fleche', mesh: bilanFlecheEffortA, origine: triangleInfoBrasSup.sommet, cible: triangleInfoBrasSup.origineTriangle }
    ]);
  } else {
    // Vue d'ensemble : rien de nouveau a tracer, tout est deja affiche.
    restaurerOpaciteComplete();
  }
}

function passerEnBilan() {
  etape = 'bilan';
  panneauPalette.visible = false;
  panneau.visible = true;

  // L'etape 7 est terminee : on efface ses objets et on remet tout le
  // mecanisme visible, le bilan etant une vue d'ensemble et non plus
  // l'isolement d'une seule piece.
  if (flecheReactionC) { anchor.remove(flecheReactionC); flecheReactionC = null; }
  supprimerLigneDeplacable(ligneG); ligneG = null;
  supprimerLigneDeplacable(ligneA); ligneA = null;
  if (marqueurSommetBrasSup) { anchor.remove(marqueurSommetBrasSup); marqueurSommetBrasSup = null; }
  if (traceEffortG) { anchor.remove(traceEffortG.fleche); traceEffortG = null; }
  if (traceEffortA) { anchor.remove(traceEffortA.fleche); traceEffortA = null; }
  if (flecheCorrigeG) { anchor.remove(flecheCorrigeG); flecheCorrigeG = null; }
  if (flecheCorrigeA) { anchor.remove(flecheCorrigeA); flecheCorrigeA = null; }

  demarrerBilan();
}

// (Re)demarre la revue depuis le debut : entree dans l'etape et bouton REVOIR.
function demarrerBilan() {
  supprimerObjetsBilan();
  etapeBilan = 0;
  reveelerPhaseBilan();
  majPanneauBilan();
}

function suivantBilan() {
  if (etapeBilan >= ETAPE_BILAN_COMPETENCES) return;
  etapeBilan++;
  reveelerPhaseBilan();
  majPanneauBilan();
}

function precedentBilan() {
  if (etapeBilan <= 0) return;
  etapeBilan--;   // navigation pure : ce qui a deja ete revele le reste
  majPanneauBilan();
}

function majPanneauBilan() {
  var corps = [];
  if (etapeBilan === 0) {
    corps.push('La charge de ' + MASSE_CHARGE_KG + ' kg s\'applique au point H, verticalement vers le bas.');
    corps.push({ texte: 'P = m·g = ' + MASSE_CHARGE_KG + ' × ' + G + ' ≈ ' + Math.round(triangleInfo.poidsN) + ' N', couleur: '#dfeaf5' });
  } else if (etapeBilan === 1) {
    corps.push('La chape est soumise a 3 forces non paralleles (P, et les reactions en D et C) : leurs lignes d\'action sont concourantes.');
    corps.push('Le bras inferieur, piece a 2 forces, donne directement la direction en D. Le point de concours (intersection avec la verticale de P) donne alors la direction en C.');
  } else if (etapeBilan === 2) {
    corps.push('Le triangle des forces sur la chape (P, effort D, effort C, trace bout a bout) donne les intensites :');
    corps.push({ texte: 'Effort en D (bras inferieur) ≈ ' + Math.round(triangleInfo.forceD_N) + ' N', couleur: '#dfeaf5' });
    corps.push({ texte: 'Effort en C (bras superieur) ≈ ' + Math.round(triangleInfo.forceC_N) + ' N', couleur: '#dfeaf5' });
  } else if (etapeBilan === 3) {
    corps.push('Sur le bras superieur : la reaction en C est connue par action/reaction avec l\'effort calcule a l\'etape precedente.');
    corps.push('Le levier, piece a 2 forces, donne directement la direction en G. Le point de concours donne alors la direction en A.');
  } else if (etapeBilan === 4) {
    corps.push('Le triangle des forces sur le bras superieur donne les intensites :');
    corps.push({ texte: 'Effort en G (levier) ≈ ' + Math.round(triangleInfoBrasSup.forceG_N) + ' N', couleur: '#dfeaf5' });
    corps.push({ texte: 'Effort en A (bati) ≈ ' + Math.round(triangleInfoBrasSup.forceA_N) + ' N', couleur: '#dfeaf5' });
  } else if (etapeBilan === 5) {
    corps.push('Recapitulatif complet :');
    corps.push({ texte: 'Poids P                      ≈ ' + Math.round(triangleInfo.poidsN) + ' N', couleur: '#dfeaf5' });
    corps.push({ texte: 'Effort en D (bras inferieur)  ≈ ' + Math.round(triangleInfo.forceD_N) + ' N', couleur: '#dfeaf5' });
    corps.push({ texte: 'Effort en C (bras superieur)  ≈ ' + Math.round(triangleInfo.forceC_N) + ' N', couleur: '#dfeaf5' });
    corps.push({ texte: 'Effort en G (levier)          ≈ ' + Math.round(triangleInfoBrasSup.forceG_N) + ' N', couleur: '#dfeaf5' });
    corps.push({ texte: 'Effort en A (bati)             ≈ ' + Math.round(triangleInfoBrasSup.forceA_N) + ' N', couleur: '#dfeaf5' });
  } else {
    corps.push('Niveau estime sur les 3 grandes competences de l\'exercice (base sur tes reussites, essais et questions sautees) :');
    corps.push('');
    COMPETENCES.forEach(function (comp) {
      var niveau = niveauCompetence(comp);
      corps.push({ texte: comp.nom + ' : ' + LIBELLES_NIVEAU[niveau], couleur: COULEURS_NIVEAU[niveau] });
    });
  }
  if (etapeBilan !== ETAPE_BILAN_COMPETENCES) {
    corps.push('');
    corps.push({ texte: 'Echelle des forces : 1 cm = 200 N.', couleur: '#9fd0ff' });
  }

  var boutons2 = [
    bouton(0, 0, '< PRECEDENT', '#3a5f8a', precedentBilan),
    bouton(0, 1, 'SUIVANT >',   '#3a5f8a', suivantBilan)
  ];
  if (etapeBilan === ETAPE_BILAN_COMPETENCES) boutons2.push(bouton(0, 2, 'REVOIR', '#4a4a4a', demarrerBilan));

  dessinerPanneau({
    eyebrow: EYEBROW_BILAN,
    titre: TITRES_BILAN[etapeBilan],
    sousTitre: (etapeBilan + 1) + ' / ' + TITRES_BILAN.length,
    corps: corps,
    boutons: boutons2,
    curseurs: curseursEpaisseurStandard()
  });
}

// =====================================================================
//  PANNEAU EN MODE PLACEMENT
// =====================================================================
var EYEBROW_LIAISONS = 'Étape 2 — Modélisation du système';

function afficherAideLiaisons() {
  dessinerPanneau({
    eyebrow: EYEBROW_LIAISONS,
    titre: 'Aide',
    corps: [
      'Une liaison correspond a un point ou deux pieces se touchent et peuvent tourner l\'une par rapport a l\'autre (un pivot).',
      '',
      { texte: 'Vise le centre de ce contact sur le modele, au plus pres, gachette pour le figer. Tu peux corriger un point deja place en le revisant.', couleur: '#9fd0ff' }
    ],
    boutons: [ boutonLarge(0, 'RETOUR À LA QUESTION', '#2f7d4f', function () { majPanneau(null); }) ]
  });
}

function majPanneau(message) {
  var pt = points[courant];
  var corps = [
    { texte: pt.nom, couleur: '#ffe37a' },
    { texte: 'Il faut maintenant situer les centres des liaisons entre classes d\'equivalence. Vise un point sur l\'axe de la liaison et clique sur la gachette pour le selectionner. Un point apparaitra sur le plan median du cric.', couleur: '#cfd8e6' },
    { texte: pt.pos ? 'Deja place. Rappuie pour le corriger.' : 'Pas encore place.', couleur: '#9fd0ff' }
  ];
  if (message) corps.push('', { texte: message, couleur: '#ff9f4a' });

  dessinerPanneau({
    eyebrow: EYEBROW_LIAISONS,
    titre: 'Question',
    sousTitre: 'Point ' + (courant + 1) + ' / ' + points.length + '  ·  ' + nbPlaces() + ' / ' + points.length + ' places',
    corps: corps,
    aide: afficherAideLiaisons,
    boutons: [
      bouton(0, 0, '< PRECEDENT', '#3a5f8a', precedent),
      bouton(0, 1, 'VALIDER',     '#2f7d4f', validerPoint),
      bouton(0, 2, 'ANNULER',     '#3a5f8a', annulerDerniere)
    ],
    curseurs: curseursEpaisseurStandard()
  });
}

function passerEnPlacement() {
  etape = 'liaisons';
  panneauPalette.visible = false;
  panneau.visible = true;
  rafraichirTousMarqueurs();
  majPanneau(null);
}

// =====================================================================
//  MANETTES : viser le modele, gachette pour poser
// =====================================================================
var controllers = [renderer.xr.getController(0), renderer.xr.getController(1)];
var rayon = new THREE.Raycaster();
var mat4 = new THREE.Matrix4();
var grabs = [null, null];   // groupePanneaux actuellement tenu par chaque manette, ou null

// --- Prehension du systeme : 1 grip = attrape et positionne librement
// (position ET orientation suivent la main, via ctrl.attach), 2 grips =
// zoom (l'ecart entre les mains pilote l'echelle).
var grabSysteme = [false, false];   // manette(s) qui tiennent actuellement le systeme
var zoomBase    = null;             // { distance, echelle } au moment ou la 2e main attrape
var ECHELLE_MIN = 0.4, ECHELLE_MAX = 2.5;

// Reticule : petit anneau qui suit le point vise sur le modele.
var reticuleVisee = new THREE.Mesh(
  new THREE.RingGeometry(0.006, 0.009, 20),
  new THREE.MeshBasicMaterial({ color: 0x00aeef, side: THREE.DoubleSide, depthTest: false })
);
reticuleVisee.renderOrder = 950;
reticuleVisee.visible = false;
scene.add(reticuleVisee);

var derniereVisee = null;   // { point: Vector3(monde), nomMesh: string } ou null

controllers.forEach(function (ctrl, idx) {
  scene.add(ctrl);
  var pointeManette = new THREE.Mesh(
    new THREE.SphereGeometry(0.008, 10, 10),
    new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false })
  );
  pointeManette.renderOrder = 999;   // toujours dessinee au-dessus (jamais cachee par le modele/un panneau)
  ctrl.add(pointeManette);
  var ligne = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0x00aeef, transparent: true, opacity: 0.5 })
  );
  ligne.scale.z = 3;
  ctrl.add(ligne);

  ctrl.addEventListener('selectstart', function () {
    if (!modeleCharge) return;   // rien a faire tant que le modele charge (reseau lent)

    if (panneau.visible && testerPanneau(ctrl, idx)) return;
    if (panneauPalette.visible && testerPalette(ctrl, idx)) return;

    if (etape === 'coloriage') {
      // Visee recalculee ICI, depuis LA manette qui vient d'appuyer (et non
      // depuis l'etat partage derniereVisee, mis a jour une fois par frame
      // pour une seule manette a la fois : sinon peindre avec la "mauvaise"
      // main ne faisait rien, voir calculerVisee).
      var viseeColoriage = calculerVisee(ctrl);
      if (viseeColoriage && viseeColoriage.pieceIdx !== null) {
        peindrePiece(viseeColoriage.pieceIdx);
      } else {
        majPanneauColoriage('Vise une piece du modele avec le rayon bleu.');
      }
      return;
    }

    if (etape === 'forces') {
      if (traceForce) return;   // deja en cours (2e appui accidentel) : on ignore
      var pt = pointParLettre('H');
      if (!pt || !pt.pos) { majPanneauForces('Le point H (charge) n\'a pas ete place a l\'etape precedente.'); return; }
      var origineF = versAncre(projeterLocal(pt.pos));
      var f = creerFleche(0xffd400, RAYON_FLECHE_FORCE);
      anchor.add(f);
      traceForce = { fleche: f, origine: origineF, direction: null };
      manetteActiveForce = idx;
      return;
    }

    if (etape === 'isolement_chape') {
      if (etapeChape === 'direction_D') {
        if (traceD) return;
        var origineD = positionMarqueurAncre('D');
        if (!origineD) { majPanneauChape('Point D introuvable.'); return; }
        var fD = creerTraitSimple(0xffd400, RAYON_TRAIT_DIRECTION);
        anchor.add(fD);
        traceD = { fleche: fD, origine: origineD, direction: null };
        manetteActiveChape = idx;
        return;
      }
      if (etapeChape === 'concours') {
        if (pointConcoursTrouve) return;   // deja pose : il faut RECOMMENCER pour reessayer
        var wpConcours = new THREE.Vector3();
        ctrl.getWorldPosition(wpConcours);
        pointConcoursTrouve = versAncre(projeterLocal(racine.worldToLocal(wpConcours)));
        marqueurConcours = new THREE.Mesh(
          new THREE.SphereGeometry(RAYON_MARQUEUR_POINT, 14, 14),
          new THREE.MeshBasicMaterial({ color: 0xffd400, depthTest: false })
        );
        marqueurConcours.position.copy(pointConcoursTrouve);
        marqueurConcours.scale.setScalar(facteurPoint);
        anchor.add(marqueurConcours);
        majPanneauChape(null);
        return;
      }
      if (etapeChape === 'direction_C') {
        if (traceC) return;
        var origineC = positionMarqueurAncre('C');
        if (!origineC) { majPanneauChape('Point C introuvable.'); return; }
        var fC = creerTraitSimple(0xffd400, RAYON_TRAIT_DIRECTION);
        anchor.add(fC);
        traceC = { fleche: fC, origine: origineC, direction: null };
        manetteActiveChape = idx;
        return;
      }
      return;   // etapeChape === 'fini' : plus rien a tracer
    }

    if (etape === 'triangle') {
      if (etapeTriangle === 'placer_droites') return;   // rien a faire ici, seul le grip agit

      if (etapeTriangle === 'effort_D') {
        if (traceEffortD) return;
        var fED = creerFleche(0xffd400, RAYON_FLECHE_FORCE);
        anchor.add(fED);
        traceEffortD = { fleche: fED, origine: triangleInfo.pointeP.clone(), direction: null, arrivee: null };
        manetteActiveEffort = idx;
        return;
      }

      if (etapeTriangle === 'effort_C') {
        if (traceEffortC) return;
        var fEC = creerFleche(0xffd400, RAYON_FLECHE_FORCE);
        anchor.add(fEC);
        traceEffortC = { fleche: fEC, origine: marqueurSommet.position.clone(), direction: null, arrivee: null };
        manetteActiveEffort = idx;
        return;
      }

      return;   // etapeTriangle === 'fini' : plus rien a tracer
    }

    if (etape === 'isolement_bras_sup') {
      if (etapeBrasSup === 'direction_G') {
        if (traceG) return;
        var origineG = positionMarqueurAncre('G');
        if (!origineG) { majPanneauBrasSup('Point G introuvable.'); return; }
        var fG = creerTraitSimple(0xffd400, RAYON_TRAIT_DIRECTION);
        anchor.add(fG);
        traceG = { fleche: fG, origine: origineG, direction: null };
        manetteActiveBrasSup = idx;
        return;
      }
      if (etapeBrasSup === 'concours') {
        if (pointConcoursTrouveBrasSup) return;   // deja pose : il faut RECOMMENCER pour reessayer
        var wpConcoursBS = new THREE.Vector3();
        ctrl.getWorldPosition(wpConcoursBS);
        pointConcoursTrouveBrasSup = versAncre(projeterLocal(racine.worldToLocal(wpConcoursBS)));
        marqueurConcoursBrasSup = new THREE.Mesh(
          new THREE.SphereGeometry(RAYON_MARQUEUR_POINT, 14, 14),
          new THREE.MeshBasicMaterial({ color: 0xffd400, depthTest: false })
        );
        marqueurConcoursBrasSup.position.copy(pointConcoursTrouveBrasSup);
        marqueurConcoursBrasSup.scale.setScalar(facteurPoint);
        anchor.add(marqueurConcoursBrasSup);
        majPanneauBrasSup(null);
        return;
      }
      if (etapeBrasSup === 'direction_A') {
        if (traceA) return;
        var origineA = positionMarqueurAncre('A');
        if (!origineA) { majPanneauBrasSup('Point A introuvable.'); return; }
        var fA = creerTraitSimple(0xffd400, RAYON_TRAIT_DIRECTION);
        anchor.add(fA);
        traceA = { fleche: fA, origine: origineA, direction: null };
        manetteActiveBrasSup = idx;
        return;
      }
      return;   // etapeBrasSup === 'fini' : plus rien a tracer
    }

    if (etape === 'triangle_bras_sup') {
      if (etapeTriangleBrasSup === 'placer_droites') return;   // rien a faire ici, seul le grip agit

      if (etapeTriangleBrasSup === 'effort_G') {
        if (traceEffortG) return;
        var fEG = creerFleche(0xffd400, RAYON_FLECHE_FORCE);
        anchor.add(fEG);
        traceEffortG = { fleche: fEG, origine: triangleInfoBrasSup.pointeP.clone(), direction: null, arrivee: null };
        manetteActiveEffortBrasSup = idx;
        return;
      }

      if (etapeTriangleBrasSup === 'effort_A') {
        if (traceEffortA) return;
        var fEA = creerFleche(0xffd400, RAYON_FLECHE_FORCE);
        anchor.add(fEA);
        traceEffortA = { fleche: fEA, origine: marqueurSommetBrasSup.position.clone(), direction: null, arrivee: null };
        manetteActiveEffortBrasSup = idx;
        return;
      }

      return;   // etapeTriangleBrasSup === 'fini' : plus rien a tracer
    }

    // etape === 'liaisons' : poser le point courant a l'endroit vise.
    // Garde explicite : sans elle, un clic gachette pendant une autre etape
    // (par ex. le triangle, avant l'ajout du bloc ci-dessus) retombait ici
    // par defaut et posait un point parasite (bug remonte par l'utilisateur).
    if (etape !== 'liaisons') return;

    // Visee recalculee ici, depuis LA manette qui vient d'appuyer (voir
    // calculerVisee : meme raison que pour le coloriage ci-dessus).
    var viseeLiaison = calculerVisee(ctrl);
    if (viseeLiaison) {
      var i = courant;
      var ancienPos  = points[i].pos ? points[i].pos.clone() : null;
      var ancienMesh = points[i].meshProche;
      pousserAnnulation(function () {
        points[i].pos = ancienPos;
        points[i].meshProche = ancienMesh;
        majMarqueur(i);
        allerA(i);
      });
      points[courant].pos = racine.worldToLocal(viseeLiaison.point.clone());
      points[courant].meshProche = viseeLiaison.nomMesh;
      majMarqueur(courant);
      majPanneau(null);   // reste sur ce point : c'est VALIDER qui fait avancer
    } else {
      majPanneau('Vise une surface du modele avec le rayon bleu.');
    }
  });

  // Relachement d'un curseur d'epaisseur (etapes 2 a 5) : inconditionnel,
  // sans lien avec l'etape en cours (le curseur peut etre glisse depuis
  // n'importe quel panneau qui en affiche).
  ctrl.addEventListener('selectend', function () {
    curseurActif[idx] = null;
  });

  // Fin du trace du vecteur force (etape 3) : releve la position finale et
  // fige la fleche telle quelle (trait "grossier", pas d'accrochage).
  ctrl.addEventListener('selectend', function () {
    if (etape !== 'forces' || !traceForce || manetteActiveForce !== idx) return;
    var wp = new THREE.Vector3();
    ctrl.getWorldPosition(wp);
    var pAncre = versAncre(projeterLocal(racine.worldToLocal(wp)));
    if (traceForce.origine.distanceTo(pAncre) < LONGUEUR_MIN_FORCE) {
      anchor.remove(traceForce.fleche);
      traceForce = null;
      manetteActiveForce = -1;
      majPanneauForces('Trace trop court, recommence.');
      return;
    }
    majFleche(traceForce.fleche, traceForce.origine, pAncre);
    traceForce.direction = pAncre.clone().sub(traceForce.origine).normalize();
    manetteActiveForce = -1;
    majPanneauForces(null);
  });

  // Fin des traces de direction de l'etape 4 (D puis C), meme principe que
  // le trace du poids : la fleche suit la manette jusqu'au relachement.
  ctrl.addEventListener('selectend', function () {
    if (etape !== 'isolement_chape' || manetteActiveChape !== idx) return;
    var traceActive = (etapeChape === 'direction_D') ? traceD : (etapeChape === 'direction_C') ? traceC : null;
    if (!traceActive) return;

    var wpC = new THREE.Vector3();
    ctrl.getWorldPosition(wpC);
    var pAncreC = versAncre(projeterLocal(racine.worldToLocal(wpC)));

    if (traceActive.origine.distanceTo(pAncreC) < LONGUEUR_MIN_FORCE) {
      anchor.remove(traceActive.fleche);
      if (etapeChape === 'direction_D') traceD = null; else traceC = null;
      manetteActiveChape = -1;
      majPanneauChape('Trace trop court, recommence.');
      return;
    }
    majTraitSimple(traceActive.fleche, traceActive.origine, pAncreC);
    traceActive.direction = pAncreC.clone().sub(traceActive.origine).normalize();
    manetteActiveChape = -1;
    majPanneauChape(null);
  });

  // Fin des traces d'effort de l'etape 5 (D puis C) : meme principe, mais
  // avec une fleche (le sens compte desormais) et une origine fixee (pointe
  // de P ou point de resolution), pas celle de la manette. On garde aussi
  // le point d'arrivee exact (arrivee) : c'est lui qui sera compare au
  // point de resolution pour valider le trace (voir validerEffortD/C).
  ctrl.addEventListener('selectend', function () {
    if (etape !== 'triangle' || manetteActiveEffort !== idx) return;
    var traceActifEffort = (etapeTriangle === 'effort_D') ? traceEffortD : (etapeTriangle === 'effort_C') ? traceEffortC : null;
    if (!traceActifEffort) return;

    var wpE = new THREE.Vector3();
    ctrl.getWorldPosition(wpE);
    var pAncreE = versAncre(projeterLocal(racine.worldToLocal(wpE)));

    if (traceActifEffort.origine.distanceTo(pAncreE) < LONGUEUR_MIN_FORCE) {
      anchor.remove(traceActifEffort.fleche);
      if (etapeTriangle === 'effort_D') traceEffortD = null; else traceEffortC = null;
      manetteActiveEffort = -1;
      majPanneauTriangle('Trace trop court, recommence.');
      return;
    }
    majFleche(traceActifEffort.fleche, traceActifEffort.origine, pAncreE);
    traceActifEffort.direction = pAncreE.clone().sub(traceActifEffort.origine).normalize();
    traceActifEffort.arrivee = pAncreE.clone();
    manetteActiveEffort = -1;
    majPanneauTriangle(null);
  });

  // Fin des traces de direction de l'etape 6 (G puis A), meme principe
  // qu'a l'etape 4.
  ctrl.addEventListener('selectend', function () {
    if (etape !== 'isolement_bras_sup' || manetteActiveBrasSup !== idx) return;
    var traceActiveBS = (etapeBrasSup === 'direction_G') ? traceG : (etapeBrasSup === 'direction_A') ? traceA : null;
    if (!traceActiveBS) return;

    var wpBS = new THREE.Vector3();
    ctrl.getWorldPosition(wpBS);
    var pAncreBS = versAncre(projeterLocal(racine.worldToLocal(wpBS)));

    if (traceActiveBS.origine.distanceTo(pAncreBS) < LONGUEUR_MIN_FORCE) {
      anchor.remove(traceActiveBS.fleche);
      if (etapeBrasSup === 'direction_G') traceG = null; else traceA = null;
      manetteActiveBrasSup = -1;
      majPanneauBrasSup('Trace trop court, recommence.');
      return;
    }
    majTraitSimple(traceActiveBS.fleche, traceActiveBS.origine, pAncreBS);
    traceActiveBS.direction = pAncreBS.clone().sub(traceActiveBS.origine).normalize();
    manetteActiveBrasSup = -1;
    majPanneauBrasSup(null);
  });

  // Fin des traces d'effort de l'etape 7 (G puis A), meme principe qu'a
  // l'etape 5.
  ctrl.addEventListener('selectend', function () {
    if (etape !== 'triangle_bras_sup' || manetteActiveEffortBrasSup !== idx) return;
    var traceActifEffortBS = (etapeTriangleBrasSup === 'effort_G') ? traceEffortG : (etapeTriangleBrasSup === 'effort_A') ? traceEffortA : null;
    if (!traceActifEffortBS) return;

    var wpEBS = new THREE.Vector3();
    ctrl.getWorldPosition(wpEBS);
    var pAncreEBS = versAncre(projeterLocal(racine.worldToLocal(wpEBS)));

    if (traceActifEffortBS.origine.distanceTo(pAncreEBS) < LONGUEUR_MIN_FORCE) {
      anchor.remove(traceActifEffortBS.fleche);
      if (etapeTriangleBrasSup === 'effort_G') traceEffortG = null; else traceEffortA = null;
      manetteActiveEffortBrasSup = -1;
      majPanneauTriangleBrasSup('Trace trop court, recommence.');
      return;
    }
    majFleche(traceActifEffortBS.fleche, traceActifEffortBS.origine, pAncreEBS);
    traceActifEffortBS.direction = pAncreEBS.clone().sub(traceActifEffortBS.origine).normalize();
    traceActifEffortBS.arrivee = pAncreEBS.clone();
    manetteActiveEffortBrasSup = -1;
    majPanneauTriangleBrasSup(null);
  });

  // Grip (prehension) : attraper le GROUPE des 2 panneaux (ils bougent
  // toujours ensemble) pour le repositionner, sinon attraper le systeme
  // lui-meme pour le positionner librement (1 main) ou le zoomer (2 mains).
  // Les deux sont totalement independants l'un de l'autre : deplacer l'un
  // ne deplace jamais l'autre.
  ctrl.addEventListener('squeezestart', function () {
    mat4.identity().extractRotation(ctrl.matrixWorld);
    rayon.ray.origin.setFromMatrixPosition(ctrl.matrixWorld);
    rayon.ray.direction.set(0, 0, -1).applyMatrix4(mat4);

    var cibles = [];
    if (panneau.visible) cibles.push(panneau);
    if (panneauPalette.visible) cibles.push(panneauPalette);
    var hits = rayon.intersectObjects(cibles, false);
    if (hits.length) {
      grabs[idx] = groupePanneaux;
      ctrl.attach(groupePanneaux);
      return;
    }

    // Etape 5 (phase de placement) : attraper la poignee de la droite D ou
    // C pour la faire glisser (translation libre, orientation figee).
    if (etape === 'triangle' && etapeTriangle === 'placer_droites' && ligneD && ligneC) {
      var cibleTriangle = [ligneD.poignee, ligneC.poignee];
      var hitsTriangle = rayon.intersectObjects(cibleTriangle, false);
      if (hitsTriangle.length) {
        glissement[idx] = (hitsTriangle[0].object === ligneD.poignee) ? 'D' : 'C';
        return;
      }
    }

    // Etape 7 (phase de placement), meme principe pour les droites G/A.
    if (etape === 'triangle_bras_sup' && etapeTriangleBrasSup === 'placer_droites' && ligneG && ligneA) {
      var cibleTriangleBS = [ligneG.poignee, ligneA.poignee];
      var hitsTriangleBS = rayon.intersectObjects(cibleTriangleBS, false);
      if (hitsTriangleBS.length) {
        glissementBrasSup[idx] = (hitsTriangleBS[0].object === ligneG.poignee) ? 'G' : 'A';
        return;
      }
    }

    // Pas de panneau ni de poignee visee : on attrape le systeme.
    var autre = 1 - idx;
    if (grabSysteme[autre]) {
      // La 2e main vient de saisir en plus de la 1ere : on bascule en zoom.
      // On detache de la main qui le tenait (position/orientation figees,
      // seule l'echelle bougera tant que les 2 mains tiennent).
      scene.attach(anchor);
      var p0 = new THREE.Vector3(), p1 = new THREE.Vector3();
      controllers[0].getWorldPosition(p0);
      controllers[1].getWorldPosition(p1);
      zoomBase = { distance: p0.distanceTo(p1), echelle: anchor.scale.x };
    } else {
      // 1ere main : le systeme suit desormais cette manette (position ET
      // orientation), exactement comme on attrape une piece a assembler.
      ctrl.attach(anchor);
    }
    grabSysteme[idx] = true;
  });

  ctrl.addEventListener('squeezeend', function () {
    var cible = grabs[idx];
    if (cible) {
      scene.attach(cible);   // reparente a la scene SANS sauter (garde la position mondiale)
      grabs[idx] = null;
      return;
    }

    if (glissement[idx]) {
      glissement[idx] = null;   // la droite reste ou elle a ete laissee
      return;
    }

    if (glissementBrasSup[idx]) {
      glissementBrasSup[idx] = null;
      return;
    }

    if (grabSysteme[idx]) {
      grabSysteme[idx] = false;
      var autre = 1 - idx;
      if (grabSysteme[autre]) {
        // Une main relache pendant un zoom : l'autre reprend la main libre
        // (position + orientation), sans saut (attach garde la position
        // mondiale actuelle du systeme).
        controllers[autre].attach(anchor);
      } else {
        // Plus aucune main ne tient : on fige le systeme la ou il est,
        // en le detachant de la manette (sinon il continuerait a suivre
        // la main indefiniment).
        scene.attach(anchor);
        zoomBase = null;
      }
    }
  });
});

// Raycast generique manette -> panneau canvas : declenche le bouton vise.
// Retourne true si le panneau a ete touche (meme hors bouton), pour bloquer
// toute action "derriere" le panneau.
function raycastPanneau(ctrl, mesh, pw, ph, listeBoutons, listeCurseurs, idx) {
  mat4.identity().extractRotation(ctrl.matrixWorld);
  rayon.ray.origin.setFromMatrixPosition(ctrl.matrixWorld);
  rayon.ray.direction.set(0, 0, -1).applyMatrix4(mat4);

  var hits = rayon.intersectObject(mesh, false);
  if (!hits.length) return false;

  var uv = hits[0].uv;
  var cx = uv.x * pw;
  var cy = (1 - uv.y) * ph;
  for (var i = 0; i < listeBoutons.length; i++) {
    var b = listeBoutons[i];
    if (cx >= b.x1 && cx <= b.x2 && cy >= b.y1 && cy <= b.y2) { b.action(); return true; }
  }
  if (listeCurseurs) {
    for (var j = 0; j < listeCurseurs.length; j++) {
      var c = listeCurseurs[j];
      // Marge verticale genereuse : plus facile a attraper qu'un bouton fin.
      if (cx >= c.x1 && cx <= c.x2 && cy >= c.y1 - 24 && cy <= c.y2 + 24) {
        curseurActif[idx] = c;
        c.valeur = c.min + THREE.MathUtils.clamp((cx - c.x1) / (c.x2 - c.x1), 0, 1) * (c.max - c.min);
        c.onChange(c.valeur);
        return true;
      }
    }
  }
  return true;
}
function testerPanneau(ctrl, idx) { return raycastPanneau(ctrl, panneau, PW, PH, boutons, curseursPanneau, idx); }
function testerPalette(ctrl, idx) { return raycastPanneau(ctrl, panneauPalette, PPW, PPH, boutonsPalette, null, idx); }

// Raycast ponctuel depuis UNE manette donnee : { point, nomMesh, pieceIdx }
// ou null si rien vise. Appelee a la fois en continu (reticule, voir
// majVisee) et fraiche a l'instant du clic (selectstart), pour que peindre
// ou poser un point utilise toujours la manette qui vient d'appuyer, jamais
// un etat partage calcule pour une autre manette.
function calculerVisee(ctrl) {
  if (!modeleCharge || !meshesModele.length) return null;
  mat4.identity().extractRotation(ctrl.matrixWorld);
  rayon.ray.origin.setFromMatrixPosition(ctrl.matrixWorld);
  rayon.ray.direction.set(0, 0, -1).applyMatrix4(mat4);

  var hits = rayon.intersectObjects(meshesModele, false);
  if (!hits.length) return null;
  return {
    point: hits[0].point.clone(),
    nomMesh: hits[0].object.name || null,
    pieceIdx: (hits[0].object.userData.piece !== undefined) ? hits[0].object.userData.piece : null
  };
}

// Raycast continu (hors clic) pour montrer ou la manette pointe sur le
// modele (reticule bleu). Purement visuel : les actions (peindre, poser un
// point) recalculent toujours leur propre visee via calculerVisee.
function majVisee(ctrl) {
  var v = calculerVisee(ctrl);
  derniereVisee = v;
  if (v) {
    reticuleVisee.visible = true;
    reticuleVisee.position.copy(v.point);
    reticuleVisee.lookAt(rayon.ray.origin);
  } else {
    reticuleVisee.visible = false;
  }
}

// =====================================================================
//  BOUCLE DE RENDU
// =====================================================================
var camPos = new THREE.Vector3();

renderer.setAnimationLoop(function (t, frame) {
  // Apercu sur la page d'accueil (avant l'entree en VR) : le systeme tourne
  // lentement devant la camera par defaut, juste pour le montrer.
  if (modeleCharge && !renderer.xr.isPresenting) {
    anchor.rotation.y += 0.006;
  }

  // Glissement continu d'un curseur d'epaisseur (etapes 2 a 5), tant que la
  // gachette reste enfoncee dessus : relit la position de la manette sur le
  // panneau, ajuste la valeur, et repercute en direct sur les objets deja
  // traces (voir onChangeFacteurTrait/Point -> rafraichirEpaisseurs).
  for (var kc = 0; kc < 2; kc++) {
    if (!curseurActif[kc]) continue;
    mat4.identity().extractRotation(controllers[kc].matrixWorld);
    rayon.ray.origin.setFromMatrixPosition(controllers[kc].matrixWorld);
    rayon.ray.direction.set(0, 0, -1).applyMatrix4(mat4);
    var hitsCurseur = rayon.intersectObject(panneau, false);
    if (!hitsCurseur.length) continue;
    var cCurseur = curseurActif[kc];
    var cxCurseur = hitsCurseur[0].uv.x * PW;
    cCurseur.valeur = cCurseur.min + THREE.MathUtils.clamp((cxCurseur - cCurseur.x1) / (cCurseur.x2 - cCurseur.x1), 0, 1) * (cCurseur.max - cCurseur.min);
    cCurseur.onChange(cCurseur.valeur);
  }

  // Zoom a 2 mains : l'ecart entre les manettes pilote l'echelle. Le
  // positionnement libre a 1 main n'a rien a faire ici, ctrl.attach()
  // s'en charge tout seul a chaque frame.
  if (grabSysteme[0] && grabSysteme[1] && zoomBase) {
    var p0 = new THREE.Vector3(), p1 = new THREE.Vector3();
    controllers[0].getWorldPosition(p0);
    controllers[1].getWorldPosition(p1);
    var ratio = p0.distanceTo(p1) / Math.max(zoomBase.distance, 1e-4);
    anchor.scale.setScalar(THREE.MathUtils.clamp(zoomBase.echelle * ratio, ECHELLE_MIN, ECHELLE_MAX));
  }

  // Visee continue (reticule) : quelle que soit la main utilisee, on
  // affiche le reticule sur celle des deux manettes qui vise effectivement
  // le modele (sinon celle-ci reste sans effet visuel, mais n'empeche pas
  // l'autre main de peindre/poser un point : voir calculerVisee).
  if (anchorPlaced && modeleCharge) {
    if (!calculerVisee(controllers[0])) majVisee(controllers[1]);
    else majVisee(controllers[0]);
  }

  // Trace du vecteur force (etape 3) : la fleche suit la manette active
  // tant que la gachette reste enfoncee.
  if (traceForce && manetteActiveForce >= 0) {
    var wpF = new THREE.Vector3();
    controllers[manetteActiveForce].getWorldPosition(wpF);
    var pAncreF = versAncre(projeterLocal(racine.worldToLocal(wpF)));
    majFleche(traceForce.fleche, traceForce.origine, pAncreF);
  }

  // Traces de direction de l'etape 4 (D puis C), meme principe.
  if (manetteActiveChape >= 0) {
    var traceActiveFrame = (etapeChape === 'direction_D') ? traceD : (etapeChape === 'direction_C') ? traceC : null;
    if (traceActiveFrame) {
      var wpCh = new THREE.Vector3();
      controllers[manetteActiveChape].getWorldPosition(wpCh);
      var pAncreCh = versAncre(projeterLocal(racine.worldToLocal(wpCh)));
      majTraitSimple(traceActiveFrame.fleche, traceActiveFrame.origine, pAncreCh);
    }
  }

  // Traces d'effort de l'etape 5 (D puis C), meme principe : sans ce bloc,
  // la fleche ne suivait la manette qu'au relachement (bug remonte par
  // l'utilisateur, "je ne vois pas la fleche pendant le trace").
  if (etape === 'triangle' && manetteActiveEffort >= 0) {
    var traceEffortActif = (etapeTriangle === 'effort_D') ? traceEffortD : (etapeTriangle === 'effort_C') ? traceEffortC : null;
    if (traceEffortActif) {
      var wpEf = new THREE.Vector3();
      controllers[manetteActiveEffort].getWorldPosition(wpEf);
      var pAncreEf = versAncre(projeterLocal(racine.worldToLocal(wpEf)));
      majFleche(traceEffortActif.fleche, traceEffortActif.origine, pAncreEf);
    }
  }

  // Glissement des droites du triangle des forces (etape 5, phase de
  // placement) : la main deplace librement le point par lequel passe la
  // droite (translation), son orientation reste figee tout du long.
  for (var kt = 0; kt < 2; kt++) {
    if (!glissement[kt]) continue;
    var wpT = new THREE.Vector3();
    controllers[kt].getWorldPosition(wpT);
    var pAncreT = versAncre(projeterLocal(racine.worldToLocal(wpT)));
    var l = (glissement[kt] === 'D') ? ligneD : ligneC;
    l.ancrage.copy(pAncreT);
    majLigneDeplacable(l);
  }

  // Traces de direction de l'etape 6 (G puis A), meme principe qu'a l'etape 4.
  if (manetteActiveBrasSup >= 0) {
    var traceActiveFrameBS = (etapeBrasSup === 'direction_G') ? traceG : (etapeBrasSup === 'direction_A') ? traceA : null;
    if (traceActiveFrameBS) {
      var wpChBS = new THREE.Vector3();
      controllers[manetteActiveBrasSup].getWorldPosition(wpChBS);
      var pAncreChBS = versAncre(projeterLocal(racine.worldToLocal(wpChBS)));
      majTraitSimple(traceActiveFrameBS.fleche, traceActiveFrameBS.origine, pAncreChBS);
    }
  }

  // Traces d'effort de l'etape 7 (G puis A), meme principe qu'a l'etape 5.
  if (etape === 'triangle_bras_sup' && manetteActiveEffortBrasSup >= 0) {
    var traceEffortActifBS = (etapeTriangleBrasSup === 'effort_G') ? traceEffortG : (etapeTriangleBrasSup === 'effort_A') ? traceEffortA : null;
    if (traceEffortActifBS) {
      var wpEfBS = new THREE.Vector3();
      controllers[manetteActiveEffortBrasSup].getWorldPosition(wpEfBS);
      var pAncreEfBS = versAncre(projeterLocal(racine.worldToLocal(wpEfBS)));
      majFleche(traceEffortActifBS.fleche, traceEffortActifBS.origine, pAncreEfBS);
    }
  }

  // Glissement des droites de l'etape 7, meme principe qu'a l'etape 5.
  for (var ktBS = 0; ktBS < 2; ktBS++) {
    if (!glissementBrasSup[ktBS]) continue;
    var wpTBS = new THREE.Vector3();
    controllers[ktBS].getWorldPosition(wpTBS);
    var pAncreTBS = versAncre(projeterLocal(racine.worldToLocal(wpTBS)));
    var lBS = (glissementBrasSup[ktBS] === 'G') ? ligneG : ligneA;
    lBS.ancrage.copy(pAncreTBS);
    majLigneDeplacable(lBS);
  }

  // Animation du bilan (etape 8) : les objets de la phase en cours
  // grandissent depuis leur origine jusqu'a leur cible.
  if (animationBilan) {
    var progressBilan = THREE.MathUtils.clamp((performance.now() - animationBilan.debut) / animationBilan.duree, 0, 1);
    var easedBilan = progressBilan * progressBilan * (3 - 2 * progressBilan);   // smoothstep
    animationBilan.objets.forEach(function (o) {
      if (o.type === 'fleche') {
        majFleche(o.mesh, o.origine, o.origine.clone().lerp(o.cible, easedBilan));
      } else if (o.type === 'trait') {
        majTraitSimple(o.mesh, o.origine, o.origine.clone().lerp(o.cible, easedBilan));
      } else if (o.type === 'point') {
        o.mesh.scale.setScalar(facteurPoint * easedBilan);
      }
    });
    if (progressBilan >= 1) animationBilan = null;
  }

  // Le groupe de panneaux ne suit JAMAIS le systeme : sa position ne
  // change que si on l'attrape au grip (ctrl.attach() s'en charge tout
  // seul). On se contente ici de le faire toujours face a l'utilisateur
  // (rotation uniquement), sauf pendant qu'il est tenu.
  if ((panneau.visible || panneauPalette.visible) && grabs[0] !== groupePanneaux && grabs[1] !== groupePanneaux) {
    camera.getWorldPosition(camPos);
    groupePanneaux.lookAt(camPos.x, groupePanneaux.position.y, camPos.z);
  }

  renderer.render(scene, camera);
});

// =====================================================================
//  DEMARRAGE
// =====================================================================
// Certains navigateurs refusent la session entiere si un des features
// optionnels de la liste leur deplait ("session configuration not
// supported"), meme s'il est demande en optionalFeatures. On retente donc
// avec une liste de plus en plus courte plutot que d'echouer d'un coup.
// hit-test retire de la liste : le placement suit desormais la main droite,
// il n'est plus utilise (et c'etait une source possible de refus de session).
var LISTES_FEATURES = [
  ['local-floor', 'local'],
  ['local-floor'],
  []
];

function demarrerSessionAR(i) {
  if (i >= LISTES_FEATURES.length) {
    status.textContent = 'Realite mixte non supportee par ce navigateur (toutes les configurations ont ete refusees).';
    return;
  }
  navigator.xr.requestSession('immersive-ar', { optionalFeatures: LISTES_FEATURES[i] }).then(function (session) {
    renderer.xr.setSession(session).then(function () {
      overlay.style.display = 'none';
      anchorPlaced = false;
      sessionEnCours = true;
      // Le modele est deja charge (apercu sur la page d'accueil) dans le cas
      // normal ; si le chargement n'est pas encore fini (reseau lent),
      // chargerModeleUnique() enchainera lui-meme sur le placement des que
      // c'est pret (voir sessionEnCours).
      if (modeleCharge) placerSystemeDevantUtilisateur();

      session.addEventListener('end', function () {
        overlay.style.display = 'flex';
        status.textContent = 'Session terminee.';
      });
    }).catch(function (e) { status.textContent = 'Erreur setSession : ' + e.message; });
  }).catch(function () {
    demarrerSessionAR(i + 1);   // configuration refusee : on retente en plus sobre
  });
}

document.getElementById('btnCommencer').addEventListener('click', function () { demarrerSessionAR(0); });

}); // fin window load
