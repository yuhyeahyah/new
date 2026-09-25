// render.ts — card do /artista (4 layouts), roda no GitHub Actions com Deno
// Satori (layout) + svg2png-wasm (SVG -> PNG) -> Telegram sendPhoto
//
// A ALTURA DO CARD É AUTOMÁTICA: o Satori mede o conteúdo e a gente lê a
// altura do SVG gerado. Sem feed / sem bio / sem destaque / com menos faixas,
// o card simplesmente fica menor — nada corta e nada sobra vazio.
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
// Campos (todos opcionais, exceto name):
//   layout: classic | midnight | social | compact
//   name, banner, picture, bio, genre, nationality, label, residence,
//   worldRank, followers, listeners, salesRank, streamingRank,
//   tracks:   [{ pos, title, streams, cover?, album? }]
//   feed:     [{ text, likes?, comments?, time? }]  (ou lista de strings)
//   featured: { id, title, type?, cover? } | null
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
  // O Satori quebra ("reading 'trim'") se algum valor de estilo for undefined/null
  const st: Record<string, unknown> = { display: "flex" };
  for (const [k, v] of Object.entries(style)) {
    if (v !== undefined && v !== null) st[k] = v;
  }
  return { type: "div", props: { style: st, children: kids } };
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

// O Satori 0.10.3 não decodifica WEBP/AVIF. O imgur serve a mesma imagem
// em PNG/JPG só trocando a extensão, então reescrevemos essas URLs.
//   https://i.imgur.com/yF4TaaW_d.webp?maxwidth=760  ->  https://i.imgur.com/yF4TaaW.png
function normalizeImageUrl(url: string): string {
  const m = url.match(/^https?:\/\/i\.imgur\.com\/([A-Za-z0-9]+?)(?:_[a-z])?\.(webp|avif)(\?.*)?$/i);
  if (m) return `https://i.imgur.com/${m[1]}.png`;
  return url;
}

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

// Guarda os bytes brutos já baixados de cada URL (banner/foto), pra
// reaproveitar na extração de cor sem baixar a imagem de novo.
const rawImageBytes = new Map<string, Uint8Array>();

async function loadImageUncached(url: string, label: string): Promise<string> {
  const fixed = normalizeImageUrl(url);
  if (fixed !== url) console.log(`🔁 [${label}] URL reescrita: ${url} -> ${fixed}`);

  const got = await fetchImageBytes(fixed);
  if (!got) return "";

  if (got.buf.byteLength > 8_000_000) {
    console.log(`⚠️ imagem [${label}] grande demais (${got.buf.byteLength} bytes), ignorada`);
    return "";
  }

  rawImageBytes.set(url, got.buf);

  const sniffed = sniffMime(got.buf);
  if (sniffed === "image/webp" || sniffed === "image/avif") {
    console.log(`⚠️ [${label}] formato ${sniffed} não suportado pelo Satori, ignorada`);
    return "";
  }
  const mime = sniffed || got.type.split(";")[0].trim() || "image/png";
  console.log(
    `🖼️ [${label}] ${fixed} | real: ${sniffed || "?"} | header: ${got.type || "?"} | ${got.buf.byteLength} bytes`,
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
// Extração de cor dominante (banner > foto > nome)
// Reaproveita os bytes já baixados em `rawImageBytes`. Decodifica PNG e
// JPEG (baseline) manualmente, já que aqui não temos DOM/Canvas.
// -----------------------------------------------------------------

type DecodedImage = { pixels: Uint8Array; width: number; height: number };

// --- PNG ---------------------------------------------------------
async function decodePNG(pngBytes: Uint8Array): Promise<DecodedImage | null> {
  try {
    const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) {
      if (pngBytes[i] !== SIG[i]) {
        console.log("⚠️ Assinatura PNG inválida");
        return null;
      }
    }
    const view = new DataView(pngBytes.buffer, pngBytes.byteOffset);
    let offset = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    const idatChunks: Uint8Array[] = [];

    while (offset + 12 <= pngBytes.length) {
      const length = view.getUint32(offset);
      const type = String.fromCharCode(
        pngBytes[offset + 4],
        pngBytes[offset + 5],
        pngBytes[offset + 6],
        pngBytes[offset + 7],
      );
      const data = pngBytes.slice(offset + 8, offset + 8 + length);
      if (type === "IHDR") {
        width = view.getUint32(offset + 8);
        height = view.getUint32(offset + 12);
        bitDepth = data[8];
        colorType = data[9];
      } else if (type === "IDAT") {
        idatChunks.push(data);
      } else if (type === "IEND") {
        break;
      }
      offset += 12 + length;
    }

    if (!width || !height) return null;
    if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
      console.log(`⚠️ PNG não suportado: bitDepth=${bitDepth} colorType=${colorType}`);
      return null;
    }

    const totalLen = idatChunks.reduce((s, c) => s + c.length, 0);
    const idatData = new Uint8Array(totalLen);
    let pos = 0;
    for (const chunk of idatChunks) {
      idatData.set(chunk, pos);
      pos += chunk.length;
    }

    const ds = new DecompressionStream("deflate");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(idatData);
    writer.close();

    const decompChunks: Uint8Array[] = [];
    let done = false;
    while (!done) {
      const { value, done: d } = await reader.read();
      if (value) decompChunks.push(value);
      done = d;
    }
    const rawLen = decompChunks.reduce((s, c) => s + c.length, 0);
    const rawData = new Uint8Array(rawLen);
    pos = 0;
    for (const chunk of decompChunks) {
      rawData.set(chunk, pos);
      pos += chunk.length;
    }

    const bpp = colorType === 6 ? 4 : 3;
    const stride = width * bpp + 1;
    const pixels = new Uint8Array(width * height * 4);
    let prevRecon = new Uint8Array(width * bpp);

    for (let y = 0; y < height; y++) {
      const filterType = rawData[y * stride];
      const rawRow = rawData.subarray(y * stride + 1, y * stride + 1 + width * bpp);
      const recon = new Uint8Array(width * bpp);
      for (let x = 0; x < rawRow.length; x++) {
        const raw = rawRow[x];
        const av = x >= bpp ? recon[x - bpp] : 0;
        const bv = prevRecon[x] || 0;
        const cv = x >= bpp ? prevRecon[x - bpp] || 0 : 0;
        switch (filterType) {
          case 0:
            recon[x] = raw;
            break;
          case 1:
            recon[x] = (raw + av) & 255;
            break;
          case 2:
            recon[x] = (raw + bv) & 255;
            break;
          case 3:
            recon[x] = (raw + Math.floor((av + bv) / 2)) & 255;
            break;
          case 4: {
            const pa = Math.abs(bv - cv), pb = Math.abs(av - cv), pc = Math.abs(av + bv - 2 * cv);
            recon[x] = (raw + (pa <= pb && pa <= pc ? av : pb <= pc ? bv : cv)) & 255;
            break;
          }
          default:
            recon[x] = raw;
        }
      }
      for (let x = 0; x < width; x++) {
        const pi = (y * width + x) * 4;
        const ri = x * bpp;
        pixels[pi] = recon[ri];
        pixels[pi + 1] = recon[ri + 1];
        pixels[pi + 2] = recon[ri + 2];
        pixels[pi + 3] = bpp === 4 ? recon[ri + 3] : 255;
      }
      prevRecon = recon;
    }

    return { pixels, width, height };
  } catch (e) {
    console.log("⚠️ decodePNG erro:", (e as Error).message);
    return null;
  }
}

