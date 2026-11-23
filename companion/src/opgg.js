// Client minimal pour le serveur MCP d'OP.GG (JSON-RPC sur HTTP « streamable »).
const ENDPOINT = process.env.LOBBY_OPGG_URL || 'https://mcp-api.op.gg/mcp';
let sessionId = null;
let nextId = 1;

async function rpc(method, params, { notify = false } = {}) {
  const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id: nextId++ }) };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  sessionId = res.headers.get('mcp-session-id') || sessionId;
  if (notify) return null;
  if (!res.ok) throw new Error(`OP.GG ${res.status} : ${await res.text()}`);
  const text = await res.text();
  // Réponse en JSON direct, ou en flux SSE (« data: {...} »)
  const payload = res.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))).find((m) => m.id === body.id)
    : JSON.parse(text);
  if (payload?.error) throw new Error(`OP.GG : ${payload.error.message}`);
  return payload?.result;
}

let ready = null;
function init() {
  ready ??= (async () => {
    await rpc('initialize', {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'lobby-companion', version: '0.1.0' },
    });
    await rpc('notifications/initialized', undefined, { notify: true });
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

export async function listTools() {
  await init();
  return (await rpc('tools/list', {}))?.tools || [];
}

export async function callTool(name, args) {
  await init();
  const result = await rpc('tools/call', { name, arguments: args });
  // Les outils MCP renvoient du contenu texte, souvent du JSON sérialisé
  const text = (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  try { return JSON.parse(text); } catch { return text; }
}
