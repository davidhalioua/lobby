// Lobby — app compagnon PC : relaie le client LoL vers les téléphones du réseau local.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import { LCU } from './lcu.js';
import { getAsset } from './assets.js';
import { APP_DIR, isPackaged, bootstrap, openInBrowser, redirectLogs } from './desktop.js';
import { startAutoUpdate } from './update.js';
import { Relay } from './relay.js';
import { fetchBuild, applyBuild } from './builds.js';
import pkg from '../package.json' with { type: 'json' };

if (bootstrap()) process.exit(0); // Lobby.exe vient de s'installer ou de se relancer en arrière-plan
redirectLogs();

const VERSION = pkg.version;
const PORT = Number(process.env.LOBBY_PORT || 7777);
const CONFIG_FILE = path.join(APP_DIR, isPackaged ? 'config.json' : '.lobby.json');
// Lobby.exe : tout lancement sauf celui du démarrage de Windows affiche la page QR
const WANTS_SETUP = isPackaged ? !process.argv.includes('--autostart') : process.argv.includes('--setup');

// ---- Jeton d'appairage (conservé entre deux lancements pour ne pas re-scanner le QR) ----
function loadToken() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).token; } catch { /* premier lancement */ }
  const token = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ token }), { mode: 0o600 });
  return token;
}
const TOKEN = process.argv.includes('--new-token')
  ? (fs.rmSync(CONFIG_FILE, { force: true }), loadToken())
  : loadToken();

const tokenOk = (t) => typeof t === 'string' && t.length === TOKEN.length
  && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}

const safe = (p) => p.catch(() => null);

// ---- État partagé avec les téléphones ----
const lcu = new LCU();
const state = {
  lcu: 'waiting', phase: 'None', readyCheck: null, queue: null,
  champSelect: null, mode: null, pickable: [], bannable: [], perks: { pages: [], currentId: null },
  lobby: null, queues: [], autoAcceptUntil: 0, relay: false,
  build: null, autoBuild: [],
  invitations: [], friends: [], prefs: { picks: {}, bans: [] },
};

// ---- Préférences enregistrées (import auto du build, par champion) ----
function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; } }
function saveConfig(patch) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...readConfig(), ...patch }), { mode: 0o600 });
}
state.autoBuild = readConfig().autoBuild || [];
state.prefs = readConfig().prefs || state.prefs;

// ---- Invitations reçues et amis en ligne ----
const nameCache = new Map();
async function summonerName(id) {
  if (!id) return '';
  if (!nameCache.has(id)) {
    const s = await safe(lcu.request('GET', `/lol-summoner/v1/summoners/${id}`));
    nameCache.set(id, s?.gameName || s?.displayName || '');
  }
  return nameCache.get(id);
}

async function refreshInvitations() {
  const list = (await safe(lcu.request('GET', '/lol-lobby/v2/received-invitations'))) || [];
  state.invitations = await Promise.all(list.filter((i) => i.state === 'Pending').map(async (i) => ({
    id: i.invitationId,
    from: i.fromSummonerName || await summonerName(i.fromSummonerId) || 'Un ami',
    queue: state.queues.find((q) => q.id === i.gameConfig?.queueId)?.name || '',
  })));
}

const ONLINE_ORDER = { chat: 0, mobile: 2, away: 1, dnd: 1 };
async function refreshFriends() {
  const list = (await safe(lcu.request('GET', '/lol-chat/v1/friends'))) || [];
  state.friends = list
    .filter((f) => f.availability && f.availability !== 'offline' && f.availability !== 'mobile' && (f.product === 'league_of_legends' || f.productName?.includes('League') || f.lol?.gameStatus))
    .map((f) => ({
      summonerId: f.summonerId, puuid: f.puuid, name: f.gameName || f.name || '…',
      status: { outOfGame: 'Disponible', inQueue: 'En file', championSelect: 'En sélection', inGame: 'En partie', hosting_NORMAL: 'Dans un salon', hosting_RANKED_SOLO_5x5: 'Dans un salon' }[f.lol?.gameStatus] || (f.availability === 'away' ? 'Absent' : 'En ligne'),
      free: !f.lol?.gameStatus || f.lol.gameStatus === 'outOfGame',
      order: ONLINE_ORDER[f.availability] ?? 3,
    }))
    .sort((a, b) => Number(b.free) - Number(a.free) || a.order - b.order || a.name.localeCompare(b.name))
    .slice(0, 30);
}
let friendsTimer = null;
const refreshFriendsSoon = () => {
  clearTimeout(friendsTimer);
  friendsTimer = setTimeout(async () => { await refreshFriends(); broadcast(); }, 1500);
};

