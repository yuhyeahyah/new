// crypto.ts — criptografia AES-256-GCM (Web Crypto nativo, sem dependências)
// Chave: 32 bytes em base64 (gerar com: openssl rand -base64 32)
// Formato do arquivo: {"v":1,"iv":"<base64>","data":"<base64 (cifra + tag)>"}

const b64e = (b: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) {
    s += String.fromCharCode(...b.subarray(i, i + 8192));
  }
  return btoa(s);
};

const b64d = (s: string): Uint8Array => Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));

async function importKey(keyB64: string, use: KeyUsage): Promise<CryptoKey> {
  const raw = b64d(keyB64);
  if (raw.length !== 32) throw new Error("PLAYLISTS_KEY inválida: precisa ter 32 bytes em base64");
  return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [use]);
}

export async function encrypt(text: string, keyB64: string): Promise<string> {
  const key = await importKey(keyB64, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
  return JSON.stringify({ v: 1, iv: b64e(iv), data: b64e(new Uint8Array(ct)) });
}

export async function decrypt(payload: string, keyB64: string): Promise<string> {
  const { iv, data } = JSON.parse(payload);
  const key = await importKey(keyB64, "decrypt");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(iv) }, key, b64d(data));
  return new TextDecoder().decode(pt);
}
