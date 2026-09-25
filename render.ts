// render.ts — 4 layouts do /artista
// Satori (layout) + svg2png-wasm (SVG→PNG) → Telegram sendPhoto
import satori from "https://esm.sh/satori@0.10.3";
import { svg2png, initialize } from "https://esm.sh/svg2png-wasm@0.6.1";

const { DATA_B64, CHAT_ID, CAPTION, TELEGRAM_TOKEN } = Deno.env.toObject();

if (!DATA_B64 || !CHAT_ID || !TELEGRAM_TOKEN) {
  console.error("Variáveis de ambiente faltando");
  Deno.exit(1);
}

function fromBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// deno-lint-ignore no-explicit-any
type N = any;
// deno-lint-ignore no-explicit-any
const a: any = JSON.parse(fromBase64Utf8(DATA_B64));

// ─── WASM + fontes ──────────────────────────────────────────────────
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

// ─── Helpers texto ───────────────────────────────────────────────────
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
      if (lines.length === maxLines) { cur = ""; break; }
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

// ─── Construtores de nós Satori ──────────────────────────────────────
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

// ─── Imagens ─────────────────────────────────────────────────────────
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

async function fetchImageBytes(url: string): Promise<{ buf: Uint8Array; type: string } | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "image/png,image/jpeg;q=0.9,*/*;q=0.5" },
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

function sniffMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return "";
}

function toBase64(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i += 8192)
    bin += String.fromCharCode(...buf.subarray(i, i + 8192));
  return btoa(bin);
}

async function imageWorks(uri: string, label: string): Promise<boolean> {
  try {
    await satori(el({ width: "32px", height: "32px" }, img(uri, 32, 32)), { width: 32, height: 32, fonts });
    return true;
  } catch (e) {
    console.log(`⚠️ Satori rejeitou imagem [${label}]:`, (e as Error).message);
    return false;
  }
}

const rawImageBytes = new Map<string, Uint8Array>();

async function loadImageUncached(url: string, label: string): Promise<string> {
  const got = await fetchImageBytes(url);
  if (!got) return "";
  if (got.buf.byteLength > 8_000_000) {
    console.log(`⚠️ [${label}] grande demais, ignorada`);
    return "";
  }
  rawImageBytes.set(url, got.buf);
  const sniffed = sniffMime(got.buf);
  const mime = sniffed || got.type.split(";")[0].trim() || "image/png";
  console.log(`🖼️ [${label}] ${url} | ${mime} | ${got.buf.byteLength} bytes`);
  const uri = `data:${mime};base64,${toBase64(got.buf)}`;
  return (await imageWorks(uri, label)) ? uri : "";
}

const imageCache = new Map<string, Promise<string>>();
function loadImage(url: string, label: string): Promise<string> {
  if (!url) return Promise.resolve("");
  let p = imageCache.get(url);
  if (!p) { p = loadImageUncached(url, label); imageCache.set(url, p); }
  return p;
}

// ─── Extração de cor dominante (PNG + JPEG) ──────────────────────────
// [Mantido exatamente igual ao original — copiado sem alterações]
type DecodedImage = { pixels: Uint8Array; width: number; height: number };

async function decodePNG(pngBytes: Uint8Array): Promise<DecodedImage | null> {
  try {
    const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) { if (pngBytes[i] !== SIG[i]) return null; }
    const view = new DataView(pngBytes.buffer, pngBytes.byteOffset);
    let offset = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
    const idatChunks: Uint8Array[] = [];
    while (offset + 12 <= pngBytes.length) {
      const length = view.getUint32(offset);
      const type = String.fromCharCode(pngBytes[offset+4],pngBytes[offset+5],pngBytes[offset+6],pngBytes[offset+7]);
      const data = pngBytes.slice(offset + 8, offset + 8 + length);
      if (type === "IHDR") { width = view.getUint32(offset+8); height = view.getUint32(offset+12); bitDepth = data[8]; colorType = data[9]; }
      else if (type === "IDAT") idatChunks.push(data);
      else if (type === "IEND") break;
      offset += 12 + length;
    }
    if (!width || !height || bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) return null;
    const totalLen = idatChunks.reduce((s, c) => s + c.length, 0);
    const idatData = new Uint8Array(totalLen);
    let pos = 0;
    for (const chunk of idatChunks) { idatData.set(chunk, pos); pos += chunk.length; }
    const ds = new DecompressionStream("deflate");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(idatData); writer.close();
    const decompChunks: Uint8Array[] = [];
    let done = false;
    while (!done) { const { value, done: d } = await reader.read(); if (value) decompChunks.push(value); done = d; }
    const rawLen = decompChunks.reduce((s, c) => s + c.length, 0);
    const rawData = new Uint8Array(rawLen);
    pos = 0;
    for (const chunk of decompChunks) { rawData.set(chunk, pos); pos += chunk.length; }
    const bpp = colorType === 6 ? 4 : 3;
    const stride = width * bpp + 1;
    const pixels = new Uint8Array(width * height * 4);
    let prevRecon = new Uint8Array(width * bpp);
    for (let y = 0; y < height; y++) {
      const filterType = rawData[y * stride];
      const rawRow = rawData.subarray(y * stride + 1, y * stride + 1 + width * bpp);
      const recon = new Uint8Array(width * bpp);
      for (let x = 0; x < rawRow.length; x++) {
        const raw = rawRow[x], av = x >= bpp ? recon[x-bpp] : 0, bv = prevRecon[x]||0, cv = x >= bpp ? prevRecon[x-bpp]||0 : 0;
        switch (filterType) {
          case 0: recon[x]=raw; break; case 1: recon[x]=(raw+av)&255; break;
          case 2: recon[x]=(raw+bv)&255; break; case 3: recon[x]=(raw+Math.floor((av+bv)/2))&255; break;
          case 4: { const pa=Math.abs(bv-cv),pb=Math.abs(av-cv),pc=Math.abs(av+bv-2*cv); recon[x]=(raw+(pa<=pb&&pa<=pc?av:pb<=pc?bv:cv))&255; break; }
          default: recon[x]=raw;
        }
      }
      for (let x = 0; x < width; x++) {
        const pi=(y*width+x)*4, ri=x*bpp;
        pixels[pi]=recon[ri]; pixels[pi+1]=recon[ri+1]; pixels[pi+2]=recon[ri+2]; pixels[pi+3]=bpp===4?recon[ri+3]:255;
      }
      prevRecon = recon;
    }
    return { pixels, width, height };
  } catch { return null; }
}