// --- JPEG (baseline, sem progressive) -----------------------------
function decodeJPEG(data: Uint8Array): DecodedImage | null {
  try {
    let offset = 0;
    const readUint16 = () => {
      const v = (data[offset] << 8) | data[offset + 1];
      offset += 2;
      return v;
    };

    if (readUint16() !== 0xffd8) return null; // SOI

    const qTables: Record<number, Int32Array> = {};
    let frame: {
      width: number;
      height: number;
      components: { id: number; h: number; v: number; qId: number }[];
    } | null = null;
    const huffmanTablesDC: Record<number, N> = {};
    const huffmanTablesAC: Record<number, N> = {};
    let scanData: Uint8Array | null = null;
    let scanComponents: { id: number; dcId: number; acId: number }[] = [];

    const buildHuffmanTable = (bits: Uint8Array, values: Uint8Array) => {
      let code = 0;
      const table: N = {};
      let k = 0;
      for (let i = 0; i < 16; i++) {
        for (let j = 0; j < bits[i]; j++) {
          table[`${i + 1}_${code}`] = values[k];
          code++;
          k++;
        }
        code <<= 1;
      }
      return { table, maxLen: 16 };
    };

    while (offset < data.length) {
      if (data[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = readUint16();

      if (marker === 0xffd9) break; // EOI
      if (marker === 0xff01 || (marker >= 0xffd0 && marker <= 0xffd7)) continue;

      const length = readUint16();
      const segStart = offset;

      if (marker === 0xffdb) {
        // DQT
        let p = segStart;
        const end = segStart + length - 2;
        while (p < end) {
          const pq = data[p] >> 4;
          const tq = data[p] & 15;
          p++;
          const table = new Int32Array(64);
          for (let i = 0; i < 64; i++) {
            if (pq === 0) {
              table[i] = data[p++];
            } else {
              table[i] = (data[p] << 8) | data[p + 1];
              p += 2;
            }
          }
          qTables[tq] = table;
        }
      } else if (marker === 0xffc0 || marker === 0xffc1) {
        // SOF0/1 - baseline
        let p = segStart;
        p++; // precision
        const height = (data[p] << 8) | data[p + 1];
        p += 2;
        const width = (data[p] << 8) | data[p + 1];
        p += 2;
        const numComponents = data[p];
        p++;
        const components = [];
        for (let i = 0; i < numComponents; i++) {
          const id = data[p];
          const hv = data[p + 1];
          const qId = data[p + 2];
          components.push({ id, h: hv >> 4, v: hv & 15, qId });
          p += 3;
        }
        frame = { width, height, components };
      } else if (marker === 0xffc2) {
        console.log("⚠️ JPEG progressivo não suportado");
        return null;
      } else if (marker === 0xffc4) {
        // DHT
        let p = segStart;
        const end = segStart + length - 2;
        while (p < end) {
          const tc = data[p] >> 4;
          const th = data[p] & 15;
          p++;
          const bits = data.slice(p, p + 16);
          p += 16;
          let total = 0;
          for (let i = 0; i < 16; i++) total += bits[i];
          const values = data.slice(p, p + total);
          p += total;
          const built = buildHuffmanTable(bits, values);
          if (tc === 0) huffmanTablesDC[th] = built;
          else huffmanTablesAC[th] = built;
        }
      } else if (marker === 0xffda) {
        // SOS
        let p = segStart;
        const ns = data[p];
        p++;
        scanComponents = [];
        for (let i = 0; i < ns; i++) {
          const id = data[p];
          const td = data[p + 1] >> 4;
          const ta = data[p + 1] & 15;
          scanComponents.push({ id, dcId: td, acId: ta });
          p += 2;
        }
        p += 3; // Ss, Se, AhAl
        let scanEnd = p;
        while (scanEnd < data.length - 1) {
          if (data[scanEnd] === 0xff) {
            const next = data[scanEnd + 1];
            if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) break;
          }
          scanEnd++;
        }
        scanData = data.slice(p, scanEnd);
        offset = scanEnd;
        break; // só precisamos do primeiro scan pra amostragem de cor
      }

      offset = segStart + length - 2;
    }

    if (!frame || !scanData) return null;

    return decodeJPEGApprox(frame, scanData, scanComponents, huffmanTablesDC, huffmanTablesAC, qTables);
  } catch (e) {
    console.log("⚠️ decodeJPEG erro:", (e as Error).message);
    return null;
  }
}

// Decodificador aproximado: extrai o coeficiente DC de cada bloco via Huffman
// e reconstrói uma imagem em baixa resolução (1 "pixel" por MCU).
function decodeJPEGApprox(
  frame: { width: number; height: number; components: { id: number; h: number; v: number; qId: number }[] },
  scanData: Uint8Array,
  scanComponents: { id: number; dcId: number; acId: number }[],
  huffDC: Record<number, N>,
  huffAC: Record<number, N>,
  qTables: Record<number, Int32Array>,
): DecodedImage | null {
  const cleaned: number[] = [];
  for (let i = 0; i < scanData.length; i++) {
    if (scanData[i] === 0xff && scanData[i + 1] === 0x00) {
      cleaned.push(0xff);
      i++;
    } else if (scanData[i] === 0xff && scanData[i + 1] >= 0xd0 && scanData[i + 1] <= 0xd7) {
      i++;
    } else {
      cleaned.push(scanData[i]);
    }
  }
  const bytes = new Uint8Array(cleaned);

  let bitPos = 0;
  const totalBits = bytes.length * 8;
  const readBit = (): number => {
    if (bitPos >= totalBits) return 0;
    const byteIdx = bitPos >> 3;
    const bitIdx = 7 - (bitPos & 7);
    bitPos++;
    return (bytes[byteIdx] >> bitIdx) & 1;
  };

  const decodeHuff = (table: N): number => {
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | readBit();
      const key = `${len}_${code}`;
      if (table.table[key] !== undefined) return table.table[key];
    }
    return 0;
  };

  const receive = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | readBit();
    return v;
  };

  const extend = (v: number, n: number): number => {
    if (n === 0) return 0;
    return v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
  };

  const hMax = Math.max(...frame.components.map((c) => c.h));
  const vMax = Math.max(...frame.components.map((c) => c.v));
  const mcuW = 8 * hMax;
  const mcuH = 8 * vMax;
  const mcusX = Math.ceil(frame.width / mcuW);
  const mcusY = Math.ceil(frame.height / mcuH);

  const dcPrev: Record<number, number> = {};
  for (const c of scanComponents) dcPrev[c.id] = 0;

  const ids = frame.components.map((c) => c.id).sort((x, y) => x - y);
  const yId = ids[0];
  const cbId = ids[1];
  const crId = ids[2];

  const pixels = new Uint8Array(mcusX * mcusY * 4);
  let samplesWritten = 0;

  outer:
  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      let yDcSum = 0, yDcCount = 0;
      let cbDc = 0, crDc = 0;
      let gotCb = false, gotCr = false;

      for (const comp of frame.components) {
        const sc = scanComponents.find((s) => s.id === comp.id);
        if (!sc) continue;
        const dcTable = huffDC[sc.dcId];
        const acTable = huffAC[sc.acId];
        if (!dcTable || !acTable) break outer;

        for (let by = 0; by < comp.v; by++) {
          for (let bx = 0; bx < comp.h; bx++) {
            const t = decodeHuff(dcTable);
            const diff = t === 0 ? 0 : extend(receive(t), t);
            dcPrev[comp.id] += diff;
            const q = qTables[comp.qId];
            const dcValue = (dcPrev[comp.id] * (q ? q[0] : 1)) / 8;

            if (comp.id === yId) {
              yDcSum += dcValue;
              yDcCount++;
            } else if (comp.id === cbId) {
              cbDc = dcValue;
              gotCb = true;
            } else if (comp.id === crId) {
              crDc = dcValue;
              gotCr = true;
            }

            // Consome os coeficientes AC pra manter o bitstream sincronizado
            let k = 1;
            while (k < 64) {
              const rs = decodeHuff(acTable);
              const r = rs >> 4;
              const s = rs & 15;
              if (s === 0) {
                if (r === 15) {
                  k += 16;
                  continue;
                }
                break; // EOB
              }
              k += r;
              extend(receive(s), s);
              k++;
            }
          }
        }
      }

      if (yDcCount > 0) {
        const yAvg = yDcSum / yDcCount + 128;
        const cbAvg = gotCb ? cbDc + 128 : 128;
        const crAvg = gotCr ? crDc + 128 : 128;

        const r = clamp255(yAvg + 1.402 * (crAvg - 128));
        const g = clamp255(yAvg - 0.344136 * (cbAvg - 128) - 0.714136 * (crAvg - 128));
        const b = clamp255(yAvg + 1.772 * (cbAvg - 128));

        const pi = (my * mcusX + mx) * 4;
        pixels[pi] = r;
        pixels[pi + 1] = g;
        pixels[pi + 2] = b;
        pixels[pi + 3] = 255;
        samplesWritten++;
      }

      if (bitPos >= totalBits) break outer;
    }
  }

  if (!samplesWritten) return null;

  console.log(`🧩 JPEG decodificado por blocos: ${mcusX}x${mcusY} amostras (${samplesWritten} válidas)`);
  return { pixels, width: mcusX, height: mcusY };
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

