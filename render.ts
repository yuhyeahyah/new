// render.ts — card do /artista (roda no GitHub Actions com Deno)
// Satori (layout) + svg2png-wasm (SVG -> PNG) -> Telegram sendPhoto
import satori from "https://esm.sh/satori@0.10.3";
import { svg2png, initialize } from "https://esm.sh/svg2png-wasm@0.6.1";

const { DATA_B64, CHAT_ID, CAPTION, TELEGRAM_TOKEN } = Deno.env.toObject();

if (!DATA_B64 || !CHAT_ID || !TELEGRAM_TOKEN) {
  console.error("Variáveis de ambiente faltando");
  Deno.exit(1);
}

// -----------------------------------------------------------------
// Dados vindos do bot (base64 UTF-8)
//
// Campos usados (todos opcionais, exceto name):
//   name, banner, picture, bio, genre, nationality, label,
//   residence, worldRank, followers, listeners, salesRank, streamingRank,
//   tracks: [{ pos, title, streams, cover?, album? }]
//   feed:   [{ text, date? }]  (ou lista de strings)
// Campo que não vier simplesmente não aparece no card.
// -----------------------------------------------------------------
function fromBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// deno-lint-ignore no-explicit-any
type N = any;

// deno-lint-ignore no-explicit-any
const a: any = JSON.parse(fromBase64Utf8(DATA_B64));

// -----------------------------------------------------------------
// WASM + fontes
// -----------------------------------------------------------------
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

// -----------------------------------------------------------------
// Helpers de texto
// -----------------------------------------------------------------

// Limpa HTML/entidades e remove caracteres que a fonte Inter (latin) não tem
// (coreano, emoji etc. viram "quadradinhos" no Satori). Também some com
// parênteses que ficaram vazios, ex.: "always on time (항상 제 시간에)".
function clean(v: unknown): string {
  return String(v ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[^\u0020-\u007E\u00A0-\u00FF\u2013\u2014\u2018-\u201D\u2022\u2026]/g, "")
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

// Quebra manual de linhas (cada linha vira um div de linha única).
// Evita depender da quebra automática do Satori com texto longo.
function wrapLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(" ").filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i].slice(0, maxChars);
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= maxChars) cur += " " + w;
    else {
      lines.push(cur);
      if (lines.length === maxLines) {
        cur = "";
        break;
      }
      cur = w;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (i < words.length && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.slice(0, maxChars - 1).trimEnd() + "…";
  }
  return lines;
}

// -----------------------------------------------------------------
// Construtores de nós do Satori
// (todo div ganha display:flex, exigência do Satori com vários filhos)
// -----------------------------------------------------------------
function el(style: Record<string, unknown>, children?: N): N {
  const kids = Array.isArray(children) ? children.filter(Boolean) : children;
  return { type: "div", props: { style: { display: "flex", ...style }, children: kids } };
}

function img(src: string, w: number, h: number, style: Record<string, unknown> = {}): N {
  return {
    type: "img",
    props: { src, width: w, height: h, style: { width: `${w}px`, height: `${h}px`, ...style } },
  };
}

// -----------------------------------------------------------------
// Imagens -> base64 (com retry, detecção de formato e validação)
// -----------------------------------------------------------------
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchImageBytes(
  url: string,
  timeoutMs = 20000,
): Promise<{ buf: Uint8Array; type: string } | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          // De propósito SEM avif/webp: alguns servidores/CDNs trocam o formato
          // conforme o Accept, e o Satori 0.10.3 não decodifica esses formatos.
          Accept: "image/png,image/jpeg;q=0.9,image/gif;q=0.8,*/*;q=0.5",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      if (!res.ok) throw new Error("status " + res.status);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength < 100) throw new Error("imagem vazia");
      return { buf, type: res.headers.get("content-type") || "" };
    } catch (e) {
      console.log(`⚠️ download falhou (${attempt + 1}/3) ${url}:`, (e as Error).message);
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    } finally {
      clearTimeout(t);
    }
  }
  return null;
}

// Descobre o formato real pelos primeiros bytes (não confia no Content-Type).
function sniffMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return "image/webp";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return "image/avif";
  return "";
}

function toBase64(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i += 8192) {
    bin += String.fromCharCode(...buf.subarray(i, i + 8192));
  }
  return btoa(bin);
}