// ---- Pré-sélection : survole tout seul ton favori quand vient ton tour (sans verrouiller) ----
let prehovered = null;
async function maybePrehover() {
  const cs = state.champSelect;
  const a = cs?.action;
  if (!a || a.championId || prehovered === a.id) return;
  const me = cs.myTeam.find((p) => p.isMe);
  const taken = new Set([...cs.bans.mine, ...cs.bans.theirs, ...cs.myTeam.filter((p) => !p.isMe).flatMap((p) => [p.championId, p.intentId]), ...cs.theirTeam.map((p) => p.championId)].filter(Boolean));
  const lane = (me?.position || '').toUpperCase();
  const wanted = a.type === 'ban'
    ? state.prefs.bans || []
    : [...(state.prefs.picks?.[lane] || []), ...(state.prefs.picks?.ANY || [])];
  const allowed = new Set(a.type === 'ban' ? state.bannable : state.pickable);
  // Ne jamais bannir le champion qu'un coéquipier veut jouer
  const mates = new Set(cs.myTeam.filter((p) => !p.isMe).map((p) => p.intentId).filter(Boolean));
  if (!allowed.size) return; // listes pas encore chargées : on réessaiera au prochain événement
  const choice = wanted.find((id) => allowed.has(id) && !taken.has(id) && !(a.type === 'ban' && mates.has(id)));
  prehovered = a.id;
  if (!choice) return;
  await safe(lcu.request('PATCH', `/lol-champ-select/v1/session/actions/${a.id}`, { championId: choice }));
}

// ---- Build OP.GG : chargé dès que ton champion est choisi, importé tout seul si demandé ----
let buildFor = null;
async function maybeLoadBuild() {
  const cs = state.champSelect;
  if (!cs) { state.build = null; buildFor = null; return; }
  const me = cs.myTeam.find((p) => p.isMe);
  const locked = me?.championId && (cs.bench || !cs.action || cs.action.type !== 'pick');
  if (!locked) return;
  if (!state.mode) await refreshMode();
  const key = `${me.championId}:${state.mode?.queueId}`;
  if (key === buildFor) return;
  buildFor = key;
  const championId = me.championId;
  state.build = { championId, status: 'loading' };
  broadcast();
  try {
    const gameMode = state.mode?.queueId === 440 ? 'flex' : state.mode?.gameMode;
    const data = await fetchBuild({ championId, position: me.position, gameMode });
    if (buildFor !== key) return; // champion changé entre-temps
    state.build = { championId, status: 'ready', data, applied: [] };
    if (state.autoBuild.includes(championId)) await importBuild();
  } catch (e) {
    if (buildFor === key) state.build = { championId, status: 'error', error: e.message };
  }
  broadcast();
}

async function importBuild() {
  const b = state.build;
  if (b?.status !== 'ready') throw new Error("Le build n'est pas encore chargé");
  const champ = await lcu.request('GET', `/lol-game-data/assets/v1/champions/${b.championId}.json`).catch(() => null);
  const me = state.champSelect?.myTeam.find((p) => p.isMe);
  b.applied = await applyBuild(lcu, b.data, { championName: champ?.name || 'Champion', currentSpells: [me?.spell1Id, me?.spell2Id] });
  await refreshPerks();
  broadcast();
}

