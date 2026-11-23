// Connexion au client League (LCU) : lecture des identifiants, requêtes REST, événements WebSocket.
import fs from 'node:fs';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

// Le client utilise un certificat auto-signé sur 127.0.0.1 : on ne désactive la vérification
// que pour ces connexions locales, jamais globalement.
const localAgent = new https.Agent({ rejectUnauthorized: false });

const DEFAULT_LOCKFILES = [
  'C:\\Riot Games\\League of Legends\\lockfile',
  'D:\\Riot Games\\League of Legends\\lockfile',
  '/Applications/League of Legends.app/Contents/LoL/lockfile',
];

function readLockfile(file) {
  try {
    const [, , port, password, protocol] = fs.readFileSync(file, 'utf8').trim().split(':');
    if (port && password) return { port: Number(port), password, protocol: protocol || 'https' };
  } catch { /* absent : le client n'est pas lancé */ }
  return null;
}

// Repli : lire la ligne de commande du processus LeagueClientUx (marche quel que soit le dossier d'install).
function fromProcess() {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'powershell.exe' : 'ps';
    const args = isWin
      ? ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine"]
      : ['-A', '-o', 'args='];
    execFile(cmd, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err || !out) return resolve(null);
      const line = out.split('\n').find((l) => l.includes('--remoting-auth-token='));
      if (!line) return resolve(null);
      const port = line.match(/--app-port=(\d+)/)?.[1];
      const password = line.match(/--remoting-auth-token=([\w-]+)/)?.[1];
      const installDir = line.match(/--install-directory=([^"]+?)(?:"|\s--|$)/)?.[1];
      resolve(port && password ? { port: Number(port), password, protocol: 'https', installDir } : null);
    });
  });
}

async function findCredentials() {
  const candidates = process.env.LOL_LOCKFILE ? [process.env.LOL_LOCKFILE] : DEFAULT_LOCKFILES;
  for (const f of candidates) {
    const c = readLockfile(f);
    if (c) return c;
  }
  return fromProcess();
}

export class LCU extends EventEmitter {
  constructor() {
    super();
    this.creds = null;
    this.ws = null;
    this.connected = false;
  }

  async start() {
    for (;;) {
      this.creds = await findCredentials();
      if (this.creds) {
        try {
          await this.request('GET', '/lol-summoner/v1/current-summoner');
          await this.openSocket();
          return;
        } catch { /* client en cours de démarrage : on réessaie */ }
      }
      this.emit('status', 'waiting');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  request(method, uri, body) {
    if (!this.creds) return Promise.reject(new Error('Client LoL non détecté'));
    const auth = Buffer.from(`riot:${this.creds.password}`).toString('base64');
    const data = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = https.request({
        host: '127.0.0.1', port: this.creds.port, path: uri, method, agent: localAgent,
        headers: {
          Authorization: `Basic ${auth}`, Accept: 'application/json',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
          if (res.statusCode >= 400) {
            const e = new Error(json?.message || `LCU ${res.statusCode} sur ${method} ${uri}`);
            e.status = res.statusCode;
            return reject(e);
          }
          resolve(json);
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  openSocket() {
    return new Promise((resolve, reject) => {
      const auth = Buffer.from(`riot:${this.creds.password}`).toString('base64');
      const ws = new WebSocket(`wss://127.0.0.1:${this.creds.port}`, 'wamp', {
        headers: { Authorization: `Basic ${auth}` }, rejectUnauthorized: false,
      });
      ws.on('open', () => {
        this.ws = ws;
        this.connected = true;
        ws.send(JSON.stringify([5, 'OnJsonApiEvent'])); // abonnement à tous les événements
        this.emit('status', 'connected');
        resolve();
      });
      ws.on('message', (buf) => {
        try {
          const msg = JSON.parse(buf.toString());
          if (msg[0] === 8 && msg[2]) this.emit('event', msg[2]); // { uri, eventType, data }
        } catch { /* message vide ou keep-alive */ }
      });
      ws.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.ws = null;
        if (wasConnected) {
          this.emit('status', 'disconnected');
          setTimeout(() => this.start(), 2000); // client fermé ou relancé
        }
      });
      ws.on('error', (e) => { if (!this.connected) reject(e); });
    });
  }
}
