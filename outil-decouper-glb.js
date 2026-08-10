// Outil ponctuel : retire des sous-ensembles d'un .glb en coupant leurs
// references dans les enfants du noeud racine. Le reste du fichier (mesh,
// accessors, buffer binaire) n'est pas touche : les entrees devenues
// orphelines restent dans le fichier mais ne sont plus jamais parcourues
// par le loader (il ne suit que les enfants atteignables depuis la scene).
//
// Usage : node outil-decouper-glb.js entree.glb sortie.glb "nom a retirer" "autre nom"...
const fs = require('fs');

const [, , entree, sortie, ...aRetirer] = process.argv;
if (!entree || !sortie || !aRetirer.length) {
  console.error('Usage: node outil-decouper-glb.js entree.glb sortie.glb "nom1" "nom2" ...');
  process.exit(1);
}

const buf = fs.readFileSync(entree);

// --- en-tete GLB (12 octets) ---
const magic = buf.readUInt32LE(0);
if (magic !== 0x46546c67) throw new Error('Pas un fichier .glb valide');
const version = buf.readUInt32LE(4);

// --- chunk 0 : JSON ---
const jsonLen = buf.readUInt32LE(12);
const jsonType = buf.readUInt32LE(16);
if (jsonType !== 0x4e4f534a) throw new Error('Chunk JSON attendu en premier');
const jsonBytes = buf.subarray(20, 20 + jsonLen);
const gltf = JSON.parse(jsonBytes.toString('utf8'));

// --- chunk 1 : BIN (copie telle quelle) ---
const binOffset = 20 + jsonLen;
const binHeaderLen = buf.readUInt32LE(binOffset);
const binType = buf.readUInt32LE(binOffset + 4);
if (binType !== 0x004e4942) throw new Error('Chunk BIN attendu en second');
const binChunk = buf.subarray(binOffset, binOffset + 8 + binHeaderLen);

// --- coupe des noeuds ---
const racine = gltf.nodes[0];
const nomBase = (nom) => nom ? nom.split(' <')[0] : nom;

let coupes = [];
racine.children = racine.children.filter((idx) => {
  const nom = nomBase(gltf.nodes[idx].name);
  const retirer = aRetirer.indexOf(nom) >= 0;
  if (retirer) coupes.push(nom + ' (noeud ' + idx + ')');
  return !retirer;
});

if (coupes.length !== aRetirer.length) {
  console.error('ATTENTION : tous les noms a retirer n\'ont pas ete trouves.');
  console.error('Trouves et coupes : ' + coupes.join(', '));
  console.error('Demandes : ' + aRetirer.join(', '));
  process.exit(1);
}
console.log('Coupes : ' + coupes.join(', '));

// --- reserialisation ---
let jsonStr = JSON.stringify(gltf);
// Le chunk JSON doit etre un multiple de 4 octets, complete par des espaces.
while (jsonStr.length % 4 !== 0) jsonStr += ' ';
const jsonOut = Buffer.from(jsonStr, 'utf8');

const jsonChunkHeader = Buffer.alloc(8);
jsonChunkHeader.writeUInt32LE(jsonOut.length, 0);
jsonChunkHeader.writeUInt32LE(0x4e4f534a, 4);

const totalLength = 12 + 8 + jsonOut.length + binChunk.length;
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(version, 4);
header.writeUInt32LE(totalLength, 8);

fs.writeFileSync(sortie, Buffer.concat([header, jsonChunkHeader, jsonOut, binChunk]));
console.log('Ecrit : ' + sortie + ' (' + totalLength + ' octets, original : ' + buf.length + ')');
