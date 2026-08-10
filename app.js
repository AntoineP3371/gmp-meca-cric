// =====================================================================
//  Statique en realite mixte - v1.0.0
//  L'utilisateur trace les vecteurs des actions mecaniques subies par
//  une piece isolee, l'application corrige puis affiche la solution.
//
//  Les exercices sont definis dans exercices.json (aucun code a toucher
//  pour en ajouter un).
// =====================================================================

window.addEventListener('load', function () {

var status  = document.getElementById('status');
var overlay = document.getElementById('overlay');
var canvas  = document.getElementById('c');
var errbox  = document.getElementById('errbox');

function erreur(txt) { errbox.textContent = txt; }

// --- Reglages generaux ---------------------------------------------
var TAILLE_MODELE = 0.60;   // plus grande dimension de la pince, en metres
// Deux points d'application peuvent etre distants de seulement 3,4 cm :
// le rayon d'accrochage doit rester bien en dessous de la moitie.
var RAYON_SNAP    = 0.014;  // distance d'accrochage a un point d'application
var LONG_MIN      = 0.020;  // longueur minimale pour qu'un trace compte
var ECH_SOLUTION  = 0.046;  // metres par unite de norme, pour les fleches vertes

if (typeof THREE === 'undefined') { status.textContent = 'Erreur : Three.js non charge'; return; }

if (!navigator.xr) {
  status.textContent = 'WebXR non disponible sur ce navigateur';
} else {
  navigator.xr.isSessionSupported('immersive-ar').then(function (ok) {
    status.textContent = ok ? 'Pret !' : 'Realite mixte non supportee';
    if (!ok) document.getElementById('btnCommencer').disabled = true;
  });
}

// --- Rendu ----------------------------------------------------------
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

// --- Etat global ----------------------------------------------------
var ETAT = { PLACEMENT: 0, DESSIN: 1, CORRECTION: 2, SOLUTION: 3 };
var etat = ETAT.PLACEMENT;

var exercice     = null;   // objet issu de exercices.json
var anchor       = new THREE.Group();
var anchorPlaced = false;
var modeleCharge = false;

var pointsAppli  = [];     // { id, nom, objet(Object3D), marqueur(Mesh), pos(Vector3 monde) }
var vecteurs     = [];     // { pointId, origine, extremite, fleche }
var flechesSol   = [];     // fleches vertes de la solution
var lignesFeed   = [];     // texte de retour affiche sur le panneau

anchor.visible = false;
scene.add(anchor);

// =====================================================================
//  CHARGEMENT DES EXERCICES
// =====================================================================
fetch('exercices.json?v=' + Date.now())
  .then(function (r) { return r.json(); })
  .then(function (data) {
    exercice = data.exercices[0];
    status.textContent = 'Exercice charge : ' + exercice.titre;
  })
  .catch(function (e) { erreur('Impossible de lire exercices.json : ' + e); });

// =====================================================================
//  PANNEAU D'AFFICHAGE (texture canvas)
// =====================================================================
var PW = 1024, PH = 640;
var pc = document.createElement('canvas'); pc.width = PW; pc.height = PH;
var px = pc.getContext('2d');
var ptex = new THREE.CanvasTexture(pc);
var panneau = new THREE.Mesh(
  new THREE.PlaneGeometry(0.60, 0.375),
  new THREE.MeshBasicMaterial({ map: ptex, transparent: true })
);
panneau.visible = false;
scene.add(panneau);

var boutons = [];   // { x1, y1, x2, y2, texte, couleur, action }

function coinsArrondis(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y,     x + w, y + h, r);
  c.arcTo(x + w, y + h, x,     y + h, r);
  c.arcTo(x,     y + h, x,     y,     r);
  c.arcTo(x,     y,     x + w, y,     r);
  c.closePath();
}

// Decoupe un texte pour qu'il tienne dans une largeur donnee.
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
  px.strokeStyle = '#e0245e'; px.lineWidth = 4;
  coinsArrondis(px, 2, 2, PW - 4, PH - 4, 28); px.stroke();

  // Titre
  px.fillStyle = '#e0245e';
  px.font = 'bold 40px sans-serif';
  px.textAlign = 'left'; px.textBaseline = 'top';
  px.fillText(titre, 44, 30);

  // Corps : tableau de { texte, couleur }
  px.font = '30px sans-serif';
  var y = 100;
  corps.forEach(function (item) {
    var txt     = (typeof item === 'string') ? item : item.texte;
    var couleur = (typeof item === 'string') ? '#e8e8e8' : item.couleur;
    px.fillStyle = couleur;
    couper(px, txt, PW - 88).forEach(function (l) {
      if (y < 500) { px.fillText(l, 44, y); y += 36; }
    });
  });

  // Boutons
  px.textAlign = 'center'; px.textBaseline = 'middle';
  boutons.forEach(function (b) {
    px.fillStyle = b.couleur;
    coinsArrondis(px, b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1, 16); px.fill();
    px.fillStyle = '#fff';
    px.font = 'bold 28px sans-serif';
    px.fillText(b.texte, (b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2);
  });
  px.textAlign = 'left'; px.textBaseline = 'top';

  ptex.needsUpdate = true;
}

// Trois emplacements de boutons en bas du panneau.
function emplacement(i) {
  var larg = 290, marge = 44, ecart = 37;
  return { x1: marge + i * (larg + ecart), y1: 530, x2: marge + i * (larg + ecart) + larg, y2: 610 };
}
function bouton(i, texte, couleur, action) {
  var e = emplacement(i);
  return { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, texte: texte, couleur: couleur, action: action };
}

// =====================================================================
//  FLECHES 3D
// =====================================================================
function creerFleche(couleur, rayon) {
  var g = new THREE.Group();
  // depthTest desactive : un vecteur part souvent d'un point situe a
  // l'interieur du mecanisme et serait sinon tronque par les pieces.
  var mat = new THREE.MeshBasicMaterial({ color: couleur, depthTest: false });
  var corps = new THREE.Mesh(new THREE.CylinderGeometry(rayon, rayon, 1, 10), mat);
  var tete  = new THREE.Mesh(new THREE.ConeGeometry(rayon * 2.8, rayon * 8, 12), mat);
  corps.renderOrder = 800; tete.renderOrder = 800;
  g.add(corps); g.add(tete);
  g.userData = { corps: corps, tete: tete, mat: mat, rayon: rayon };
  return g;
}

// Positionne une fleche entre deux points exprimes en coordonnees monde.
var _dir = new THREE.Vector3(), _mid = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
function majFleche(f, depuis, vers) {
  _dir.subVectors(vers, depuis);
  var L = _dir.length();
  if (L < 1e-5) { f.visible = false; return; }
  f.visible = true;
  _dir.normalize();

  var d = f.userData;
  var lTete  = Math.min(d.rayon * 8, L * 0.45);
  var lCorps = L - lTete;

  d.corps.scale.set(1, Math.max(lCorps, 1e-4), 1);
  d.corps.position.set(0, lCorps / 2, 0);
  d.tete.scale.set(1, lTete / (d.rayon * 8), 1);
  d.tete.position.set(0, lCorps + lTete / 2, 0);

  f.position.copy(depuis);
  // Le cylindre de Three.js est oriente selon +Y : on l'aligne sur _dir.
  f.quaternion.setFromUnitVectors(_up, _dir);
}

function couleurFleche(f, c) { f.userData.mat.color.set(c); }

// Etiquette texte flottante.
function creerEtiquette(texte, couleur) {
  var c = document.createElement('canvas'); c.width = 512; c.height = 96;
  var x = c.getContext('2d');
  x.font = 'bold 46px sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.lineWidth = 8; x.strokeStyle = 'rgba(0,0,0,0.85)';
  x.strokeText(texte, 256, 48);
  x.fillStyle = couleur;
  x.fillText(texte, 256, 48);
  var s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), transparent: true, depthTest: false
  }));
  s.scale.set(0.16, 0.03, 1);
  s.renderOrder = 999;
  return s;
}

