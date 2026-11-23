// Web Push sans dépendance (WebCrypto) : signature VAPID (RFC 8292) et chiffrement aes128gcm (RFC 8291).
const enc = new TextEncoder();

export const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
// HKDF avec une seule sortie de bloc (≤ 32 octets), suffisant ici
const hkdf = async (salt, ikm, info, len) => (await hmac(await hmac(salt, ikm), concat(info, new Uint8Array([1])))).slice(0, len);

export function vapidPublicKey(jwk) {
  return b64url(concat(new Uint8Array([4]), fromB64url(jwk.x), fromB64url(jwk.y)));
}

async function vapidHeader(endpoint, jwk, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', { ...jwk, key_ops: ['sign'], ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${vapidPublicKey(jwk)}`;
}

export async function encryptPayload(subscription, payload) {
  const uaPublic = fromB64url(subscription.keys.p256dh);
  const authSecret = fromB64url(subscription.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = concat(enc.encode(payload), new Uint8Array([2])); // 0x02 : dernier enregistrement
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain));
  const rs = new Uint8Array([0, 0, 16, 0]); // taille d'enregistrement 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// Renvoie le code HTTP du service de push (404/410 : abonnement expiré, à supprimer)
export async function sendPush(subscription, payload, { jwk, subject }) {
  const body = await encryptPayload(subscription, payload);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(subscription.endpoint, jwk, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '60', // une partie trouvée ne sert plus à rien après une minute
      Urgency: 'high',
    },
    body,
  });
  return res.status;
}