// --- Seleção da cor dominante a partir dos pixels decodificados ---
function extractDominantFromPixels(
  pixels: Uint8Array,
): { r: number; g: number; b: number; saturation: number } | null {
  const QUANT_SHIFT = 3;
  const MIN_SAT = 0.22;
  const MIN_BRIGHT = 10;
  const MAX_BRIGHT = 245;
  const TOP_N = 10;

  const buckets = new Map<number, number>();
  const bucketSum = new Map<number, { r: number; g: number; b: number; n: number }>();

  for (let i = 0; i < pixels.length; i += 4) {
    const r2 = pixels[i], g2 = pixels[i + 1], b2 = pixels[i + 2], a2 = pixels[i + 3];
    if (a2 < 200) continue;

    const brightness = (r2 + g2 + b2) / 3;
    if (brightness < MIN_BRIGHT || brightness > MAX_BRIGHT) continue;

    const rn = r2 / 255, gn = g2 / 255, bn = b2 / 255;
    const max2 = Math.max(rn, gn, bn), min2 = Math.min(rn, gn, bn);
    const l = (max2 + min2) / 2;
    const s = max2 === min2 ? 0 : l > 0.5 ? (max2 - min2) / (2 - max2 - min2) : (max2 - min2) / (max2 + min2);
    if (s < MIN_SAT) continue;

    const key = ((r2 >> QUANT_SHIFT) << 16) | ((g2 >> QUANT_SHIFT) << 8) | (b2 >> QUANT_SHIFT);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
    const prev = bucketSum.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    bucketSum.set(key, { r: prev.r + r2, g: prev.g + g2, b: prev.b + b2, n: prev.n + 1 });
  }

  if (buckets.size === 0) return null;

  const sorted = Array.from(buckets.entries()).sort((a2, b2) => b2[1] - a2[1]);
  const candidates = sorted.slice(0, Math.min(TOP_N, sorted.length));

  let bestKey = candidates[0][0];
  let bestScore = -Infinity;
  for (const [k, count] of candidates) {
    const sum2 = bucketSum.get(k)!;
    const rr = sum2.r / sum2.n, gg = sum2.g / sum2.n, bb = sum2.b / sum2.n;
    const max2 = Math.max(rr, gg, bb) / 255, min2 = Math.min(rr, gg, bb) / 255;
    const lv2 = (max2 + min2) / 2;
    const sat2 = max2 === min2 ? 0 : lv2 > 0.5 ? (max2 - min2) / (2 - max2 - min2) : (max2 - min2) / (max2 + min2);
    const score = sat2 * 100 + Math.log(count + 1) * 2;
    if (score > bestScore) {
      bestScore = score;
      bestKey = k;
    }
  }

  const sum = bucketSum.get(bestKey)!;
  const r = Math.round(sum.r / sum.n);
  const g = Math.round(sum.g / sum.n);
  const b = Math.round(sum.b / sum.n);
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
  const lv = (max + min) / 2;
  const sat = max === min ? 0 : lv > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);

  return { r, g, b, saturation: sat };
}

// --- Fallback determinístico a partir do nome ---
function generateColorFromName(name: string): string {
  let hash1 = 0, hash2 = 0;
  for (let i = 0; i < name.length; i++) {
    hash1 = (hash1 << 5) - hash1 + name.charCodeAt(i);
    hash1 |= 0;
    hash2 = (hash2 << 3) + hash2 + name.charCodeAt(i);
    hash2 |= 0;
  }
  const hue = Math.abs((hash1 + hash2) % 360);
  const saturation = 70 + Math.abs(hash1 % 25);
  const lightness = 48 + Math.abs(hash2 % 14);
  const h = hue / 360, s = saturation / 100, l = lightness / 100;
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p2: number, q2: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p2 + (q2 - p2) * 6 * t;
      if (t < 1 / 2) return q2;
      if (t < 2 / 3) return p2 + (q2 - p2) * (2 / 3 - t) * 6;
      return p2;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m
    ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
    : { r: 61, g: 22, b: 112 };
}

