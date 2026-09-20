#!/usr/bin/env node
/**
 * Build the Content Atlas: a chunk-level semantic map of all posts.
 *
 * - Splits posts in content/{projects,writing} into ~40-150 word chunks,
 *   keeping the nearest heading's anchor for deep links
 * - Embeds each chunk with all-MiniLM-L6-v2 (quantized ONNX) via
 *   @huggingface/transformers — the SAME model transformers.js loads in the
 *   browser for query embedding, so the search space matches exactly
 * - Caches embeddings by chunk-text hash in scripts/atlas-cache.json
 * - Projects to 2D with seeded UMAP (umap-js) — deterministic layout
 * - Assigns each chunk its post's strongest skill (data/skills.json, same
 *   overlap logic as the graph template)
 * - Writes assets/atlas/atlas.json (chunks + positions + meta) and
 *   assets/atlas/atlas-vectors.bin (int8-quantized unit vectors for
 *   in-browser cosine search)
 *
 * Run locally: npm run build:atlas   (first run downloads the model once)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECTIONS = ['projects', 'writing'];
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIMS = 384;
const MIN_WORDS = 40;
const MAX_WORDS = 150;
const POSITION_SCALE = 400;
const UMAP_SEED = 42;

const CACHE_PATH = path.join(ROOT, 'scripts', 'atlas-cache.json');
const SKILLS_PATH = path.join(ROOT, 'data', 'skills.json');
const OUT_DIR = path.join(ROOT, 'assets', 'atlas');

/* ---------------- Parsing ---------------- */

function parseFrontmatter(raw) {
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
    if (!m) return { front: {}, body: raw };
    const front = {};
    const text = m[1];
    const get = key => {
        const mm = text.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, 'm'));
        return mm ? mm[1] : null;
    };
    const getList = key => {
        const mm = text.match(new RegExp(`^${key}:\\s*\\[(.*)\\]`, 'm'));
        if (!mm) return [];
        return mm[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    };
    front.title = get('title') || '';
    front.draft = /^draft:\s*true\s*$/im.test(text);
    front.tags = getList('tags');
    front.categories = getList('categories');
    return { front, body: raw.slice(m[0].length) };
}

/* Mirror Hugo's GitHub-style auto heading IDs. Verified against a real Hugo
   build by the anchor test, which is the guard if goldmark ever changes:
     - inline markup contributes its rendered text, not its source
     - typographer folds --, ---, ... and quotes into characters that then drop
     - Unicode letters and digits survive, lowercased; so do - and _
     - every other character is dropped, contributing nothing
     - each whitespace character becomes one hyphen; runs are NOT collapsed */
export function anchorize(heading) {
    return heading
        .trim()
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')       // images contribute no text
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')    // links -> their text
        .replace(/`([^`]*)`/g, '$1')                // inline code -> its text
        .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')    // emphasis (never _, which anchors keep)
        .replace(/-{2,}|\.{3,}/g, '')               // typographer dashes/ellipsis drop out
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s\-_]/gu, '')
        .replace(/\s/g, '-');
}

function cleanParagraph(p) {
    return p
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')       // images
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')     // links -> text
        .replace(/<[^>]+>/g, ' ')                    // html tags
        .replace(/`([^`]*)`/g, '$1')                 // inline code
        .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1') // emphasis
        .replace(/^\s*[-*+]\s+/gm, '')               // list markers
        .replace(/^\s*\d+\.\s+/gm, '')               // ordered list markers
        .replace(/\s+/g, ' ')
        .trim();
}

/* Split a post body into chunks of MIN..MAX words, flushed on heading
   changes so every chunk deep-links to its section. */