// =====================================================================
//  CHARGEMENT DU MODELE
// =====================================================================
var loader = new THREE.GLTFLoader();

// Retrouve un noeud par son identifiant CAO (NAUO...). Three.js remplace
// certains caracteres dans les noms, on cherche donc une sous-chaine.
function trouverNoeud(racine, id) {
  var trouve = null;
  var motif1 = 'NAUO' + id.replace(/^NAUO/, '') + '>';
  var motif2 = 'NAUO' + id.replace(/^NAUO/, '') + '_';
  racine.traverse(function (n) {
    if (trouve || !n.name) return;
    if (n.name.indexOf(motif1) >= 0 || n.name.indexOf(motif2) >= 0) trouve = n;
    else if (n.name.slice(-motif1.length + 1) === motif1.slice(0, -1)) trouve = n;
  });
  return trouve;
}

function ajusterTaille(objet, cible) {
  var box = new THREE.Box3().setFromObject(objet);
  var t = new THREE.Vector3(); box.getSize(t);
  var m = Math.max(t.x, t.y, t.z);
  if (m > 0) objet.scale.setScalar(cible / m);
}

var matPiece = new THREE.MeshStandardMaterial({ color: 0xff8c1a, metalness: 0.2, roughness: 0.5 });
var matAutre = new THREE.MeshStandardMaterial({
  color: 0x8a93a6, metalness: 0.1, roughness: 0.8, transparent: true, opacity: 0.38
});