async function extractColorFromBytes(url: string): Promise<string | null> {
  const buf = rawImageBytes.get(url);
  if (!buf) {
    console.log(`⚠️ Sem bytes em cache para ${url}, não dá pra extrair cor`);
    return null;
  }

  const mime = sniffMime(buf);
  let decoded: DecodedImage | null = null;

  console.log(`🔬 Decodificando [${mime || "formato desconhecido"}] ${url} (${buf.byteLength} bytes)`);

  if (mime === "image/png") decoded = await decodePNG(buf);
  else if (mime === "image/jpeg") decoded = decodeJPEG(buf);
  else {
    console.log(`⚠️ Formato [${mime || "desconhecido"}] sem decoder de cor, pulando`);
    return null;
  }

  if (!decoded) {
    console.log(`⚠️ Decodificação falhou para ${url}`);
    return null;
  }

  const best = extractDominantFromPixels(decoded.pixels);
  if (!best) {
    console.log(`⚠️ Nenhum pixel suficientemente saturado em ${url}`);
    return null;
  }

  const MIN_USABLE_SAT = 0.12;
  if (best.saturation < MIN_USABLE_SAT) {
    console.log(`🚫 Imagem praticamente sem cor (sat: ${(best.saturation * 100).toFixed(1)}%), descartando`);
    return null;
  }

  let { r, g, b, saturation } = best;
  const BOOST_THRESHOLD = 0.22;
  if (saturation < BOOST_THRESHOLD) {
    const strength = 1 - saturation / BOOST_THRESHOLD;
    const boost = Math.round(12 + strength * 23);
    const cut = Math.round(4 + strength * 8);
    if (r >= g && r >= b) {
      r = Math.min(255, r + boost);
      g = Math.max(0, g - cut);
      b = Math.max(0, b - cut);
    } else if (g >= r && g >= b) {
      g = Math.min(255, g + boost);
      r = Math.max(0, r - cut);
      b = Math.max(0, b - cut);
    } else {
      b = Math.min(255, b + boost);
      r = Math.max(0, r - cut);
      g = Math.max(0, g - cut);
    }
  }

  const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  console.log(`✅ Cor final extraída de ${url}: ${hex}`);
  return hex;
}

async function extractDominantColor(bannerUrl: string, pictureUrl: string, name: string): Promise<string> {
  if (bannerUrl) {
    const c = await extractColorFromBytes(bannerUrl);
    if (c) return c;
  }
  if (pictureUrl && pictureUrl !== bannerUrl) {
    const c = await extractColorFromBytes(pictureUrl);
    if (c) return c;
  }
  const fallback = generateColorFromName(name);
  console.log(`🏁 Cor gerada pelo nome "${name}": ${fallback}`);
  return fallback;
}

// -----------------------------------------------------------------
// Paleta
// -----------------------------------------------------------------
type Palette = {
  base: string;
  darker: string;
  darkest: string;
  brand: string;
  cardBg: string;
  cardBorder: string;
  isLight: boolean;
};

function generatePalette(color: string): Palette {
  const rgb = hexToRgb(color);
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  const isLight = luminance > 0.55;

  const FULL_DARKER = 0.72;
  const FULL_DARKEST = 0.5;
  const scaleDarker = FULL_DARKER + (1 - FULL_DARKER) * luminance;
  const scaleDarkest = FULL_DARKEST + (1 - FULL_DARKEST) * luminance;

  const darker = {
    r: Math.round(rgb.r * scaleDarker),
    g: Math.round(rgb.g * scaleDarker),
    b: Math.round(rgb.b * scaleDarker),
  };
  const darkest = {
    r: Math.round(rgb.r * scaleDarkest),
    g: Math.round(rgb.g * scaleDarkest),
    b: Math.round(rgb.b * scaleDarkest),
  };
  const brandEnd = { r: Math.max(0, rgb.r - 60), g: Math.max(0, rgb.g - 20), b: Math.min(255, rgb.b + 50) };

  const cardBg = isLight
    ? `rgba(${Math.round(rgb.r * 0.35)}, ${Math.round(rgb.g * 0.35)}, ${Math.round(rgb.b * 0.35)}, 0.55)`
    : `rgba(${Math.min(255, rgb.r + 20)}, ${Math.min(255, rgb.g + 20)}, ${Math.min(255, rgb.b + 20)}, 0.10)`;
  const cardBorder = isLight
    ? `1px solid rgba(${Math.round(rgb.r * 0.5)}, ${Math.round(rgb.g * 0.5)}, ${Math.round(rgb.b * 0.5)}, 0.35)`
    : `1px solid rgba(${Math.min(255, rgb.r + 40)}, ${Math.min(255, rgb.g + 40)}, ${Math.min(255, rgb.b + 40)}, 0.18)`;

  return {
    base: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
    darker: `rgb(${darker.r}, ${darker.g}, ${darker.b})`,
    darkest: `rgb(${darkest.r}, ${darkest.g}, ${darkest.b})`,
    brand: `linear-gradient(90deg, rgb(${rgb.r}, ${rgb.g}, ${rgb.b}) 0%, rgb(${brandEnd.r}, ${brandEnd.g}, ${brandEnd.b}) 100%)`,
    cardBg,
    cardBorder,
    isLight,
  };
}

// -----------------------------------------------------------------
// Dados normalizados
// -----------------------------------------------------------------
const LAYOUT_IDS = ["classic", "midnight", "social", "compact"];
const layoutName: string = LAYOUT_IDS.includes(clean(a.layout)) ? clean(a.layout) : "classic";
const W_MAP: Record<string, number> = { classic: 1200, midnight: 1200, social: 1080, compact: 900 };
const W = W_MAP[layoutName];

const name = clean(a.name) || "Artista";
const worldRank = clean(a.worldRank);
const bioFull = clean(a.bio);

const chips = [a.genre, a.nationality, a.label, a.residence ? `Reside em ${clean(a.residence)}` : ""]
  .map(clean)
  .filter(Boolean);

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

const feedAll: N[] = (Array.isArray(a.feed) ? a.feed : [])
  .map((f: N) =>
    typeof f === "string"
      ? { text: clean(f), likes: "", comments: "", time: "" }
      : {
        text: clean(f?.text ?? f?.content ?? ""),
        likes: clean(f?.likes ?? ""),
        comments: clean(f?.comments ?? ""),
        time: clean(f?.time ?? f?.date ?? ""),
      }
  )
  .filter((f: N) => f.text && f.text.length >= 4);

const featured: N = a.featured && clean(a.featured.title)
  ? {
    title: clean(a.featured.title),
    type: clean(a.featured.type),
    cover: String(a.featured.cover ?? ""),
    coverB64: "",
  }
  : null;

console.log(
  `📦 layout=${layoutName} | faixas=${tracks.length} | feed=${feedAll.length} | destaque=${featured ? featured.title : "-"} | bio=${bioFull ? "sim" : "não"}`,
);

// -----------------------------------------------------------------
// Imagens (banner, foto, capas, destaque) em paralelo
// -----------------------------------------------------------------
const bannerUrl = String(a.banner ?? "");
const pictureUrl = String(a.picture ?? "");
const needsTrackCovers = layoutName === "classic" || layoutName === "social";

let [bannerB64, picB64] = await Promise.all([
  loadImage(bannerUrl, "banner"),
  loadImage(pictureUrl, "foto"),
]);

await Promise.all([
  ...(needsTrackCovers
    ? tracks.map(async (t: N, i: number) => {
      t.coverB64 = await loadImage(t.cover, `capa ${i + 1}`);
    })
    : []),
  featured
    ? (async () => {
      featured.coverB64 = await loadImage(featured.cover, "destaque");
    })()
    : Promise.resolve(),
]);

const dominantColor = await extractDominantColor(bannerUrl, pictureUrl, name);
const palette = generatePalette(dominantColor);
const ACC = hexToRgb(dominantColor);

function accent(alpha: number): string {
  return `rgba(${ACC.r}, ${ACC.g}, ${ACC.b}, ${alpha})`;
}
function textRgba(alpha: number): string {
  return `rgba(255, 255, 255, ${alpha})`;
}

// -----------------------------------------------------------------
// Peças reutilizáveis
// -----------------------------------------------------------------