function chunkPost(body) {
    // Drop fenced code blocks entirely (noise for sentence embeddings)
    const noCode = body.replace(/```[\s\S]*?```/g, '\n\n');
    const lines = noCode.split('\n');

    const chunks = [];
    let heading = '', anchor = '';
    let buffer = [], bufferWords = 0;

    const flush = () => {
        if (!buffer.length) return;
        const text = buffer.join(' ');
        if (bufferWords >= 15) {
            chunks.push({ text, heading, anchor });
        } else if (chunks.length && chunks[chunks.length - 1].anchor === anchor) {
            chunks[chunks.length - 1].text += ' ' + text;
        } else if (bufferWords >= 8) {
            chunks.push({ text, heading, anchor });
        }
        buffer = []; bufferWords = 0;
    };

    let para = [];
    const endParagraph = () => {
        const text = cleanParagraph(para.join(' '));
        para = [];
        if (!text) return;
        const words = text.split(/\s+/).length;
        if (bufferWords + words > MAX_WORDS && bufferWords >= MIN_WORDS) flush();
        buffer.push(text);
        bufferWords += words;
        if (bufferWords >= MIN_WORDS && bufferWords + 40 > MAX_WORDS) flush();
    };

    for (const line of lines) {
        const hm = line.match(/^#{1,6}\s+(.*)$/);
        if (hm) {
            endParagraph();
            flush();
            heading = cleanParagraph(hm[1]);
            anchor = anchorize(hm[1].trim());
            continue;
        }
        if (line.trim() === '') { endParagraph(); continue; }
        para.push(line);
    }
    endParagraph();
    flush();
    return chunks;
}

/* ---------------- Skills ---------------- */

function strongestSkill(front, permalink, skills) {
    const tags = front.tags.map(t => t.toLowerCase());
    const cats = front.categories.map(c => c.toLowerCase());
    let best = null, bestW = 0;
    for (const s of skills) {
        let w = 0;
        for (const t of tags) if ((s.tags || []).includes(t)) w++;
        for (const c of cats) if ((s.categories || []).includes(c)) w++;
        if ((s.posts || []).includes(permalink)) w += 2;
        if (w > bestW) { bestW = w; best = s; }
    }
    return best;
}

/* Hugo supports both standalone Markdown files and leaf bundles (dir/index.md).
   Stop at a leaf bundle: other Markdown files inside it are page resources. */
function* postFiles(dir) {
    if (fs.existsSync(path.join(dir, 'index.md'))) {
        yield path.join(dir, 'index.md');
        return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* postFiles(file);
        else if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('_')) yield file;
    }
}

export function collectChunks(root, skills) {
    const chunks = [];
    for (const section of SECTIONS) {
        const dir = path.join(root, 'content', section);
        if (!fs.existsSync(dir)) continue;
        for (const file of postFiles(dir)) {
            const raw = fs.readFileSync(file, 'utf8');
            const { front, body } = parseFrontmatter(raw);
            if (front.draft) continue;
            const slug = path.relative(dir, file).split(path.sep).join('/')
                .replace(/(^|\/)index\.md$/, '').replace(/\.md$/, '');
            const permalink = `/${section}/${slug ? slug + '/' : ''}`;
            const skill = strongestSkill(front, permalink, skills);
            for (const c of chunkPost(body)) {
                chunks.push({
                    post: permalink,
                    title: front.title || slug,
                    section,
                    skill: skill ? skill.id : null,
                    heading: c.heading,
                    anchor: c.anchor,
                    text: c.text
                });
            }
        }
    }
    return chunks;
}

/* ---------------- Main ---------------- */