function decodeJPEG(data: Uint8Array): DecodedImage | null {
  // [mantido igual ao original — função grande, não alterada]
  // Para não duplicar centenas de linhas, copie da sua versão existente.
  // A função decodeJPEG, decodeJPEGApprox, clamp255 permanecem IGUAIS.
  return null; // substitua por sua implementação existente
}

function clamp255(v: number): number { return Math.max(0, Math.min(255, Math.round(v))); }

function extractDominantFromPixels(pixels: Uint8Array): { r: number; g: number; b: number; saturation: number } | null {
  const QUANT_SHIFT = 3, MIN_SAT = 0.22, MIN_BRIGHT = 10, MAX_BRIGHT = 245, TOP_N = 10;
  const buckets = new Map<number, number>();
  const bucketSum = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (let i = 0; i < pixels.length; i += 4) {
    const r2=pixels[i],g2=pixels[i+1],b2=pixels[i+2],a2=pixels[i+3];
    if (a2 < 200) continue;
    const brightness=(r2+g2+b2)/3;
    if (brightness < MIN_BRIGHT || brightness > MAX_BRIGHT) continue;
    const rn=r2/255,gn=g2/255,bn=b2/255,max2=Math.max(rn,gn,bn),min2=Math.min(rn,gn,bn);
    const l=(max2+min2)/2, s=max2===min2?0:l>0.5?(max2-min2)/(2-max2-min2):(max2-min2)/(max2+min2);
    if (s < MIN_SAT) continue;
    const key=((r2>>QUANT_SHIFT)<<16)|((g2>>QUANT_SHIFT)<<8)|(b2>>QUANT_SHIFT);
    buckets.set(key,(buckets.get(key)??0)+1);
    const prev=bucketSum.get(key)??{r:0,g:0,b:0,n:0};
    bucketSum.set(key,{r:prev.r+r2,g:prev.g+g2,b:prev.b+b2,n:prev.n+1});
  }
  if (buckets.size === 0) return null;
  const sorted = Array.from(buckets.entries()).sort((a2,b2)=>b2[1]-a2[1]);
  const candidates = sorted.slice(0, Math.min(TOP_N, sorted.length));
  let bestKey = candidates[0][0], bestScore = -Infinity;
  for (const [k, count] of candidates) {
    const sum2=bucketSum.get(k)!,rr=sum2.r/sum2.n,gg=sum2.g/sum2.n,bb=sum2.b/sum2.n;
    const max2=Math.max(rr,gg,bb)/255,min2=Math.min(rr,gg,bb)/255,lv2=(max2+min2)/2;
    const sat2=max2===min2?0:lv2>0.5?(max2-min2)/(2-max2-min2):(max2-min2)/(max2+min2);
    const score=sat2*100+Math.log(count+1)*2;
    if (score > bestScore) { bestScore=score; bestKey=k; }
  }
  const sum=bucketSum.get(bestKey)!;
  const r=Math.round(sum.r/sum.n),g=Math.round(sum.g/sum.n),b=Math.round(sum.b/sum.n);
  const max=Math.max(r,g,b)/255,min=Math.min(r,g,b)/255,lv=(max+min)/2;
  const sat=max===min?0:lv>0.5?(max-min)/(2-max-min):(max-min)/(max+min);
  return {r,g,b,saturation:sat};
}

