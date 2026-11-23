// Fichiers de l'interface téléphone. En développement, lus depuis ../../phone ;
// dans Lobby.exe, ce module est remplacé au build par une version qui les embarque.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PHONE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../phone');

export function getAsset(name) {
  const file = path.resolve(PHONE_DIR, name);
  if (!file.startsWith(PHONE_DIR + path.sep)) return null;
  try { return fs.readFileSync(file); } catch { return null; }
}