async function main() {
    const skills = JSON.parse(fs.readFileSync(SKILLS_PATH, 'utf8')).skills || [];
    const chunks = collectChunks(ROOT, skills);
    if (!chunks.length) {
        console.error('No chunks produced.');
        process.exit(1);
    }
    console.log(`Chunked ${new Set(chunks.map(c => c.post)).size} posts into ${chunks.length} chunks.`);

    // Embed (with cache keyed by text hash)
    let cache = {};
    if (fs.existsSync(CACHE_PATH)) cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));

    const hashes = chunks.map(c => crypto.createHash('sha256').update(MODEL_ID + '\n' + c.text).digest('hex').slice(0, 16));
    const toEmbed = [];
    hashes.forEach((h, i) => { if (!cache[h]) toEmbed.push(i); });

    if (toEmbed.length) {
        console.log(`Embedding ${toEmbed.length} new/changed chunk(s) with ${MODEL_ID}...`);
        const { pipeline } = await import('@huggingface/transformers');
        const extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
        const BATCH = 32;
        for (let i = 0; i < toEmbed.length; i += BATCH) {
            const idxs = toEmbed.slice(i, i + BATCH);
            const out = await extractor(idxs.map(j => chunks[j].text), { pooling: 'mean', normalize: true });
            const flat = out.data;
            idxs.forEach((j, k) => {
                cache[hashes[j]] = Array.from(flat.slice(k * DIMS, (k + 1) * DIMS)).map(v => +v.toFixed(6));
            });
            console.log(`  ${Math.min(i + BATCH, toEmbed.length)}/${toEmbed.length}`);
        }
    } else {
        console.log('All chunk embeddings up to date (cache hit).');
    }

    // Prune cache to live hashes, then persist
    const live = new Set(hashes);
    cache = Object.fromEntries(Object.entries(cache).filter(([h]) => live.has(h)));
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));

    const vectors = hashes.map(h => cache[h]);

    const reused = process.argv.includes('--reproject') ? null : committedPositions(chunks);
    if (reused) {
        console.log('Chunk set unchanged; keeping the committed layout.');
    } else {
        console.log('Projecting with UMAP...');
    }
    const positions = reused || await projectVectors(vectors);
    chunks.forEach((c, i) => { [c.x, c.y] = positions[i]; });

    // Quantize unit vectors to int8 with a single global scale
    // (cosine similarity is invariant to uniform scaling)
    let gMax = 0;
    vectors.forEach(v => v.forEach(x => { const a = Math.abs(x); if (a > gMax) gMax = a; }));
    const qscale = gMax / 127;
    const bin = new Int8Array(vectors.length * DIMS);
    vectors.forEach((v, i) => v.forEach((x, d) => { bin[i * DIMS + d] = Math.max(-127, Math.min(127, Math.round(x / qscale))); }));

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'atlas-vectors.bin'), Buffer.from(bin.buffer));
    fs.writeFileSync(path.join(OUT_DIR, 'atlas.json'), JSON.stringify({
        meta: {
            model: MODEL_ID,
            dims: DIMS,
            count: chunks.length,
            posts: new Set(chunks.map(c => c.post)).size,
            quantScale: +qscale.toFixed(8),
            projection: 'umap'
        },
        skills: Object.fromEntries(skills.map(s => [s.id, { name: s.name, color: s.color }])),
        chunks
    }));

    const jsonKB = Math.round(fs.statSync(path.join(OUT_DIR, 'atlas.json')).size / 1024);
    const binKB = Math.round(fs.statSync(path.join(OUT_DIR, 'atlas-vectors.bin')).size / 1024);
    console.log(`Wrote ${chunks.length} chunks -> assets/atlas/atlas.json (${jsonKB} KB) + atlas-vectors.bin (${binKB} KB)`);
}

/* The UMAP seed makes a layout reproducible within one V8, but umap-js leans on
   Math.pow/log/exp, which ECMAScript leaves implementation-defined — another
   Node version or architecture returns coordinates that differ in the last
   digits. Reprojecting only when the chunk set actually changes keeps the
   committed output byte-identical everywhere, so CI and a laptop agree.
   Pass --reproject to force a fresh layout. */
export function committedPositions(chunks, dir = OUT_DIR) {
    const file = path.join(dir, 'atlas.json');
    if (!fs.existsSync(file)) return null;
    let prev;
    try {
        prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
    if (prev?.meta?.model !== MODEL_ID || prev.chunks?.length !== chunks.length) return null;
    const identical = prev.chunks.every((c, i) =>
        c.post === chunks[i].post && c.anchor === chunks[i].anchor && c.text === chunks[i].text
        && Number.isFinite(c.x) && Number.isFinite(c.y));
    return identical ? prev.chunks.map(c => [c.x, c.y]) : null;
}

// A broader neighborhood keeps small, self-similar topics connected to the
// rest of the map. With 12 neighbors the ADR article became a distant island;
// fitting that island compressed every other topic. minDist gives dots room.
export async function projectVectors(vectors) {
    if (vectors.length <= 1) return vectors.map(() => [0, 0]);
    if (vectors.length === 2) return [[-POSITION_SCALE / 2, 0], [POSITION_SCALE / 2, 0]];
    const { UMAP } = await import('umap-js');
    let seed = UMAP_SEED;
    const random = () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const proj = new UMAP({
        nComponents: 2,
        nNeighbors: Math.min(30, vectors.length - 1),
        minDist: 0.25,
        random
    }).fit(vectors);
    const cx = proj.reduce((s, p) => s + p[0], 0) / proj.length;
    const cy = proj.reduce((s, p) => s + p[1], 0) / proj.length;
    const maxAbs = Math.max(...proj.map(p => Math.max(Math.abs(p[0] - cx), Math.abs(p[1] - cy)))) || 1;
    const k = POSITION_SCALE / maxAbs;
    // Collapse -0 to 0: JSON.stringify writes both as "0", so a -0 here could
    // never compare equal to the value read back out of atlas.json.
    const round = v => (+(v).toFixed(1)) || 0;
    return proj.map(p => [round((p[0] - cx) * k), round((p[1] - cy) * k)]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(e => { console.error(e); process.exitCode = 1; });
}
