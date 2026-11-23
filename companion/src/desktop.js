// Comportement « vraie app » quand Lobby tourne en Lobby.exe sur Windows :
// installation dans %LOCALAPPDATA%\Lobby, lancement caché au démarrage, raccourci menu Démarrer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { getAsset } from './assets.js';

export const isPackaged = Boolean(process.pkg);
const isWin = process.platform === 'win32';

export const APP_DIR = isPackaged && isWin
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Lobby')
  : os.homedir();
export const INSTALLED_EXE = path.join(APP_DIR, 'Lobby.exe');
const START_MENU_LNK = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Lobby.lnk');
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const quietly = (cmd, args) => execFile(cmd, args, { windowsHide: true }, () => {});

const ICON_FILE = path.join(APP_DIR, 'lobby.ico');

function registerApp() {
  try { fs.writeFileSync(ICON_FILE, getAsset('lobby.ico')); } catch { /* icône facultative */ }
  // Démarrage de Windows : clé « Run » standard, sans script intermédiaire
  quietly('reg.exe', ['add', RUN_KEY, '/v', 'Lobby', '/t', 'REG_SZ', '/d', `"${INSTALLED_EXE}" --autostart`, '/f']);
  // Menu Démarrer : « Lobby » ouvre la page avec le QR code
  const q = (x) => x.replace(/'/g, "''");
  quietly('powershell.exe', ['-NoProfile', '-Command',
    `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${q(START_MENU_LNK)}');$s.TargetPath='${q(INSTALLED_EXE)}';$s.IconLocation='${q(ICON_FILE)},0';$s.Description='Lobby';$s.Save()`]);
  // Nettoyage des lanceurs .vbs de la v0.3.0, bloqués par Windows Defender
  for (const f of [path.join(APP_DIR, 'launch.vbs'), path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Lobby.vbs')]) {
    try { fs.rmSync(f, { force: true }); } catch { /* déjà absent */ }
  }
}

export function relaunch(args = []) {
  spawn(INSTALLED_EXE, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// Appelé au tout début. Renvoie true si ce processus doit s'arrêter (il a passé la main).
export function bootstrap() {
  if (!isPackaged || !isWin) return false;
  fs.mkdirSync(APP_DIR, { recursive: true });
  try { fs.rmSync(path.join(APP_DIR, 'Lobby.old.exe'), { force: true }); } catch { /* encore verrouillé : au prochain coup */ }

  if (!samePath(process.execPath, INSTALLED_EXE)) {
    // Lancé depuis le téléchargement : on s'installe (ou on remplace une ancienne version), puis on passe la main
    try { fs.copyFileSync(process.execPath, INSTALLED_EXE); } catch { /* Lobby tourne déjà : il affichera sa page QR */ }
    registerApp();
    relaunch(['--setup']);
    return true;
  }
  if (!fs.existsSync(START_MENU_LNK)) registerApp();
  return false;
}

export function openInBrowser(url) {
  if (isWin) spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

// En arrière-plan il n'y a pas de console : les messages vont dans lobby.log
export function redirectLogs() {
  if (!isPackaged) return;
  const file = path.join(APP_DIR, 'lobby.log');
  try { if (fs.statSync(file).size > 1_000_000) fs.rmSync(file); } catch { /* pas encore de log */ }
  const write = (...a) => fs.appendFileSync(file, `[${new Date().toISOString()}] ${a.join(' ')}\n`);
  console.log = write;
  console.error = write;
  // Sans console, une erreur fatale serait invisible : on la note avant de quitter
  process.on('uncaughtException', (e) => { write('ERREUR FATALE', e?.stack || e); process.exit(1); });
}