function chargerModele() {
  loader.load(exercice.modele, function (gltf) {
    var racine = gltf.scene;
    ajusterTaille(racine, TAILLE_MODELE);
    anchor.add(racine);
    racine.position.set(0, 0.01, 0);
    racine.updateMatrixWorld(true);

    // Mise en evidence : la piece isolee en orange, le reste estompe.
    var piece = trouverNoeud(racine, exercice.piece);
    var dansPiece = [];
    if (piece) piece.traverse(function (n) { if (n.isMesh) dansPiece.push(n); });
    racine.traverse(function (n) {
      if (!n.isMesh) return;
      n.material = (dansPiece.indexOf(n) >= 0) ? matPiece : matAutre;
      if (dansPiece.indexOf(n) < 0) n.renderOrder = -1;
    });

    // Points d'application candidats : on prend l'ORIGINE du noeud, pas le
    // centre de sa boite englobante (le cable, par exemple, est un fil de
    // 30 mm dont seule l'extremite touche la lame).
    pointsAppli = [];
    exercice.pointsCandidats.forEach(function (pt) {
      var n = trouverNoeud(racine, pt.id);
      if (!n) { erreur('Piece introuvable dans le GLB : ' + pt.id); return; }
      // depthTest desactive : plusieurs points d'application sont a
      // l'interieur des pieces (axes, pivot) et seraient invisibles.
      var m = new THREE.Mesh(
        new THREE.SphereGeometry(0.009, 14, 14),
        new THREE.MeshBasicMaterial({
          color: 0x35c9ff, transparent: true, opacity: 0.9, depthTest: false
        })
      );
      m.renderOrder = 900;
      anchor.add(m);
      var p = new THREE.Vector3(); n.getWorldPosition(p);
      anchor.worldToLocal(p);
      m.position.copy(p);
      pointsAppli.push({ id: pt.id, nom: pt.nom, objet: n, marqueur: m });
    });

    // Reperes du plan du mecanisme.
    refPiece = piece;
    refPivot = trouverNoeud(racine, exercice.reperePivot);
    refLame  = trouverNoeud(racine, exercice.repereLame);
    refGalet = trouverNoeud(racine, exercice.repereGalet);
    if (!refPiece || !refPivot || !refLame) {
      erreur('Reperes du plan introuvables dans le GLB.');
      return;
    }

    modeleCharge = true;
    passerEnDessin();
  }, undefined, function (e) { erreur('Erreur GLB : ' + e); });
}

