import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const hasHugo = spawnSync('hugo', ['version']).status === 0;
const readJSON = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

/* One Hugo build, shared by the checks below: it is the slow part, and every
   assertion here is about what Hugo actually published rather than what the
   generators intended. */
let site = null;
function build(t) {
    if (site) return site;
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-publishing-'));
    t.after(() => { fs.rmSync(destination, { recursive: true, force: true }); site = null; });
    execFileSync('hugo', ['--destination', destination, '--baseURL', 'https://example.test/preview/', '--quiet'], {
        cwd: root, stdio: 'pipe'
    });
    site = { destination, base: '/preview/' };
    return site;
}
const page = (destination, permalink) =>
    fs.readFileSync(path.join(destination, permalink, 'index.html'), 'utf8');

test('Hugo publishes the current Atlas and vectors at content-addressed, base-path-aware URLs', { skip: !hasHugo }, t => {
    const { destination, base } = build(t);
    const html = page(destination, 'explore');
    for (const [attribute, file] of [['source', 'atlas.json'], ['vectors', 'atlas-vectors.bin']]) {
        const url = html.match(new RegExp(`data-${attribute}="([^"]+)"`))?.[1];
        assert.ok(url?.startsWith(`${base}atlas/`), `Missing base-path-aware ${attribute} URL`);
        const original = fs.readFileSync(path.join(root, 'assets/atlas', file));
        const digest = crypto.createHash('sha256').update(original).digest('hex');
        assert.ok(url.includes(`.${digest}.`), `${attribute} URL must change whenever its contents change`);
        const published = fs.readFileSync(path.join(destination, url.slice(base.length)));
        assert.deepEqual(published, original, 'Publishing must preserve exact bytes, including binary vectors');
    }
});

test('the generated data ships once, only under its fingerprinted name', { skip: !hasHugo }, t => {
    const { destination } = build(t);
    const stray = fs.readdirSync(path.join(destination, 'atlas'))
        .filter(name => name === 'atlas.json' || name === 'atlas-vectors.bin');
    assert.deepEqual(stray, [], 'An unfingerprinted copy is dead weight and can be served stale');
    assert.ok(!fs.existsSync(path.join(destination, 'graph', 'embeddings.json')),
        'The graph embeddings must ship fingerprinted too');
});

test('every Atlas deep link resolves to a heading Hugo actually emitted', { skip: !hasHugo }, t => {
    const { destination } = build(t);
    const ids = new Map();
    const broken = [];
    for (const chunk of readJSON('assets/atlas/atlas.json').chunks) {
        if (!chunk.anchor) continue;
        if (!ids.has(chunk.post)) {
            ids.set(chunk.post, new Set(
                [...page(destination, chunk.post).matchAll(/<h[1-6][^>]*\sid="([^"]+)"/g)].map(m => m[1])
            ));
        }
        if (!ids.get(chunk.post).has(chunk.anchor)) {
            broken.push(`${chunk.post}#${chunk.anchor}  (heading: ${JSON.stringify(chunk.heading)})`);
        }
    }
    assert.deepEqual([...new Set(broken)], [],
        'anchorize() has drifted from goldmark; "Read in context" would land at the top of the page');
});