// Chip: fundo escuro semi-opaco, sempre legível (inclusive em fundo claro)
function buildChip(text: string, over: Record<string, unknown> = {}): N {
  return el({
    fontSize: "18px",
    fontWeight: 700,
    padding: "6px 16px",
    borderRadius: "20px",
    background: "rgba(0,0,0,0.48)",
    color: "white",
    marginRight: "10px",
    ...over,
  }, text);
}

// Capa ou quadrado com a inicial (mantém o alinhamento quando a capa falha)
function coverBox(b64: string, size: number, radius: number, label: string, over: Record<string, unknown> = {}): N {
  if (b64) return img(b64, size, size, { borderRadius: `${radius}px`, objectFit: "cover", ...over });
  return el({
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: `${radius}px`,
    background: textRgba(0.1),
    alignItems: "center",
    justifyContent: "center",
    fontSize: `${Math.round(size * 0.4)}px`,
    fontWeight: 900,
    color: textRgba(0.45),
    ...over,
  }, (label[0] || "?").toUpperCase());
}

function avatar(size: number, borderCss: string, over: Record<string, unknown> = {}): N {
  if (picB64) {
    return img(picB64, size, size, { borderRadius: `${size / 2}px`, border: borderCss, objectFit: "cover", ...over });
  }
  return el({
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: `${size / 2}px`,
    border: borderCss,
    background: palette.base,
    alignItems: "center",
    justifyContent: "center",
    fontSize: `${Math.round(size * 0.4)}px`,
    fontWeight: 900,
    color: "white",
    ...over,
  }, name[0]?.toUpperCase() ?? "?");
}

// Linha "82,074 curtidas • 20,155 comentários • 78 dias atrás"
function feedMeta(f: N, size = 13, alpha = 0.55): N {
  const parts = [
    f.likes ? `${f.likes} curtidas` : "",
    f.comments ? `${f.comments} comentários` : "",
    f.time,
  ].filter(Boolean);
  if (!parts.length) return null;
  return el({ fontSize: `${size}px`, color: textRgba(alpha), marginTop: "8px" }, parts.join("  •  "));
}

function sectionLabel(text: string, color: string, over: Record<string, unknown> = {}): N {
  return el({ fontSize: "13px", fontWeight: 700, color, letterSpacing: "2px", marginBottom: "12px", ...over }, text);
}

function typeTag(text: string, bg: string): N {
  return text
    ? el({
      fontSize: "12px",
      fontWeight: 700,
      letterSpacing: "1px",
      padding: "4px 10px",
      borderRadius: "10px",
      background: bg,
      marginTop: "8px",
      alignSelf: "flex-start",
    }, text.toUpperCase())
    : null;
}

function statBoxes(
  list: [string, string][],
  opts: { bg: string; border: string; labelColor: string; valueSize: number; labelSize: number; pad: string },
): N[] {
  return list.map(([label, value]) =>
    el(
      { flex: 1, flexDirection: "column", background: opts.bg, border: opts.border, borderRadius: "16px", padding: opts.pad },
      [
        el({ fontSize: `${opts.labelSize}px`, fontWeight: 700, color: opts.labelColor, letterSpacing: "2px" }, label),
        el({ fontSize: `${opts.valueSize}px`, fontWeight: 900, marginTop: "4px", color: "white" }, value),
      ],
    )
  );
}

// ═════════════════════════════════════════════════════════════════
// LAYOUT: CLASSIC (1200)
// Destaque = faixa larga logo abaixo da bio.
// Faixas à esquerda + feed à direita; sem feed -> faixas na largura toda.
// ═════════════════════════════════════════════════════════════════
function buildClassic(): N {
  const BG = palette.darkest;
  const CARD_BG = palette.cardBg;
  const CARD_BORDER = palette.cardBorder;
  const hasFeed = feedAll.length > 0;
  const bio = clip(bioFull, 95);

  const header = el({ position: "relative", width: `${W}px`, height: "340px" }, [
    el(
      { position: "absolute", top: "0px", left: "0px", width: `${W}px`, height: "250px", background: palette.brand, overflow: "hidden" },
      bannerB64 ? img(bannerB64, W, 250, { objectFit: "cover" }) : null,
    ),
    el({
      position: "absolute", top: "0px", left: "0px", width: `${W}px`, height: "250px",
      background: `linear-gradient(to bottom, rgba(0,0,0,0.08) 0%, rgba(0,0,0,0.55) 55%, ${BG} 100%)`,
    }),
    el({
      position: "absolute", top: "28px", left: "40px", padding: "8px 18px", borderRadius: "30px",
      background: "rgba(0,0,0,0.45)", fontSize: "16px", fontWeight: 900, letterSpacing: "3px", color: "white",
    }, "FAMOU$"),
    worldRank
      ? el({
        position: "absolute", top: "28px", right: "40px", padding: "10px 26px", borderRadius: "50px",
        background: "rgba(0,0,0,0.5)", fontSize: "22px", fontWeight: 700, color: "white",
      }, `${worldRank} mundial`)
      : null,
    avatar(170, "6px solid white", { position: "absolute", top: "150px", left: "60px" }),
    el({
      position: "absolute", top: "166px", left: "262px", width: `${W - 320}px`,
      fontSize: "56px", fontWeight: 900, color: "white",
    }, clip(name, 26)),
    chips.length
      ? el({ position: "absolute", top: "252px", left: "262px", flexDirection: "row" }, chips.map((c) => buildChip(c)))
      : null,
  ]);

  const statsRow = el(
    { flexDirection: "row", gap: "16px" },
    statBoxes(stats, { bg: CARD_BG, border: CARD_BORDER, labelColor: textRgba(0.7), valueSize: 30, labelSize: 12, pad: "14px 20px" }),
  );

  const bioBar = bio
    ? el(
      { flexDirection: "row", alignItems: "center", background: CARD_BG, border: CARD_BORDER, borderRadius: "16px", padding: "12px 22px" },
      [
        el({ width: "4px", height: "24px", borderRadius: "2px", background: palette.base, marginRight: "16px" }),
        el({ flex: 1, fontSize: "21px", whiteSpace: "nowrap", overflow: "hidden" }, bio),
      ],
    )
    : null;

  const anyCover = tracks.some((t: N) => t.coverB64);
  const titleMax = hasFeed ? 26 : 46;

  const trackRow = (t: N, i: number) =>
    el({ flexDirection: "row", alignItems: "center", height: "56px", marginTop: i ? "8px" : "0px" }, [
      el({ width: "34px", fontSize: "20px", fontWeight: 900, color: textRgba(0.6) }, String(t.pos)),
      anyCover ? coverBox(t.coverB64, 50, 10, t.title, { marginRight: "14px" }) : null,
      el({ flex: 1, flexDirection: "column", overflow: "hidden" }, [
        el({ fontSize: "20px", fontWeight: 700, whiteSpace: "nowrap" }, clip(t.title, titleMax)),
        t.album ? el({ fontSize: "14px", color: textRgba(0.6), marginTop: "2px", whiteSpace: "nowrap" }, clip(t.album, 36)) : null,
      ]),
      el({ width: "150px", justifyContent: "flex-end", fontSize: "18px" }, t.streams),
    ]);

  const tracksCard = tracks.length
    ? el(
      { flex: 1, flexDirection: "column", background: CARD_BG, border: CARD_BORDER, borderRadius: "20px", padding: "20px 26px", overflow: "hidden" },
      [sectionLabel("FAIXAS POPULARES", textRgba(0.65)), ...tracks.map(trackRow)],
    )
    : null;

  // Se o destaque também está nas faixas populares, mostra posição e streams
  const featTrack = featured
    ? tracks.find((t: N) => t.title.toLowerCase() === featured.title.toLowerCase())
    : null;

  const featuredBanner = featured
    ? el(
      { flexDirection: "row", background: CARD_BG, border: CARD_BORDER, borderRadius: "20px", overflow: "hidden" },
      [
        el({ width: "6px", background: palette.base }),
        el(
          {
            flex: 1, flexDirection: "row", alignItems: "center", padding: "18px 26px 18px 20px",
            background: "linear-gradient(90deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0) 70%)",
          },
          [
            coverBox(featured.coverB64, 104, 14, featured.title, { marginRight: "22px", border: "3px solid rgba(255,255,255,0.85)" }),
            el({ flex: 1, flexDirection: "column", overflow: "hidden" }, [
              el({ fontSize: "12px", fontWeight: 700, letterSpacing: "3px", color: textRgba(0.7) }, "DESTAQUE DO ARTISTA"),
              el({ fontSize: "36px", fontWeight: 900, marginTop: "2px", whiteSpace: "nowrap" }, clip(featured.title, 34)),
              el({ flexDirection: "row", alignItems: "center" }, [
                typeTag(featured.type, "rgba(0,0,0,0.35)"),
                featTrack
                  ? el({ fontSize: "14px", fontWeight: 700, color: textRgba(0.75), marginTop: "8px", marginLeft: featured.type ? "12px" : "0px" },
                    `#${featTrack.pos} nas faixas populares`)
                  : null,
              ]),
            ]),
            featTrack && featTrack.streams
              ? el({ flexDirection: "column", alignItems: "flex-end", marginLeft: "20px" }, [
                el({ fontSize: "12px", fontWeight: 700, letterSpacing: "2px", color: textRgba(0.6) }, "STREAMS"),
                el({ fontSize: "30px", fontWeight: 900, marginTop: "2px" }, featTrack.streams),
              ])
              : null,
          ],
        ),
      ],
    )
    : null;

  const posts = feedAll.slice(0, 3);
  const feedCard = posts.length
    ? el(
      { flex: 1, flexDirection: "column", background: CARD_BG, border: CARD_BORDER, borderRadius: "20px", padding: "20px 22px", overflow: "hidden" },
      [
        sectionLabel("FEED", textRgba(0.65)),
        ...posts.flatMap((f: N, i: number) => [
          i ? el({ height: "1px", background: textRgba(0.12), marginTop: "14px", marginBottom: "14px" }) : null,
          el({ flexDirection: "column" }, [
            ...wrapLines(f.text, 34, 3).map((l) => el({ fontSize: "17px", lineHeight: 1.35, whiteSpace: "nowrap" }, l)),
            feedMeta(f),
          ]),
        ]),
      ],
    )
    : null;

  // Coluna do feed só existe se houver feed; sem faixas, o feed ocupa tudo
  const feedCol = feedCard
    ? el(tracks.length ? { width: "400px", flexDirection: "column" } : { flex: 1, flexDirection: "column" }, [feedCard])
    : null;

  const columns = tracksCard || feedCol ? el({ flexDirection: "row", gap: "20px" }, [tracksCard, feedCol]) : null;

  return el(
    { width: `${W}px`, background: BG, color: "white", fontFamily: "Inter", flexDirection: "column" },
    [
      header,
      el({ flexDirection: "column", padding: "6px 60px 40px 60px", gap: "18px" }, [statsRow, bioBar, featuredBanner, columns]),
    ],
  );
}

