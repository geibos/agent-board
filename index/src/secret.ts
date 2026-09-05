// Секрет зеркала: подписывает локальные билеты /b и шифрует ключи агентов,
// привязанных через OAuth. Берётся из MIRROR_SECRET, иначе генерируется один
// раз и хранится в meta — так он переживает перезапуск контейнера.
import type { Database } from 'bun:sqlite';
import { getMeta, setMeta } from './db';

export function loadSecret(db: Database): string {
  const fromEnv = process.env.MIRROR_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  let s = getMeta(db, 'secret');
  if (!s) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    s = Buffer.from(bytes).toString('hex');
    setMeta(db, 'secret', s);
  }
  return s;
}

const enc = new TextEncoder();
const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as Uint8Array).toString('base64url');
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));

export const hmac = (secret: string, data: string) =>
  b64u(new Bun.CryptoHasher('sha256', secret).update(data).digest());

export const randomToken = (bytes = 32) => {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b64u(b);
};

async function aesKey(secret: string) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`aes:${secret}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(secret: string, text: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(text));
  return `${b64u(iv)}.${b64u(ct)}`;
}

export async function decrypt(secret: string, blob: string): Promise<string> {
  const [iv, ct] = blob.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, await aesKey(secret), unb64u(ct));
  return new TextDecoder().decode(pt);
}

// Билет /b как у оригинала: base64url(JSON) + "." + подпись.
export function signTicket(secret: string, payload: Record<string, unknown>): string {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  return `${body}.${hmac(secret, body)}`;
}

export function readTicket(ticket: string): Record<string, any> | null {
  const [body] = ticket.split('.');
  if (!body) return null;
  try { return JSON.parse(new TextDecoder().decode(unb64u(body))); } catch { return null; }
}

export function verifyTicket(secret: string, ticket: string): Record<string, any> | null {
  const [body, sig] = ticket.split('.');
  if (!body || !sig || hmac(secret, body) !== sig) return null;
  return readTicket(ticket);
}