// Modes les plus joués en premier ; les autres suivent dans l'ordre du client
const QUEUE_ORDER = [420, 440, 400, 490, 450, 2400, 1700, 900, 1900, 1020, 1300, 830, 840, 850];
const POSITIONS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY', 'FILL'];

async function refreshQueues() {
  const list = await safe(lcu.request('GET', '/lol-game-queues/v1/queues'));
  const seen = new Set();
  state.queues = (list || [])
    .filter((q) => q.queueAvailability === 'Available' && ['PvP', 'VersusAi'].includes(q.category) && q.description)
    .filter((q) => !seen.has(q.description) && seen.add(q.description))
    .map((q) => ({ id: q.id, name: q.description, ranked: Boolean(q.isRanked), bots: q.category === 'VersusAi' }))
    .sort((a, b) => {
      const ia = QUEUE_ORDER.indexOf(a.id); const ib = QUEUE_ORDER.indexOf(b.id);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || Number(a.bots) - Number(b.bots);
    });
}

function simplifyLobby(l) {
  if (!l?.gameConfig) return null;
  const me = l.localMember || {};
  return {
    queueId: l.gameConfig.queueId,
    name: state.queues.find((q) => q.id === l.gameConfig.queueId)?.name || l.gameConfig.gameMode || 'Salon',
    showPositions: Boolean(l.gameConfig.showPositionSelector),
    isLeader: Boolean(me.isLeader),
    canStart: l.canStartActivity !== false,
    positions: [me.firstPositionPreference || 'UNSELECTED', me.secondPositionPreference || 'UNSELECTED'],
    members: (l.members || []).map((m) => ({
      name: m.gameName || m.summonerName || '…', isLeader: Boolean(m.isLeader),
      isMe: m.puuid === me.puuid, position: m.firstPositionPreference || '',
    })),
  };
}

function simplifySession(s) {
  if (!s) return null;
  const me = s.localPlayerCellId;
  const myCells = new Set(s.myTeam.map((p) => p.cellId));
  const actions = s.actions.flat();
  const mine = actions.filter((a) => a.actorCellId === me);
  const current = mine.find((a) => a.isInProgress && !a.completed) || null;
  const bans = actions.filter((a) => a.type === 'ban' && a.completed && a.championId);
  return {
    myCellId: me,
    timer: { phase: s.timer?.phase, msLeft: s.timer?.adjustedTimeLeftInPhase ?? 0, at: Date.now() },
    myTeam: s.myTeam.map((p) => ({
      cellId: p.cellId, isMe: p.cellId === me, position: p.assignedPosition || '',
      championId: p.championId || 0, intentId: p.championPickIntent || 0,
      spell1Id: p.spell1Id, spell2Id: p.spell2Id,
    })),
    theirTeam: s.theirTeam.map((p) => ({ cellId: p.cellId, championId: p.championId || 0 })),
    bans: {
      mine: bans.filter((a) => myCells.has(a.actorCellId)).map((a) => a.championId),
      theirs: bans.filter((a) => !myCells.has(a.actorCellId)).map((a) => a.championId),
    },
    action: current && { id: current.id, type: current.type, championId: current.championId || 0 },
    // ARAM, ARAM du chaos… : champion aléatoire, banc partagé et relances
    bench: s.benchEnabled ? (s.benchChampions || []).map((b) => b.championId ?? b) : null,
    rerolls: s.allowRerolling ? (s.rerollsRemaining ?? 0) : null,
  };
}


async function refreshChampLists() {
  const [pick, ban] = await Promise.all([
    safe(lcu.request('GET', '/lol-champ-select/v1/pickable-champion-ids')),
    safe(lcu.request('GET', '/lol-champ-select/v1/bannable-champion-ids')),
  ]);
  state.pickable = pick || [];
  state.bannable = ban || [];
}

async function refreshPerks() {
  const [pages, current] = await Promise.all([
    safe(lcu.request('GET', '/lol-perks/v1/pages')),
    safe(lcu.request('GET', '/lol-perks/v1/currentpage')),
  ]);
  state.perks = {
    pages: (pages || []).filter((p) => p.isValid !== false).map((p) => ({ id: p.id, name: p.name, editable: p.isEditable })),
    currentId: current?.id ?? null,
  };
}