// =====================================================================
//  REPERE DU PLAN DU MECANISME
//  origine = pivot, u = pivot -> lame, w = perpendiculaire (cote galet)
//
//  ATTENTION : la normale du plan est l'AXE DU PIVOT, pris sur la piece
//  isolee elle-meme. Il ne faut PAS la calculer a partir de trois points
//  d'application : l'axe de machoire est decale de 7 mm hors du plan du
//  mecanisme, ce qui donnerait un plan incline de plus de 15 degres.
// =====================================================================
var refPivot = null, refLame = null, refGalet = null, refPiece = null;
var _q = new THREE.Quaternion();

function repere() {
  var P = new THREE.Vector3(), L = new THREE.Vector3();
  refPivot.getWorldPosition(P);
  refLame.getWorldPosition(L);

  var n = new THREE.Vector3(0, 0, 1)
            .applyQuaternion(refPiece.getWorldQuaternion(_q)).normalize();

  // u = composante de (pivot -> lame) dans le plan
  var v = L.clone().sub(P);
  var u = v.sub(n.clone().multiplyScalar(v.dot(n))).normalize();
  var w = n.clone().cross(u).normalize();
  return { O: P, u: u, w: w, n: n };
}

// Projette un point du monde sur le plan du mecanisme.
function projeter(p, R) {
  var d = p.clone().sub(R.O).dot(R.n);
  return p.clone().sub(R.n.clone().multiplyScalar(d));
}

// Convertit une direction [au, aw] du JSON en vecteur monde.
function directionMonde(dir, R) {
  return R.u.clone().multiplyScalar(dir[0])
          .add(R.w.clone().multiplyScalar(dir[1])).normalize();
}

// =====================================================================
//  TRACE DES VECTEURS
// =====================================================================
var trace = null;   // { pointId, origine, fleche } pendant l'appui gachette

function pointLePlusProche(pMonde) {
  var best = null, bestD = RAYON_SNAP;
  var w = new THREE.Vector3();
  pointsAppli.forEach(function (pt) {
    pt.marqueur.getWorldPosition(w);
    var d = w.distanceTo(pMonde);
    if (d < bestD) { bestD = d; best = pt; }
  });
  return best;
}

function debutTrace(posManette) {
  if (!modeleCharge || etat !== ETAT.DESSIN) return;
  var R = repere();
  var p = projeter(posManette, R);
  var pt = pointLePlusProche(p);
  if (!pt) {
    majPanneauDessin('Fais partir ton vecteur d\'un point bleu.');
    return;
  }
  var origine = new THREE.Vector3();
  pt.marqueur.getWorldPosition(origine);

  var f = creerFleche(0xffd400, 0.004);
  scene.add(f);
  trace = { pointId: pt.id, nom: pt.nom, origine: origine, fleche: f };
  majPanneauDessin('Depuis : ' + pt.nom);
}

function pendantTrace(posManette) {
  if (!trace) return;
  var R = repere();
  var p = projeter(posManette, R);
  majFleche(trace.fleche, trace.origine, p);
}

function finTrace(posManette) {
  if (!trace) return;
  var R = repere();
  var p = projeter(posManette, R);
  if (p.distanceTo(trace.origine) < LONG_MIN) {
    scene.remove(trace.fleche);
    trace = null;
    majPanneauDessin('Trace trop court, recommence.');
    return;
  }
  majFleche(trace.fleche, trace.origine, p);
  vecteurs.push({
    pointId:   trace.pointId,
    nom:       trace.nom,
    origine:   trace.origine.clone(),
    extremite: p.clone(),
    fleche:    trace.fleche
  });
  trace = null;
  majPanneauDessin(null);
}

function effacerDernier() {
  var v = vecteurs.pop();
  if (v) scene.remove(v.fleche);
  majPanneauDessin(null);
}
function effacerTout() {
  vecteurs.forEach(function (v) { scene.remove(v.fleche); });
  vecteurs = [];
  majPanneauDessin(null);
}
function effacerSolution() {
  flechesSol.forEach(function (o) { scene.remove(o); });
  flechesSol = [];
}