// Testa a imagem sozinha num mini-render: se o Satori engasgar, só ESSA imagem
// é descartada (o resto do card continua com as outras imagens).
async function imageWorks(uri: string, label: string): Promise<boolean> {
  try {
    await satori(
      el({ width: "32px", height: "32px" }, img(uri, 32, 32)),
      { width: 32, height: 32, fonts },
    );
    return true;
  } catch (e) {
    console.log(`⚠️ Satori não aceitou a imagem [${label}]:`, (e as Error).message);
    return false;
  }
}

async function loadImageUncached(url: string, label: string): Promise<string> {
  const got = await fetchImageBytes(url);
  if (!got) return "";

  if (got.buf.byteLength > 8_000_000) {
    console.log(`⚠️ imagem [${label}] grande demais (${got.buf.byteLength} bytes), ignorada`);
    return "";
  }

  const sniffed = sniffMime(got.buf);
  const mime = sniffed || got.type.split(";")[0].trim() || "image/png";
  console.log(
    `🖼️ [${label}] ${url} | real: ${sniffed || "?"} | header: ${got.type || "?"} | ${got.buf.byteLength} bytes`,
  );

  const uri = `data:${mime};base64,${toBase64(got.buf)}`;
  return (await imageWorks(uri, label)) ? uri : "";
}

const imageCache = new Map<string, Promise<string>>();
function loadImage(url: string, label: string): Promise<string> {
  if (!url) return Promise.resolve("");
  let p = imageCache.get(url);
  if (!p) {
    p = loadImageUncached(url, label);
    imageCache.set(url, p);
  }
  return p;
}

// -----------------------------------------------------------------
// Dados normalizados
// -----------------------------------------------------------------
const W = 1200;
const BG = "#120a2e";
const BRAND = "linear-gradient(90deg, #b433ff 0%, #284aff 100%)";
const CARD_BG = "rgba(255,255,255,0.07)";
const CARD_BORDER = "1px solid rgba(255,255,255,0.12)";

const name = clean(a.name) || "Artista";
const worldRank = clean(a.worldRank);

const chips = [a.genre, a.nationality, a.label, a.residence ? `Reside em ${clean(a.residence)}` : ""]
  .map(clean)
  .filter(Boolean);

const BIO_MAX = 90;
const bio = clip(clean(a.bio), BIO_MAX);

const stats: [string, string][] = [
  ["SEGUIDORES", clean(a.followers) || "N/A"],
  ["OUVINTES MENSAIS", clean(a.listeners) || "N/A"],
];
if (clean(a.salesRank)) stats.push(["ALL-TIME SALES", clean(a.salesRank)]);
if (clean(a.streamingRank)) stats.push(["ALL-TIME STREAMING", clean(a.streamingRank)]);

const tracks: N[] = (Array.isArray(a.tracks) ? a.tracks : []).slice(0, 5).map((t: N, i: number) => ({
  pos: t?.pos ?? i + 1,
  title: clean(t?.title) || "—",
  streams: clean(t?.streams),
  album: clean(t?.album),
  cover: String(t?.cover ?? ""),
  coverB64: "",
}));

// Feed: escolhe quantos posts cabem no espaço disponível do cartão
const FEED_LINE_CHARS = 36;
const FEED_BUDGET = 320; // altura (px) estimada disponível para os posts
const feedAll = (Array.isArray(a.feed) ? a.feed : [])
  .map((f: N) =>
    typeof f === "string"
      ? { text: clean(f), date: "" }
      : { text: clean(f?.text ?? f?.content ?? ""), date: clean(f?.date ?? "") }
  )
  .filter((f: N) => f.text);

const feedItems: N[] = [];
let feedUsedH = 0;
{
  let used = 0;
  for (const f of feedAll) {
    const lines = wrapLines(f.text, FEED_LINE_CHARS, 3);
    const h = (f.date ? 20 : 0) + lines.length * 23 + (feedItems.length ? 25 : 0);
    if (used + h > FEED_BUDGET) break;
    used += h;
    feedUsedH = used;
    feedItems.push({ ...f, lines });
  }
}

// Altura do card = conteúdo (sem "buraco" vazio no fim quando não há feed/bio)
//   cabeçalho 340 + respiro 6 + estatísticas 84 + espaço 18 + [bio 49 + 18] + colunas + margem 40
const tracksColH = 20 + 20 + 28 + tracks.length * 56 + Math.max(0, tracks.length - 1) * 8;
const feedColH = feedItems.length ? feedUsedH + 20 + 20 + 28 + 12 : 0;
const colsH = Math.max(tracksColH, feedColH, 120);
const H = 340 + 6 + 84 + 18 + (bio ? 49 + 18 : 0) + colsH + 40;

