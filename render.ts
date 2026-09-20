// render.ts — roda no GitHub Actions com Deno
import satori from "https://esm.sh/satori@0.10.3";
import { svg2png, initialize } from "https://esm.sh/svg2png-wasm@0.6.1";

const { DATA_B64, CHAT_ID, CAPTION, TELEGRAM_TOKEN } = Deno.env.toObject();

if (!DATA_B64 || !CHAT_ID || !TELEGRAM_TOKEN) {
  console.error("Variáveis de ambiente faltando");
  Deno.exit(1);
}

// -----------------------------
// Dados vindos do bot (base64 UTF-8)
// -----------------------------
function fromBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const a = JSON.parse(fromBase64Utf8(DATA_B64));

// -----------------------------
// WASM + fontes
// -----------------------------
const wasmRes = await fetch("https://esm.sh/svg2png-wasm@0.6.1/svg2png_wasm_bg.wasm");
if (!wasmRes.ok) throw new Error("Falha ao baixar WASM: " + wasmRes.status);
await initialize(await wasmRes.arrayBuffer());

async function loadFont(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Falha na fonte: " + url);
  return await res.arrayBuffer();
}

const [f400, f700, f900] = await Promise.all([
  loadFont("https://cdn.jsdelivr.net/npm/@fontsource/inter/files/inter-latin-400-normal.woff"),
  loadFont("https://cdn.jsdelivr.net/npm/@fontsource/inter/files/inter-latin-700-normal.woff"),
  loadFont("https://cdn.jsdelivr.net/npm/@fontsource/inter/files/inter-latin-900-normal.woff"),
]);

const fonts = [
  { name: "Inter", data: f400, weight: 400 as const, style: "normal" as const },
  { name: "Inter", data: f700, weight: 700 as const, style: "normal" as const },
  { name: "Inter", data: f900, weight: 900 as const, style: "normal" as const },
];

// -----------------------------
// Imagens -> base64 (com retry)
// -----------------------------
async function loadImageAsBase64(url: string, timeoutMs = 20000): Promise<string> {
  if (!url || !/^https?:\/\//i.test(url)) return "";

  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      if (!res.ok) throw new Error("status " + res.status);

      const type = res.headers.get("content-type") || "image/jpeg";
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength < 100) throw new Error("imagem vazia");

      let bin = "";
      for (let i = 0; i < buf.length; i += 8192) {
        bin += String.fromCharCode(...buf.subarray(i, i + 8192));
      }
      return `data:${type};base64,${btoa(bin)}`;
    } catch (e) {
      console.log(`⚠️ imagem falhou (tentativa ${attempt + 1}):`, (e as Error).message);
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    } finally {
      clearTimeout(t);
    }
  }
  return "";
}

// -----------------------------
// Layout (Satori)
// -----------------------------
function famousStat(label: string, value: string) {
  return {
    type: "div",
    props: {
      style: {
        display: "flex", flexDirection: "column",
        background: "rgba(255,255,255,0.14)", borderRadius: "14px", padding: "14px 22px",
      },
      children: [
        { type: "div", props: { style: { fontSize: "12px", fontWeight: 700, opacity: 0.75, letterSpacing: "2px", display: "flex" }, children: label } },
        { type: "div", props: { style: { fontSize: "34px", fontWeight: 900, display: "flex" }, children: value } },
      ],
    },
  };
}

const [bannerB64, picB64] = await Promise.all([
  loadImageAsBase64(a.banner),
  loadImageAsBase64(a.picture),
]);

const name = String(a.name ?? "Artista");
const meta = [a.genre, a.nationality, a.label].filter(Boolean).join(" • ");
const BIO_MAX = 50;
const bioRaw = String(a.bio ?? "").trim();
const bio = bioRaw.length > BIO_MAX ? bioRaw.slice(0, BIO_MAX - 1).trimEnd() + "…" : bioRaw;
const tracks = (a.tracks ?? []).slice(0, 3);