// ═════════════════════════════════════════════════════════════════
// LAYOUT: MIDNIGHT (1200) — fundo sempre escuro, cor do artista como acento
// ═════════════════════════════════════════════════════════════════
function buildMidnight(): N {
  const BG = "#0c0c14";
  const CARD_BG = "rgba(255,255,255,0.05)";
  const CARD_BORDER = `1px solid ${accent(0.35)}`;
  const ACCENT = palette.base;
  const PAD = 60;
  const INNER = W - PAD * 2;
  const bio = clip(bioFull, 110);

  const headerBanner = el({ position: "relative", width: `${W}px`, height: "300px" }, [
    el(
      { position: "absolute", top: "0px", left: "0px", width: `${W}px`, height: "300px", background: palette.brand, overflow: "hidden" },
      bannerB64 ? img(bannerB64, W, 300, { objectFit: "cover", opacity: 0.6 }) : null,
    ),
    el({
      position: "absolute", top: "0px", left: "0px", width: `${W}px`, height: "300px",
      background: `linear-gradient(to bottom, rgba(0,0,0,0.25) 0%, rgba(12,12,20,0.9) 70%, ${BG} 100%)`,
    }),
    el({
      position: "absolute", top: "24px", left: "40px", padding: "8px 18px", borderRadius: "30px",
      background: accent(0.3), border: `1px solid ${accent(0.7)}`,
      fontSize: "16px", fontWeight: 900, letterSpacing: "3px", color: "white",
    }, "FAMOU$"),
    worldRank
      ? el({
        position: "absolute", top: "24px", right: "40px", padding: "10px 26px", borderRadius: "50px",
        background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.2)",
        fontSize: "22px", fontWeight: 700, color: "white",
      }, `${worldRank} mundial`)
      : null,
  ]);

  const avatarSection = el(
    { flexDirection: "row", alignItems: "flex-end", padding: `0 ${PAD}px`, marginTop: "-80px", marginBottom: "22px" },
    [
      avatar(160, `4px solid ${ACCENT}`),
      el({ flex: 1, flexDirection: "column", marginLeft: "28px", paddingBottom: "8px" }, [
        el({ fontSize: "52px", fontWeight: 900, color: "white", lineHeight: 1.1 }, clip(name, 24)),
        chips.length
          ? el(
            { flexDirection: "row", marginTop: "12px" },
            chips.map((c) => buildChip(c, { background: accent(0.25), border: `1px solid ${accent(0.6)}` })),
          )
          : null,
      ]),
    ],
  );

  const statsRow = el(
    { flexDirection: "row", gap: "14px" },
    statBoxes(stats, { bg: CARD_BG, border: CARD_BORDER, labelColor: ACCENT, valueSize: 28, labelSize: 11, pad: "16px 20px" }),
  );

  const bioLine = bio ? el({ fontSize: "19px", color: textRgba(0.7) }, `"${bio}"`) : null;

  const featuredRow = featured
    ? el(
      {
        flexDirection: "row", alignItems: "center", borderRadius: "18px", padding: "18px 22px",
        background: `linear-gradient(90deg, ${accent(0.22)} 0%, rgba(255,255,255,0.03) 100%)`,
        border: `1px solid ${accent(0.45)}`,
      },
      [
        coverBox(featured.coverB64, 100, 14, featured.title, { marginRight: "22px", border: `2px solid ${accent(0.8)}` }),
        el({ flex: 1, flexDirection: "column" }, [
          el({ fontSize: "12px", fontWeight: 700, letterSpacing: "3px", color: ACCENT }, "DESTAQUE"),
          el({ fontSize: "32px", fontWeight: 900, color: "white", marginTop: "4px" }, clip(featured.title, 40)),
          typeTag(featured.type, accent(0.3)),
        ]),
      ],
    )
    : null;

  // Feed em grade de 2 colunas (cards da mesma linha ficam com a mesma altura)
  const posts = feedAll.slice(0, 4);
  const colW = Math.floor((INNER - 14) / 2);
  const postCard = (f: N) =>
    el(
      { width: `${colW}px`, flexDirection: "row", background: CARD_BG, border: CARD_BORDER, borderRadius: "12px", overflow: "hidden" },
      [
        el({ width: "4px", background: ACCENT }),
        el({ flex: 1, flexDirection: "column", padding: "14px 18px" }, [
          ...wrapLines(f.text, 46, 3).map((l) => el({ fontSize: "17px", lineHeight: 1.35, color: "white", whiteSpace: "nowrap" }, l)),
          feedMeta(f, 13, 0.5),
        ]),
      ],
    );
  const feedRows: N[] = [];
  for (let i = 0; i < posts.length; i += 2) {
    feedRows.push(el({ flexDirection: "row", gap: "14px" }, [postCard(posts[i]), posts[i + 1] ? postCard(posts[i + 1]) : null]));
  }
  const feedSection = posts.length
    ? el({ flexDirection: "column", gap: "14px" }, [sectionLabel("FEED", ACCENT, { marginBottom: "0px" }), ...feedRows])
    : null;

  const tracksSection = tracks.length
    ? el({ flexDirection: "column" }, [
      sectionLabel("FAIXAS POPULARES", ACCENT),
      ...tracks.map((t: N, i: number) =>
        el(
          {
            flexDirection: "row", alignItems: "center", padding: "10px 0",
            borderBottom: i < tracks.length - 1 ? "1px solid rgba(255,255,255,0.06)" : "none",
          },
          [
            el({ width: "30px", fontSize: "16px", fontWeight: 900, color: ACCENT }, String(t.pos)),
            el({ flex: 1, flexDirection: "column" }, [
              el({ fontSize: "19px", fontWeight: 700, color: "white", whiteSpace: "nowrap" }, clip(t.title, 50)),
              t.album ? el({ fontSize: "13px", color: textRgba(0.5), marginTop: "2px" }, clip(t.album, 50)) : null,
            ]),
            el({ fontSize: "17px", color: textRgba(0.7), justifyContent: "flex-end" }, t.streams),
          ],
        )
      ),
    ])
    : null;

  return el(
    { width: `${W}px`, background: BG, color: "white", fontFamily: "Inter", flexDirection: "column" },
    [
      headerBanner,
      avatarSection,
      el({ flexDirection: "column", padding: `0 ${PAD}px 44px ${PAD}px`, gap: "22px" }, [
        statsRow,
        bioLine,
        featuredRow,
        feedSection,
        tracksSection,
      ]),
    ],
  );
}