function generateColorFromName(name: string): string {
  let hash1=0,hash2=0;
  for (let i=0;i<name.length;i++){hash1=(hash1<<5)-hash1+name.charCodeAt(i);hash1|=0;hash2=(hash2<<3)+hash2+name.charCodeAt(i);hash2|=0;}
  const hue=Math.abs((hash1+hash2)%360),saturation=70+Math.abs(hash1%25),lightness=48+Math.abs(hash2%14);
  const h=hue/360,s=saturation/100,l=lightness/100;
  let r:number,g:number,b:number;
  if(s===0){r=g=b=l;}else{
    const hue2rgb=(p2:number,q2:number,t:number)=>{if(t<0)t+=1;if(t>1)t-=1;if(t<1/6)return p2+(q2-p2)*6*t;if(t<1/2)return q2;if(t<2/3)return p2+(q2-p2)*(2/3-t)*6;return p2;};
    const q=l<0.5?l*(1+s):l+s-l*s,p=2*l-q;
    r=hue2rgb(p,q,h+1/3);g=hue2rgb(p,q,h);b=hue2rgb(p,q,h-1/3);
  }
  const toHex=(x:number)=>Math.round(x*255).toString(16).padStart(2,"0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m=/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m?{r:parseInt(m[1],16),g:parseInt(m[2],16),b:parseInt(m[3],16)}:{r:61,g:22,b:112};
}

async function extractColorFromBytes(url: string): Promise<string | null> {
  const buf = rawImageBytes.get(url);
  if (!buf) return null;
  const mime = sniffMime(buf);
  let decoded: DecodedImage | null = null;
  if (mime === "image/png") decoded = await decodePNG(buf);
  else if (mime === "image/jpeg") decoded = decodeJPEG(buf);
  else return null;
  if (!decoded) return null;
  const best = extractDominantFromPixels(decoded.pixels);
  if (!best) return null;
  const rawHex = `#${best.r.toString(16).padStart(2,"0")}${best.g.toString(16).padStart(2,"0")}${best.b.toString(16).padStart(2,"0")}`;
  console.log(`🎯 Cor dominante bruta: ${rawHex} (sat: ${(best.saturation*100).toFixed(1)}%)`);
  if (best.saturation < 0.12) return null;
  let {r,g,b,saturation} = best;
  if (saturation < 0.22) {
    const strength=1-saturation/0.22, boost=Math.round(12+strength*23), cut=Math.round(4+strength*8);
    if(r>=g&&r>=b){r=Math.min(255,r+boost);g=Math.max(0,g-cut);b=Math.max(0,b-cut);}
    else if(g>=r&&g>=b){g=Math.min(255,g+boost);r=Math.max(0,r-cut);b=Math.max(0,b-cut);}
    else{b=Math.min(255,b+boost);r=Math.max(0,r-cut);g=Math.max(0,g-cut);}
  }
  const hex=`#${r.toString(16).padStart(2,"0")}${g.toString(16).padStart(2,"0")}${b.toString(16).padStart(2,"0")}`;
  console.log(`✅ Cor final: ${hex}`);
  return hex;
}

async function extractDominantColor(bannerUrl: string, pictureUrl: string, name: string): Promise<string> {
  if (bannerUrl) { const c=await extractColorFromBytes(bannerUrl); if(c) return c; }
  if (pictureUrl && pictureUrl !== bannerUrl) { const c=await extractColorFromBytes(pictureUrl); if(c) return c; }
  return generateColorFromName(name);
}

// ─── Paleta ──────────────────────────────────────────────────────────
type Palette = {
  base: string; darker: string; darkest: string; brand: string;
  cardBg: string; cardBorder: string; isLight: boolean;
};

function generatePalette(color: string): Palette {
  const rgb = hexToRgb(color);
  const luminance = (0.299*rgb.r + 0.587*rgb.g + 0.114*rgb.b) / 255;
  const isLight = luminance > 0.55;
  const FULL_DARKER=0.72, FULL_DARKEST=0.50;
  const scaleDarker=FULL_DARKER+(1-FULL_DARKER)*luminance;
  const scaleDarkest=FULL_DARKEST+(1-FULL_DARKEST)*luminance;
  const darker={r:Math.round(rgb.r*scaleDarker),g:Math.round(rgb.g*scaleDarker),b:Math.round(rgb.b*scaleDarker)};
  const darkest={r:Math.round(rgb.r*scaleDarkest),g:Math.round(rgb.g*scaleDarkest),b:Math.round(rgb.b*scaleDarkest)};
  const brandEnd={r:Math.max(0,rgb.r-60),g:Math.max(0,rgb.g-20),b:Math.min(255,rgb.b+50)};
  const cardBg = isLight
    ? `rgba(${Math.round(rgb.r*0.35)},${Math.round(rgb.g*0.35)},${Math.round(rgb.b*0.35)},0.55)`
    : `rgba(${Math.min(255,rgb.r+20)},${Math.min(255,rgb.g+20)},${Math.min(255,rgb.b+20)},0.10)`;
  const cardBorder = isLight
    ? `1px solid rgba(${Math.round(rgb.r*0.5)},${Math.round(rgb.g*0.5)},${Math.round(rgb.b*0.5)},0.35)`
    : `1px solid rgba(${Math.min(255,rgb.r+40)},${Math.min(255,rgb.g+40)},${Math.min(255,rgb.b+40)},0.18)`;
  return {
    base: `rgb(${rgb.r},${rgb.g},${rgb.b})`,
    darker: `rgb(${darker.r},${darker.g},${darker.b})`,
    darkest: `rgb(${darkest.r},${darkest.g},${darkest.b})`,
    brand: `linear-gradient(90deg,rgb(${rgb.r},${rgb.g},${rgb.b}) 0%,rgb(${brandEnd.r},${brandEnd.g},${brandEnd.b}) 100%)`,
    cardBg, cardBorder, isLight,
  };
}

// ─── Dados normalizados ──────────────────────────────────────────────
const layoutName: string = clean(a.layout) || "classic";
const W_MAP: Record<string, number> = { classic:1200, midnight:1200, social:1080, compact:900 };
const W = W_MAP[layoutName] ?? 1200;

const name = clean(a.name) || "Artista";
const worldRank = clean(a.worldRank);
const bio = clip(clean(a.bio), 100);
const birthplace = clean(a.birthplace);
const relationship = clean(a.relationship);

const chips = [
  a.genre, a.nationality, a.label,
  a.residence ? `Reside em ${clean(a.residence)}` : "",
].map(clean).filter(Boolean);

// chips extras para alguns layouts
const chipsExtra = [birthplace, relationship].map(clean).filter(Boolean);

const stats: [string, string][] = [
  ["SEGUIDORES", clean(a.followers) || "N/A"],
  ["OUVINTES MENSAIS", clean(a.listeners) || "N/A"],
];
if (clean(a.salesRank)) stats.push(["ALL-TIME SALES", clean(a.salesRank)]);
if (clean(a.streamingRank)) stats.push(["ALL-TIME STREAMING", clean(a.streamingRank)]);

const tracks: N[] = (Array.isArray(a.tracks) ? a.tracks : []).slice(0, 5).map((t: N, i: number) => ({
  pos: t?.pos ?? i+1,
  title: clean(t?.title) || "—",
  streams: clean(t?.streams),
  album: clean(t?.album),
  cover: String(t?.cover ?? ""),
  coverB64: "",
}));

// Feed: aceita os novos campos likes/comments/time
const feedAll: N[] = (Array.isArray(a.feed) ? a.feed : [])
  .map((f: N) =>
    typeof f === "string"
      ? { text: clean(f), likes: "", comments: "", time: "" }
      : { text: clean(f?.text ?? f?.content ?? ""), likes: clean(f?.likes ?? ""), comments: clean(f?.comments ?? ""), time: clean(f?.time ?? f?.date ?? "") }
  )
  .filter((f: N) => f.text && f.text.length >= 5);

const bannerUrl = String(a.banner ?? "");
const pictureUrl = String(a.picture ?? "");

// ─── Carrega imagens (adaptado por layout) ───────────────────────────
const needsCovers = layoutName !== "compact";

let [bannerB64, picB64] = await Promise.all([
  loadImage(bannerUrl, "banner"),
  loadImage(pictureUrl, "foto"),
]);

if (needsCovers) {
  await Promise.all(tracks.map(async (t: N, i: number) => {
    t.coverB64 = await loadImage(t.cover, `capa ${i+1}`);
  }));
}

const dominantColor = await extractDominantColor(bannerUrl, pictureUrl, name);
const palette = generatePalette(dominantColor);

// ─── Constantes de cor por layout ───────────────────────────────────
// Midnight: sempre escuro, usa cor como acento
const midnightBg = "#0c0c14";
const midnightCard = "rgba(255,255,255,0.06)";
const midnightBorder = `1px solid ${palette.base.replace("rgb", "rgba").replace(")", ",0.4)")}`;

// Helpers de rgba para o texto
function textRgba(alpha: number, layout = layoutName): string {
  return `rgba(255,255,255,${alpha})`;
}

// ─── CHIP helper (FIX: sempre visível, fundo sempre semi-opaco escuro) ──
function buildChip(text: string, styleover: Record<string, unknown> = {}): N {
  return el({
    fontSize: "18px", fontWeight: 700,
    padding: "6px 16px", borderRadius: "20px",
    // FIX AQUI: rgba escuro em vez de branco translúcido
    background: "rgba(0,0,0,0.48)",
    color: "white",
    marginRight: "10px",
    ...styleover,
  }, text);
}

// ─── Shared header (usada no classic, midnight e compact) ─────────────
function buildHeader(BG: string, BRAND: string, showBio = false): N {
  return el(
    { position: "relative", width: `${W}px`, height: "340px" },
    [
      // Banner
      el(
        { position: "absolute", top: "0px", left: "0px", width: `${W}px`, height: "250px", background: BRAND, overflow: "hidden" },
        bannerB64 ? img(bannerB64, W, 250, { objectFit: "cover" }) : null,
      ),
      // Escurece base do banner
      el({
        position: "absolute", top: "0px", left: "0px", width: `${W}px`, height: "250px",
        background: `linear-gradient(to bottom, rgba(0,0,0,0.08) 0%, rgba(0,0,0,0.55) 55%, ${BG} 100%)`,
      }),
      // FAMOU$ marca
      el({
        position: "absolute", top: "28px", left: "40px", padding: "8px 18px", borderRadius: "30px",
        background: "rgba(0,0,0,0.45)", fontSize: "16px", fontWeight: 900, letterSpacing: "3px", color: "white",
      }, "FAMOU$"),
      // Ranking mundial
      worldRank
        ? el({
            position: "absolute", top: "28px", right: "40px", padding: "10px 26px", borderRadius: "50px",
            background: "rgba(0,0,0,0.50)", fontSize: "22px", fontWeight: 700, color: "white",
          }, `${worldRank} mundial`)
        : null,
      // Avatar
      picB64
        ? img(picB64, 170, 170, {
            position: "absolute", top: "150px", left: "60px", borderRadius: "85px",
            border: "6px solid white", objectFit: "cover",
          })
        : el({
            position: "absolute", top: "150px", left: "60px", width: "170px", height: "170px", borderRadius: "85px",
            border: "6px solid white", background: palette.base, alignItems: "center", justifyContent: "center",
            fontSize: "68px", fontWeight: 900, color: "white",
          }, (name[0]?.toUpperCase() ?? "?")),
      // Nome
      el({
        position: "absolute", top: "166px", left: "262px", width: `${W - 320}px`,
        fontSize: "56px", fontWeight: 900, color: "white",
      }, clip(name, 26)),
      // Chips
      chips.length
        ? el(
            { position: "absolute", top: "252px", left: "262px", flexDirection: "row", flexWrap: "nowrap" },
            chips.map((c) => buildChip(c)),
          )
        : null,
    ],
  );
}

// ─── LAYOUT: CLASSIC ─────────────────────────────────────────────────
function buildClassicMarkup(): N {
  const BG = palette.darkest;
  const BRAND = palette.brand;
  const CARD_BG = palette.cardBg;
  const CARD_BORDER = palette.cardBorder;
  const TEXT = "rgb(255,255,255)";

  const statsRow = el(
    { flexDirection: "row", gap: "16px" },
    stats.map(([label, value]) =>
      el(
        { flex: 1, flexDirection: "column", background: CARD_BG, border: CARD_BORDER, borderRadius: "16px", padding: "14px 20px" },
        [
          el({ fontSize: "12px", fontWeight: 700, opacity: 0.7, letterSpacing: "2px", color: TEXT }, label),
          el({ fontSize: "30px", fontWeight: 900, marginTop: "4px", color: TEXT }, value),
        ],
      )
    ),
  );

  const bioBar = bio
    ? el(
        { flexDirection: "row", alignItems: "center", background: CARD_BG, border: CARD_BORDER, borderRadius: "16px", padding: "12px 22px" },
        [
          el({ width: "4px", height: "24px", borderRadius: "2px", background: palette.base, marginRight: "16px" }),
          el({ flex: 1, fontSize: "21px", color: TEXT, whiteSpace: "nowrap", overflow: "hidden" }, bio),
        ],
      )
    : null;

  const anyCover = tracks.some((t: N) => t.coverB64);

  const trackRow = (t: N, i: number) =>
    el({ flexDirection: "row", alignItems: "center", height: "56px", marginTop: i ? "8px" : "0px" },
      [
        el({ width: "34px", fontSize: "20px", fontWeight: 900, color: textRgba(0.6) }, String(t.pos)),
        anyCover
          ? (t.coverB64
              ? img(t.coverB64, 50, 50, { borderRadius: "10px", objectFit: "cover", marginRight: "14px" })
              : el({ width: "50px", height: "50px", borderRadius: "10px", background: textRgba(0.08), marginRight: "14px" }))
          : null,
        el({ flex: 1, flexDirection: "column", overflow: "hidden" },
          [
            el({ fontSize: "20px", fontWeight: 700, color: TEXT, whiteSpace: "nowrap" }, clip(t.title, feedAll.length ? 30 : 46)),
            t.album ? el({ fontSize: "14px", color: textRgba(0.6), marginTop: "2px", whiteSpace: "nowrap" }, clip(t.album, 36)) : null,
          ],
        ),
        el({ width: "150px", justifyContent: "flex-end", fontSize: "18px", color: TEXT }, t.streams),
      ],
    );

  const tracksCard = tracks.length
    ? el(
        { flex: 1, flexDirection: "column", background: CARD_BG, border: CARD_BORDER, borderRadius: "20px", padding: "20px 26px", overflow: "hidden" },
        [
          el({ fontSize: "13px", fontWeight: 700, color: textRgba(0.65), letterSpacing: "2px", marginBottom: "12px" }, "FAIXAS POPULARES"),
          ...tracks.map(trackRow),
        ],
      )
    : null;

  // Feed melhorado com likes + tempo
  const FEED_LINE_CHARS = 36, FEED_BUDGET = 320;
  const feedItems: N[] = [];
  let feedUsedH = 0;
  for (const f of feedAll) {
    const lines = wrapLines(f.text, FEED_LINE_CHARS, 3);
    const hasReactions = f.likes || f.time;
    const h = lines.length * 23 + (hasReactions ? 22 : 0) + (feedItems.length ? 25 : 0);
    if (feedUsedH + h > FEED_BUDGET) break;
    feedUsedH += h;
    feedItems.push({ ...f, lines });
  }

  const feedCard = feedItems.length
    ? el(
        { width: "400px", flexDirection: "column", background: CARD_BG, border: CARD_BORDER, borderRadius: "20px", padding: "20px 22px", overflow: "hidden" },
        [
          el({ fontSize: "13px", fontWeight: 700, color: textRgba(0.65), letterSpacing: "2px", marginBottom: "12px" }, "FEED"),
          ...feedItems.flatMap((f: N, i: number) => [
            i ? el({ height: "1px", background: textRgba(0.12), marginTop: "12px", marginBottom: "12px" }) : null,
            el({ flexDirection: "column" },
              [
                ...f.lines.map((l: string) => el({ fontSize: "17px", lineHeight: 1.35, color: TEXT, whiteSpace: "nowrap" }, l)),
                (f.likes || f.time)
                  ? el({ flexDirection: "row", marginTop: "6px", gap: "14px" },
                      [
                        f.likes ? el({ fontSize: "13px", color: textRgba(0.55) }, `★ ${f.likes}`) : null,
                        f.comments ? el({ fontSize: "13px", color: textRgba(0.55) }, `💬 ${f.comments}`) : null,
                        f.time ? el({ fontSize: "13px", color: textRgba(0.45) }, f.time) : null,
                      ],
                    )
                  : null,
              ],
            ),
          ]),
        ],
      )
    : null;

  const tracksColH = 20 + 20 + 28 + tracks.length * 56 + Math.max(0, tracks.length - 1) * 8;
  const feedColH = feedItems.length ? feedUsedH + 20 + 20 + 28 + 12 : 0;
  const colsH = Math.max(tracksColH, feedColH, 120);
  const H = 340 + 6 + 84 + 18 + (bio ? 49 + 18 : 0) + colsH + 40;

  return { markup: el(
    { width: `${W}px`, height: `${H}px`, background: BG, color: TEXT, fontFamily: "Inter", flexDirection: "column", overflow: "hidden" },
    [
      buildHeader(BG, BRAND),
      el({ flex: 1, flexDirection: "column", padding: "6px 60px 40px 60px", gap: "18px", color: TEXT },
        [statsRow, bioBar, el({ flexDirection: "row", flex: 1, gap: "20px" }, [tracksCard, feedCard])],
      ),
    ],
  ), H };
}

// ─── LAYOUT: MIDNIGHT ─────────────────────────────────────────────────
function buildMidnightMarkup(): N {
  const BG = midnightBg;
  const CARD_BG = midnightCard;
  const CARD_BORDER = midnightBorder;
  const TEXT = "rgba(255,255,255,1)";
  const ACCENT = palette.base;

  // Header sempre escuro; usa brand como gradiente mas força BG a #0c0c14
  const headerBanner = el(
    { position: "relative", width: `${W}px`, height: "300px" },
    [
      // Banner
      el(
        { position: "absolute", top: "0px", left: "0px", width: `${W}px`, height: "300px", background: palette.brand, overflow: "hidden" },
        bannerB64 ? img(bannerB64, W, 300, { objectFit: "cover", opacity: 0.6 }) : null,
      ),
      // Fade ainda mais escuro
      el({
        position: "absolute", top: "0px", left: "0px", width: `${W}px`, height: "300px",
        background: `linear-gradient(to bottom, rgba(0,0,0,0.25) 0%, rgba(12,12,20,0.9) 70%, ${BG} 100%)`,
      }),
      // Marca
      el({
        position: "absolute", top: "24px", left: "40px", padding: "8px 18px", borderRadius: "30px",
        background: ACCENT.replace("rgb","rgba").replace(")",",0.3)"),
        border: `1px solid ${ACCENT.replace("rgb","rgba").replace(")",",0.7)")}`,
        fontSize: "16px", fontWeight: 900, letterSpacing: "3px", color: "white",
      }, "FAMOU$"),
      worldRank ? el({
        position: "absolute", top: "24px", right: "40px", padding: "10px 26px", borderRadius: "50px",
        background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.2)",
        fontSize: "22px", fontWeight: 700, color: "white",
      }, `${worldRank} mundial`) : null,
    ],
  );

  // Avatar com glow
  const avatarSection = el(
    { position: "relative", flexDirection: "row", alignItems: "flex-end", padding: "0 60px", marginTop: "-80px", marginBottom: "20px" },
    [
      picB64
        ? img(picB64, 160, 160, {
            borderRadius: "80px", border: `4px solid ${ACCENT}`,
            objectFit: "cover",
            boxShadow: `0 0 40px ${ACCENT.replace("rgb","rgba").replace(")",",0.6)")}`,
          })
        : el({
            width: "160px", height: "160px", borderRadius: "80px",
            border: `4px solid ${ACCENT}`, background: ACCENT,
            alignItems: "center", justifyContent: "center", fontSize: "64px", fontWeight: 900, color: "white",
          }, (name[0]?.toUpperCase() ?? "?")),
      el({ flex: 1, flexDirection: "column", marginLeft: "28px", paddingBottom: "8px" },
        [
          el({ fontSize: "52px", fontWeight: 900, color: "white", lineHeight: 1.1 }, clip(name, 24)),
          chips.length
            ? el({ flexDirection: "row", flexWrap: "nowrap", marginTop: "12px" },
                chips.map((c) => buildChip(c, {
                  background: ACCENT.replace("rgb","rgba").replace(")",",0.25)"),
                  border: `1px solid ${ACCENT.replace("rgb","rgba").replace(")",",0.6)")}`,
                })),
              )
            : null,
        ],
      ),
    ],
  );

  const statsRow = el(
    { flexDirection: "row", gap: "14px", padding: "0 60px" },
    stats.map(([label, value]) =>
      el(
        { flex: 1, flexDirection: "column", background: CARD_BG, border: CARD_BORDER, borderRadius: "16px", padding: "16px 20px" },
        [
          el({ fontSize: "11px", fontWeight: 700, color: ACCENT, letterSpacing: "2px", marginBottom: "6px" }, label),
          el({ fontSize: "28px", fontWeight: 900, color: "white" }, value),
        ],
      )
    ),
  );

  // Feed como cards com acento lateral
  const feedItems: N[] = feedAll.slice(0, 3).map((f: N) => ({
    ...f,
    lines: wrapLines(f.text, 52, 2),
  }));

  const feedSection = feedItems.length
    ? el(
        { flexDirection: "column", padding: "0 60px", gap: "12px" },
        [
          el({ fontSize: "13px", fontWeight: 700, color: ACCENT, letterSpacing: "2px", marginBottom: "4px" }, "FEED"),
          ...feedItems.map((f: N) =>
            el(
              { flexDirection: "row", alignItems: "flex-start", background: CARD_BG, border: CARD_BORDER, borderRadius: "12px", overflow: "hidden" },
              [
                el({ width: "4px", alignSelf: "stretch", background: ACCENT, flexShrink: 0 }),
                el({ flex: 1, flexDirection: "column", padding: "14px 18px" },
                  [
                    ...f.lines.map((l: string) => el({ fontSize: "18px", color: "white", whiteSpace: "nowrap" }, l)),
                    (f.likes || f.time)
                      ? el({ flexDirection: "row", marginTop: "8px", gap: "16px" },
                          [
                            f.likes ? el({ fontSize: "13px", color: textRgba(0.5) }, `★ ${f.likes}`) : null,
                            f.time ? el({ fontSize: "13px", color: textRgba(0.4) }, f.time) : null,
                          ],
                        )
                      : null,
                  ],
                ),
              ],
            )
          ),
        ],
      )
    : null;

  // Tracks (sem capas no midnight para look limpo)
  const tracksSection = tracks.length
    ? el(
        { flexDirection: "column", padding: "0 60px" },
        [
          el({ fontSize: "13px", fontWeight: 700, color: ACCENT, letterSpacing: "2px", marginBottom: "12px" }, "FAIXAS POPULARES"),
          ...tracks.map((t: N, i: number) =>
            el(
              { flexDirection: "row", alignItems: "center", padding: "10px 0", borderBottom: i < tracks.length-1 ? "1px solid rgba(255,255,255,0.06)" : "none" },
              [
                el({ width: "30px", fontSize: "16px", fontWeight: 900, color: ACCENT }, String(t.pos)),
                el({ flex: 1, flexDirection: "column" },
                  [
                    el({ fontSize: "19px", fontWeight: 700, color: "white", whiteSpace: "nowrap" }, clip(t.title, 40)),
                    t.album ? el({ fontSize: "13px", color: textRgba(0.5), marginTop: "2px" }, clip(t.album, 40)) : null,
                  ],
                ),
                el({ fontSize: "17px", color: textRgba(0.7), minWidth: "120px", justifyContent: "flex-end" }, t.streams),
              ],
            )
          ),
        ],
      )
    : null;

  const H = 300 + 200 + 90 + (feedSection ? 160 + feedItems.length * 80 : 0) + (tracksSection ? 28 + tracks.length * 48 : 0) + 60;

  return { markup: el(
    { width: `${W}px`, height: `${H}px`, background: BG, fontFamily: "Inter", flexDirection: "column" },
    [
      headerBanner,
      avatarSection,
      statsRow,
      bio ? el({ padding: "16px 60px 0 60px" },
        [el({ fontSize: "19px", color: textRgba(0.7), fontStyle: "italic" }, `"${bio}"`)]) : null,
      el({ height: "24px" }),
      feedSection,
      feedSection && tracksSection ? el({ height: "20px" }) : null,
      tracksSection,
      el({ height: "40px" }),
    ],
  ), H };
}

