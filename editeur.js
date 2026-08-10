// =====================================================================
//  Editeur de liaisons - v2.0.0
//  Deux etapes en realite mixte :
//   1. Coloriage : regrouper par couleur les pieces qui forment un meme
//      solide (classes d'equivalence cinematique). Corrige par
//      equivalence (peu importe la couleur exacte, seul le regroupement
//      compte) a partir de classes.json.
//   2. Liaisons : viser le centre de chaque liaison pivot et le poser
//      d'une pression de gachette. Enregistre dans points-liaisons.json
//      (via le serveur local) pour etre relu ensuite.
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

// --- Liste des points a placer, initialisee depuis le champ texte -----
// Format attendu : "LETTRE : cote1 / cote2" (ex: "C : chape / bras superieur").
// cotes[] sert a rattacher chaque point aux classes de classes.json, pour
// tracer ensuite la structure filaire de chaque solide colorie.
var points = [];   // { nom, lettre, cotes:[id,id], pos: THREE.Vector3|null, meshProche: string|null }
var courant = 0;

(function initListe() {
  var texte = document.getElementById('listePoints').value;
  texte.split('\n').map(function (l) { return l.trim(); }).filter(Boolean)
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

var PW = 1024, PH = 700;
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

function dessinerPanneau(titre, corps, listeBoutons) {
  boutons = listeBoutons || [];

  px.clearRect(0, 0, PW, PH);
  px.fillStyle = 'rgba(12,14,20,0.94)';
  coinsArrondis(px, 0, 0, PW, PH, 28); px.fill();
  px.strokeStyle = '#35c9ff'; px.lineWidth = 4;
  coinsArrondis(px, 2, 2, PW - 4, PH - 4, 28); px.stroke();

  px.fillStyle = '#35c9ff';
  px.font = 'bold 38px sans-serif';
  px.textAlign = 'left'; px.textBaseline = 'top';
  px.fillText(titre, 44, 30);

  px.font = '28px sans-serif';
  var y = 90;
  corps.forEach(function (item) {
    var txt     = (typeof item === 'string') ? item : item.texte;
    var couleur = (typeof item === 'string') ? '#e8e8e8' : item.couleur;
    px.fillStyle = couleur;
    couper(px, txt, PW - 88).forEach(function (l) {
      if (y < 450) { px.fillText(l, 44, y); y += 34; }
    });
  });

  px.textAlign = 'center'; px.textBaseline = 'middle';
  boutons.forEach(function (b) {
    px.fillStyle = b.couleur;
    coinsArrondis(px, b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1, 16); px.fill();
    px.fillStyle = '#fff';
    px.font = 'bold 24px sans-serif';
    px.fillText(b.texte, (b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2);
  });
  px.textAlign = 'left'; px.textBaseline = 'top';

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

// Le modele est charge des l'entree en realite mixte, et apparait tout de
// suite a une position par defaut devant l'utilisateur (pas de mode de
// placement separe) : il suffit de l'attraper au grip pour le repositionner
// ou le tourner comme on veut, a tout moment (voir squeezestart/squeezeend).
function demarrerEtape() {
  if (classesDef && classesDef.classes && classesDef.classes.length) passerEnColoriage();
  else passerEnPlacement();
}

function chargerModele() {
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

    modeleCharge = true;
    anchorPlaced = true;
    anchor.visible = true;
    demarrerEtape();
  }, undefined, function (e) { erreur('Erreur GLB : ' + e); });
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
var RAYON_FILAIRE = 0.0035;
function creerBarre(p1, p2, couleur, rayon) {
  var longueur = p1.distanceTo(p2);
  if (longueur < 1e-5) return null;
  var barre = new THREE.Mesh(
    new THREE.CylinderGeometry(rayon, rayon, longueur, 10),
    new THREE.MeshBasicMaterial({ color: couleur, depthTest: false })
  );
  barre.position.copy(p1).lerp(p2, 0.5);
  barre.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p2.clone().sub(p1).normalize());
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
  ppx.strokeStyle = '#35c9ff'; ppx.lineWidth = 3;
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

function validerColoriage() {
  var r = evaluerColoriage();
  var VERT = '#3ddc84', ORANGE = '#ffb020';
  var corps = [
    { texte: r.ok + ' / ' + r.total + ' solides correctement regroupes.', couleur: r.ok === r.total ? VERT : ORANGE }
  ];
  r.problemes.slice(0, 4).forEach(function (p) { corps.push({ texte: '• ' + p, couleur: '#ff9f4a' }); });

  if (r.ok === r.total) {
    corps.push('');
    corps.push({ texte: 'Bravo, le regroupement est correct.', couleur: VERT });
    dessinerPanneau('Coloriage — résultat', corps, [
      bouton(0, 0, 'CONTINUER',   '#2f7d4f', passerEnPlacement),
      bouton(0, 1, 'RECOLORIER',  '#3a5f8a', function () { majPanneauColoriage(null); })
    ]);
  } else {
    dessinerPanneau('Coloriage — résultat', corps, [
      bouton(0, 0, 'CORRIGER',            '#3a5f8a', function () { majPanneauColoriage(null); }),
      bouton(0, 1, 'CONTINUER MALGRE TOUT','#7d4f2f', passerEnPlacement)
    ]);
  }
}

function majPanneauColoriage(message) {
  var corps = [
    classesDef.consigne, '',
    { texte: 'Pieces coloriees : ' + nbPiecesColoriees() + ' / ' + piecesModele.length, couleur: '#9fd0ff' }
  ];
  if (message) corps.push({ texte: message, couleur: '#ff9f4a' });

  dessinerPanneau('Recherche des classes d’équivalence', corps, [
    bouton(0, 0, 'VALIDER',      '#2f7d4f', validerColoriage),
    bouton(0, 1, 'TOUT EFFACER', '#7d4f2f', effacerColoriageTout),
    bouton(0, 2, 'ANNULER',      '#3a5f8a', annulerDerniere)
  ]);
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
    new THREE.SphereGeometry(0.010, 14, 14),
    new THREE.MeshBasicMaterial({ color: couleur, depthTest: false, transparent: true, opacity: 0.92 })
  );
  sphere.renderOrder = 900;
  sphere.position.copy(pAncre);
  anchor.add(sphere);

  var etq = creerEtiquette(pt.lettre || (i + 1) + '', estCourant ? '#ffe37a' : '#9dffc0');
  etq.position.copy(pAncre).add(new THREE.Vector3(0, 0.022, 0));
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

function supprimerCourant() {
  var i = courant;
  var ancienPos = points[i].pos;
  if (!ancienPos) { majPanneau('Ce point n\'est pas encore place.'); return; }
  var ancienMesh = points[i].meshProche;
  pousserAnnulation(function () {
    points[i].pos = ancienPos;
    points[i].meshProche = ancienMesh;
    majMarqueur(i);
    allerA(i);
  });
  points[courant].pos = null;
  points[courant].meshProche = null;
  majMarqueur(courant);
  majPanneau('Point efface. Vise et appuie pour le replacer.');
}

function ajouterPoint() {
  var n = points.length + 1;
  // cotes: [] -> ce point supplementaire n'est rattache a aucun solide
  // connu, il n'apparaitra donc pas dans la structure filaire (normal :
  // classes.json ne le connait pas).
  var nouveauPoint = { nom: '+' + n, lettre: '+' + n, cotes: [], pos: null, meshProche: null };
  var ancienCourant = courant;
  points.push(nouveauPoint);
  marqueurs.push(null);
  pousserAnnulation(function () {
    if (points[points.length - 1] !== nouveauPoint) return;   // deja modifie depuis : on n'annule pas a l'aveugle
    points.pop();
    var m = marqueurs.pop();
    if (m) { scene.remove(m.sphere); scene.remove(m.etiquette); }
    allerA(Math.min(ancienCourant, points.length - 1));
    majProjectionEtFilaire();
  });
  allerA(points.length - 1);
  majPanneau('Nouveau point ajoute. Vise sa position et appuie sur la gachette.');
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
var MASSE_CHARGE_KG      = 500;
var G                    = 9.81;
var ECHELLE_FORCE_M_PAR_N = 0.01 / 200;   // 200 N pour 1 cm
var TOL_ANGLE_FORCE      = 20;            // degres
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
  d.corps.scale.set(1, Math.max(lCorps, 1e-4), 1);
  d.corps.position.set(0, lCorps / 2, 0);
  d.tete.scale.set(1, lTete / (d.rayon * 8), 1);
  d.tete.position.set(0, lCorps + lTete / 2, 0);
  f.position.copy(depuis);
  f.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
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

  var VERT = '#3ddc84', ORANGE = '#ffb020', ROUGE = '#ff5f5f';
  var corps = [];
  if (juste) {
    traceForce.fleche.userData.mat.color.set(0x3ddc84);
    corps.push({ texte: 'Direction correcte (ecart ' + Math.round(angle) + '°).', couleur: VERT });
  } else if (presque) {
    traceForce.fleche.userData.mat.color.set(0xffb020);
    corps.push({ texte: 'Presque : ecart de ' + Math.round(angle) + '° avec la verticale.', couleur: ORANGE });
  } else {
    traceForce.fleche.userData.mat.color.set(0xff5f5f);
    corps.push({ texte: 'Direction incorrecte (ecart ' + Math.round(angle) + '°).', couleur: ROUGE });
    corps.push({ texte: 'Le poids d\'une charge est toujours vertical, dirige vers le bas.', couleur: '#9fd0ff' });
  }

  dessinerPanneau('Modélisation des forces — résultat', corps, [
    bouton(0, 0, 'RECOMMENCER',      '#7d4f2f', recommencerForce),
    bouton(0, 1, 'VOIR LA SOLUTION', '#2f7d4f', afficherSolutionForce)
  ]);
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

  flecheSolutionForce = creerFleche(0x3ddc84, 0.005);
  anchor.add(flecheSolutionForce);
  majFleche(flecheSolutionForce, origine, bout);

  etiquetteSolutionForce = creerEtiquette('P ≈ ' + Math.round(poidsN) + ' N', '#7dffb0');
  etiquetteSolutionForce.position.copy(bout).add(new THREE.Vector3(0.035, 0, 0));
  anchor.add(etiquetteSolutionForce);

  dessinerPanneau('Modélisation des forces — solution', [
    { texte: 'Poids de la charge : P = m·g = ' + MASSE_CHARGE_KG + ' × ' + G + ' ≈ ' + Math.round(poidsN) + ' N', couleur: '#dfeaf5' },
    { texte: 'Vecteur vertical, vers le bas, applique au point H (charge sur la chape).', couleur: '#dfeaf5' },
    { texte: 'Echelle des forces : 1 cm = 200 N.', couleur: '#9fd0ff' }
  ], [
    bouton(0, 0, 'RECOMMENCER', '#7d4f2f', recommencerForce),
    bouton(0, 1, 'CONTINUER',   '#2f7d4f', passerEnIsolementChape)
  ]);
}

function majPanneauForces(message) {
  var corps = [
    'Trace la direction du poids de la charge : vise le point H (repere bleu), gachette maintenue, tire vers le bas, relache.',
    '',
    { texte: (traceForce && traceForce.direction) ? 'Vecteur trace.' : 'Pas encore trace.', couleur: '#9fd0ff' },
    { texte: 'Echelle des forces : 1 cm = 200 N.', couleur: '#9fd0ff' }
  ];
  if (message) corps.push({ texte: message, couleur: '#ff9f4a' });

  dessinerPanneau('Modélisation des forces', corps, [
    bouton(0, 0, 'VALIDER',     '#2f7d4f', validerForce),
    bouton(0, 1, 'RECOMMENCER', '#7d4f2f', recommencerForce)
  ]);
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
  return creerBarre(p1.clone().sub(dir.clone().multiplyScalar(ext)), p2.clone().add(dir.clone().multiplyScalar(ext)), couleur, 0.0018);
}

// Fait ressortir la chape (opacite pleine) en gardant le reste du modele
// tres estompe (deja regle par afficherResultatFinal a l'etape 3).
function mettreEnEvidenceChape() {
  piecesModele.forEach(function (p) {
    if (p.nomBase !== 'chape_2') return;
    p.meshes.forEach(function (m) { m.material.opacity = 1; });
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
  mettreEnEvidenceChape();
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

function validerDirectionD() {
  if (!traceD || !traceD.direction) { majPanneauChape('Trace d\'abord la direction en D.'); return; }
  var pB = positionMarqueurAncre('B'), pD = positionMarqueurAncre('D');
  var attendue = pD.clone().sub(pB).normalize();
  // Une droite n'a pas de sens : on compare a la direction ou a son opposee.
  var cos = Math.abs(THREE.MathUtils.clamp(traceD.direction.dot(attendue), -1, 1));
  var angle = THREE.MathUtils.radToDeg(Math.acos(cos));

  if (angle <= TOL_ANGLE_FORCE) {
    traceD.fleche.userData.mat.color.set(0x3ddc84);
    guideBD = creerLigneGuide(pB, pD, 0x35c9ff);
    anchor.add(guideBD);
    etapeChape = 'concours';
    majPanneauChape('Direction en D correcte (ecart ' + Math.round(angle) + '°). La droite (BD) est maintenant tracee.');
  } else {
    traceD.fleche.userData.mat.color.set(0xff5f5f);
    majPanneauChape('Direction incorrecte (ecart ' + Math.round(angle) + '°). Aligne-toi sur les points B et D.');
  }
}

function validerConcours() {
  if (!pointConcoursTrouve) { majPanneauChape('Vise l\'intersection des deux droites et appuie sur la gachette.'); return; }
  var d = pointConcoursTrouve.distanceTo(pointConcoursVrai);
  if (d <= TOL_DISTANCE_CONCOURS) {
    marqueurConcours.material.color.set(0x3ddc84);
    etapeChape = 'direction_C';
    majPanneauChape('Point de concours correctement identifie.');
  } else {
    anchor.remove(marqueurConcours);
    marqueurConcours = null;
    pointConcoursTrouve = null;
    majPanneauChape('Pas tout a fait : vise le croisement entre la droite (BD) et la verticale du poids, en H.');
  }
}

function validerDirectionC() {
  if (!traceC || !traceC.direction) { majPanneauChape('Trace d\'abord la direction en C.'); return; }
  var pC = positionMarqueurAncre('C');
  var attendue = pointConcoursVrai.clone().sub(pC).normalize();
  var cos = Math.abs(THREE.MathUtils.clamp(traceC.direction.dot(attendue), -1, 1));
  var angle = THREE.MathUtils.radToDeg(Math.acos(cos));

  if (angle <= TOL_ANGLE_FORCE) {
    traceC.fleche.userData.mat.color.set(0x3ddc84);
    guideCConcours = creerLigneGuide(pC, pointConcoursVrai, 0x35c9ff);
    anchor.add(guideCConcours);
    etapeChape = 'fini';
    majPanneauChape('Direction en C correcte (ecart ' + Math.round(angle) + '°). Isolement de la chape termine.');
  } else {
    traceC.fleche.userData.mat.color.set(0xff5f5f);
    majPanneauChape('Direction incorrecte (ecart ' + Math.round(angle) + '°). Aligne-toi sur C et le point de concours.');
  }
}

function majPanneauChape(message) {
  var titre = 'Étape 4 — Isolement de la chape';
  var corps = [];
  if (etapeChape === 'direction_D') {
    corps.push('Trace la direction de l\'effort en D : le bras inferieur est une piece a 2 forces, aligne-toi sur les points B et D.');
  } else if (etapeChape === 'concours') {
    corps.push('Une piece a 3 forces non paralleles en equilibre a des lignes d\'action concourantes.');
    corps.push('Vise l\'intersection de la droite (BD) et de la verticale du poids (par H), gachette pour la marquer.');
  } else if (etapeChape === 'direction_C') {
    corps.push('Trace la direction de l\'effort en C, en t\'alignant sur C et le point de concours identifie.');
  } else {
    corps.push('Les trois directions sont determinees. Isolement de la chape termine.');
  }
  corps.push('');
  if (message) corps.push({ texte: message, couleur: '#ff9f4a' });

  var boutons2 = [bouton(0, 0, 'RECOMMENCER', '#7d4f2f', recommencerChape)];
  if (etapeChape === 'direction_D') boutons2.push(bouton(0, 1, 'VALIDER', '#2f7d4f', validerDirectionD));
  else if (etapeChape === 'concours') boutons2.push(bouton(0, 1, 'VALIDER', '#2f7d4f', validerConcours));
  else if (etapeChape === 'direction_C') boutons2.push(bouton(0, 1, 'VALIDER', '#2f7d4f', validerDirectionC));

  dessinerPanneau(titre, corps, boutons2);
}

// =====================================================================
//  PANNEAU EN MODE PLACEMENT
// =====================================================================
function majPanneau(message) {
  var pt = points[courant];
  var corps = [
    { texte: 'Point ' + (courant + 1) + ' / ' + points.length + ' :', couleur: '#9fd0ff' },
    { texte: pt.nom, couleur: '#ffe37a' },
    { texte: pt.pos ? 'Deja place. Rappuie pour le corriger.' : 'Vise le centre de cette liaison, gachette pour poser.', couleur: '#cfd8e6' },
    '',
    { texte: 'Points places : ' + nbPlaces() + ' / ' + points.length, couleur: '#9dffc0' }
  ];
  if (message) corps.push({ texte: message, couleur: '#ff9f4a' });

  dessinerPanneau('Modélisation du système', corps, [
    bouton(0, 0, '< PRECEDENT',   '#3a5f8a', precedent),
    bouton(0, 1, 'SUIVANT >',     '#3a5f8a', suivant),
    bouton(0, 2, 'AJOUTER POINT', '#4a4a4a', ajouterPoint),
    bouton(1, 0, 'SUPPRIMER',     '#7d4f2f', supprimerCourant),
    bouton(1, 1, 'ENREGISTRER',   '#2f7d4f', enregistrer),
    bouton(1, 2, 'ANNULER',       '#3a5f8a', annulerDerniere)
  ]);
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
  new THREE.MeshBasicMaterial({ color: 0x35c9ff, side: THREE.DoubleSide, depthTest: false })
);
reticuleVisee.renderOrder = 950;
reticuleVisee.visible = false;
scene.add(reticuleVisee);

var derniereVisee = null;   // { point: Vector3(monde), nomMesh: string } ou null

controllers.forEach(function (ctrl, idx) {
  scene.add(ctrl);
  ctrl.add(new THREE.Mesh(
    new THREE.SphereGeometry(0.008, 10, 10),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  ));
  var ligne = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0x35c9ff, transparent: true, opacity: 0.5 })
  );
  ligne.scale.z = 3;
  ctrl.add(ligne);

  ctrl.addEventListener('selectstart', function () {
    if (!modeleCharge) return;   // rien a faire tant que le modele charge (reseau lent)

    if (panneau.visible && testerPanneau(ctrl)) return;
    if (panneauPalette.visible && testerPalette(ctrl)) return;

    if (etape === 'coloriage') {
      if (derniereVisee && derniereVisee.pieceIdx !== null) {
        peindrePiece(derniereVisee.pieceIdx);
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
      var f = creerFleche(0xffd400, 0.0045);
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
        var fD = creerFleche(0xffd400, 0.0045);
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
          new THREE.SphereGeometry(0.010, 14, 14),
          new THREE.MeshBasicMaterial({ color: 0xffd400, depthTest: false })
        );
        marqueurConcours.position.copy(pointConcoursTrouve);
        anchor.add(marqueurConcours);
        majPanneauChape(null);
        return;
      }
      if (etapeChape === 'direction_C') {
        if (traceC) return;
        var origineC = positionMarqueurAncre('C');
        if (!origineC) { majPanneauChape('Point C introuvable.'); return; }
        var fC = creerFleche(0xffd400, 0.0045);
        anchor.add(fC);
        traceC = { fleche: fC, origine: origineC, direction: null };
        manetteActiveChape = idx;
        return;
      }
      return;   // etapeChape === 'fini' : plus rien a tracer
    }

    // etape === 'liaisons' : poser le point courant a l'endroit vise.
    if (derniereVisee) {
      var i = courant;
      var ancienPos  = points[i].pos ? points[i].pos.clone() : null;
      var ancienMesh = points[i].meshProche;
      pousserAnnulation(function () {
        points[i].pos = ancienPos;
        points[i].meshProche = ancienMesh;
        majMarqueur(i);
        allerA(i);
      });
      points[courant].pos = racine.worldToLocal(derniereVisee.point.clone());
      points[courant].meshProche = derniereVisee.nomMesh;
      majMarqueur(courant);
      allerA(pointSuivantNonPlace(courant));
    } else {
      majPanneau('Vise une surface du modele avec le rayon bleu.');
    }
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
    majFleche(traceActive.fleche, traceActive.origine, pAncreC);
    traceActive.direction = pAncreC.clone().sub(traceActive.origine).normalize();
    manetteActiveChape = -1;
    majPanneauChape(null);
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

    // Pas de panneau vise : on attrape le systeme.
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
function raycastPanneau(ctrl, mesh, pw, ph, listeBoutons) {
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
  return true;
}
function testerPanneau(ctrl) { return raycastPanneau(ctrl, panneau, PW, PH, boutons); }
function testerPalette(ctrl) { return raycastPanneau(ctrl, panneauPalette, PPW, PPH, boutonsPalette); }

// Raycast continu (hors clic) pour montrer ou la manette pointe sur le modele.
function majVisee(ctrl) {
  if (!modeleCharge || !meshesModele.length) { derniereVisee = null; reticuleVisee.visible = false; return; }
  mat4.identity().extractRotation(ctrl.matrixWorld);
  rayon.ray.origin.setFromMatrixPosition(ctrl.matrixWorld);
  rayon.ray.direction.set(0, 0, -1).applyMatrix4(mat4);

  var hits = rayon.intersectObjects(meshesModele, false);
  if (hits.length) {
    derniereVisee = {
      point: hits[0].point.clone(),
      nomMesh: hits[0].object.name || null,
      pieceIdx: (hits[0].object.userData.piece !== undefined) ? hits[0].object.userData.piece : null
    };
    reticuleVisee.visible = true;
    reticuleVisee.position.copy(hits[0].point);
    reticuleVisee.lookAt(rayon.ray.origin);
  } else {
    derniereVisee = null;
    reticuleVisee.visible = false;
  }
}

// =====================================================================
//  BOUCLE DE RENDU
// =====================================================================
var camPos = new THREE.Vector3();

renderer.setAnimationLoop(function (t, frame) {
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

  // Visee continue avec la premiere manette active (celle qui bouge).
  if (anchorPlaced && modeleCharge) {
    majVisee(controllers[0].visible === false ? controllers[1] : controllers[0]);
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
      majFleche(traceActiveFrame.fleche, traceActiveFrame.origine, pAncreCh);
    }
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
      if (!modeleCharge) chargerModele();   // charge tout de suite : le modele est visible en apercu avant la pose

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