// =====================================================================
//  CORRECTION
// =====================================================================
function corriger() {
  var R = repere();
  var tol = exercice.tolAngle;
  var resultats = [];
  var utilises  = [];
  var nbJustes = 0, nbApprox = 0;

  exercice.forces.forEach(function (F) {
    var attendue = directionMonde(F.dir, R);

    // On cherche le vecteur trace accroche au bon point d'application.
    var candidat = null, iCand = -1;
    for (var i = 0; i < vecteurs.length; i++) {
      if (utilises.indexOf(i) >= 0) continue;
      if (vecteurs[i].pointId === F.point) { candidat = vecteurs[i]; iCand = i; break; }
    }

    if (!candidat) {
      resultats.push({ force: F, etat: 'manquant' });
      return;
    }
    utilises.push(iCand);

    // Les deux extremites sont deja dans le plan : la difference l'est aussi.
    var tracee = candidat.extremite.clone().sub(candidat.origine).normalize();
    var cos = Math.max(-1, Math.min(1, tracee.dot(attendue)));
    var angle = Math.acos(cos) * 180 / Math.PI;

    var e;
    if (angle <= tol)          { e = 'juste';   nbJustes++; }
    else if (angle <= tol * 2) { e = 'approx';  nbApprox++; }
    else if (angle >= 180 - tol * 2) { e = 'sens'; }
    else                       { e = 'faux'; }

    resultats.push({ force: F, etat: e, angle: angle, vecteur: candidat });
  });

  var enTrop = [];
  for (var j = 0; j < vecteurs.length; j++) {
    if (utilises.indexOf(j) < 0) enTrop.push(vecteurs[j]);
  }

  afficherCorrection(resultats, enTrop, nbJustes, nbApprox);
}

function afficherCorrection(resultats, enTrop, nbJustes, nbApprox) {
  etat = ETAT.CORRECTION;

  var VERT = '#3ddc84', ORANGE = '#ffb020', ROUGE = '#ff5f5f';
  var corps = [];

  resultats.forEach(function (r) {
    var couleur, txt;
    if (r.etat === 'juste') {
      couleur = VERT;   txt = 'OK   ' + r.force.symbole + '  (ecart ' + Math.round(r.angle) + ' deg)';
      couleurFleche(r.vecteur.fleche, 0x3ddc84);
    } else if (r.etat === 'approx') {
      couleur = ORANGE; txt = 'PRESQUE   ' + r.force.symbole + '  (ecart ' + Math.round(r.angle) + ' deg)';
      couleurFleche(r.vecteur.fleche, 0xffb020);
    } else if (r.etat === 'sens') {
      couleur = ROUGE;  txt = 'SENS INVERSE   ' + r.force.symbole;
      couleurFleche(r.vecteur.fleche, 0xff5f5f);
    } else if (r.etat === 'faux') {
      couleur = ROUGE;  txt = 'DIRECTION FAUSSE   ' + r.force.symbole;
      couleurFleche(r.vecteur.fleche, 0xff5f5f);
    } else {
      couleur = ROUGE;  txt = 'MANQUANT   ' + r.force.symbole;
    }
    corps.push({ texte: txt, couleur: couleur });
  });

  enTrop.forEach(function (v) {
    corps.push({ texte: 'EN TROP   vecteur depuis : ' + v.nom, couleur: ROUGE });
    couleurFleche(v.fleche, 0xff5f5f);
  });

  var total   = exercice.forces.length;
  var reussi  = (nbJustes + nbApprox === total) && enTrop.length === 0;

  corps.push('');
  if (reussi) {
    corps.push({
      texte: nbApprox ? 'Bien ! Tes directions sont correctes, a quelques degres pres.'
                      : 'Parfait. Toutes les actions sont justes.',
      couleur: VERT
    });
    dessinerPanneau('Correction', corps, [
      bouton(0, 'VOIR LA SOLUTION', '#2f7d4f', montrerSolution),
      bouton(1, 'RECOMMENCER',      '#7d4f2f', recommencer)
    ]);
  } else {
    // Un indice cible sur la premiere erreur rencontree.
    var premiere = null;
    for (var i = 0; i < resultats.length; i++) {
      if (resultats[i].etat !== 'juste' && resultats[i].etat !== 'approx') { premiere = resultats[i]; break; }
    }
    if (premiere) corps.push({ texte: 'Indice : ' + premiere.force.aide, couleur: '#9fd0ff' });

    dessinerPanneau('Correction', corps, [
      bouton(0, 'RECOMMENCER',      '#7d4f2f', recommencer),
      bouton(1, 'VOIR LA SOLUTION', '#4a4a4a', montrerSolution)
    ]);
  }
}