async function refreshMode() {
  const g = await safe(lcu.request('GET', '/lol-gameflow/v1/session'));
  const q = g?.gameData?.queue;
  state.mode = q ? { name: q.description || q.gameMode || '', gameMode: q.gameMode || '', queueId: q.id } : null;
}

function debugDump(session) {
  if (!process.env.LOBBY_DEBUG || !session) return;
  fs.writeFileSync('lobby-debug.json', JSON.stringify({ mode: state.mode, session }, null, 2));
}

async function syncAll() {
  state.phase = (await safe(lcu.request('GET', '/lol-gameflow/v1/gameflow-phase'))) || 'None';
  state.readyCheck = await safe(lcu.request('GET', '/lol-matchmaking/v1/ready-check'));
  state.queue = await safe(lcu.request('GET', '/lol-matchmaking/v1/search'));
  const session = await safe(lcu.request('GET', '/lol-champ-select/v1/session'));
  state.champSelect = simplifySession(session);
  if (state.champSelect) { await refreshChampLists(); await refreshMode(); debugDump(session); }
  await refreshPerks();
  await refreshQueues();
  state.lobby = simplifyLobby(await safe(lcu.request('GET', '/lol-lobby/v2/lobby')));
  await Promise.all([refreshInvitations(), refreshFriends()]);
  broadcast();
}

// ---- Partie trouvée : auto-accept ou notification ----
let readyHandled = false; // un seul déclenchement par ready-check
function onReadyCheck(rc) {
  if (rc?.state !== 'InProgress') { readyHandled = false; return; }
  if (readyHandled || rc.playerResponse !== 'None') return;
  readyHandled = true;
  if (state.autoAcceptUntil > Date.now()) {
    setTimeout(() => lcu.request('POST', '/lol-matchmaking/v1/ready-check/accept').catch(() => {}), 1500);
    relay.push('accepted');
  } else {
    relay.push('ready');
  }
}

lcu.on('status', (s) => {
  state.lcu = s === 'connected' ? 'connected' : 'waiting';
  console.log(s === 'connected' ? '✔ Client LoL connecté' : '… En attente du client LoL');
  if (s === 'connected') syncAll(); else broadcast();
});

lcu.on('event', async ({ uri, eventType, data }) => {
  const deleted = eventType === 'Delete';
  switch (uri) {
    case '/lol-gameflow/v1/gameflow-phase':
      state.phase = data;
      if (data !== 'ChampSelect' && state.champSelect) { state.champSelect = null; state.build = null; buildFor = null; }
      if (data === 'ChampSelect') await Promise.all([refreshChampLists(), refreshPerks(), refreshMode()]);
      break;
    case '/lol-matchmaking/v1/ready-check':
      state.readyCheck = deleted ? null : data;
      onReadyCheck(state.readyCheck);
      break;
    case '/lol-lobby/v2/lobby':
      state.lobby = deleted ? null : simplifyLobby(data);
      break;
    case '/lol-matchmaking/v1/search':
      state.queue = deleted ? null : data;
      break;
    case '/lol-champ-select/v1/session':
      state.champSelect = deleted ? null : simplifySession(data);
      debugDump(deleted ? null : data);
      maybeLoadBuild();
      maybePrehover();
      break;
    case '/lol-lobby/v2/received-invitations':
      await refreshInvitations();
      break;
    case '/lol-perks/v1/pages':
    case '/lol-perks/v1/currentpage':
      await refreshPerks();
      break;
    default:
      if (uri.startsWith('/lol-chat/v1/friends')) refreshFriendsSoon();
      return; // événement sans intérêt pour l'app : pas de diffusion immédiate
  }
  broadcast();
});

