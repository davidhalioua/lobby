// Relais Lobby (Cloudflare Workers) : sert l'app téléphone en HTTPS, relaie PC ⇄ téléphones,
// envoie les notifications « Partie trouvée ». Une « Room » (Durable Object) par PC.
import { DurableObject } from 'cloudflare:workers';
import { sendPush, vapidPublicKey } from './webpush.js';
import { scout } from './scout.js';

const TOKEN_RE = /^[a-f0-9]{32}$/;
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
async function roomName(token) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const roomFor = async (env, token) => env.ROOMS.get(env.ROOMS.idFromName(await roomName(token)));
const directory = (env) => env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'));
const readJson = async (req) => { try { return await req.json(); } catch { return {}; } };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const t = url.searchParams.get('t') || '';
    const p = url.pathname;

    if (p === '/pc' || p === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket attendu', { status: 426 });
      if (!TOKEN_RE.test(t)) return new Response('Jeton invalide', { status: 401 });
      return (await roomFor(env, t)).fetch(req);
    }
    if (p === '/check') {
      if (!TOKEN_RE.test(t)) return json({}, 401);
      return json({}, (await (await roomFor(env, t)).isRegistered()) ? 200 : 401);
    }
    if (p === '/pair' && req.method === 'POST') {
      const { code } = await readJson(req);
      const ip = req.headers.get('CF-Connecting-IP') || 'inconnue';
      const token = await directory(env).redeem(String(code || ''), ip);
      return token ? json({ token }) : json({ error: 'Code incorrect ou expiré' }, 401);
    }
    if (p === '/api/scout' && req.method === 'POST') {
      // Appelé par l'app PC quand une partie démarre (joueurs visibles à l'écran de chargement)
      const body = await readJson(req);
      if (!TOKEN_RE.test(body.t || '') || !(await (await roomFor(env, body.t)).isRegistered())) return json({}, 401);
      try { return json({ players: await scout(env, body) }); } catch (e) { return json({ error: e.message }, 502); }
    }
    if (p === '/api/vapid') return json({ key: vapidPublicKey(JSON.parse(env.VAPID_PRIVATE)) });
    if ((p === '/api/subscribe' || p === '/api/cmd') && req.method === 'POST') {
      const body = await readJson(req);
      if (!TOKEN_RE.test(body.t || '')) return json({}, 401);
      const room = await roomFor(env, body.t);
      if (!(await room.isRegistered())) return json({}, 401);
      if (p === '/api/subscribe') {
        const sub = body.subscription;
        if (!sub?.endpoint?.startsWith('https://') || !sub.keys?.p256dh || !sub.keys?.auth) return json({ error: 'Abonnement invalide' }, 400);
        await room.subscribe({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
        return json({ ok: true });
      }
      return json({}, (await room.command(body.cmd)) ? 202 : 503);
    }
    if (p === '/manifest.webmanifest') {
      return new Response(JSON.stringify({
        name: 'Lobby', short_name: 'Lobby', display: 'standalone',
        background_color: '#0C0F14', theme_color: '#0C0F14',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
     
        start_url: TOKEN_RE.test(t) ? `/?t=${t}` : '/',
      }), { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' } });
    }
    return env.ASSETS.fetch(req); // index.html, app.js, styles.css, sw.js
  },
};

// ---- Un PC et ses téléphones ----
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.lastState = null; // perdu si l'objet hiberne : on redemande alors l'état au PC
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  pc() { return this.ctx.getWebSockets('pc')[0] || null; }
  phones() { return this.ctx.getWebSockets('phone'); }
  async isRegistered() { return Boolean(await this.ctx.storage.get('registered')); }

  async fetch(req) {
    const url = new URL(req.url);
    const { 0: client, 1: server } = new WebSocketPair();
    if (url.pathname === '/pc') {
      for (const old of this.ctx.getWebSockets('pc')) old.close(4000, 'Remplacé par une nouvelle connexion');
      this.ctx.acceptWebSocket(server, ['pc']);
      server.serializeAttachment({ role: 'pc', token: url.searchParams.get('t') });
      await this.ctx.storage.put('registered', true);
    } else {
      if (!(await this.isRegistered())) return new Response('Inconnu', { status: 401 });
      const id = crypto.randomUUID();
      this.ctx.acceptWebSocket(server, ['phone', id]);
      server.serializeAttachment({ role: 'phone', id });
      const pc = this.pc();
      if (!pc) server.send(JSON.stringify({ type: 'pc', online: false }));
      else if (this.lastState) server.send(this.lastState);
      else pc.send(JSON.stringify({ type: 'resync' }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 256_000) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const me = ws.deserializeAttachment() || {};

    if (me.role === 'pc') {
      if (msg.type === 'state') {
        this.lastState = raw;
        for (const ph of this.phones()) ph.send(raw);
      } else if (msg.type === 'reply' && msg.to) {
        this.ctx.getWebSockets(msg.to)[0]?.send(JSON.stringify(msg.reply));
      } else if (msg.type === 'push') {
        await this.notify(msg.kind === 'accepted' ? 'accepted' : 'ready');
      } else if (msg.type === 'pairCode' && /^\d{6}$/.test(msg.code)) {
        await directory(this.env).register(msg.code, me.token, Math.min(Number(msg.expires) || 0, Date.now() + 15 * 60_000));
      }
      return;
    }
    // Téléphone → PC
    const pc = this.pc();
    if (!pc) return ws.send(JSON.stringify({ type: 'error', message: 'PC hors ligne' }));
    pc.send(JSON.stringify({ type: 'cmd', from: me.id, cmd: msg }));
  }

  async webSocketClose(ws) {
    const me = ws.deserializeAttachment() || {};
    if (me.role === 'pc' && !this.pc()) {
      this.lastState = null;
      for (const ph of this.phones()) ph.send(JSON.stringify({ type: 'pc', online: false }));
    }
  }

  async command(cmd) {
    const pc = this.pc();
    if (!pc || !cmd?.cmd) return false;
    pc.send(JSON.stringify({ type: 'cmd', from: 'notification', cmd }));
    return true;
  }

  async subscribe(sub) {
    const subs = ((await this.ctx.storage.get('subs')) || []).filter((s) => s.endpoint !== sub.endpoint);
    subs.push(sub);
    await this.ctx.storage.put('subs', subs.slice(-5)); // 5 appareils max par PC
  }

  async notify(kind) {
    const subs = (await this.ctx.storage.get('subs')) || [];
    if (!subs.length) return;
    const opts = { jwk: JSON.parse(this.env.VAPID_PRIVATE), subject: this.env.VAPID_SUBJECT || 'mailto:lobby@example.com' };
    const results = await Promise.all(subs.map((s) => sendPush(s, JSON.stringify({ kind }), opts).catch(() => 0)));
    const alive = subs.filter((_, i) => results[i] !== 404 && results[i] !== 410);
    if (alive.length !== subs.length) await this.ctx.storage.put('subs', alive);
  }
}

// ---- Codes d'appairage à 6 chiffres, avec limite d'essais par adresse IP ----
export class Directory extends DurableObject {
  async register(code, token, expires) {
    if (!token) return;
    await this.ctx.storage.put(`code:${code}`, { token, expires });
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 60 * 60_000);
  }

  // Ménage horaire : codes expirés et compteurs d'essais périmés
  async alarm() {
    const now = Date.now();
    const all = await this.ctx.storage.list();
    const stale = [...all].filter(([, v]) => (v.expires ?? v.until ?? 0) < now).map(([k]) => k);
    for (let i = 0; i < stale.length; i += 128) await this.ctx.storage.delete(stale.slice(i, i + 128));
    if (all.size > stale.length) await this.ctx.storage.setAlarm(now + 60 * 60_000);
  }

  async redeem(code, ip) {
    const now = Date.now();
    const key = `ip:${ip}`;
    const tries = (await this.ctx.storage.get(key)) || { n: 0, until: now + 10 * 60_000 };
    if (now > tries.until) { tries.n = 0; tries.until = now + 10 * 60_000; }
    if (tries.n >= 10) return null; // 10 essais ratés : bloqué 10 minutes

    const entry = /^\d{6}$/.test(code) ? await this.ctx.storage.get(`code:${code}`) : null;
    if (!entry || now > entry.expires) {
      tries.n++;
      await this.ctx.storage.put(key, tries);
      return null;
    }
    await this.ctx.storage.delete(`code:${code}`); // usage unique
    return entry.token;
  }
}
