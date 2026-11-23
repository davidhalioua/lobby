// Lobby — interface téléphone. Reçoit l'état du client via l'app PC, envoie les commandes.
'use strict';

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

// ---------- Appairage ----------
// Le jeton arrive par le QR code (?t=…) ou par le code à 6 chiffres. On le garde aussi dans l'URL :
// sur iPhone, l'icône d'écran d'accueil n'a pas accès au stockage de Safari et rouvre cette URL.
const urlToken = new URLSearchParams(location.search).get('t') || new URLSearchParams(location.hash.slice(1)).get('t');
let token = urlToken;
try { token = token || localStorage.getItem('lobby.token'); } catch {}

function savePairing(t) {
  const isNew = token !== t;
  token = t;
  if (isNew) setTimeout(setupServiceWorker, 0);
  try { localStorage.setItem('lobby.token', t); } catch {}
  history.replaceState(null, '', `/?t=${encodeURIComponent(t)}`);
  document.querySelector('link[rel="manifest"]').href = `manifest.webmanifest?t=${encodeURIComponent(t)}`;
}
function forgetPairing() {
  token = null;
  try { localStorage.removeItem('lobby.token'); } catch {}
  history.replaceState(null, '', '/');
  document.querySelector('link[rel="manifest"]').href = 'manifest.webmanifest';
}
if (token) savePairing(token);

async function pairWithCode(code) {
  try {
    const res = await fetch('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    if (!res.ok) return toast('Code incorrect ou expiré');
    savePairing((await res.json()).token);
    connect();
  } catch { toast('PC injoignable'); }
}

// ---------- Données Data Dragon (images et noms officiels de Riot) ----------
const dd = { v: null, champs: {}, spells: {} };
async function loadDataDragon() {
  try {
    const versions = await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json();
    dd.v = versions[0];
    const base = `https://ddragon.leagueoflegends.com/cdn/${dd.v}/data/fr_FR`;
    const [champs, spells] = await Promise.all([
      fetch(`${base}/champion.json`).then((r) => r.json()),
      fetch(`${base}/summoner.json`).then((r) => r.json()),
    ]);
    for (const c of Object.values(champs.data)) dd.champs[c.key] = { id: c.id, name: c.name };
    for (const s of Object.values(spells.data)) {
      if (s.modes.includes('CLASSIC')) dd.spells[s.key] = { id: s.id, name: s.name };
    }
  } catch { toast('Images indisponibles (pas d\'accès à Data Dragon)'); }
  render();
}
const champName = (id) => dd.champs[id]?.name || (id ? `#${id}` : '');
const champImg = (id) => (dd.v && dd.champs[id]?.id) ? `https://ddragon.leagueoflegends.com/cdn/${dd.v}/img/champion/${dd.champs[id].id}.png` : '';
const spellImg = (id) => (dd.v && dd.spells[id]) ? `https://ddragon.leagueoflegends.com/cdn/${dd.v}/img/spell/${dd.spells[id].id}.png` : '';
const POS = { top: 'Top', jungle: 'Jungle', middle: 'Mid', bottom: 'ADC', utility: 'Support' };

// Icônes de postes (dessins originaux, pas ceux de Riot)
const LANE_PATHS = {
  TOP: '<path d="M3 19 12 5l9 14Z"/>',
  JUNGLE: '<path d="M5 19c0-8 6-14 14-14 0 8-6 14-14 14Z"/><path d="M5 19 13 11"/>',
  MIDDLE: '<path d="M4 20 20 4"/><circle cx="12" cy="12" r="3"/>',
  BOTTOM: '<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
  UTILITY: '<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6Z"/>',
  FILL: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
};
const ownLaneIcon = (k, size, hidden) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${hidden ? ' style="display:none"' : ''}>${LANE_PATHS[k]}</svg>`;
// Icônes officielles du client, chargées à l'affichage depuis CommunityDragon (miroir des fichiers du client) ;
// nos dessins prennent le relais si le chargement échoue. « Peu importe » n'a pas d'équivalent officiel.
const CDRAGON_LANE = 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/svg/position-';
function laneIcon(key, size = 16, active = false) {
  const k = String(key).toUpperCase();
  if (!LANE_PATHS[k]) return '';
  if (k === 'FILL') return ownLaneIcon(k, size, false);
  const src = `${CDRAGON_LANE}${k.toLowerCase()}${active ? '-light' : ''}.svg`;
  return `<img src="${src}" width="${size}" height="${size}" alt="" aria-hidden="true" onerror="this.style.display='none';this.nextElementSibling.style.display=''">${ownLaneIcon(k, size, true)}`;
}
const SEARCH_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const img = (src, cls = 'portrait', alt = '') => (src
  ? `<img class="${cls}" src="${src}" alt="${esc(alt)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:this.className}))">`
  : `<div class="${cls}" aria-hidden="true"></div>`);

// ---------- Connexion à l'app PC ----------
let ws = null;
let state = null;
let stateAt = 0;
const ui = { tab: 'pick', search: '', spellSlot: null, modes: false, friends: false, view: null, prefsPick: null };
let pcOnline = true;

function connect() {
  if (!token) return render();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?t=${encodeURIComponent(token)}`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'state') { pcOnline = true; onState(msg.state); }
    else if (msg.type === 'pc') { pcOnline = msg.online; if (!pcOnline) state = null; render(); }
    else if (msg.type === 'error') toast(msg.message);
  };
  ws.onclose = async () => {
    state = null;
    // Jeton refusé (ex. nouveau jeton généré sur le PC) : retour à l'écran d'appairage
    try { if ((await fetch(`/check?t=${encodeURIComponent(token)}`)).status === 401) { forgetPairing(); return render(); } } catch {}
    render(); setTimeout(connect, 2000);
  };
}
const send = (cmd) => ws?.readyState === 1 ? ws.send(JSON.stringify(cmd)) : toast('PC déconnecté');