test('the graph embeddings cover every post Hugo publishes on the graph', { skip: !hasHugo }, t => {
    const { destination, base } = build(t);
    const nodes = JSON.parse(fs.readFileSync(path.join(destination, 'explore/graph/index.json'), 'utf8'));
    const posts = nodes.nodes.filter(n => n.section !== 'skill').map(n => n.id);
    // graph.js rebases the generator's root-relative ids onto the site's base
    // path; assert against the same mapping so a subpath deploy stays covered.
    const { positions, links } = readJSON('assets/graph/embeddings.json');
    const localize = id => id.startsWith('skill:') ? id : base + id.replace(/^\//, '');
    const placed = new Set(Object.keys(positions).map(localize));
    assert.deepEqual(posts.filter(id => !placed.has(id)), [],
        'Run scripts/embed_graph.py: these posts have no semantic position and no similarity edges');
    const linked = new Set(links.flatMap(l => [localize(l.source), localize(l.target)]));
    assert.deepEqual(posts.filter(id => !linked.has(id)), [],
        'These posts are semantically isolated on the graph');
});

/* Hugo derives a term's display name from how posts spell it, and when posts
   disagree it picks build-order-dependently — writing "AI" in one post can make
   the whole site render "Ai". Slug-style values humanize badly on top of that
   (`vector-search` -> `Vector-Search`). So: one spelling per term, written the
   way it should read. Where the label cannot be a tag value — "llama.cpp" would
   mint /tags/llama.cpp/, and Hugo force-capitalises "watchOS" — pin it with
   content/tags/<slug>/_index.md, which leaves the URL alone. */
test('every taxonomy term has one spelling and renders exactly as written', { skip: !hasHugo }, t => {
    const { destination } = build(t);
    const pinned = fs.existsSync(path.join(root, 'content/tags'))
        ? new Set(fs.readdirSync(path.join(root, 'content/tags')))
        : new Set();
    const spellings = { tags: new Map(), categories: new Map() };
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(file);
        if (!entry.name.endsWith('.md') || entry.name.startsWith('_')) return;
        const front = fs.readFileSync(file, 'utf8').match(/^---\s*\n([\s\S]*?)\n---/)?.[1];
        for (const key of Object.keys(spellings)) {
            front?.match(new RegExp(`^${key}:\\s*\\[(.*)\\]`, 'm'))?.[1]
                .split(',').map(v => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
                .forEach(v => {
                    if (!spellings[key].has(v.toLowerCase())) spellings[key].set(v.toLowerCase(), new Set());
                    spellings[key].get(v.toLowerCase()).add(v);
                });
        }
    });
    ['projects', 'writing'].forEach(s => walk(path.join(root, 'content', s)));

    const conflicts = [], mangled = [];
    for (const [kind, terms] of Object.entries(spellings)) {
        for (const [, written] of terms) {
            if (written.size > 1) { conflicts.push(`${kind}: ${[...written].join(' vs ')}`); continue; }
            const [value] = written;
            const slug = [...fs.readdirSync(path.join(destination, kind))]
                .find(d => d.toLowerCase() === value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
            if (!slug || (kind === 'tags' && pinned.has(slug))) continue;
            const rendered = fs.readFileSync(path.join(destination, kind, slug, 'index.html'), 'utf8')
                .match(/<title>(.*?) \|/)[1];
            if (rendered !== value) mangled.push(`${kind}/${slug}: written "${value}", renders "${rendered}"`);
        }
    }
    assert.deepEqual(conflicts, [], 'Same term spelled two ways; the rendered label is then build-order dependent');
    assert.deepEqual(mangled, [], 'Hugo humanized these; write the tag as it should read, or pin it with a term page');
});

test('pinned terms render their pinned label and keep their URL', { skip: !hasHugo }, t => {
    const { destination } = build(t);
    for (const [slug, label] of [['watchos', 'watchOS'], ['llama-cpp', 'llama.cpp']]) {
        const file = path.join(destination, 'tags', slug, 'index.html');
        assert.ok(fs.existsSync(file), `/tags/${slug}/ moved`);
        assert.equal(fs.readFileSync(file, 'utf8').match(/<title>(.*?) \|/)[1], label);
    }
});

test('MicroPrompt carries the labels a reader sees on the post', { skip: !hasHugo }, t => {
    const { destination } = build(t);
    const labels = [...page(destination, 'projects/microprompt')
        .match(/class=["']?post-tags["']?[^>]*>([\s\S]*?)<\/ul>/)[1]
        .matchAll(/\/tags\/([^/]+)\/["']?>([^<]+)</g)]
        .map(([, slug, label]) => `${slug}=${label}`);
    assert.deepEqual(labels, [
        'ai=AI', 'llm=LLM', 'on-device-ai=On-Device AI', 'quantization=Quantization',
        'apple-watch=Apple Watch', 'watchos=watchOS', 'swift=Swift', 'llama-cpp=llama.cpp'
    ]);
});
