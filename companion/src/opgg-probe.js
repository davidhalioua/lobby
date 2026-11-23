// Sonde OP.GG : affiche le schéma exact des outils LoL, puis un exemple de réponse.
// Usage : npm run opgg:probe -- Viego JUNGLE
// Sers-toi de la sortie (opgg-probe.json) pour brancher l'import de build.
import fs from 'node:fs';
import { listTools, callTool } from './opgg.js';

const [champion = 'Viego', position = 'JUNGLE'] = process.argv.slice(2);

const tools = await listTools();
const analysis = tools.find((t) => t.name === 'lol_get_champion_analysis');
console.log('Outils LoL disponibles :', tools.filter((t) => t.name.startsWith('lol_')).map((t) => t.name).join(', '));
console.log('\nSchéma de lol_get_champion_analysis :\n', JSON.stringify(analysis?.inputSchema, null, 2));

// On remplit les paramètres à partir du schéma, puisque leurs noms exacts ne sont pas documentés.
const props = analysis?.inputSchema?.properties || {};
const args = {};
for (const [key, spec] of Object.entries(props)) {
  const k = key.toLowerCase();
  if (k.includes('champion')) args[key] = spec.enum?.find((v) => v.toLowerCase() === champion.toLowerCase()) ?? champion.toUpperCase();
  else if (k.includes('position') || k.includes('lane')) args[key] = spec.enum?.find((v) => v.toLowerCase() === position.toLowerCase()) ?? position.toLowerCase();
  else if (k === 'desired_output_fields') args[key] = ['data'];
  else if (spec.default !== undefined) args[key] = spec.default;
  else if (spec.enum) args[key] = spec.enum[0];
}
console.log('\nAppel avec :', JSON.stringify(args));

let result;
try { result = await callTool('lol_get_champion_analysis', args); } catch (e) { result = { error: e.message }; }
fs.writeFileSync('opgg-probe.json', JSON.stringify({ tools, args, result }, null, 2));
console.log('\nRéponse enregistrée dans opgg-probe.json');
