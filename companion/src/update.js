// Mise à jour automatique depuis les releases GitHub (asset « Lobby.exe », tag « vX.Y.Z »).
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, INSTALLED_EXE, isPackaged, relaunch } from './desktop.js';

const newer = (a, b) => {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

export function startAutoUpdate({ repo, version, isBusy, shutdown }) {
  if (!isPackaged || process.platform !== 'win32' || !repo) return;

  async function check() {
    try {
      if (isBusy()) return; // jamais pendant une file ou une sélection
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { 'User-Agent': 'lobby-updater', Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) return;
      const rel = await res.json();
      const asset = rel.assets?.find((a) => a.name.toLowerCase() === 'lobby.exe');
      if (!asset || !newer(rel.tag_name, version)) return;

      console.log(`Mise à jour ${version} → ${rel.tag_name}`);
      const bin = Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer());
      if (bin.length < 1_000_000 || bin.length !== asset.size) throw new Error('Téléchargement incomplet');
      const fresh = path.join(APP_DIR, 'Lobby.new.exe');
      fs.writeFileSync(fresh, bin);
      if (isBusy()) return; // une partie a été trouvée pendant le téléchargement : on réessaiera

      // Windows autorise à renommer un exe en cours d'exécution, pas à l'écraser
      fs.renameSync(INSTALLED_EXE, path.join(APP_DIR, 'Lobby.old.exe'));
      fs.renameSync(fresh, INSTALLED_EXE);
      await shutdown();
      relaunch(['--autostart']);
      process.exit(0);
    } catch (e) {
      console.log('Mise à jour impossible :', e.message);
    }
  }

  setTimeout(check, 30_000);
  setInterval(check, 6 * 60 * 60 * 1000);
}
