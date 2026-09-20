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

// Guarda os bytes brutos já baixados de cada URL (banner/foto), pra
// reaproveitar na extração de cor sem baixar a imagem de novo.
const rawImageBytes = new Map<string, Uint8Array>();

async function loadImageUncached(url: string, label: string): Promise<string> {
  const got = await fetchImageBytes(url);
  if (!got) return "";

  if (got.buf.byteLength > 8_000_000) {
    console.log(`⚠️ imagem [${label}] grande demais (${got.buf.byteLength} bytes), ignorada`);
    return "";
  }

  rawImageBytes.set(url, got.buf);

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
// Extração de cor dominante (banner > foto > nome)
//
// Reaproveita os bytes já baixados em `rawImageBytes` (a mesma imagem
// que o Satori usa) — não faz nenhuma chamada de rede extra. Decodifica
// PNG e JPEG (baseline) manualmente, já que aqui não temos DOM/Canvas.
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
// Decoder minimalista: cobre JPEG baseline DCT (o caso comum de fotos
// de perfil/banner). JPEGs progressivos ou 12-bit não são suportados
// e caem no fallback (retorna null -> extractDominantColor tenta a
// próxima imagem ou gera cor pelo nome).
function decodeJPEG(data: Uint8Array): DecodedImage | null {
  try {
    let offset = 0;
    const readUint16 = () => {
      const v = (data[offset] << 8) | data[offset + 1];
      offset += 2;
      return v;
    };

    if (readUint16() !== 0xffd8) return null; // SOI

    let qTables: Record<number, Int32Array> = {};
    let frame: {
      width: number;
      height: number;
      components: { id: number; h: number; v: number; qId: number }[];
    } | null = null;
    let huffmanTablesDC: Record<number, N> = {};
    let huffmanTablesAC: Record<number, N> = {};
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
            table[i] = pq === 0 ? data[p++] : readUint16At(p, (n) => (p += n));
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
        // progressive - não suportado
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
        // dados de scan vão até o próximo marker que não seja RSTn
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

    function readUint16At(p: number, advance: (n: number) => void): number {
      const v = (data[p] << 8) | data[p + 1];
      advance(2);
      return v;
    }

    if (!frame || !scanData) return null;

    // Decodificação completa de JPEG é cara para o que precisamos (só a cor
    // dominante). Em vez de implementar IDCT+upsampling completos aqui,
    // aproximamos usando os coeficientes DC de cada bloco de luminância/
    // crominância via um decodificador simplificado de Huffman + DC.
    const result = decodeJPEGApprox(data, frame, scanData, scanComponents, huffmanTablesDC, huffmanTablesAC, qTables);
    return result;
  } catch (e) {
    console.log("⚠️ decodeJPEG erro:", (e as Error).message);
    return null;
  }
}

// Decodificador aproximado: extrai o coeficiente DC de cada bloco 8x8 via
// Huffman e reconstrói uma imagem em baixa resolução — 1 "pixel" por bloco
// de luminância (não uma média global única). Isso preserva a variação de
// cor pela cena (céu vs grama vs pele, por exemplo) em vez de achatar tudo
// numa única média cinzenta, o que é essencial para extractDominantFromPixels
// conseguir escolher o bucket de cor mais frequente/saturado de verdade.
function decodeJPEGApprox(
  data: Uint8Array,
  frame: { width: number; height: number; components: { id: number; h: number; v: number; qId: number }[] },
  scanData: Uint8Array,
  scanComponents: { id: number; dcId: number; acId: number }[],
  huffDC: Record<number, N>,
  huffAC: Record<number, N>,
  qTables: Record<number, Int32Array>,
): DecodedImage | null {
  // Remove byte stuffing (0xFF 0x00 -> 0xFF) e pula restart markers
  const cleaned: number[] = [];
  for (let i = 0; i < scanData.length; i++) {
    if (scanData[i] === 0xff && scanData[i + 1] === 0x00) {
      cleaned.push(0xff);
      i++;
    } else if (scanData[i] === 0xff && scanData[i + 1] >= 0xd0 && scanData[i + 1] <= 0xd7) {
      i++; // pula restart markers (RSTn)
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

  // Uma amostra de cor por MCU (não por sub-bloco de croma, que costuma vir
  // subamostrado 2x2 em 4:2:0). Cada MCU vira 1 "pixel" na imagem de saída,
  // preservando onde na cena aquela cor aparece em vez de só uma média geral.
  const pixels = new Uint8Array(mcusX * mcusY * 4);
  let samplesWritten = 0;

  outer:
  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      // valores DC (já em unidades reais, pós quantização) coletados neste MCU
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
            // DC
            const t = decodeHuff(dcTable);
            const diff = t === 0 ? 0 : extend(receive(t), t);
            dcPrev[comp.id] += diff;
            const q = qTables[comp.qId];
            // Coeficiente DC já escalado: dividir por 8 normaliza o bloco
            // 8x8 (DC = soma/N, N=8 na base DCT) pra virar o nível médio
            // real do bloco em 0-255 (antes do +128 de level shift).
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

            // Consome (sem usar) os coeficientes AC pra manter o bitstream
            // sincronizado — não precisamos deles pra cor dominante.
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

// --- Fallback determinístico a partir do nome (mesmo algoritmo do outro bot) ---
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

// Decodifica os bytes brutos (PNG ou JPEG) de uma URL já baixada e tenta
// extrair a cor dominante. Retorna null se não conseguir decodificar ou
// não achar nenhum pixel saturado o bastante.
async function extractColorFromBytes(url: string): Promise<string | null> {
  const buf = rawImageBytes.get(url);
  if (!buf) {
    console.log(`⚠️ Sem bytes em cache para ${url}, não dá pra extrair cor`);
    return null;
  }

  const mime = sniffMime(buf);
  let decoded: DecodedImage | null = null;

  console.log(`🔬 Decodificando [${mime || "formato desconhecido"}] ${url} (${buf.byteLength} bytes)`);

  if (mime === "image/png") {
    decoded = await decodePNG(buf);
  } else if (mime === "image/jpeg") {
    decoded = decodeJPEG(buf);
  } else {
    console.log(`⚠️ Formato [${mime || "desconhecido"}] sem decoder de cor, pulando`);
    return null;
  }

  if (!decoded) {
    console.log(`⚠️ Decodificação falhou para ${url}`);
    return null;
  }

  console.log(`🖼️ Decodificado ${decoded.width}x${decoded.height} px`);

  const best = extractDominantFromPixels(decoded.pixels);
  if (!best) {
    console.log(`⚠️ Nenhum pixel suficientemente saturado em ${url}`);
    return null;
  }

  const rawHex = `#${best.r.toString(16).padStart(2, "0")}${best.g.toString(16).padStart(2, "0")}${best.b.toString(16).padStart(2, "0")}`;
  console.log(`🎯 Bucket dominante antes do boost: ${rawHex} (sat: ${(best.saturation * 100).toFixed(1)}%)`);

  // Abaixo desse piso, "qual canal é dominante" é essencialmente ruído de
  // compressão numa imagem visualmente cinza/monocromática — não existe
  // cor real pra extrair aqui. Em vez de forçar uma cor vibrante artificial
  // (o boost abaixo faria isso), desiste desta imagem e deixa o chamador
  // cair pro próximo fallback (foto de perfil, depois nome).
  const MIN_USABLE_SAT = 0.12;
  if (best.saturation < MIN_USABLE_SAT) {
    console.log(
      `🚫 Imagem praticamente sem cor (sat: ${(best.saturation * 100).toFixed(1)}% < ${MIN_USABLE_SAT * 100}%) — descartando, sem inventar cor`,
    );
    return null;
  }

  let { r, g, b, saturation } = best;
  // Limiar mais baixo (22%, não 35%): a 34.6% de saturação real (caso de
  // teste com um banner esverdeado bem pálido) o resultado já é uma cor
  // perfeitamente reconhecível — não precisa de ajuda. Só imagens realmente
  // próximas do cinza (abaixo de ~22%, mas ainda acima do piso de descarte
  // de 12%) recebem um empurrão, e mesmo assim mais fraco que antes.
  const BOOST_THRESHOLD = 0.22;
  if (saturation < BOOST_THRESHOLD) {
    // Boost proporcional: quanto mais perto de 0% de saturação, mais forte
    // o empurrão (até um teto bem mais contido que antes); perto do limiar
    // de 22% o boost já é bem sutil.
    const strength = 1 - saturation / BOOST_THRESHOLD; // 1 (bem dessaturado) -> 0 (no limiar)
    const boost = Math.round(12 + strength * 23); // 12..35 (antes: 25..60)
    const cut = Math.round(4 + strength * 8); // 4..12 (antes: 8..20)

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
    console.log(`📈 Saturação baixa (${(saturation * 100).toFixed(1)}%) — boost proporcional aplicado (+${boost}/-${cut})`);
  } else {
    console.log(`✅ Saturação suficiente (${(saturation * 100).toFixed(1)}%) — sem boost`);
  }

  const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  console.log(`✅ Cor final extraída de ${url}: ${hex}`);
  return hex;
}

// Banner -> foto -> nome (mesma ordem de fallback do outro bot)
async function extractDominantColor(bannerUrl: string, pictureUrl: string, name: string): Promise<string> {
  console.log("🎨 === ANÁLISE DE COR (pixels reais) ===");

  if (bannerUrl) {
    console.log("🔍 Analisando banner...");
    const color = await extractColorFromBytes(bannerUrl);
    if (color) {
      console.log(`🏁 Cor final escolhida (fonte: banner): ${color}`);
      return color;
    }
  }

  if (pictureUrl && pictureUrl !== bannerUrl) {
    console.log("🔍 Banner sem cor usável, analisando foto...");
    const color = await extractColorFromBytes(pictureUrl);
    if (color) {
      console.log(`🏁 Cor final escolhida (fonte: foto de perfil): ${color}`);
      return color;
    }
  }

  console.log("🔍 Nenhuma imagem deu cor usável, gerando cor a partir do nome...");
  const fallback = generateColorFromName(name);
  console.log(`🏁 Cor final escolhida (fonte: nome "${name}"): ${fallback}`);
  return fallback;
}

type Palette = {
  base: string;
  darker: string;
  darkest: string;
  brand: string; // gradiente CSS pronto pra usar em `background`
  cardBg: string;
  cardBorder: string;
};

function generatePalette(color: string): Palette {
  const rgb = hexToRgb(color);

  // Escurecimento PROPORCIONAL (multiplicativo), não subtrativo por valor
  // fixo. Subtrair um valor absoluto grande do canal B (por exemplo) some
  // desproporcionalmente mais de canais que já são baixos, distorcendo o
  // matiz original — foi isso que fazia um amarelo puro (#efdf87) virar
  // visualmente oliva/mostarda depois de escurecido. Multiplicar por um
  // fator preserva a proporção entre R/G/B e portanto o matiz.
  const scaleDarker = 0.72; // ~28% mais escuro, mantendo o tom
  const scaleDarkest = 0.5; // ~50% mais escuro — ainda reconhecível como o mesmo tom
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
  // Segunda cor do gradiente: mesmo tom, deslocado pra um tom mais "frio"
  // (leve giro pra azul) — mantém a identidade visual sem ficar um degradê
  // genérico de duas cores aleatórias.
  const brandEnd = { r: Math.max(0, rgb.r - 60), g: Math.max(0, rgb.g - 20), b: Math.min(255, rgb.b + 50) };

  return {
    base: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
    darker: `rgb(${darker.r}, ${darker.g}, ${darker.b})`,
    darkest: `rgb(${darkest.r}, ${darkest.g}, ${darkest.b})`,
    brand: `linear-gradient(90deg, rgb(${rgb.r}, ${rgb.g}, ${rgb.b}) 0%, rgb(${brandEnd.r}, ${brandEnd.g}, ${brandEnd.b}) 100%)`,
    cardBg: `rgba(${Math.min(255, rgb.r + 20)}, ${Math.min(255, rgb.g + 20)}, ${Math.min(255, rgb.b + 20)}, 0.10)`,
    cardBorder: `1px solid rgba(${Math.min(255, rgb.r + 40)}, ${Math.min(255, rgb.g + 40)}, ${Math.min(255, rgb.b + 40)}, 0.18)`,
  };
}

// -----------------------------------------------------------------
// Dados normalizados
// -----------------------------------------------------------------
const W = 1200;

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
const bannerUrl = String(a.banner ?? "");
const pictureUrl = String(a.picture ?? "");

let [bannerB64, picB64] = await Promise.all([
  loadImage(bannerUrl, "banner"),
  loadImage(pictureUrl, "foto"),
]);
await Promise.all(
  tracks.map(async (t: N, i: number) => {
    t.coverB64 = await loadImage(t.cover, `capa ${i + 1}`);
  }),
);

// Extrai a cor dominante a partir dos bytes que já baixamos pro Satori
// (banner primeiro, depois foto, depois cor gerada a partir do nome).
const dominantColor = await extractDominantColor(bannerUrl, pictureUrl, name);
const palette = generatePalette(dominantColor);

const BG = palette.darkest;
const BRAND = palette.brand;
const CARD_BG = palette.cardBg;
const CARD_BORDER = palette.cardBorder;

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
      background: `linear-gradient(to bottom, rgba(18,10,46,0.10) 0%, rgba(18,10,46,0.55) 55%, ${BG} 100%)`,
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
          border: "6px solid white", background: palette.base, alignItems: "center", justifyContent: "center",
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
        el({ width: "4px", height: "24px", borderRadius: "2px", background: palette.base, marginRight: "16px" }),
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
