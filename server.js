// Mini serveur web local (sans aucune dépendance à installer).
// Sert les fichiers de ce dossier sur http://localhost:8080
// Lancé automatiquement par serveur.bat.

const http = require("http");
const fs = require("fs");
const path = require("path");

// Port modifiable : "node server.js 8081" ou variable d'environnement PORT.
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const DOSSIER = __dirname; // le dossier où se trouve ce fichier

// Types de fichiers (pour que le navigateur comprenne les .glb, .js, etc.)
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const serveur = http.createServer((req, res) => {
  // On enlève les paramètres d'URL et on évite de sortir du dossier.
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  // --- Enregistrement des points de liaison places dans l'editeur VR ---
  // Le casque (ou le PC) poste le JSON complet des points ; on l'ecrit tel
  // quel sur le disque pour que Claude puisse le relire ensuite.
  if (req.method === "POST" && urlPath === "/enregistrer-points") {
    let corps = "";
    req.on("data", (chunk) => {
      corps += chunk;
      if (corps.length > 2_000_000) req.destroy(); // garde-fou taille
    });
    req.on("end", () => {
      try {
        const donnees = JSON.parse(corps); // valide que c'est bien du JSON
        const cible = path.join(DOSSIER, "points-liaisons.json");
        fs.writeFile(cible, JSON.stringify(donnees, null, 2), (err) => {
          if (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ ok: false, erreur: String(err) }));
          }
          console.log("Points de liaison enregistres dans points-liaisons.json");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, erreur: "JSON invalide : " + e.message }));
      }
    });
    return;
  }

  const fichier = path.join(DOSSIER, path.normalize(urlPath));
  if (!fichier.startsWith(DOSSIER)) {
    res.writeHead(403);
    return res.end("Accès refusé");
  }

  fs.readFile(fichier, (err, contenu) => {
    if (err) {
      res.writeHead(404);
      return res.end("Fichier introuvable : " + urlPath);
    }
    const ext = path.extname(fichier).toLowerCase();
    res.writeHead(200, {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    });
    res.end(contenu);
  });
});

serveur.listen(PORT, "0.0.0.0", () => {
  console.log("Serveur local demarre sur http://localhost:" + PORT);
  console.log("Dossier servi : " + DOSSIER);
});