// ---- Commandes envoyées par le téléphone ----
async function handle(cmd) {
  const action = state.champSelect?.action;
  switch (cmd.cmd) {
    case 'accept': return lcu.request('POST', '/lol-matchmaking/v1/ready-check/accept');
    case 'decline': return lcu.request('POST', '/lol-matchmaking/v1/ready-check/decline');
    case 'select': // survol (pick) ou sélection du ban, sans verrouiller
      if (!action) throw new Error("Ce n'est pas ton tour");
      return lcu.request('PATCH', `/lol-champ-select/v1/session/actions/${action.id}`, { championId: Number(cmd.championId) });
    case 'lock':
      if (!action?.championId) throw new Error("Choisis d'abord un champion");
      await lcu.request('POST', `/lol-champ-select/v1/session/actions/${action.id}/complete`);
      return refreshChampLists();
    case 'spells':
      return lcu.request('PATCH', '/lol-champ-select/v1/session/my-selection', {
        spell1Id: Number(cmd.spell1Id), spell2Id: Number(cmd.spell2Id),
      });
    case 'benchSwap': // ARAM : prendre un champion du banc
      return lcu.request('POST', `/lol-champ-select/v1/session/bench/swap/${Number(cmd.championId)}`);
    case 'reroll':
      return lcu.request('POST', '/lol-champ-select/v1/session/my-selection/reroll');
    case 'createLobby':
      return lcu.request('POST', '/lol-lobby/v2/lobby', { queueId: Number(cmd.queueId) });
    case 'leaveLobby':
      return lcu.request('DELETE', '/lol-lobby/v2/lobby');
    case 'positions': {
      const ok = (p) => (POSITIONS.includes(p) ? p : 'UNSELECTED');
      return lcu.request('PUT', '/lol-lobby/v2/lobby/members/localMember/position-preferences', {
        firstPreference: ok(cmd.first), secondPreference: cmd.first === 'FILL' ? 'UNSELECTED' : ok(cmd.second),
      });
    }
    case 'startSearch':
      return lcu.request('POST', '/lol-lobby/v2/lobby/matchmaking/search');
    case 'cancelSearch':
      return lcu.request('DELETE', '/lol-lobby/v2/lobby/matchmaking/search');
    case 'autoAccept': {
      const minutes = Math.min(Math.max(Number(cmd.minutes) || 0, 0), 240);
      state.autoAcceptUntil = minutes ? Date.now() + minutes * 60_000 : 0;
      return broadcast();
    }
    case 'acceptInvite':
      return lcu.request('POST', `/lol-lobby/v2/received-invitations/${encodeURIComponent(cmd.id)}/accept`);
    case 'declineInvite':
      return lcu.request('POST', `/lol-lobby/v2/received-invitations/${encodeURIComponent(cmd.id)}/decline`);
    case 'invite': {
      const f = state.friends.find((x) => String(x.summonerId) === String(cmd.summonerId));
      if (!f) throw new Error('Ami introuvable');
      return lcu.request('POST', '/lol-lobby/v2/lobby/invitations', [{ toSummonerId: f.summonerId }]);
    }
    case 'playAgain':
      return lcu.request('POST', '/lol-lobby/v2/play-again');
    case 'setPrefs': {
      const ids = (l) => (Array.isArray(l) ? l.map(Number).filter((n) => n > 0).slice(0, 5) : []);
      const picks = {};
      for (const k of ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY', 'ANY']) picks[k] = ids(cmd.prefs?.picks?.[k]);
      state.prefs = { picks, bans: ids(cmd.prefs?.bans) };
      saveConfig({ prefs: state.prefs });
      return broadcast();
    }
    case 'importBuild':
      return importBuild();
    case 'autoBuild': {
      const id = Number(cmd.championId);
      state.autoBuild = state.autoBuild.filter((x) => x !== id);
      if (cmd.on) state.autoBuild.push(id);
      saveConfig({ autoBuild: state.autoBuild });
      if (cmd.on && state.build?.championId === id && state.build.status === 'ready' && !state.build.applied?.length) await importBuild();
      return broadcast();
    }
    case 'runePage':
      await lcu.request('PUT', '/lol-perks/v1/currentpage', Number(cmd.id));
      return refreshPerks();
    default:
      throw new Error(`Commande inconnue : ${cmd.cmd}`);
  }
}

// ---- Serveur HTTP (interface du téléphone, page d'appairage locale) + WebSocket ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const relayUrl = () => (process.env.LOBBY_RELAY || pkg.lobby?.relayUrl || '').replace(/\/$/, '');
const phoneLink = () => (relayUrl() ? `${relayUrl()}/?t=${TOKEN}` : `http://${lanAddress()}:${PORT}/?t=${TOKEN}`);

// Code d'appairage à 6 chiffres (à taper dans l'app) : valable 10 minutes, 10 essais ratés max.
const pairing = { code: null, expires: 0, failures: 0 };
function pairingCode() {
  if (!pairing.code || Date.now() > pairing.expires || pairing.failures >= 10) {
    pairing.code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    pairing.expires = Date.now() + 10 * 60 * 1000;
    pairing.failures = 0;
    relay.pairCode(pairing.code, pairing.expires);
  }
  return pairing.code;
}
function tryPair(code) {
  if (!pairing.code || Date.now() > pairing.expires || pairing.failures >= 10) return null;
  if (String(code).replace(/\D/g, '') === pairing.code) { pairing.code = null; return TOKEN; }
  pairing.failures++;
  return null;
}
const readBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 1000) req.destroy(); }); req.on('end', () => resolve(b));
});
const sendJson = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

