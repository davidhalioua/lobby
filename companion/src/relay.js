// Connexion sortante vers le relais en ligne (Cloudflare) : téléphone hors du Wi-Fi + notifications.
// Le PC n'ouvre aucun port sur Internet : c'est lui qui appelle le relais.
import WebSocket from 'ws';

export class Relay {
  constructor({ url, token, onCommand, onResync }) {
    this.url = url ? url.replace(/\/$/, '').replace(/^http/, 'ws') : null;
    this.token = token;
    this.onCommand = onCommand;
    this.onResync = onResync;
    this.ws = null;
    this.online = false;
    this.retry = 1000;
  }

  get enabled() { return Boolean(this.url); }

  start() {
    if (!this.enabled) return;
    const ws = new WebSocket(`${this.url}/pc?t=${encodeURIComponent(this.token)}`);
    this.ws = ws;
    let ping;
    ws.on('open', () => {
      this.online = true;
      this.retry = 1000;
      console.log('✔ Relais en ligne connecté');
      ping = setInterval(() => ws.readyState === 1 && ws.send('ping'), 30_000);
      this.onResync();
    });
    ws.on('message', async (raw) => {
      const text = raw.toString();
      if (text === 'pong') return;
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.type === 'resync') return this.onResync();
      if (msg.type === 'cmd') {
        try {
          await this.onCommand(msg.cmd);
          this.send({ type: 'reply', to: msg.from, reply: { type: 'ok', cmd: msg.cmd?.cmd } });
        } catch (e) {
          this.send({ type: 'reply', to: msg.from, reply: { type: 'error', cmd: msg.cmd?.cmd, message: e.message } });
        }
      }
    });
    ws.on('close', () => {
      clearInterval(ping);
      if (this.online) console.log('… Relais déconnecté, nouvelle tentative');
      this.online = false;
      setTimeout(() => this.start(), this.retry);
      this.retry = Math.min(this.retry * 2, 60_000);
    });
    ws.on('error', () => { /* géré par « close » */ });
  }

  send(obj) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  sendState(state) { this.send({ type: 'state', state }); }
  push(kind) { this.send({ type: 'push', kind }); }
  pairCode(code, expires) { this.send({ type: 'pairCode', code, expires }); }
}