function montrerSolution() {
  etat = ETAT.SOLUTION;
  effacerSolution();
  var R = repere();

  // Les vecteurs de l'utilisateur sont estompes pour laisser voir la solution.
  vecteurs.forEach(function (v) { v.fleche.userData.mat.opacity = 0.35; v.fleche.userData.mat.transparent = true; });

  exercice.forces.forEach(function (F) {
    var pt = null;
    pointsAppli.forEach(function (p) { if (p.id === F.point) pt = p; });
    if (!pt) return;

    var origine = new THREE.Vector3();
    pt.marqueur.getWorldPosition(origine);
    var d = directionMonde(F.dir, R);
    var bout = origine.clone().add(d.multiplyScalar(F.norme * ECH_SOLUTION));

    var f = creerFleche(0x3ddc84, 0.005);
    scene.add(f); flechesSol.push(f);
    majFleche(f, origine, bout);

    var et = creerEtiquette(F.symbole, '#7dffb0');
    et.position.copy(bout).add(new THREE.Vector3(0, 0.035, 0));
    scene.add(et); flechesSol.push(et);
  });

  var corps = exercice.correction.map(function (l) { return { texte: l, couleur: '#dfeaf5' }; });
  dessinerPanneau('Solution', corps, [
    bouton(0, 'RECOMMENCER', '#7d4f2f', recommencer),
    bouton(1, 'DEPLACER',    '#3a5f8a', replacer)
  ]);
}

function recommencer() {
  effacerSolution();
  effacerTout();
  passerEnDessin();
}

function replacer() {
  effacerSolution();
  effacerTout();
  anchorPlaced = false;
  etat = ETAT.PLACEMENT;
  panneau.visible = false;
  reticle.visible = true;
}

// =====================================================================
//  PANNEAU EN MODE DESSIN
// =====================================================================
function majPanneauDessin(message) {
  var corps = [exercice.question, ''];
  corps.push({ texte: 'Vecteurs traces : ' + vecteurs.length, couleur: '#9fd0ff' });
  if (message) corps.push({ texte: message, couleur: '#ffd400' });
  dessinerPanneau(exercice.titre, corps, [
    bouton(0, 'VALIDER',         '#2f7d4f', corriger),
    bouton(1, 'EFFACER DERNIER', '#7d4f2f', effacerDernier),
    bouton(2, 'TOUT EFFACER',    '#7a2f2f', effacerTout)
  ]);
}

function passerEnDessin() {
  etat = ETAT.DESSIN;
  panneau.visible = true;
  majPanneauDessin(null);
}

// =====================================================================
//  MANETTES
// =====================================================================
var controllers = [renderer.xr.getController(0), renderer.xr.getController(1)];
var rayon = new THREE.Raycaster();
var tmpPos = new THREE.Vector3(), tmpDir = new THREE.Vector3();
var mat4 = new THREE.Matrix4();
var manetteActive = -1;

controllers.forEach(function (ctrl, idx) {
  scene.add(ctrl);

  // Petite bille au bout de la manette : c'est la pointe du crayon.
  ctrl.add(new THREE.Mesh(
    new THREE.SphereGeometry(0.008, 10, 10),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  ));

  // Rayon de visee, pour appuyer sur les boutons du panneau.
  var ligne = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0x35c9ff, transparent: true, opacity: 0.5 })
  );
  ligne.scale.z = 3;
  ctrl.add(ligne);

  ctrl.addEventListener('selectstart', function () {
    // 1er appui : on pose le mecanisme sur la table.
    if (!anchorPlaced) {
      anchorPlaced = true;
      anchor.visible = true;
      reticle.visible = false;
      if (!modeleCharge) chargerModele(); else passerEnDessin();
      return;
    }

    // Le panneau est prioritaire : on teste d'abord la visee.
    if (panneau.visible && testerPanneau(ctrl)) return;

    manetteActive = idx;
    ctrl.getWorldPosition(tmpPos);
    debutTrace(tmpPos);
  });

  ctrl.addEventListener('selectend', function () {
    if (manetteActive !== idx) return;
    ctrl.getWorldPosition(tmpPos);
    finTrace(tmpPos);
    manetteActive = -1;
  });
});