async function setupPage() {
  const code = pairingCode();
  const qr = await QRCode.toString(phoneLink(), { type: 'svg', margin: 1, color: { dark: '#0C0F14', light: '#FFFFFF' } });
  const ok = state.lcu === 'connected';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Lobby</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0C0F14;color:#E8ECF2;font-family:Inter,system-ui,sans-serif}
main{max-width:420px;text-align:center;display:flex;flex-direction:column;gap:18px;padding:32px}
.qr{background:#fff;border-radius:20px;padding:16px;width:260px;margin:0 auto}.muted{color:#A9B3C1;font-size:14px;line-height:1.5}
code{background:#151A22;padding:8px 10px;border-radius:8px;font-size:12px;word-break:break-all;display:block}
button{background:transparent;border:1px solid #2A3341;color:#A9B3C1;border-radius:12px;padding:10px 16px;font:inherit;cursor:pointer}
.pill{display:inline-flex;gap:8px;align-items:center;margin:0 auto;background:#151A22;border-radius:999px;padding:6px 12px;font-size:13px;color:#A9B3C1}
.dot{width:8px;height:8px;border-radius:50%;background:${ok ? '#4ADE80' : '#FF9A57'}}</style></head>
<body><main><h1 style="margin:0">Lobby</h1>
<span class="pill"><span class="dot"></span>${ok ? 'Client LoL connecté' : 'En attente du client LoL'}</span>
<div class="qr">${qr}</div>
<p class="muted">Scanne ce QR code avec ton téléphone${relayUrl() ? '' : ', sur le <strong>même Wi-Fi</strong> que ce PC'}.<br>
Puis « Ajouter à l'écran d'accueil » pour l'avoir comme une app.</p>
<p class="muted" style="margin:0">ou tape ce code dans l'app Lobby :</p>
<div style="font-size:44px;font-weight:700;letter-spacing:8px;font-family:'Space Grotesk',Inter,sans-serif">${code.slice(0, 3)} ${code.slice(3)}</div>
<p class="muted" style="font-size:12px;margin:0">Code valable 10 minutes · <a href="/setup" style="color:#8FE3F7">en générer un nouveau</a></p>
<p class="muted">Ne partage pas ce lien : il donne le contrôle de ton client.<br>Lobby se lance tout seul au démarrage de Windows.</p>
<form method="post" action="/quit"><button>Quitter Lobby</button></form>
<p class="muted" style="font-size:12px">Version ${VERSION}<br>Lobby est un projet fan, non affilié à Riot Games, conçu dans le respect de la politique « Legal Jibber Jabber » de Riot.</p></main></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/setup' || url.pathname === '/quit') {
    if (!isLocal(req)) { res.writeHead(403); return res.end('Réservé à ce PC'); }
    if (url.pathname === '/quit' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<body style="background:#0C0F14;color:#E8ECF2;font-family:sans-serif;text-align:center;padding-top:20vh">Lobby est arrêté. Relance-le depuis le menu Démarrer.</body>');
      return setTimeout(() => process.exit(0), 200);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(await setupPage());
  }
  if (url.pathname === '/pair' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { /* corps invalide */ }
    const token = tryPair(body.code);
    return token ? sendJson(res, 200, { token }) : sendJson(res, 401, { error: 'Code incorrect ou expiré' });
  }
  if (url.pathname === '/check') return sendJson(res, tokenOk(url.searchParams.get('t')) ? 200 : 401, {});
  if (url.pathname === '/manifest.webmanifest') {
    // L'icône d'écran d'accueil rouvre l'app déjà appairée (iOS isole son stockage de celui de Safari)
    const t = url.searchParams.get('t');
    return sendJson(res, 200, {
      name: 'Lobby', short_name: 'Lobby', display: 'standalone',
      background_color: '#0C0F14', theme_color: '#0C0F14',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
     
      start_url: tokenOk(t) ? `/?t=${t}` : '/',
    });
  }
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const body = getAsset(name);
  if (!body) { res.writeHead(404); return res.end('Introuvable'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(body);
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' || !tokenOk(url.searchParams.get('t'))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

const relay = new Relay({
  url: process.env.LOBBY_RELAY || pkg.lobby?.relayUrl,
  token: TOKEN,
  onCommand: (cmd) => handle(cmd),
  onResync: () => { if (pairing.code) relay.pairCode(pairing.code, pairing.expires); broadcast(); },
});

function broadcast() {
  state.relay = relay.online;
  relay.sendState(state);
  const msg = JSON.stringify({ type: 'state', state });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', state }));
  ws.on('message', async (raw) => {
    let cmd;
    try { cmd = JSON.parse(raw.toString()); } catch { return; }
    try {
      await handle(cmd);
      ws.send(JSON.stringify({ type: 'ok', cmd: cmd.cmd }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', cmd: cmd.cmd, message: e.message }));
    }
  });
});

function shutdown() {
  for (const c of wss.clients) c.terminate();
  return new Promise((r) => server.close(() => r()));
}

let listenTries = 0;
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  if (isPackaged && WANTS_SETUP) {
    // Lobby tourne déjà : on affiche simplement sa page d'appairage
    openInBrowser(`http://127.0.0.1:${PORT}/setup`);
    return process.exit(0);
  }
  if (isPackaged && ++listenTries <= 5) return setTimeout(() => server.listen(PORT, '0.0.0.0'), 1000); // ancienne version en train de s'arrêter
  console.error(`Le port ${PORT} est déjà utilisé. Lobby tourne peut-être déjà ?`);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Lobby ${VERSION} lancé sur le port ${PORT}`);
  if (isPackaged) {
    if (WANTS_SETUP) openInBrowser(`http://127.0.0.1:${PORT}/setup`);
  } else {
    console.log('\n  Scanne ce QR code avec ton téléphone (même Wi-Fi que le PC) :\n');
    qrcodeTerminal.generate(phoneLink(), { small: true });
    console.log(`\n  ou ouvre : ${phoneLink()}\n  Page d'appairage : http://127.0.0.1:${PORT}/setup\n  (Ne partage pas ce lien. Nouveau lien : npm start -- --new-token)\n`);
  }
  lcu.start();
  relay.start();
  startAutoUpdate({
    repo: pkg.lobby?.updateRepo,
    version: VERSION,
    isBusy: () => ['Matchmaking', 'ReadyCheck', 'ChampSelect'].includes(state.phase),
    shutdown,
  });
});
