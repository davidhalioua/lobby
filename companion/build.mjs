// Construit dist/Lobby.exe : un seul fichier, interface téléphone embarquée, Node inclus.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as esbuild from 'esbuild';

const PHONE = path.resolve('../phone');
const files = Object.fromEntries(fs.readdirSync(PHONE).map((f) => [f, fs.readFileSync(path.join(PHONE, f)).toString('base64')]));

const embedPhone = {
  name: 'embed-phone',
  setup(build) {
    build.onResolve({ filter: /\/assets\.js$/ }, () => ({ path: 'assets', namespace: 'embedded' }));
    build.onLoad({ filter: /.*/, namespace: 'embedded' }, () => ({
      contents: `const files = ${JSON.stringify(files)};
export function getAsset(name) { return files[name] ? Buffer.from(files[name], 'base64') : null; }`,
      loader: 'js',
    }));
  },
};

fs.mkdirSync('dist', { recursive: true });
await esbuild.build({
  entryPoints: ['src/index.js'],
  bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  outfile: 'dist/lobby.cjs',
  external: ['bufferutil', 'utf-8-validate'],
  plugins: [embedPhone],
  logLevel: 'warning',
});

const target = process.argv[2] || 'node22-win-x64';
execFileSync(process.execPath, [path.resolve('node_modules/@yao-pkg/pkg/lib-es5/bin.js'), 'dist/lobby.cjs', '-t', target, '-o', 'dist/Lobby.exe', '--no-bytecode', '--public-packages', '*', '--public'], { stdio: 'inherit' });
// Sous-système Windows « GUI » au lieu de « console » : Lobby tourne sans fenêtre noire.
// (Champ Subsystem de l'en-tête PE : offset PE + 0x5C ; 2 = GUI, 3 = console.)
if (target.includes('win')) {
  const fd = fs.openSync('dist/Lobby.exe', 'r+');
  const head = Buffer.alloc(4096);
  fs.readSync(fd, head, 0, 4096, 0);
  const pe = head.readUInt32LE(0x3c);
  if (head.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('En-tête PE introuvable');
  const sub = Buffer.alloc(2); sub.writeUInt16LE(2);
  fs.writeSync(fd, sub, 0, 2, pe + 0x5c);
  fs.closeSync(fd);
}
console.log('✔ dist/Lobby.exe');
