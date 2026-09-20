// scrape-playlists.ts — roda no GitHub Actions (Deno)
// Raspa as playlists oficiais (Spotify / Apple Music / Deezer) do site de origem
// e grava tudo em UM arquivo: playlists.json
//
// Uso: SITE_URL=https://... deno run --allow-net --allow-write --allow-env=SITE_URL scrape-playlists.ts

// URL do site vem do secret SITE_URL (Settings > Secrets and variables > Actions),
// assim ela não fica escrita no código do repositório público.
const BASE = (globalThis.Deno?.env.get("SITE_URL") ?? "").trim().replace(/\/+$/, "");
const OUT_FILE = "playlists.json";
const CONCURRENCY = 2; // quantas playlists baixar ao mesmo tempo (5 dava 500 em rajada)
const PAUSE_MS = 250; // pausa depois de cada playlist, pra não sobrecarregar o site

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// deno-lint-ignore no-explicit-any
type N = any;

function decodeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

async function fetchText(url: string, tries = 3): Promise<string> {
  let lastErr = "";
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error("status " + res.status);
      return await res.text();
    } catch (e) {
      lastErr = (e as Error).message;
      console.log(`⚠️ falha (${i + 1}/${tries}) ${url}: ${lastErr}`);
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw new Error(`não consegui baixar ${url}: ${lastErr}`);
}

// -----------------------------------------------------------------
// 1) Lista das playlists oficiais (home /fmusic)
// -----------------------------------------------------------------
export function parsePlaylistList(html: string) {
  const wanted: Record<string, string> = {
    "spotify playlists": "Spotify",
    "apple music playlists": "Apple Music",
    "deezer playlists": "Deezer",
  };

  // Divide a página nas <section class="subsection ...">; cada uma tem um título
  // ("Spotify Playlists", ...) e os cards com href="../playlist/Slug".
  const sections = html.split(/<section class="subsection/i).slice(1);

  const list: { slug: string; name: string; platform: string }[] = [];
  const seen = new Set<string>();

  for (const sec of sections) {
    const title = sec.match(
      /<div class="heading horizontal-roll"[^>]*>\s*([^<]+?)\s*<div class="arrows">/i,
    );
    if (!title) continue;
    const platform = wanted[decodeHtml(title[1]).trim().toLowerCase()];
    if (!platform) continue; // ignora "Users Playlists" e outras

    const cardRegex =
      /<a href="\.\.\/playlist\/([^"]+)">\s*<div class="album-title"[^>]*>([^<]+)<\/div>/gi;
    let c: RegExpExecArray | null;
    while ((c = cardRegex.exec(sec)) !== null) {
      const slug = c[1].trim();
      if (seen.has(slug)) continue;
      seen.add(slug);
      list.push({ slug, name: decodeHtml(c[2].trim()), platform });
    }
  }
  return list;
}

