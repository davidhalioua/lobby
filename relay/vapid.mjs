// Génère la paire de clés VAPID des notifications (une seule fois) et l'enregistre comme secret Cloudflare.
import { execSync } from 'node:child_process';
const { privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', privateKey);
const secret = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d });
if (process.argv.includes('--print')) { console.log(secret); process.exit(0); }
execSync('npx wrangler secret put VAPID_PRIVATE', { input: secret, stdio: ['pipe', 'inherit', 'inherit'] });
console.log('✔ Clés de notification enregistrées');