// ---------- Alerte « partie trouvée » ----------
let audio = null;
document.addEventListener('pointerdown', () => { audio ??= new (window.AudioContext || window.webkitAudioContext)(); }, { once: true });
function alertQueuePop() {
  navigator.vibrate?.([300, 150, 300, 150, 300]);
  if (!audio) return;
  for (let i = 0; i < 3; i++) {
    const o = audio.createOscillator(); const g = audio.createGain();
    o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
    const t = audio.currentTime + i * 0.35;
    g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.start(t); o.stop(t + 0.3);
  }
}

function onState(next) {
  const wasPopping = state?.readyCheck?.state === 'InProgress';
  const lastAction = state?.champSelect?.action?.id;
  state = next; stateAt = Date.now();
  if (!wasPopping && state.readyCheck?.state === 'InProgress') alertQueuePop();
  if (state.champSelect?.action?.id !== lastAction) ui.search = '';
  if (!state.champSelect) ui.tab = 'pick';
  render();
}

// ---------- Écrans ----------
function header() {
  const ok = state?.lcu === 'connected';
  return `<div class="row"><span class="big" style="font-size:22px;font-weight:700;display:flex;align-items:center;gap:10px"><img src="icon-192.png" alt="" width="30" height="30" style="border-radius:8px">Lobby</span>
    <span class="pill"><span class="dot" style="background:${ok ? 'var(--ok)' : 'var(--ban)'}"></span>${ok ? 'Client connecté' : 'Client LoL fermé'}</span></div>`;
}

function screenNoToken() {
  return `<div class="spacer"></div>
    <div style="text-align:center"><h1>Associe ton téléphone</h1>
    <p class="soft">Ouvre <strong>Lobby</strong> sur ton PC (menu Démarrer) et tape le code affiché.</p></div>
    <form id="pair" style="display:flex;flex-direction:column;gap:12px">
      <label for="code" class="label" style="text-align:center">Code à 6 chiffres</label>
      <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000 000"
        style="height:64px;border-radius:16px;border:1px solid var(--line);background:var(--card);color:var(--text);text-align:center;font-size:32px;letter-spacing:6px;font-family:'Space Grotesk',Inter,sans-serif">
      <button class="btn primary" type="submit">Associer</button>
    </form>
    <p class="muted" style="text-align:center;font-size:14px">Tu peux aussi scanner le QR code du PC avec l'appareil photo.</p>
    <div class="spacer"></div>`;
}

const LANE = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'ADC', UTILITY: 'Support', FILL: 'Peu importe' };

function autoAcceptBar() {
  const left = Math.max(0, state.autoAcceptUntil - Date.now());
  const on = left > 0;
  const opt = (m, label) => `<button class="chip" data-auto="${m}" aria-pressed="${m === 0 ? !on : false}">${label}</button>`;
  return `<div class="card" style="display:flex;flex-direction:column;gap:10px">
    <div class="row"><span style="font-weight:600">Auto-accept</span>
      <span class="${on ? '' : 'muted'}" style="font-size:13px;${on ? 'color:var(--ok)' : ''}" data-tick="auto">${on ? '' : 'désactivé'}</span></div>
    <div class="chips">${opt(0, 'Off')}${opt(15, '15 min')}${opt(60, '1 h')}${opt(180, '3 h')}</div></div>`;
}

function notifBlock() {
  if (location.protocol !== 'https:' || !('serviceWorker' in navigator)) return '';
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  if (ios && !standalone) return `<p class="muted" style="font-size:13px;text-align:center">Pour être prévenu téléphone verrouillé : Partager › « Sur l'écran d'accueil », puis ouvre Lobby depuis l'icône.</p>`;
  if (!('PushManager' in window)) return '';
  if (Notification.permission === 'granted' && pushReady) return `<p class="muted" style="font-size:13px;text-align:center">🔔 Notifications activées</p>`;
  if (Notification.permission === 'denied') return `<p class="muted" style="font-size:13px;text-align:center">Notifications bloquées dans les réglages du téléphone.</p>`;
  return `<button class="btn ghost" data-notif="1">Activer les notifications</button>`;
}