const markup = {
  type: "div",
  props: {
    style: {
      width: "1200px", height: "800px",
      background: "linear-gradient(135deg, #b433ff, #284aff)",
      color: "white", fontFamily: "Inter",
      display: "flex", flexDirection: "column",
      position: "relative", overflow: "hidden",
    },
    children: [
      {
        type: "div",
        props: {
          style: { position: "absolute", top: 0, left: 0, width: "1200px", height: "360px", display: "flex", overflow: "hidden" },
          children: bannerB64
            ? { type: "img", props: { src: bannerB64, style: { width: "1200px", height: "360px", objectFit: "cover" } } }
            : null,
        },
      },
      {
        type: "div",
        props: {
          style: {
            position: "absolute", top: 0, left: 0, width: "1200px", height: "360px", display: "flex",
            background: "linear-gradient(to bottom, rgba(0,0,0,0.05), rgba(20,10,50,0.95))",
          },
        },
      },
      a.worldRank
        ? {
            type: "div",
            props: {
              style: {
                position: "absolute", top: "30px", right: "40px", display: "flex",
                background: "rgba(0,0,0,0.5)", borderRadius: "50px", padding: "10px 26px",
                fontSize: "22px", fontWeight: 700,
              },
              children: `${a.worldRank} mundial`,
            },
          }
        : null,
      picB64
        ? {
            type: "img",
            props: {
              src: picB64,
              style: {
                position: "absolute", top: "230px", left: "60px", width: "200px", height: "200px",
                borderRadius: "100px", border: "6px solid white", objectFit: "cover",
              },
            },
          }
        : {
            type: "div",
            props: {
              style: {
                position: "absolute", top: "230px", left: "60px", width: "200px", height: "200px",
                borderRadius: "100px", border: "6px solid white", background: "#333",
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: "72px", fontWeight: 900,
              },
              children: name[0]?.toUpperCase() ?? "?",
            },
          },
      {
        type: "div",
        props: {
          style: { position: "absolute", top: "285px", left: "290px", width: "850px", display: "flex", flexDirection: "column" },
          children: [
            { type: "div", props: { style: { fontSize: "58px", fontWeight: 900, display: "flex" }, children: name } },
            { type: "div", props: { style: { fontSize: "22px", fontWeight: 400, opacity: 0.92, marginTop: "10px", display: "flex" }, children: meta || " " } },
          ],
        },
      },
            bio && bio.trim()
        ? {
            type: "div",
            props: {
              style: {
                position: "absolute", top: "450px", left: "60px", width: "640px", display: "flex",
                background: "rgba(0,0,0,0.28)", borderRadius: "16px", padding: "18px 24px",
                fontSize: "20px", fontStyle: "italic", lineHeight: 1.4,
              },
              children: bio,
            },
          }
        : null,
      {
        type: "div",
        props: {
          style: { position: "absolute", top: "450px", right: "60px", width: "400px", display: "flex", flexDirection: "column", gap: "12px" },
          children: [
            famousStat("SEGUIDORES", String(a.followers ?? "N/A")),
            famousStat("OUVINTES MENSAIS", String(a.listeners ?? "N/A")),
          ],
        },
      },
      {
        type: "div",
        props: {
          style: {
            position: "absolute", bottom: "28px", left: "60px", width: "1080px", height: "170px",
            background: "rgba(0,0,0,0.3)", borderRadius: "16px", padding: "16px 26px",
            display: "flex", flexDirection: "column",
          },
          children: [
            { type: "div", props: { style: { fontSize: "13px", fontWeight: 700, opacity: 0.7, letterSpacing: "2px", marginBottom: "8px", display: "flex" }, children: "FAIXAS POPULARES" } },
            ...tracks.map((t: any) => ({
              type: "div",
              props: {
                style: { display: "flex", flexDirection: "row", alignItems: "center", padding: "6px 0", fontSize: "21px" },
                children: [
                  { type: "div", props: { style: { width: "34px", fontWeight: 900, opacity: 0.7, display: "flex" }, children: String(t.pos) } },
                  { type: "div", props: { style: { flex: 1, fontWeight: 700, display: "flex" }, children: String(t.title).slice(0, 48) } },
                  { type: "div", props: { style: { fontWeight: 400, display: "flex" }, children: String(t.streams) } },
                ],
              },
            })),
          ],
        },
      },
    ].filter(Boolean),
  },
};

// -----------------------------
// Renderizar
// -----------------------------
const svg = await satori(markup as any, { width: 1200, height: 800, fonts });
const png = await svg2png(svg, { width: 1200, height: 800 });
console.log("✅ PNG gerado:", png.byteLength, "bytes");

// -----------------------------
// Enviar pro Telegram
// -----------------------------
const form = new FormData();
form.append("chat_id", CHAT_ID);
form.append("caption", CAPTION ?? "");
form.append("photo", new Blob([png], { type: "image/png" }), "card.png");

const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
  method: "POST",
  body: form,
});

if (!res.ok) {
  console.error("Erro Telegram:", await res.text());
  Deno.exit(1);
}
console.log("✅ Enviado para o Telegram!");