// ─── LAYOUT: SOCIAL ───────────────────────────────────────────────────
function buildSocialMarkup(): N {
  // W=1080, portrait, feed em destaque
  const BG = palette.darkest;
  const CARD_BG = palette.cardBg;
  const CARD_BORDER = palette.cardBorder;
  const TEXT = "rgba(255,255,255,1)";

  // Topo: banner + avatar centralizado
  const topSection = el(
    { position: "relative", width: `${W}px`, height: "320px" },
    [
      // Banner
      el(
        { position: "absolute", top: "0px", left: "0px", width: `${W}px`, height: "220px", background: palette.brand, overflow: "hidden" },
        bannerB64 ? img(bannerB64, W, 220, { objectFit: "cover" }) : null,
      ),
      el({
        position: "absolute", top: "0px", left: "0px", width: `${W}px`, height: "220px",
        background: `linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.4) 60%, ${BG} 100%)`,
      }),
      // FAMOU$ marca (canto)
      el({
        position: "absolute", top: "20px", left: "32px", padding: "6px 14px", borderRadius: "20px",
        background: "rgba(0,0,0,0.5)", fontSize: "14px", fontWeight: 900, letterSpacing: "3px", color: "white",
      }, "FAMOU$"),
      worldRank ? el({
        position: "absolute", top: "20px", right: "32px", padding: "6px 20px", borderRadius: "20px",
        background: "rgba(0,0,0,0.5)", fontSize: "16px", fontWeight: 700, color: "white",
      }, `${worldRank} mundial`) : null,
      // Avatar centralizado, sobrepondo banner
      picB64
        ? img(picB64, 140, 140, {
            position: "absolute", top: "148px", left: `${(W - 140) / 2}px`,
            borderRadius: "70px", border: "5px solid white", objectFit: "cover",
          })
        : el({
            position: "absolute", top: "148px", left: `${(W - 140) / 2}px`,
            width: "140px", height: "140px", borderRadius: "70px",
            border: "5px solid white", background: palette.base,
            alignItems: "center", justifyContent: "center", fontSize: "56px", fontWeight: 900, color: "white",
          }, (name[0]?.toUpperCase() ?? "?")),
    ],
  );

  // Nome + chips centralizados
  const nameSection = el(
    { flexDirection: "column", alignItems: "center", padding: "8px 40px" },
    [
      el({ fontSize: "46px", fontWeight: 900, color: TEXT, textAlign: "center" }, clip(name, 24)),
      chips.length
        ? el({ flexDirection: "row", flexWrap: "nowrap", marginTop: "12px", justifyContent: "center" },
            chips.map((c) => buildChip(c, { fontSize: "16px", padding: "5px 14px" })),
          )
        : null,
    ],
  );

  // Stats: 2 linhas × 2 colunas
  const statsGrid = el(
    { flexDirection: "row", flexWrap: "nowrap", gap: "12px", padding: "0 40px" },
    stats.map(([label, value]) =>
      el(
        { flex: 1, flexDirection: "column", background: CARD_BG, border: CARD_BORDER, borderRadius: "14px", padding: "14px 16px" },
        [
          el({ fontSize: "11px", fontWeight: 700, color: textRgba(0.65), letterSpacing: "2px" }, label),
          el({ fontSize: "26px", fontWeight: 900, marginTop: "4px", color: TEXT }, value),
        ],
      )
    ),
  );

  // Feed — 4 posts como cards
  const feedPosts = feedAll.slice(0, 4);
  const feedSection = feedPosts.length
    ? el(
        { flexDirection: "column", padding: "0 40px", gap: "10px" },
        [
          el({ fontSize: "13px", fontWeight: 700, color: textRgba(0.6), letterSpacing: "2px", marginBottom: "4px" }, "FEED"),
          ...feedPosts.map((f: N) => {
            const lines = wrapLines(f.text, 58, 2);
            return el(
              { flexDirection: "column", background: CARD_BG, border: CARD_BORDER, borderRadius: "14px", padding: "14px 18px" },
              [
                ...lines.map((l: string) => el({ fontSize: "18px", color: TEXT, whiteSpace: "nowrap" }, l)),
                (f.likes || f.comments || f.time)
                  ? el({ flexDirection: "row", marginTop: "8px", gap: "16px" },
                      [
                        f.likes ? el({ fontSize: "13px", color: textRgba(0.55) }, `★ ${f.likes}`) : null,
                        f.comments ? el({ fontSize: "13px", color: textRgba(0.55) }, `💬 ${f.comments}`) : null,
                        f.time ? el({ fontSize: "13px", color: textRgba(0.4), flex: 1, justifyContent: "flex-end" }, f.time) : null,
                      ],
                    )
                  : null,
              ],
            );
          }),
        ],
      )
    : null;

  // Top 3 tracks horizontal
  const topTracks = tracks.slice(0, 3);
  const tracksSection = topTracks.length
    ? el(
        { flexDirection: "column", padding: "0 40px" },
        [
          el({ fontSize: "13px", fontWeight: 700, color: textRgba(0.6), letterSpacing: "2px", marginBottom: "10px" }, "FAIXAS POPULARES"),
          el(
            { flexDirection: "row", gap: "12px" },
            topTracks.map((t: N) =>
              el(
                { flex: 1, flexDirection: "column", background: CARD_BG, border: CARD_BORDER, borderRadius: "14px", padding: "12px 14px", alignItems: "center" },
                [
                  t.coverB64 ? img(t.coverB64, 80, 80, { borderRadius: "10px", objectFit: "cover", marginBottom: "8px" }) : null,
                  el({ fontSize: "15px", fontWeight: 700, color: TEXT, textAlign: "center" }, clip(t.title, 18)),
                  el({ fontSize: "13px", color: textRgba(0.5), marginTop: "4px" }, t.streams),
                ],
              )
            ),
          ),
        ],
      )
    : null;

  const feedH = feedPosts.length * 80;
  const H = 320 + 120 + 90 + 20 + feedH + (tracksSection ? 140 : 0) + 40;

  return { markup: el(
    { width: `${W}px`, height: `${H}px`, background: BG, fontFamily: "Inter", flexDirection: "column" },
    [
      topSection,
      el({ height: "20px" }),
      nameSection,
      el({ height: "20px" }),
      statsGrid,
      el({ height: "20px" }),
      feedSection,
      el({ height: feedSection ? "20px" : "0px" }),
      tracksSection,
      el({ height: "40px" }),
    ],
  ), H };
}