function modesList() {
  if (!state.queues.length) return '<p class="muted">Aucun mode disponible pour l\'instant.</p>';
  return `<div class="list">${state.queues.map((q) => `<button class="option" data-queue="${q.id}">
      <span>${esc(q.name)}</span>${q.ranked ? ' <span class="muted" style="font-weight:500;font-size:13px">· classé</span>' : ''}</button>`).join('')}</div>`;
}

function invitesBanner() {
  return (state.invitations || []).map((i) => `<div class="card invite">
    <div><div style="font-weight:600">${esc(i.from)} t'invite</div>${i.queue ? `<div class="muted" style="font-size:13px;margin-top:2px">${esc(i.queue)}</div>` : ''}</div>
    <div class="row" style="gap:8px"><button class="chip" data-invite-no="${esc(i.id)}">Refuser</button>
    <button class="chip accent" data-invite-yes="${esc(i.id)}">Rejoindre</button></div></div>`).join('');
}

function friendsBlock(l) {
  const friends = state.friends || [];
  const inLobby = new Set(l.members.map((m) => m.name));
  const list = friends.filter((f) => !inLobby.has(f.name));
  const head = `<button class="option row" data-friends="1" aria-expanded="${ui.friends}"><span>Inviter des amis</span>
    <span class="muted" style="font-weight:500;font-size:13px">${list.filter((f) => f.free).length} dispo ${ui.friends ? '▴' : '▾'}</span></button>`;
  if (!ui.friends) return head;
  const rows = list.length ? list.map((f) => `<div class="member"><div style="flex:1"><div style="font-weight:600">${esc(f.name)}</div>
      <div class="muted" style="font-size:13px">${esc(f.status)}</div></div>
      <button class="chip${f.free ? ' accent' : ''}" data-invite="${esc(f.summonerId)}" ${f.free ? '' : 'disabled'}>Inviter</button></div>`).join('')
    : '<p class="muted">Aucun ami en ligne.</p>';
  return `${head}<div class="team">${rows}</div>`;
}

