// Scout : infos publiques sur les joueurs d'une partie déjà lancée (écran de chargement),
// via l'API officielle de Riot. La clé reste sur le relais (secret RIOT_API_KEY).
const PLATFORMS = {
  EUW: ['euw1', 'europe'], EUNE: ['eun1', 'europe'], TR: ['tr1', 'europe'], RU: ['ru', 'europe'], ME: ['me1', 'europe'],
  NA: ['na1', 'americas'], BR: ['br1', 'americas'], LAN: ['la1', 'americas'], LAS: ['la2', 'americas'],
  KR: ['kr', 'asia'], JP: ['jp1', 'asia'],
  OCE: ['oc1', 'sea'], SG: ['sg2', 'sea'], TW: ['tw2', 'sea'], VN: ['vn2', 'sea'],
};

async function riot(env, host, path, ttl) {
  const base = env.RIOT_API_BASE ? `${env.RIOT_API_BASE}/${host}` : `https://${host}.api.riotgames.com`;
  const url = `${base}${path}`;
  const cache = caches.default;
  const key = new Request(`https://lobby-cache.invalid/${host}${path}`);
  if (ttl) {
    const hit = await cache.match(key);
    if (hit) return hit.json();
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: { 'X-Riot-Token': env.RIOT_API_KEY } });
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(Number(res.headers.get('Retry-After')) || 2, 5);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Riot ${res.status}`);
    const data = await res.json();
    if (ttl) await cache.put(key, new Response(JSON.stringify(data), { headers: { 'Cache-Control': `max-age=${ttl}` } }));
    return data;
  }
  throw new Error('Limite de requêtes Riot atteinte');
}

async function scoutPlayer(env, platform, region, p) {
  const [account, leagues, mastery, ids] = await Promise.all([
    p.name ? null : riot(env, region, `/riot/account/v1/accounts/by-puuid/${p.puuid}`, 86400).catch(() => null),
    riot(env, platform, `/lol/league/v4/entries/by-puuid/${p.puuid}`, 300).catch(() => null),
    p.championId ? riot(env, platform, `/lol/champion-mastery/v4/champion-masteries/by-puuid/${p.puuid}/by-champion/${p.championId}`, 600).catch(() => null) : null,
    riot(env, region, `/lol/match/v5/matches/by-puuid/${p.puuid}/ids?type=ranked&count=5`, 300).catch(() => []),
  ]);

  const solo = (leagues || []).find((l) => l.queueType === 'RANKED_SOLO_5x5') || (leagues || []).find((l) => l.queueType === 'RANKED_FLEX_SR');
  // Les détails de parties ne changent jamais : longue mise en cache
  const matches = (await Promise.all((ids || []).map((id) => riot(env, region, `/lol/match/v5/matches/${id}`, 86400 * 7).catch(() => null)))).filter(Boolean);
  const games = matches.map((m) => {
    const me = m.info.participants.find((x) => x.puuid === p.puuid);
    return me && { win: me.win, championId: me.championId, k: me.kills, d: me.deaths, a: me.assists, queue: m.info.queueId, at: m.info.gameEndTimestamp };
  }).filter(Boolean).sort((a, b) => b.at - a.at);

  let streak = 0;
  for (const g of games) { if (games[0] && g.win === games[0].win) streak++; else break; }
  const kda = games.length ? games.reduce((s, g) => s + (g.k + g.a) / Math.max(1, g.d), 0) / games.length : null;

  return {
    puuid: p.puuid, championId: p.championId, team: p.team,
    name: p.name || (account ? `${account.gameName}#${account.tagLine}` : ''),
    rank: solo ? { queue: solo.queueType === 'RANKED_SOLO_5x5' ? 'solo' : 'flex', tier: solo.tier, division: solo.rank, lp: solo.leaguePoints, wins: solo.wins, losses: solo.losses, hot: Boolean(solo.hotStreak) } : null,
    mastery: mastery ? { level: mastery.championLevel, points: mastery.championPoints, lastPlayed: mastery.lastPlayTime } : null,
    recent: games.map((g) => ({ win: g.win, championId: g.championId })),
    onChampion: games.filter((g) => g.championId === p.championId).length,
    streak: games.length ? { win: games[0].win, count: streak } : null,
    kda: kda && Math.round(kda * 10) / 10,
  };
}

export async function scout(env, { region: regionCode, players }) {
  if (!env.RIOT_API_KEY) throw new Error("La clé API Riot n'est pas configurée sur le relais");
  const [platform, region] = PLATFORMS[String(regionCode || '').toUpperCase()] || [];
  if (!platform) throw new Error(`Région inconnue : ${regionCode}`);
  const list = (players || []).filter((p) => /^[\w-]{20,100}$/.test(p.puuid || '')).slice(0, 10);
  // Deux joueurs à la fois : la clé personnelle est limitée à 20 requêtes par seconde
  const out = [];
  for (let i = 0; i < list.length; i += 2) {
    out.push(...await Promise.all(list.slice(i, i + 2).map((p) => scoutPlayer(env, platform, region, p).catch((e) => ({ puuid: p.puuid, championId: p.championId, team: p.team, name: p.name || '', error: e.message })))));
  }
  return out;
}

