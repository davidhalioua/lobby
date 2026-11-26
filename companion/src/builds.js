// Builds OP.GG : récupération (runes, sorts, objets, compétences) et import dans le client LoL.
import { callTool } from './opgg.js';
import { parseOpgg } from './opgg-format.js';

const FIELDS = [
  'data.summary.average_stats.{win_rate,pick_rate,tier}',
  'data.runes.{primary_page_id,primary_rune_ids[],primary_rune_names[],secondary_page_id,secondary_rune_ids[],secondary_rune_names[],stat_mod_ids[]}',
  'data.summoner_spells.{ids[]}',
  'data.starter_items.{ids[],ids_names[]}',
  'data.core_items.{ids[],ids_names[]}',
  'data.boots.{ids[],ids_names[]}',
  'data.fourth_items[].{ids[],ids_names[]}',
  'data.fifth_items[].{ids[],ids_names[]}',
  'data.sixth_items[].{ids[],ids_names[]}',
  'data.skills.{order[]}',
  'data.skill_masteries.{ids[]}',
];
const LANE = { top: 'top', jungle: 'jungle', middle: 'mid', bottom: 'adc', utility: 'support' };
const CLIENT_APP = 'Lobby/0.5';

// ---- Noms de champions au format OP.GG (UPPER_SNAKE_CASE), avec plusieurs essais possibles ----
let champions = null;
const resolved = new Map();
async function championCandidates(championId) {
  if (!champions) {
    const res = parseOpgg(await callTool('lol_list_champions', { desired_output_fields: ['data.champions[].{champion_id,key,name}'], client_app: CLIENT_APP }));
    champions = new Map((res?.data?.champions || []).map((c) => [Number(c.champion_id), c]));
  }
  const c = champions.get(Number(championId));
  if (!c) throw new Error('Champion inconnu chez OP.GG');
  if (resolved.has(c.champion_id)) return [resolved.get(c.champion_id)];
  const snake = (s) => s.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase();
  return [...new Set([snake(c.key), snake(c.name), c.key.toUpperCase(), c.name.replace(/[^A-Za-z0-9]/g, '').toUpperCase()])]
    .map((name) => ({ id: c.champion_id, name, display: c.name }));
}

const cache = new Map();
export async function fetchBuild({ championId, position, gameMode }) {
  const mode = gameMode === 'ARAM' || gameMode === 'KIWI' ? 'aram' : gameMode === 'URF' ? 'urf' : gameMode === 'flex' ? 'flex' : 'ranked';
  const lane = mode === 'aram' ? 'mid' : (LANE[position] || 'mid');
  const key = `${championId}:${mode}:${lane}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.build;

  let data = null;
  let lastError = null;
  let display = '';
  for (const cand of await championCandidates(championId)) {
    display = cand.display;
    try {
      const res = parseOpgg(await callTool('lol_get_champion_analysis', {
        game_mode: mode, champion: cand.name, position: lane, desired_output_fields: FIELDS, client_app: CLIENT_APP,
      }));
      if (res?.data?.runes) { data = res.data; resolved.set(cand.id, cand); break; }
    } catch (e) { lastError = e; }
  }
  if (!data) throw new Error(lastError ? `OP.GG : ${lastError.message}` : 'Pas de build OP.GG pour ce champion');

  const r = data.runes;
  const items = (x) => (x?.ids || []).map((id, k) => ({ id, name: x.ids_names?.[k] ?? String(id) }));
  const firstOf = (list) => (Array.isArray(list) ? items(list[0]) : items(list));
  const build = {
    championId: Number(championId), championName: display, mode, lane,
    winRate: data.summary?.average_stats?.win_rate ?? null,
    pickRate: data.summary?.average_stats?.pick_rate ?? null,
    tier: data.summary?.average_stats?.tier ?? null,
    runes: {
      primaryStyleId: r.primary_page_id, subStyleId: r.secondary_page_id,
      perkIds: [...r.primary_rune_ids, ...r.secondary_rune_ids, ...(r.stat_mod_ids || [])],
      keystone: r.primary_rune_names?.[0] || '', names: [...(r.primary_rune_names || []), ...(r.secondary_rune_names || [])],
    },
    spells: data.summoner_spells?.ids || [],
    items: {
      starter: items(data.starter_items), core: items(data.core_items), boots: items(data.boots),
      late: [...firstOf(data.fourth_items), ...firstOf(data.fifth_items), ...firstOf(data.sixth_items)],
    },
    skills: { order: data.skills?.order || [], priority: data.skill_masteries?.ids || [] },
  };
  cache.set(key, { at: Date.now(), build });
  return build;
}

// ---- Import dans le client ----
export async function applyBuild(lcu, build, { championName, currentSpells }) {
  const done = [];

  // 1. Runes : on réécrit la page actuelle au lieu d'en créer une nouvelle,
  //    pour ne jamais occuper une place de page (sinon Porofessor & co n'ont plus de place)
  const current = await lcu.request('GET', '/lol-perks/v1/currentpage').catch(() => null);
  if (!current?.isEditable) throw new Error('Sélectionne une de tes pages de runes modifiables, puis réessaie');
  await lcu.request('PUT', `/lol-perks/v1/pages/${current.id}`, {
    ...current, primaryStyleId: build.runes.primaryStyleId, subStyleId: build.runes.subStyleId,
    selectedPerkIds: build.runes.perkIds, current: true,
  });
  done.push('runes');

  // 2. Sorts (on garde Flash sur la touche où tu l'as d'habitude)
  if (build.spells.length === 2) {
    let [s1, s2] = build.spells;
    if (s1 === 4 && currentSpells?.[1] === 4) [s1, s2] = [s2, s1];
    else if (s2 === 4 && currentSpells?.[0] === 4) [s1, s2] = [s2, s1];
    try {
      await lcu.request('PATCH', '/lol-champ-select/v1/session/my-selection', { spell1Id: s1, spell2Id: s2 });
      done.push('sorts');
    } catch { /* sorts verrouillés dans certains modes */ }
  }

  // 3. Set d'objets (visible dans la boutique en jeu)
  try {
    const me = await lcu.request('GET', '/lol-summoner/v1/current-summoner');
    const url = `/lol-item-sets/v1/item-sets/${me.summonerId}/sets`;
    const existing = (await lcu.request('GET', url)) || { itemSets: [] };
    const uid = `lobby-${build.championId}`;
    const block = (type, list) => ({ type, items: list.map((it) => ({ id: String(it.id), count: 1 })) });
    const blocks = [
      build.items.starter.length && block('Départ', build.items.starter),
      build.items.core.length && block('Objets principaux', build.items.core),
      build.items.boots.length && block('Bottes', build.items.boots),
      build.items.late.length && block('Fin de partie', build.items.late),
      build.skills.order.length && { type: `Compétences : ${build.skills.order.join(' ')}`, items: [] },
    ].filter(Boolean);
    const set = {
      uid, title: `Lobby · ${championName} (OP.GG)`, associatedChampions: [build.championId], associatedMaps: [],
      blocks, map: 'any', mode: 'any', type: 'custom', sortrank: 0, startedFrom: 'blank', preferredItemSlots: [],
    };
    await lcu.request('PUT', url, {
      accountId: me.accountId,
      itemSets: [...(existing.itemSets || []).filter((s) => s.uid !== uid), set],
      timestamp: Date.now(),
    });
    done.push('objets');
  } catch { /* les sets d'objets ne sont pas bloquants */ }

  return done;
}