const PREF_SLOTS = [['TOP', 'Top'], ['JUNGLE', 'Jungle'], ['MIDDLE', 'Mid'], ['BOTTOM', 'ADC'], ['UTILITY', 'Support'], ['ANY', 'Tous postes'], ['BANS', 'Mes bans']];
const prefList = (slot) => (slot === 'BANS' ? state.prefs.bans : state.prefs.picks?.[slot]) || [];
function prefsScreen() {
  if (ui.prefsPick) {
    const label = PREF_SLOTS.find(([k]) => k === ui.prefsPick)?.[1];
    return `<div class="row"><button class="chip" data-prefs-back="1">‹ Retour</button><span class="muted">${esc(label)}</span></div>
      <label class="search"><span class="muted" style="display:flex">${SEARCH_ICON}</span>
        <input id="search" type="search" placeholder="Rechercher un champion" value="${esc(ui.search)}" aria-label="Rechercher un champion" autocomplete="off"></label>
      <div class="grid" id="grid">${prefsGrid()}</div>`;
  }
  const section = ([k, label]) => {
    const list = prefList(k);
    return `<div><div class="row" style="margin-bottom:8px"><span class="label lane">${k === 'BANS' || k === 'ANY' ? '' : laneIcon(k, 14)}${label}</span>
      ${list.length < 5 ? `<button class="chip" data-prefs-add="${k}">+ Ajouter</button>` : ''}</div>
      ${list.length ? `<div class="chips">${list.map((id, n) => `<button class="chip" data-prefs-del="${k}:${id}" aria-label="Retirer ${esc(champName(id))}">
        <span class="muted">${n + 1}</span>${esc(champName(id))} ✕</button>`).join('')}</div>` : '<p class="muted" style="margin:0;font-size:13px">Aucun</p>'}</div>`;
  };
  return `<div class="row"><button class="chip" data-view="">‹ Retour</button></div>
    <div><div class="label" style="color:var(--accent)">Pré-sélection</div><h1 style="margin-top:4px">Mes champions</h1>
    <p class="soft" style="font-size:14px">Quand vient ton tour, Lobby survole tout seul le premier de la liste qui est disponible. Tu n'as plus qu'à verrouiller.</p></div>
    ${PREF_SLOTS.map(section).join('')}`;
}
function prefsGrid() {
  const q = ui.search.trim().toLowerCase();
  const have = new Set(prefList(ui.prefsPick));
  const list = Object.entries(dd.champs).map(([id, c]) => ({ id: Number(id), name: c.name }))
    .filter((c) => !have.has(c.id) && (!q || c.name.toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  if (!list.length) return `<p class="muted" style="grid-column:1/-1">${dd.v ? 'Aucun champion' : 'Liste des champions indisponible'}</p>`;
  return list.map((c) => `<button class="champ" data-prefs-pick="${c.id}">${img(champImg(c.id), 'portrait', '')}<span>${esc(c.name)}</span></button>`).join('');
}
function updatePrefs(slot, list) {
  const prefs = { picks: { ...state.prefs.picks }, bans: [...(state.prefs.bans || [])] };
  if (slot === 'BANS') prefs.bans = list; else prefs.picks[slot] = list;
  state.prefs = prefs; // affichage immédiat, confirmé par le PC
  send({ cmd: 'setPrefs', prefs });
}

function lobbyScreen(l) {
  const lanes = (slot) => `<div class="chips">${Object.entries(LANE).map(([k, v]) => {
    const picked = l.positions[slot] === k;
    const disabled = slot === 1 && (l.positions[0] === 'FILL' || l.positions[0] === k);
    return `<button class="chip" data-lane="${slot}:${k}" aria-pressed="${picked}" ${disabled ? 'disabled' : ''}>${laneIcon(k, 18, picked)}${v}</button>`;
  }).join('')}</div>`;
  const members = `<div class="team">${l.members.map((m) => `<div class="member${m.isMe ? ' me' : ''}"><div style="flex:1">
      <div style="font-weight:600">${esc(m.name)}${m.isLeader ? ' <span class="muted" style="font-weight:500">· chef</span>' : ''}</div>
      ${m.position && m.position !== 'UNSELECTED' ? `<div class="muted lane" style="font-size:13px">${laneIcon(m.position, 14)}${esc(LANE[m.position] || m.position)}</div>` : ''}</div></div>`).join('')}</div>`;
  const ready = !l.showPositions || (l.positions[0] !== 'UNSELECTED' && (l.positions[0] === 'FILL' || l.positions[1] !== 'UNSELECTED'));
  return `${header()}${invitesBanner()}
    <div class="row"><div><div class="label" style="color:var(--accent)">Salon</div><h1 style="margin-top:4px">${esc(l.name)}</h1></div>
      <button class="chip" data-modes="1">Changer</button></div>
    ${ui.modes ? modesList() : ''}
    ${l.showPositions ? `<div><div class="label" style="margin-bottom:8px">Poste principal</div>${lanes(0)}</div>
      ${l.positions[0] === 'FILL' ? '' : `<div><div class="label" style="margin-bottom:8px">Poste secondaire</div>${lanes(1)}</div>`}` : ''}
    <div><div class="label" style="margin-bottom:8px">Joueurs</div>${members}</div>
    ${friendsBlock(l)}
    ${autoAcceptBar()}
    <div class="spacer"></div>
    ${l.isLeader ? `<button class="btn primary" data-cmd="startSearch" ${ready && l.canStart ? '' : 'disabled'}>${ready ? 'Lancer la recherche' : 'Choisis tes postes'}</button>`
      : '<p class="center soft">Le chef du salon lance la recherche.</p>'}
    <button class="btn ghost" data-cmd="leaveLobby">Quitter le salon</button>`;
}

function screenIdle() {
  const p = state.phase;
  if (state.lcu !== 'connected') return `${header()}<div class="center"><h1>Lance League of Legends</h1><p class="soft">Lobby se connecte tout seul dès que le client est ouvert.</p></div>`;
  if (p === 'Matchmaking' && state.queue) {
    return `${header()}<div class="card row"><div><div class="label">En file</div><div style="font-weight:600;margin-top:4px">${esc(state.lobby?.name || "Recherche d'une partie")}</div></div>
      <span class="big soft" data-tick="queue" style="font-size:20px"></span></div>
      ${autoAcceptBar()}
      ${notifBlock() || '<p class="center soft">Garde cette page ouverte : ton téléphone sonne quand la partie est trouvée.</p>'}
      <div class="spacer"></div>
      <button class="btn ghost" data-cmd="cancelSearch">Annuler la recherche</button>`;
  }
  if (ui.view === 'prefs') return prefsScreen();
  if (state.lobby && (p === 'Lobby' || p === 'None')) return lobbyScreen(state.lobby);
  if (p === 'None' || p === 'Lobby') {
    return `${header()}${invitesBanner()}<div><div class="label" style="color:var(--accent)">Jouer</div><h1 style="margin-top:4px">Choisis un mode</h1></div>
      ${modesList()}
      <button class="option row" data-view="prefs"><span>Mes champions</span><span class="muted" style="font-weight:500;font-size:13px">pré-sélection ›</span></button>
      ${notifBlock()}`;
  }
  if (['EndOfGame', 'PreEndOfGame', 'WaitingForStats'].includes(p)) {
    return `${header()}${invitesBanner()}<div class="center"><h1>Fin de partie</h1><p class="soft">GG ! On remet ça ?</p></div>
      <button class="btn primary" data-cmd="playAgain">Rejouer</button>`;
  }
  const msg = { InProgress: 'Partie en cours', Reconnect: 'Reconnexion' }[p] || 'Patiente…';
  return `${header()}${invitesBanner()}<div class="center"><h1>${esc(msg)}</h1><p class="soft">Bonne game !</p></div>`;
}

function screenReadyCheck() {
  const rc = state.readyCheck;
  const accepted = rc.playerResponse === 'Accepted';
  const declined = rc.playerResponse === 'Declined';
  return `${header()}
    <div class="spacer"></div>
    <div class="label center" style="color:var(--accent);margin:0 auto">Partie trouvée</div>
    <div class="countdown" data-tick="ready"></div>
    <p class="center soft" style="margin:0 auto">${accepted ? 'Acceptée : on attend les autres…' : declined ? 'Refusée' : 'secondes pour accepter'}</p>
    <div class="spacer"></div>
    <button class="btn primary" data-cmd="accept" ${accepted ? 'disabled' : ''}>Accepter</button>
    <button class="btn ghost" data-cmd="decline" ${declined ? 'disabled' : ''}>Refuser</button>`;
}

function screenChampSelect() {
  const cs = state.champSelect;
  const tabs = `<div class="tabs" role="group" aria-label="Sections">
    <button data-tab="pick" aria-pressed="${ui.tab === 'pick'}">Sélection</button>
    <button data-tab="build" aria-pressed="${ui.tab === 'build'}">Build${state.build?.applied?.length ? ' ✓' : ''}</button>
    <button data-tab="loadout" aria-pressed="${ui.tab === 'loadout'}">Runes</button></div>`;
  const body = ui.tab === 'pick' ? pickTab(cs) : ui.tab === 'build' ? buildTab() : loadoutTab(cs);
  return `${headerChampSelect(cs)}${tabs}${body}`;
}

function headerChampSelect(cs) {
  const a = cs.action;
  if (cs.bench) {
    return `<div class="row"><div><div class="label" style="color:var(--accent)">${esc(state.mode?.name || 'ARAM')}</div><h1 style="margin-top:4px">Ton champion</h1></div>
      <span class="big" style="font-size:30px;font-weight:700;color:var(--accent)" data-tick="cs"></span></div>`;
  }
  const title = a ? (a.type === 'ban' ? 'À toi de bannir' : 'À toi de choisir') : ({ PLANNING: 'Déclare ton champion', BAN_PICK: 'Bans et picks en cours', FINALIZATION: 'Derniers réglages' }[cs.timer.phase] || 'Sélection');
  const color = a?.type === 'ban' ? 'var(--ban)' : 'var(--accent)';
  return `<div class="row"><div><div class="label" style="color:${color}">Sélection des champions</div><h1 style="margin-top:4px">${title}</h1></div>
    <span class="big" style="font-size:30px;font-weight:700;color:${color}" data-tick="cs"></span></div>`;
}

function aramTab(cs) {
  const me = cs.myTeam.find((p) => p.isMe) || {};
  const mine = `<div class="card" style="display:flex;align-items:center;gap:14px">
      <div style="width:72px;flex-shrink:0">${img(champImg(me.championId), 'portrait', champName(me.championId))}</div>
      <div style="flex:1"><div class="big" style="font-size:22px;font-weight:700">${esc(champName(me.championId) || '…')}</div>
      ${cs.rerolls !== null ? `<div class="muted" style="font-size:13px;margin-top:4px">${cs.rerolls} relance${cs.rerolls > 1 ? 's' : ''} restante${cs.rerolls > 1 ? 's' : ''}</div>` : ''}</div></div>`;
  const reroll = cs.rerolls !== null
    ? `<button class="btn ghost" data-cmd="reroll" ${cs.rerolls > 0 ? '' : 'disabled'}>Relancer le dé</button>` : '';
  const bench = cs.bench.length
    ? `<div class="grid">${cs.bench.map((id) => `<button class="champ" data-bench="${id}">${img(champImg(id), 'portrait', '')}<span>${esc(champName(id))}</span></button>`).join('')}</div>`
    : '<p class="muted">Le banc est vide pour l\'instant.</p>';
  const team = `<div class="team">${cs.myTeam.filter((p) => !p.isMe).map((p) => `<div class="member">${img(champImg(p.championId), '', champName(p.championId))}
      <div style="flex:1;font-weight:600">${esc(champName(p.championId) || '…')}</div></div>`).join('')}</div>`;
  return `${mine}${reroll}<div><div class="label" style="margin-bottom:8px">Banc · touche pour échanger</div>${bench}</div>
    <div><div class="label" style="margin-bottom:8px">Ton équipe</div>${team}</div>`;
}

function pickTab(cs) {
  if (cs.bench) return aramTab(cs);
  const bans = [...cs.bans.mine, ...cs.bans.theirs].slice(0, 10);
  const banRow = bans.length ? `<div><div class="label" style="margin-bottom:8px">Bans</div><div class="bans">${bans.map((id) => img(champImg(id), 'portrait banned', champName(id))).join('')}</div></div>` : '';
  const team = `<div class="team">${cs.myTeam.map((p) => {
    const id = p.championId || p.intentId;
    return `<div class="member${p.isMe ? ' me' : ''}">${id ? img(champImg(id), p.championId ? '' : 'intent', champName(id)) : '<div class="ph" aria-hidden="true"></div>'}
      <div style="flex:1"><div style="font-weight:600">${esc(champName(id) || (p.isMe ? 'Toi' : '…'))}</div><div class="muted lane" style="font-size:13px">${laneIcon(p.position === 'middle' ? 'MIDDLE' : p.position === 'bottom' ? 'BOTTOM' : p.position === 'utility' ? 'UTILITY' : p.position, 14)}${esc(POS[p.position] || '')}${p.isMe ? ' · toi' : ''}</div></div></div>`;
  }).join('')}</div>`;

  const a = cs.action;
  let chooser = '';
  if (a) {
    const isBan = a.type === 'ban';
    chooser = `<label class="search"><span class="muted" style="display:flex">${SEARCH_ICON}</span>
        <input id="search" type="search" placeholder="Rechercher un champion" value="${esc(ui.search)}" aria-label="Rechercher un champion" autocomplete="off"></label>
      <div class="grid" id="grid">${gridHtml(isBan ? state.bannable : state.pickable, a)}</div>
      <div class="sticky"><button class="btn ${isBan ? 'ban' : 'primary'}" data-cmd="lock" ${a.championId ? '' : 'disabled'}>
        ${a.championId ? `${isBan ? 'Bannir' : 'Verrouiller'} ${esc(champName(a.championId))}` : 'Choisis un champion'}</button></div>`;
  }
  return `${banRow}<div><div class="label" style="margin-bottom:8px">Ton équipe</div>${team}</div>${chooser}`;
}

function gridHtml(ids, a) {
  const q = ui.search.trim().toLowerCase();
  const list = ids.map((id) => ({ id, name: champName(id) }))
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .sort((x, y) => x.name.localeCompare(y.name, 'fr'));
  if (!list.length) return '<p class="muted" style="grid-column:1/-1">Aucun champion</p>';
  return list.map((c) => `<button class="champ${a.type === 'ban' ? ' ban' : ''}" data-champ="${c.id}" aria-pressed="${a.championId === c.id}">
    ${img(champImg(c.id), 'portrait', '')}<span>${esc(c.name)}</span></button>`).join('');
}

const itemImg = (id) => (dd.v ? `https://ddragon.leagueoflegends.com/cdn/${dd.v}/img/item/${id}.png` : '');

function buildTab() {
  const b = state.build;
  if (b?.data?.championName && !dd.champs[b.championId]) dd.champs[b.championId] = { id: '', name: b.data.championName };
  if (!b) return '<p class="center soft">Le build OP.GG apparaît dès que ton champion est choisi.</p>';
  if (b.status === 'loading') return `<p class="center soft">Chargement du build de ${esc(champName(b.championId))}…</p>`;
  if (b.status === 'error') return `<div class="card"><div style="font-weight:600">Build indisponible</div><div class="muted" style="font-size:13px;margin-top:4px">${esc(b.error)}</div></div>`;
  const d = b.data;
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 1000) / 10} %`);
  const row = (label, list) => (list.length ? `<div><div class="label" style="margin-bottom:8px">${label}</div>
      <div class="items">${list.map((it) => `<div class="item" title="${esc(it.name)}">${img(itemImg(it.id), 'portrait', it.name)}</div>`).join('')}</div></div>` : '');
  const auto = state.autoBuild.includes(b.championId);
  const applied = b.applied?.length ? `Importé ✓ (${b.applied.join(', ')})` : 'Importer runes, sorts et objets';
  return `<div class="card" style="display:flex;align-items:center;gap:14px">
      <div style="width:56px;flex-shrink:0">${img(champImg(b.championId), 'portrait', champName(b.championId))}</div>
      <div style="flex:1"><div class="big" style="font-size:20px;font-weight:700">${esc(champName(b.championId))}</div>
      <div class="muted lane" style="font-size:13px;margin-top:2px">${d.mode === 'aram' ? '' : laneIcon({ top: 'TOP', jungle: 'JUNGLE', mid: 'MIDDLE', adc: 'BOTTOM', support: 'UTILITY' }[d.lane], 14)}${esc(d.mode === 'aram' ? 'ARAM' : (LANE[{ top: 'TOP', jungle: 'JUNGLE', mid: 'MIDDLE', adc: 'BOTTOM', support: 'UTILITY' }[d.lane]] || ''))} · OP.GG</div></div></div>
    <div class="stats"><div class="card"><div class="muted" style="font-size:11px">Winrate</div><div class="big" style="font-size:18px;font-weight:700">${pct(d.winRate)}</div></div>
      <div class="card"><div class="muted" style="font-size:11px">Pickrate</div><div class="big" style="font-size:18px;font-weight:700">${pct(d.pickRate)}</div></div>
      <div class="card"><div class="muted" style="font-size:11px">Tier</div><div class="big" style="font-size:18px;font-weight:700">${d.tier ?? '—'}</div></div></div>
    <div class="card"><div style="font-weight:600">${esc(d.runes.keystone)}</div><div class="muted" style="font-size:13px;margin-top:4px">${esc(d.runes.names.slice(1).join(' · '))}</div></div>
    ${d.spells.length ? `<div class="items">${d.spells.map((id) => `<div class="item">${img(spellImg(id), 'portrait', dd.spells[id]?.name || '')}</div>`).join('')}</div>` : ''}
    ${row('Départ', d.items.starter)}${row('Objets principaux', [...d.items.core, ...d.items.boots])}${row('Fin de partie', d.items.late)}
    ${d.skills.order.length ? `<div><div class="label" style="margin-bottom:8px">Compétences${d.skills.priority.length ? ` · priorité ${esc(d.skills.priority.join(' > '))}` : ''}</div>
      <div class="skills">${d.skills.order.map((k) => `<span class="${k === 'R' ? 'r' : ''}">${esc(k)}</span>`).join('')}</div></div>` : ''}
    <label class="card row" style="cursor:pointer"><span>Import auto pour ${esc(champName(b.championId))}</span>
      <input type="checkbox" data-autobuild="${b.championId}" ${auto ? 'checked' : ''} style="width:22px;height:22px;accent-color:var(--accent)"></label>
    <div class="sticky"><button class="btn primary" data-cmd="importBuild">${applied}</button></div>`;
}

function loadoutTab(cs) {
  const me = cs.myTeam.find((p) => p.isMe) || {};
  const pages = state.perks.pages.map((p) => `<button class="option" data-page="${p.id}" aria-pressed="${p.id === state.perks.currentId}">${esc(p.name)}</button>`).join('')
    || '<p class="muted">Aucune page de runes trouvée.</p>';
  const slot = (n, id) => `<button class="spell" data-slot="${n}" aria-pressed="${ui.spellSlot === n}">${img(spellImg(id), '', '')}<span>${esc(dd.spells[id]?.name || '—')}</span><span class="muted" style="font-size:12px">${n === 1 ? 'D' : 'F'}</span></button>`;
  const picker = ui.spellSlot ? `<div class="picker">${Object.entries(dd.spells).map(([key, s]) => `<button data-spell="${key}" aria-label="${esc(s.name)}">${img(spellImg(key), '', s.name)}</button>`).join('')}</div>` : '';
  return `<div><div class="label" style="margin-bottom:8px">Page de runes</div><div class="list">${pages}</div></div>
    <div><div class="label" style="margin-bottom:8px">Sorts d'invocateur</div><div class="spells">${slot(1, me.spell1Id)}${slot(2, me.spell2Id)}</div></div>
    ${picker}
    <button class="btn ghost" data-cmd="swap">Inverser D / F</button>`;
}

function render() {
  const active = document.activeElement;
  const keep = ['search', 'code'].includes(active?.id) ? { id: active.id, value: active.value, caret: active.selectionStart } : null;
  let html;
  if (!token) html = screenNoToken();
  else if (!state && !pcOnline) html = `<div class="center"><h1>PC hors ligne</h1><p class="soft">Ton PC est éteint, ou Lobby n'y tourne pas.</p></div>`;
  else if (!state) html = `<p class="center muted">Connexion à ton PC…</p>`;
  else if (state.readyCheck?.state === 'InProgress') html = screenReadyCheck();
  else if (state.champSelect) html = screenChampSelect();
  else html = screenIdle();
  $app.innerHTML = html;
  if (keep) { const el = document.getElementById(keep.id); if (el) { el.value = keep.value; el.focus(); el.setSelectionRange(keep.caret, keep.caret); } }
  tick();
}