// Renvoie true si la visee a touche un bouton du panneau.
function testerPanneau(ctrl) {
  mat4.identity().extractRotation(ctrl.matrixWorld);
  rayon.ray.origin.setFromMatrixPosition(ctrl.matrixWorld);
  rayon.ray.direction.set(0, 0, -1).applyMatrix4(mat4);

  var hits = rayon.intersectObject(panneau, false);
  if (!hits.length) return false;

  var uv = hits[0].uv;
  var cx = uv.x * PW;
  var cy = (1 - uv.y) * PH;
  for (var i = 0; i < boutons.length; i++) {
    var b = boutons[i];
    if (cx >= b.x1 && cx <= b.x2 && cy >= b.y1 && cy <= b.y2) { b.action(); return true; }
  }
  return true;   // touche le panneau mais pas un bouton : on ne dessine pas derriere
}

// =====================================================================
//  PLACEMENT SUR LA TABLE (hit-test)
// =====================================================================
var reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.055, 0.075, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xff8c1a })
);
reticle.visible = false;
scene.add(reticle);

var hitTestSource = null, hitTestDemande = false;

// =====================================================================
//  BOUCLE DE RENDU
// =====================================================================
var camPos = new THREE.Vector3();

renderer.setAnimationLoop(function (t, frame) {
  if (frame && !anchorPlaced) {
    var session = renderer.xr.getSession();
    var refSpace = renderer.xr.getReferenceSpace();

    if (!hitTestDemande) {
      hitTestDemande = true;
      session.requestReferenceSpace('viewer').then(function (vs) {
        session.requestHitTestSource({ space: vs }).then(function (src) { hitTestSource = src; });
      }).catch(function () {});
    }

    if (hitTestSource) {
      var res = frame.getHitTestResults(hitTestSource);
      if (res.length) {
        var pose = res[0].getPose(refSpace);
        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
        reticle.matrix.decompose(reticle.position, reticle.quaternion, reticle.scale);
        anchor.position.copy(reticle.position);
      }
    }
  }

  // Le trace suit la manette tant que la gachette est enfoncee.
  if (trace && manetteActive >= 0) {
    controllers[manetteActive].getWorldPosition(tmpPos);
    pendantTrace(tmpPos);
  }

  // Le panneau flotte au-dessus du mecanisme et fait face a l'utilisateur.
  if (panneau.visible && anchorPlaced) {
    panneau.position.copy(anchor.position).add(new THREE.Vector3(0, 0.55, 0));
    camera.getWorldPosition(camPos);
    panneau.lookAt(camPos.x, panneau.position.y, camPos.z);
  }

  // Les marqueurs bleus pulsent legerement pour rester reperables.
  if (etat === ETAT.DESSIN) {
    var s = 1 + 0.18 * Math.sin(t / 260);
    pointsAppli.forEach(function (p) { p.marqueur.scale.setScalar(s); });
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
var LISTES_FEATURES = [
  ['hit-test', 'local-floor', 'local'],
  ['hit-test', 'local-floor'],
  ['hit-test'],
  []
];

function demarrerSessionAR(i) {
  if (!exercice) { status.textContent = 'Exercice pas encore charge, patiente une seconde.'; return; }
  if (i >= LISTES_FEATURES.length) {
    status.textContent = 'Realite mixte non supportee par ce navigateur (toutes les configurations ont ete refusees).';
    return;
  }
  navigator.xr.requestSession('immersive-ar', { optionalFeatures: LISTES_FEATURES[i] }).then(function (session) {
    renderer.xr.setSession(session).then(function () {
      overlay.style.display = 'none';
      etat = ETAT.PLACEMENT;
      anchorPlaced = false;
      hitTestDemande = false;
      hitTestSource = null;

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