// -----------------------------------------------------------------
// 2) Uma playlist: capa + faixas
// -----------------------------------------------------------------
export function parsePlaylistPage(html: string) {
  // Capa: <span ...>Capa: <b><a href="../artist/Zee">Zee</a></b></span>
  const coverMatch = html.match(
    /Capa:\s*(?:<b>\s*)?<a[^>]*href=["'](?:https?:\/\/[^"'\/]+)?(?:\.\.\/|\/)?artist\/([^"'?#]+)["'][^>]*>([^<]+)<\/a>/i,
  );

  const tracks: N[] = [];
  const rows = html.split('<tr tabindex="0">').slice(1);

  for (const row of rows) {
    const end = row.indexOf("</tr>");
    const tr = end === -1 ? row : row.slice(0, end);

    const pos = tr.match(/<td class="small subtitle pos">\s*(\d+)\s*<\/td>/);
    const id = tr.match(/href="\.\.\/trabalho\/(\d+)"/);
    if (!pos || !id) continue;

    const title = tr.match(/class="title track[^"]*">([^<]+)<\/a>/);

    const artistCell = tr.match(
      /<span class="small subtitle artist">([\s\S]*?)<\/span>\s*<\/td>/,
    );
    const cell = artistCell ? artistCell[1] : "";

    const linkRe = /<a href="\.\.\/artist\/([^"]+)"[^>]*>([^<]+)<\/a>/gi;
    const parts = cell.split(/feat\./i);
    const grab = (s: string) =>
      [...s.matchAll(linkRe)].map((m) => ({
        slug: m[1].trim(),
        name: decodeHtml(m[2].trim()),
      }));

    const main = grab(parts[0]);
    const feat = parts.length > 1 ? grab(parts.slice(1).join(" ")) : [];

    tracks.push({
      pos: parseInt(pos[1]),
      id: id[1],
      title: title ? decodeHtml(title[1].trim()) : "",
      main, // artistas principais (antes do "feat.")
      feat, // convidados
    });
  }

  return {
    coverSlug: coverMatch ? coverMatch[1].trim() : "",
    coverName: coverMatch ? decodeHtml(coverMatch[2].trim()) : "",
    tracks,
  };
}

// Slugs como "A-List:Pop" NÃO podem virar "A-List%3APop": o site devolve página
// vazia (status 200) nesse caso. Escapa só o que quebraria a URL de verdade.
export function slugToPath(slug: string): string {
  return encodeURIComponent(slug).replace(/%3A/gi, ":").replace(/%21/g, "!");
}

// -----------------------------------------------------------------
// 3) Execução
// -----------------------------------------------------------------
async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

async function main() {
  if (!/^https?:\/\//i.test(BASE)) {
    console.error("❌ Secret SITE_URL ausente ou inválido (precisa começar com https://)");
    Deno.exit(1);
  }
  console.log("📥 baixando lista de playlists...");
  const home = await fetchText(`${BASE}/fmusic`);
  const list = parsePlaylistList(home);
  console.log(`🎧 ${list.length} playlists oficiais encontradas`);

  // Se a home mudou de formato e não achamos nada, NÃO sobrescreve o arquivo bom.
  if (list.length < 5) {
    console.error("❌ lista de playlists suspeita (poucas), abortando sem gravar");
    Deno.exit(1);
  }

  const failed: string[] = [];
  const playlists = await pool(list, CONCURRENCY, async (pl) => {
    try {
      const html = await fetchText(`${BASE}/playlist/${slugToPath(pl.slug)}`);
      const parsed = parsePlaylistPage(html);
      // Página que "carregou" mas sem nenhuma faixa = tratada como FALHA
      // (antes passava como sucesso e gravava a playlist vazia).
      if (parsed.tracks.length === 0) {
        throw new Error("página sem faixas (formato mudou ou slug errado)");
      }
      await new Promise((r) => setTimeout(r, PAUSE_MS));
      console.log(`  ✓ ${pl.name} (${pl.platform}): ${parsed.tracks.length} faixas, capa: ${parsed.coverName || "-"}`);
      return { ...pl, ...parsed };
    } catch (e) {
      console.log(`  ✗ ${pl.name}: ${(e as Error).message}`);
      failed.push(pl.slug);
      return null;
    }
  });

  const ok = playlists.filter(Boolean);

  // Se mais de 20% falhou, algo está errado: mantém o arquivo anterior.
  if (failed.length > list.length * 0.2) {
    console.error(`❌ ${failed.length}/${list.length} playlists falharam, abortando sem gravar`);
    Deno.exit(1);
  }

  const data = {
    updatedAt: new Date().toISOString(),
    count: ok.length,
    failed,
    playlists: ok,
  };

  await Deno.writeTextFile(OUT_FILE, JSON.stringify(data));
  console.log(`✅ ${OUT_FILE} gravado: ${ok.length} playlists, ${failed.length} falharam`);
}

if (import.meta.main) {
  await main();
}