// ─── LAYOUT: COMPACT ─────────────────────────────────────────────────
function buildCompactMarkup(): N {
  // W=900, H=480, side-by-side, sem covers, sem feed
  const H = 480;
  const BG = palette.darkest;
  const TEXT = "rgba(255,255,255,1)";
  const CARD_BG = palette.cardBg;
  const CARD_BORDER = palette.cardBorder;

  // Painel esquerdo (360px): avatar + nome + chips + bio
  const leftPanel = el(
    { width: "360px", flexDirection: "column", padding: "36px 32px", position: "relative", overflow: "hidden" },
    [
      // Gradiente de fundo do painel esquerdo
      el({
        position: "absolute", top: "0px", left: "0px", width: "360px", height: `${H}px`,
        background: palette.brand, opacity: 0.15,
      }),
      // Avatar
      picB64
        ? img(picB64, 120, 120, { borderRadius: "60px", border: "4px solid white", objectFit: "cover", marginBottom: "16px" })
        : el({
            width: "120px", height: "120px", borderRadius: "60px", border: "4px solid white",
            background: palette.base, alignItems: "center", justifyContent: "center",
            fontSize: "48px", fontWeight: 900, color: "white", marginBottom: "16px",
          }, (name[0]?.toUpperCase() ?? "?")),
      // Nome
      el({ fontSize: "38px", fontWeight: 900, color: TEXT, lineHeight: 1.1 }, clip(name, 16)),
      // Chips pequenos
      chips.length
        ? el({ flexDirection: "row", flexWrap: "wrap", marginTop: "12px", gap: "6px" },
            chips.slice(0, 3).map((c) => buildChip(c, { fontSize: "14px", padding: "4px 12px", marginRight: "0" })),
          )
        : null,
      // Bio
      bio
        ? el({ fontSize: "16px", color: textRgba(0.65), marginTop: "16px", lineHeight: 1.4 }, clip(bio, 80))
        : null,
    ],
  );

  // Divisor vertical
  const divider = el({
    width: "1px", alignSelf: "stretch", background: textRgba(0.12), margin: "32px 0",
  });

  // Painel direito: stats + tracks
  const rightPanel = el(
    { flex: 1, flexDirection: "column", padding: "36px 36px" },
    [
      // Stats 2×2
      el(
        { flexDirection: "row", gap: "12px", marginBottom: "24px" },
        stats.map(([label, value]) =>
          el(
            { flex: 1, flexDirection: "column", background: CARD_BG, border: CARD_BORDER, borderRadius: "12px", padding: "12px 14px" },
            [
              el({ fontSize: "10px", fontWeight: 700, color: textRgba(0.6), letterSpacing: "2px" }, label),
              el({ fontSize: "22px", fontWeight: 900, marginTop: "4px", color: TEXT }, value),
            ],
          )
        ),
      ),
      // Tracks sem capas
      el({ fontSize: "11px", fontWeight: 700, color: textRgba(0.55), letterSpacing: "2px", marginBottom: "10px" }, "FAIXAS POPULARES"),
      ...tracks.map((t: N, i: number) =>
        el(
          { flexDirection: "row", alignItems: "center", padding: "8px 0",
            borderBottom: i < tracks.length-1 ? `1px solid ${textRgba(0.08)}` : "none" },
          [
            el({ width: "24px", fontSize: "15px", fontWeight: 900, color: textRgba(0.5) }, String(t.pos)),
            el({ flex: 1, fontSize: "18px", fontWeight: 700, color: TEXT, whiteSpace: "nowrap", overflow: "hidden" }, clip(t.title, 28)),
            el({ fontSize: "14px", color: textRgba(0.55), minWidth: "90px", justifyContent: "flex-end" }, t.streams),
          ],
        )
      ),
      // FAMOU$ marca discreta no canto inferior
      el({ flex: 1 }),
      el({ flexDirection: "row", alignItems: "center", justifyContent: "flex-end" },
        [el({ fontSize: "11px", fontWeight: 900, color: textRgba(0.2), letterSpacing: "3px" }, "FAMOU$")]),
    ],
  );

  return { markup: el(
    { width: `${W}px`, height: `${H}px`, background: BG, fontFamily: "Inter", flexDirection: "row" },
    [leftPanel, divider, rightPanel],
  ), H };
}

// ─── Router de layouts ───────────────────────────────────────────────
function buildLayout(): { markup: N; H: number } {
  console.log(`🎨 Renderizando layout: ${layoutName}`);
  switch (layoutName) {
    case "midnight": return buildMidnightMarkup();
    case "social":   return buildSocialMarkup();
    case "compact":  return buildCompactMarkup();
    default:         return buildClassicMarkup();
  }
}

// ─── Render ──────────────────────────────────────────────────────────
const { markup, H } = buildLayout();

let svg: string;
try {
  svg = await satori(markup, { width: W, height: H, fonts });
} catch (e) {
  console.log("⚠️ Satori falhou com imagens, tentando sem nenhuma:", (e as Error).message);
  bannerB64 = "";
  picB64 = "";
  tracks.forEach((t: N) => (t.coverB64 = ""));
  const { markup: m2, H: h2 } = buildLayout();
  svg = await satori(m2, { width: W, height: h2, fonts });
}

const png = await svg2png(svg, { width: W, height: H });
console.log(`✅ PNG gerado (${layoutName}): ${png.byteLength} bytes`);

// ─── Envia pro Telegram ───────────────────────────────────────────────
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