// ═════════════════════════════════════════════════════════════════
// LAYOUT: SOCIAL (1080) — centralizado, feed em destaque
// ═════════════════════════════════════════════════════════════════
function buildSocial(): N {
  const BG = palette.darkest;
  const CARD_BG = palette.cardBg;
  const CARD_BORDER = palette.cardBorder;
  const PAD = 40;
  const INNER = W - PAD * 2;

  const topSection = el({ position: "relative", width: `${W}px`, height: "300px" }, [
    el(
      { position: "absolute", top: "0px", left: "0px", width: `${W}px`, height: "220px", background: palette.brand, overflow: "hidden" },
      bannerB64 ? img(bannerB64, W, 220, { objectFit: "cover" }) : null,
    ),
    el({
      position: "absolute", top: "0px", left: "0px", width: `${W}px`, height: "220px",
      background: `linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.4) 60%, ${BG} 100%)`,
    }),
    el({
      position: "absolute", top: "20px", left: "32px", padding: "6px 14px", borderRadius: "20px",
      background: "rgba(0,0,0,0.5)", fontSize: "14px", fontWeight: 900, letterSpacing: "3px", color: "white",
    }, "FAMOU$"),
    worldRank
      ? el({
        position: "absolute", top: "20px", right: "32px", padding: "6px 20px", borderRadius: "20px",
        background: "rgba(0,0,0,0.5)", fontSize: "16px", fontWeight: 700, color: "white",
      }, `${worldRank} mundial`)
      : null,
    avatar(140, "5px solid white", { position: "absolute", top: "148px", left: `${(W - 140) / 2}px` }),
  ]);

  const nameSection = el({ flexDirection: "column", alignItems: "center", padding: `0 ${PAD}px` }, [
    el({ fontSize: "46px", fontWeight: 900, color: "white" }, clip(name, 26)),
    chips.length
      ? el(
        { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", marginTop: "12px" },
        chips.map((c) => buildChip(c, { fontSize: "16px", padding: "5px 14px", marginRight: "5px", marginLeft: "5px", marginBottom: "8px" })),
      )
      : null,
  ]);

  const statsRow = el(
    { flexDirection: "row", gap: "12px" },
    statBoxes(stats, { bg: CARD_BG, border: CARD_BORDER, labelColor: textRgba(0.65), valueSize: 26, labelSize: 11, pad: "14px 16px" }),
  );

  const featuredRow = featured
    ? el(
      { flexDirection: "row", alignItems: "center", background: CARD_BG, border: CARD_BORDER, borderRadius: "16px", padding: "16px 18px" },
      [
        coverBox(featured.coverB64, 90, 12, featured.title, { marginRight: "18px" }),
        el({ flex: 1, flexDirection: "column" }, [
          el({ fontSize: "12px", fontWeight: 700, letterSpacing: "2px", color: textRgba(0.6) }, "DESTAQUE"),
          el({ fontSize: "28px", fontWeight: 900, color: "white", marginTop: "4px" }, clip(featured.title, 40)),
          typeTag(featured.type, textRgba(0.14)),
        ]),
      ],
    )
    : null;

  const posts = feedAll.slice(0, 4);
  const feedSection = posts.length
    ? el({ flexDirection: "column", gap: "10px" }, [
      sectionLabel("FEED", textRgba(0.6), { marginBottom: "2px" }),
      ...posts.map((f: N) =>
        el({ flexDirection: "column", background: CARD_BG, border: CARD_BORDER, borderRadius: "14px", padding: "14px 18px" }, [
          el({ flexDirection: "row", alignItems: "center", marginBottom: "8px" }, [
            avatar(28, "none", { marginRight: "10px" }),
            el({ fontSize: "15px", fontWeight: 700, color: "white" }, clip(name, 30)),
          ]),
          ...wrapLines(f.text, 78, 3).map((l) => el({ fontSize: "18px", lineHeight: 1.35, color: "white", whiteSpace: "nowrap" }, l)),
          feedMeta(f),
        ])
      ),
    ])
    : null;

  // Faixas como cards lado a lado (até 5), com capa ou inicial no lugar
  const n = tracks.length;
  const gap = 12;
  const cardW = n ? Math.floor((INNER - gap * (n - 1)) / n) : 0;
  const coverSize = Math.min(150, cardW - 28);
  const tracksSection = n
    ? el({ flexDirection: "column" }, [
      sectionLabel("FAIXAS POPULARES", textRgba(0.6)),
      el(
        { flexDirection: "row", gap: `${gap}px` },
        tracks.map((t: N) =>
          el(
            {
              width: `${cardW}px`, flexDirection: "column", alignItems: "center",
              background: CARD_BG, border: CARD_BORDER, borderRadius: "14px", padding: "14px",
            },
            [
              coverBox(t.coverB64, coverSize, 10, t.title, { marginBottom: "10px" }),
              el({ fontSize: "16px", fontWeight: 700, color: "white", whiteSpace: "nowrap" }, clip(t.title, n > 3 ? 15 : 22)),
              el({ fontSize: "13px", color: textRgba(0.55), marginTop: "4px" }, t.streams),
            ],
          )
        ),
      ),
    ])
    : null;

  return el(
    { width: `${W}px`, background: BG, color: "white", fontFamily: "Inter", flexDirection: "column" },
    [
      topSection,
      nameSection,
      el({ flexDirection: "column", padding: `16px ${PAD}px 40px ${PAD}px`, gap: "20px" }, [
        statsRow,
        featuredRow,
        feedSection,
        tracksSection,
      ]),
    ],
  );
}

// ═════════════════════════════════════════════════════════════════
// LAYOUT: COMPACT (900) — lado a lado, sem capas nem feed
// ═════════════════════════════════════════════════════════════════
function buildCompact(): N {
  const BG = palette.darkest;
  const CARD_BG = palette.cardBg;
  const CARD_BORDER = palette.cardBorder;
  const bio = clip(bioFull, 110);

  const leftPanel = el(
    { width: "340px", flexDirection: "column", padding: "36px 32px", position: "relative", overflow: "hidden" },
    [
      el({ position: "absolute", top: "0px", left: "0px", right: "0px", bottom: "0px", background: palette.brand, opacity: 0.18 }),
      avatar(120, "4px solid white", { marginBottom: "16px" }),
      el({ fontSize: "38px", fontWeight: 900, color: "white", lineHeight: 1.1 }, clip(name, 16)),
      worldRank ? el({ fontSize: "15px", fontWeight: 700, color: textRgba(0.7), marginTop: "6px" }, `${worldRank} mundial`) : null,
      chips.length
        ? el(
          { flexDirection: "row", flexWrap: "wrap", marginTop: "14px" },
          chips.slice(0, 4).map((c) =>
            buildChip(c, { fontSize: "13px", padding: "4px 12px", marginRight: "6px", marginBottom: "6px" })
          ),
        )
        : null,
      bio ? el({ fontSize: "15px", color: textRgba(0.7), marginTop: "12px", lineHeight: 1.4 }, bio) : null,
      featured
        ? el(
          { flexDirection: "row", alignItems: "center", marginTop: "18px", background: "rgba(0,0,0,0.25)", borderRadius: "12px", padding: "10px 12px" },
          [
            coverBox(featured.coverB64, 52, 8, featured.title, { marginRight: "12px" }),
            el({ flex: 1, flexDirection: "column", overflow: "hidden" }, [
              el({ fontSize: "10px", fontWeight: 700, letterSpacing: "2px", color: textRgba(0.6) }, "DESTAQUE"),
              el({ fontSize: "17px", fontWeight: 900, color: "white", marginTop: "2px", whiteSpace: "nowrap" }, clip(featured.title, 18)),
              featured.type ? el({ fontSize: "11px", color: textRgba(0.55), marginTop: "2px" }, featured.type.toUpperCase()) : null,
            ]),
          ],
        )
        : null,
    ],
  );

  const divider = el({ width: "1px", background: textRgba(0.12), marginTop: "32px", marginBottom: "32px" });

  // Estatísticas em grade 2x2 (4 numa linha não cabe em 900px)
  const statRows: N[] = [];
  for (let i = 0; i < stats.length; i += 2) {
    statRows.push(
      el(
        { flexDirection: "row", gap: "12px", marginBottom: "12px" },
        statBoxes(stats.slice(i, i + 2), { bg: CARD_BG, border: CARD_BORDER, labelColor: textRgba(0.6), valueSize: 22, labelSize: 10, pad: "12px 14px" }),
      ),
    );
  }

  const rightPanel = el({ flex: 1, flexDirection: "column", padding: "36px 36px 28px 36px" }, [
    ...statRows,
    tracks.length ? sectionLabel("FAIXAS POPULARES", textRgba(0.55), { fontSize: "11px", marginTop: "12px", marginBottom: "6px" }) : null,
    ...tracks.map((t: N, i: number) =>
      el(
        {
          flexDirection: "row", alignItems: "center", padding: "8px 0",
          borderBottom: i < tracks.length - 1 ? `1px solid ${textRgba(0.08)}` : "none",
        },
        [
          el({ width: "24px", fontSize: "15px", fontWeight: 900, color: textRgba(0.5) }, String(t.pos)),
          el({ flex: 1, fontSize: "17px", fontWeight: 700, color: "white", whiteSpace: "nowrap", overflow: "hidden" }, clip(t.title, 26)),
          el({ fontSize: "14px", color: textRgba(0.55), justifyContent: "flex-end" }, t.streams),
        ],
      )
    ),
    el({ flexDirection: "row", justifyContent: "flex-end", marginTop: "18px" }, [
      el({ fontSize: "11px", fontWeight: 900, color: textRgba(0.25), letterSpacing: "3px" }, "FAMOU$"),
    ]),
  ]);

  return el(
    { width: `${W}px`, background: BG, color: "white", fontFamily: "Inter", flexDirection: "row" },
    [leftPanel, divider, rightPanel],
  );
}

// -----------------------------------------------------------------
// Router + render com altura automática
// -----------------------------------------------------------------
function buildLayout(): N {
  console.log(`🎨 Renderizando layout: ${layoutName}`);
  switch (layoutName) {
    case "midnight":
      return buildMidnight();
    case "social":
      return buildSocial();
    case "compact":
      return buildCompact();
    default:
      return buildClassic();
  }
}

// Sem `height`: o Satori calcula pela altura do conteúdo.
async function renderAuto(): Promise<{ svg: string; H: number }> {
  const svg = await satori(buildLayout(), { width: W, fonts } as N);
  const m = svg.match(/<svg[^>]*\sheight="([\d.]+)"/);
  const H = m ? Math.ceil(parseFloat(m[1])) : 0;
  if (!H) throw new Error("não consegui ler a altura do SVG");
  return { svg, H };
}

let result: { svg: string; H: number };
try {
  result = await renderAuto();
} catch (e) {
  console.log("⚠️ Satori falhou com as imagens, tentando sem nenhuma:", (e as Error).message);
  bannerB64 = "";
  picB64 = "";
  tracks.forEach((t: N) => (t.coverB64 = ""));
  if (featured) featured.coverB64 = "";
  result = await renderAuto();
}

const { svg, H } = result;
console.log(`📐 Tamanho final: ${W}x${H}`);

const png = await svg2png(svg, { width: W, height: H });
console.log(`✅ PNG gerado (${layoutName}): ${png.byteLength} bytes`);

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