// ---------- Comptes à rebours (rafraîchis localement chaque seconde) ----------
function tick() {
  if (!state) return;
  const since = (Date.now() - stateAt) / 1000;
  for (const el of document.querySelectorAll('[data-tick]')) {
    const k = el.dataset.tick;
    if (k === 'ready') el.textContent = Math.max(0, Math.ceil(12 - (state.readyCheck?.timer ?? 0) - since));
    if (k === 'cs') { const t = state.champSelect?.timer; if (t) el.textContent = Math.max(0, Math.ceil((t.msLeft - (Date.now() - t.at)) / 1000)); }
    if (k === 'auto') { const left = state.autoAcceptUntil - Date.now(); if (left > 0) { const m = Math.ceil(left / 60000); el.textContent = `actif · encore ${m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`}`; } }
    if (k === 'queue') { const s = Math.floor((state.queue?.timeInQueue ?? 0) + since); el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
  }
}
setInterval(tick, 1000);

// ---------- Interactions ----------
$app.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const me = state?.champSelect?.myTeam.find((p) => p.isMe);
  if (t.dataset.cmd === 'swap' && me) return send({ cmd: 'spells', spell1Id: me.spell2Id, spell2Id: me.spell1Id });
  if (t.dataset.cmd) return send({ cmd: t.dataset.cmd });
  if (t.dataset.inviteYes) return send({ cmd: 'acceptInvite', id: t.dataset.inviteYes });
  if (t.dataset.inviteNo) return send({ cmd: 'declineInvite', id: t.dataset.inviteNo });
  if (t.dataset.invite) { t.disabled = true; t.textContent = 'Invité ✓'; return send({ cmd: 'invite', summonerId: t.dataset.invite }); }
  if (t.dataset.friends) { ui.friends = !ui.friends; return render(); }
  if (t.dataset.view !== undefined) { ui.view = t.dataset.view || null; ui.prefsPick = null; ui.search = ''; window.scrollTo(0, 0); return render(); }
  if (t.dataset.prefsAdd) { ui.prefsPick = t.dataset.prefsAdd; ui.search = ''; window.scrollTo(0, 0); return render(); }
  if (t.dataset.prefsBack) { ui.prefsPick = null; return render(); }
  if (t.dataset.prefsPick) {
    updatePrefs(ui.prefsPick, [...prefList(ui.prefsPick), Number(t.dataset.prefsPick)]);
    ui.prefsPick = null; ui.search = ''; return render();
  }
  if (t.dataset.prefsDel) {
    const [slot, id] = t.dataset.prefsDel.split(':');
    updatePrefs(slot, prefList(slot).filter((x) => x !== Number(id)));
    return render();
  }
  if (t.dataset.queue) { ui.modes = false; return send({ cmd: 'createLobby', queueId: Number(t.dataset.queue) }); }
  if (t.dataset.modes) { ui.modes = !ui.modes; return render(); }
  if (t.dataset.auto !== undefined) return send({ cmd: 'autoAccept', minutes: Number(t.dataset.auto) });
  if (t.dataset.notif) return enablePush();
  if (t.dataset.lane) {
    const [slot, lane] = t.dataset.lane.split(':');
    const [p1, p2] = state.lobby.positions;
    const first = slot === '0' ? lane : p1;
    let second = slot === '1' ? lane : p2;
    if (second === first) second = 'UNSELECTED';
    return send({ cmd: 'positions', first, second });
  }
  if (t.dataset.tab) { ui.tab = t.dataset.tab; ui.spellSlot = null; return render(); }
  if (t.dataset.bench) return send({ cmd: 'benchSwap', championId: Number(t.dataset.bench) });
  if (t.dataset.champ) return send({ cmd: 'select', championId: Number(t.dataset.champ) });
  if (t.dataset.page) return send({ cmd: 'runePage', id: Number(t.dataset.page) });
  if (t.dataset.slot) { ui.spellSlot = ui.spellSlot === Number(t.dataset.slot) ? null : Number(t.dataset.slot); return render(); }
  if (t.dataset.spell && me) {
    const chosen = Number(t.dataset.spell);
    let [s1, s2] = [me.spell1Id, me.spell2Id];
    if (ui.spellSlot === 1) { if (s2 === chosen) s2 = s1; s1 = chosen; } // le client refuse deux fois le même sort
    else { if (s1 === chosen) s1 = s2; s2 = chosen; }
    ui.spellSlot = null;
    render();
    return send({ cmd: 'spells', spell1Id: s1, spell2Id: s2 });
  }
});

$app.addEventListener('submit', (e) => {
  if (e.target.id !== 'pair') return;
  e.preventDefault();
  const code = document.getElementById('code').value.replace(/\D/g, '');
  if (code.length !== 6) return toast('Le code fait 6 chiffres');
  pairWithCode(code);
});

$app.addEventListener('change', (e) => {
  if (e.target.dataset.autobuild) send({ cmd: 'autoBuild', championId: Number(e.target.dataset.autobuild), on: e.target.checked });
});

$app.addEventListener('input', (e) => {
  if (e.target.id !== 'search') return;
  ui.search = e.target.value;
  const grid = document.getElementById('grid');
  if (grid && ui.prefsPick) { grid.innerHTML = prefsGrid(); return; }
  const a = state?.champSelect?.action;
  if (grid && a) grid.innerHTML = gridHtml(a.type === 'ban' ? state.bannable : state.pickable, a);
});

let toastTimer;
function toast(msg) {
  $toast.textContent = msg; $toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $toast.classList.remove('show'), 2500);
}

// ---------- Notifications push (uniquement via le relais HTTPS) ----------
let pushReady = false;
async function setupServiceWorker() {
  if (location.protocol !== 'https:' || !('serviceWorker' in navigator) || !token) return;
  try {
    const reg = await navigator.serviceWorker.register(`/sw.js?t=${encodeURIComponent(token)}`);
    pushReady = Boolean(await reg.pushManager?.getSubscription());
    render();
  } catch { /* navigateur sans service worker */ }
}
async function enablePush() {
  try {
    if (await Notification.requestPermission() !== 'granted') return render();
    const reg = await navigator.serviceWorker.ready;
    const { key } = await (await fetch('/api/vapid')).json();
    const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
    const res = await fetch('/api/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: token, subscription: sub }) });
    if (!res.ok) throw new Error();
    pushReady = true; toast('Notifications activées');
  } catch { toast("Impossible d'activer les notifications"); }
  render();
}

loadDataDragon();
connect();
setupServiceWorker();