// Imagens (banner, foto e capas) em paralelo; cada uma validada sozinha
let [bannerB64, picB64] = await Promise.all([
  loadImage(String(a.banner ?? ""), "banner"),
  loadImage(String(a.picture ?? ""), "foto"),
]);
await Promise.all(
  tracks.map(async (t: N, i: number) => {
    t.coverB64 = await loadImage(t.cover, `capa ${i + 1}`);
  }),
);

// -----------------------------------------------------------------
// Layout (Satori)
// -----------------------------------------------------------------
function buildMarkup(): N {
  const anyCover = tracks.some((t: N) => t.coverB64);

  // ---------- Cabeçalho: banner + avatar + nome ----------
  const header = el({ position: "relative", width: `${W}px`, height: "340px" }, [
    // Banner (ou degradê da marca quando não há imagem)
    el(
      { position: "absolute", top: "0px", left: "0px", width: `${W}px`, height: "250px", background: BRAND, overflow: "hidden" },
      bannerB64 ? img(bannerB64, W, 250, { objectFit: "cover" }) : null,
    ),
    // Escurece a base do banner até a cor do fundo (sem "corte" seco)
    el({
      position: "absolute", top: "0px", left: "0px", width: `${W}px`, height: "250px",
      background: "linear-gradient(to bottom, rgba(18,10,46,0.10) 0%, rgba(18,10,46,0.55) 55%, rgba(18,10,46,1) 100%)",
    }),
    // Marca
    el(
      {
        position: "absolute", top: "28px", left: "40px", padding: "8px 18px", borderRadius: "30px",
        background: "rgba(0,0,0,0.35)", fontSize: "16px", fontWeight: 900, letterSpacing: "3px",
      },
      "FAMOU$",
    ),
    // Ranking mundial
    worldRank
      ? el(
        {
          position: "absolute", top: "28px", right: "40px", padding: "10px 26px", borderRadius: "50px",
          background: "rgba(0,0,0,0.5)", fontSize: "22px", fontWeight: 700,
        },
        `${worldRank} mundial`,
      )
      : null,
    // Avatar
    picB64
      ? img(picB64, 170, 170, {
        position: "absolute", top: "150px", left: "60px", borderRadius: "85px",
        border: "6px solid white", objectFit: "cover",
      })
      : el(
        {
          position: "absolute", top: "150px", left: "60px", width: "170px", height: "170px", borderRadius: "85px",
          border: "6px solid white", background: "#2b2160", alignItems: "center", justifyContent: "center",
          fontSize: "68px", fontWeight: 900,
        },
        name[0]?.toUpperCase() ?? "?",
      ),
    // Nome
    el(
      { position: "absolute", top: "166px", left: "262px", width: "880px", fontSize: "56px", fontWeight: 900 },
      clip(name, 26),
    ),
    // Chips: gênero / nacionalidade / gravadora / residência
    chips.length
      ? el(
        { position: "absolute", top: "252px", left: "262px", flexDirection: "row" },
        chips.map((c) =>
          el(
            {
              fontSize: "18px", fontWeight: 700, padding: "6px 16px", borderRadius: "20px",
              background: "rgba(255,255,255,0.14)", marginRight: "10px",
            },
            c,
          )
        ),
      )
      : null,
  ]);

  // ---------- Estatísticas ----------
  const statsRow = el(
    { flexDirection: "row", gap: "16px" },
    stats.map(([label, value]) =>
      el(
        { flex: 1, flexDirection: "column", background: CARD_BG, border: CARD_BORDER, borderRadius: "16px", padding: "14px 20px" },
        [
          el({ fontSize: "12px", fontWeight: 700, opacity: 0.7, letterSpacing: "2px" }, label),
          el({ fontSize: "30px", fontWeight: 900, marginTop: "4px" }, value),
        ],
      )
    ),
  );

  // ---------- Bio ----------
  const bioBar = bio
    ? el(
      {
        flexDirection: "row", alignItems: "center", background: CARD_BG, border: CARD_BORDER,
        borderRadius: "16px", padding: "12px 22px",
      },
      [
        el({ width: "4px", height: "24px", borderRadius: "2px", background: "#b96bff", marginRight: "16px" }),
        el({ flex: 1, fontSize: "21px", whiteSpace: "nowrap", overflow: "hidden" }, bio),
      ],
    )
    : null;

  // ---------- Faixas populares (com capa ao lado) ----------
  const titleMax = feedItems.length ? 30 : 46;

  const trackRow = (t: N, i: number) =>
    el(
      { flexDirection: "row", alignItems: "center", height: "56px", marginTop: i ? "8px" : "0px" },
      [
        el({ width: "34px", fontSize: "20px", fontWeight: 900, opacity: 0.6 }, String(t.pos)),
        // Só reserva espaço de capa se pelo menos uma carregou.
        // Faixa sem capa fica com um quadrado vazio discreto (mantém o alinhamento).
        anyCover
          ? (t.coverB64
            ? img(t.coverB64, 50, 50, { borderRadius: "10px", objectFit: "cover", marginRight: "14px" })
            : el({ width: "50px", height: "50px", borderRadius: "10px", background: "rgba(255,255,255,0.08)", marginRight: "14px" }))
          : null,
        el({ flex: 1, flexDirection: "column", overflow: "hidden" }, [
          el({ fontSize: "20px", fontWeight: 700, whiteSpace: "nowrap" }, clip(t.title, titleMax)),
          t.album
            ? el({ fontSize: "14px", opacity: 0.6, marginTop: "2px", whiteSpace: "nowrap" }, clip(t.album, 36))
            : null,
        ]),
        el({ width: "150px", justifyContent: "flex-end", fontSize: "18px" }, t.streams),
      ],
    );

  const tracksCard = tracks.length
    ? el(
      {
        flex: 1, flexDirection: "column", background: CARD_BG, border: CARD_BORDER,
        borderRadius: "20px", padding: "20px 26px", overflow: "hidden",
      },
      [
        el({ fontSize: "13px", fontWeight: 700, opacity: 0.65, letterSpacing: "2px", marginBottom: "12px" }, "FAIXAS POPULARES"),
        ...tracks.map(trackRow),
      ],
    )
    : null;

  // ---------- Feed ----------
  const feedCard = feedItems.length
    ? el(
      {
        width: "400px", flexDirection: "column", background: CARD_BG, border: CARD_BORDER,
        borderRadius: "20px", padding: "20px 22px", overflow: "hidden",
      },
      [
        el({ fontSize: "13px", fontWeight: 700, opacity: 0.65, letterSpacing: "2px", marginBottom: "12px" }, "FEED"),
        ...feedItems.flatMap((f: N, i: number) => [
          i
            ? el({ height: "1px", background: "rgba(255,255,255,0.12)", marginTop: "12px", marginBottom: "12px" })
            : null,
          el({ flexDirection: "column" }, [
            f.date
              ? el({ fontSize: "13px", fontWeight: 700, opacity: 0.55, letterSpacing: "1px", marginBottom: "4px" }, f.date)
              : null,
            ...f.lines.map((l: string) => el({ fontSize: "17px", lineHeight: 1.35, whiteSpace: "nowrap" }, l)),
          ]),
        ]),
      ],
    )
    : null;

  const columns = el({ flexDirection: "row", flex: 1, gap: "20px" }, [tracksCard, feedCard]);

  // ---------- Raiz ----------
  return el(
    {
      width: `${W}px`, height: `${H}px`, background: BG, color: "white", fontFamily: "Inter",
      flexDirection: "column", position: "relative", overflow: "hidden",
    },
    [
      header,
      el({ flex: 1, flexDirection: "column", padding: "6px 60px 40px 60px", gap: "18px" }, [statsRow, bioBar, columns]),
    ],
  );
}

// -----------------------------------------------------------------
// Renderizar (rede de segurança: se algo ainda quebrar o Satori, tenta sem imagens)
// -----------------------------------------------------------------
let svg: string;
try {
  svg = await satori(buildMarkup(), { width: W, height: H, fonts });
} catch (e) {
  console.log("⚠️ Satori falhou com as imagens, tentando sem nenhuma:", (e as Error).message);
  bannerB64 = "";
  picB64 = "";
  tracks.forEach((t: N) => (t.coverB64 = ""));
  svg = await satori(buildMarkup(), { width: W, height: H, fonts });
}

const png = await svg2png(svg, { width: W, height: H });
console.log("✅ PNG gerado:", png.byteLength, "bytes");

// -----------------------------------------------------------------
// Enviar pro Telegram
// -----------------------------------------------------------------
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
