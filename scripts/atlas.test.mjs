import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { quadtree, zoom as d3zoom, zoomIdentity } from 'd3';
import { anchorize, collectChunks, committedPositions, projectVectors } from './build_atlas.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJSON = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const skills = readJSON('data/skills.json').skills;
const atlas = readJSON('assets/atlas/atlas.json');
const cache = readJSON('scripts/atlas-cache.json');
const vectors = atlas.chunks.map(c => cache[crypto.createHash('sha256')
    .update(atlas.meta.model + '\n' + c.text).digest('hex').slice(0, 16)]);

test('discovers standalone posts, nested posts and leaf bundles, excluding drafts/resources', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-content-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const post = (file, draft = false) => {
        const target = path.join(dir, 'content', file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `---\ntitle: "Example"\ndraft: ${draft}\ntags: ["hugo"]\n---\n## Build notes\n\nThis is a sufficiently long paragraph about building a personal website with useful tools and practical engineering techniques.\n`);
    };
    post('projects/flat.md');
    post('projects/bundle/index.md');
    post('projects/bundle/resource.md');
    post('projects/bundle/nested/resource.md');
    post('projects/draft/index.md', true);
    post('writing/nested/post.md');
    post('writing/nested/_index.md');
    post('writing/_index.md');
    post('writing/draft.md', true);
    const chunks = collectChunks(dir, skills);
    assert.deepEqual(chunks.map(c => c.post), [
        '/projects/bundle/', '/projects/flat/', '/writing/nested/post/'
    ]);
    assert.ok(chunks.every(c => c.title === 'Example' && c.anchor === 'build-notes' && c.skill === 'software-craft'));
    assert.deepEqual(collectChunks(dir, skills), chunks);
});

test('generated Atlas is current and includes the MicroPrompt bundle and deep links', () => {
    assert.deepEqual(atlas.chunks.map(({ x, y, ...c }) => c), collectChunks(root, skills));
    assert.equal(atlas.meta.count, atlas.chunks.length);
    assert.equal(atlas.meta.posts, new Set(atlas.chunks.map(c => c.post)).size);
    const micro = atlas.chunks.filter(c => c.post === '/projects/microprompt/');
    assert.ok(micro.length > 0);
    assert.ok(micro.some(c => c.anchor === 'getting-llamacpp-to-build-for-the-s5'));
    assert.ok(micro.every(c => c.title.startsWith('MicroPrompt:') && c.skill === 'llm-engineering'));
});

test('search vectors match chunk order and the regenerated embedding cache', () => {
    const bytes = fs.readFileSync(path.join(root, 'assets/atlas/atlas-vectors.bin'));
    const quantized = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(bytes.length, atlas.meta.count * atlas.meta.dims);
    vectors.forEach((v, i) => {
        assert.equal(v?.length, atlas.meta.dims);
        v.forEach((value, d) => {
            assert.ok(Math.abs(quantized[i * atlas.meta.dims + d] * atlas.meta.quantScale - value)
                <= atlas.meta.quantScale / 2 + 0.000001);
        });
    });
});

/* Not "UMAP is deterministic": it is only reproducible within one V8 build,
   because umap-js uses Math.pow/log/exp. What has to hold is that a rebuild of
   unchanged content reuses the committed layout, so CI and a laptop produce the
   same bytes. Reprojection itself only has to be sane and stable in-process. */
test('a rebuild of unchanged content keeps the committed layout', () => {
    const reused = committedPositions(collectChunks(root, skills), path.join(root, 'assets/atlas'));
    assert.deepEqual(reused, atlas.chunks.map(c => [c.x, c.y]));
});

test('the committed layout is dropped when the chunk set changes', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-layout-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const write = data => fs.writeFileSync(path.join(dir, 'atlas.json'), JSON.stringify(data));
    const chunks = collectChunks(root, skills);
    const current = { meta: atlas.meta, chunks: atlas.chunks };

    write(current);
    assert.deepEqual(committedPositions(chunks, dir), atlas.chunks.map(c => [c.x, c.y]));

    write({ ...current, chunks: current.chunks.slice(0, -1) });
    assert.equal(committedPositions(chunks, dir), null, 'a new paragraph must reproject');

    write({ ...current, meta: { ...atlas.meta, model: 'other/model' } });
    assert.equal(committedPositions(chunks, dir), null, 'a model change must reproject');

    write({ ...current, chunks: current.chunks.map((c, i) => i ? c : { ...c, text: c.text + '!' }) });
    assert.equal(committedPositions(chunks, dir), null, 'edited text must reproject');

    fs.writeFileSync(path.join(dir, 'atlas.json'), '{ not json');
    assert.equal(committedPositions(chunks, dir), null, 'unreadable layout must reproject');
});

test('reprojection is stable in-process, finite, and free of negative zero', async () => {
    const points = await projectVectors(vectors);
    assert.deepEqual(await projectVectors(vectors), points);
    assert.equal(points.length, vectors.length);
    assert.ok(points.flat().every(v => Number.isFinite(v) && !Object.is(v, -0)));
    assert.ok(points.flat().every(v => Math.abs(v) <= 400));
    for (const count of [0, 1, 2]) {
        const tiny = await projectVectors(vectors.slice(0, count));
        assert.equal(tiny.length, count);
        assert.ok(tiny.flat().every(Number.isFinite));
    }
});

/* Layout quality, not correctness: a new post can legitimately land far from
   everything else. ATLAS_LAYOUT_ADVISORY downgrades it to a warning so it
   reports on a deploy instead of blocking one; PR runs leave it strict. */
test('no island consumes more than a quarter of the map diagonal in empty space', () => {
    // Longest minimum-spanning-tree edge measures the largest inter-island
    // gap without depending on orientation or any hardcoded skill positions.
    const points = atlas.chunks;
    const seen = new Set();
    const distances = points.map(() => Infinity);
    distances[0] = 0;
    let longest = 0;
    while (seen.size < points.length) {
        let next = -1;
        distances.forEach((d, i) => {
            if (!seen.has(i) && (next < 0 || d < distances[next])) next = i;
        });
        longest = Math.max(longest, distances[next]);
        seen.add(next);
        points.forEach((p, i) => {
            distances[i] = Math.min(distances[i], Math.hypot(p.x - points[next].x, p.y - points[next].y));
        });
    }
    const spans = ['x', 'y'].map(d => Math.max(...points.map(p => p[d])) - Math.min(...points.map(p => p[d])));
    const share = longest / Math.hypot(...spans);
    const message = `Detached cluster is shrinking the fitted map: widest gap is ${(share * 100).toFixed(0)}% of the diagonal`;
    if (share >= 0.25 && process.env.ATLAS_LAYOUT_ADVISORY) {
        console.log(`::warning file=assets/atlas/atlas.json::${message}`);
        return;
    }
    assert.ok(share < 0.25, message);
});

test('hover previews remain inert, pinned details are interactive, and navigation suppresses hover', () => {
    const classes = new Set();
    const close = {};
    const panel = {
        classList: {
            add: (...names) => names.forEach(n => classes.add(n)),
            remove: (...names) => names.forEach(n => classes.delete(n)),
            toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)
        },
        querySelector: () => classes.has('pinned') ? close : null
    };
    const context = vm.createContext({
        document: { addEventListener() {}, getElementById: () => panel },
        d3: { quadtree, zoomIdentity }
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'assets/js/atlas.js'), 'utf8'), context);
    const Atlas = vm.runInContext('Atlas', context);
    const a = Object.create(Atlas.prototype);
    const chunk = { x: 20, y: 20, post: '/projects/example/', title: 'Example', section: 'projects', text: 'Example paragraph' };
    const handlers = {};
    Object.assign(a, {
        chunks: [chunk], skills: {}, transform: zoomIdentity, draw() {},
        canvas: {
            style: {}, getBoundingClientRect: () => ({ left: 0, top: 0 }),
            addEventListener: (name, handler) => { handlers[name] = handler; }
        }
    });
    a.buildQuadtree();
    a.setupPointer();
    const event = { clientX: 20, clientY: 20 };
    handlers.mousemove(event);
    assert.equal(a.hovered, chunk);
    assert.ok(classes.has('visible'));
    assert.ok(!classes.has('pinned'));
    assert.equal(panel.inert, true);

    handlers.click(event);
    handlers.mouseleave();
    assert.equal(a.pinned, chunk);
    assert.ok(classes.has('visible') && classes.has('pinned'));
    assert.equal(panel.inert, false);
    close.onclick();
    assert.equal(a.pinned, null);
    assert.ok(!classes.has('visible') && !classes.has('pinned'));
    assert.equal(panel.inert, true);

    a.navigating = true;
    handlers.mousemove(event);
    assert.equal(a.hovered, null);
    assert.ok(!classes.has('visible'));
});

/* The cases below are the ground truth Hugo produced for these exact headings;
   re-probe with a scratch site before changing any of them. */
test('anchors match the IDs Hugo generates for awkward headings', () => {
    const cases = {
        'Scan → Deep Dive → Backtrack': 'scan--deep-dive--backtrack',
        'Plain Don\'t quote "me"': 'plain-dont-quote-me',
        'Café naïve résumé': 'café-naïve-résumé',
        'Ünicode Ätdräss': 'ünicode-ätdräss',
        'under_score and-hyphen': 'under_score-and-hyphen',
        'A -- double hyphen': 'a--double-hyphen',
        'An --- em rule': 'an--em-rule',
        'Ellipsis ... here': 'ellipsis--here',
        'Ampersand & Co.': 'ampersand--co',
        'Слово по-русски': 'слово-по-русски',
        'a  double  space': 'a--double--space',
        '[Link text](https://example.com/x) after': 'link-text-after',
        '`code_span` and **b** and *i*': 'code_span-and-b-and-i',
        'Source code can be found here: [Github - Corrective RAG OpenEvals](https://example.com/x)':
            'source-code-can-be-found-here-github---corrective-rag-openevals',
        '5. SSL Certificate with Let\'s Encrypt': '5-ssl-certificate-with-lets-encrypt'
    };
    for (const [heading, id] of Object.entries(cases)) assert.equal(anchorize(heading), id, heading);
});

/* Harness mirroring the browser closely enough to drive atlas.js directly. */
function mount(chunks) {
    const classes = new Set();
    const close = {};
    const link = { clicked: 0, click() { this.clicked++; } };
    const panel = {
        classList: {
            add: (...n) => n.forEach(x => classes.add(x)),
            remove: (...n) => n.forEach(x => classes.delete(x)),
            toggle: (n, on) => on ? classes.add(n) : classes.delete(n)
        },
        querySelector: sel => sel === '.atlas-panel-open'
            ? (classes.has('visible') ? link : null)
            : (classes.has('pinned') ? close : null)
    };
    const calls = [];
    const selection = { call: (fn, ...args) => { calls.push([fn, args]); return selection; } };
    const context = vm.createContext({
        document: { addEventListener() {}, getElementById: () => panel },
        requestAnimationFrame: null,
        d3: { quadtree, zoom: d3zoom, zoomIdentity, select: () => selection }
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'assets/js/atlas.js'), 'utf8'), context);
    const a = Object.create(vm.runInContext('Atlas', context).prototype);
    const handlers = {};
    const listener = (name, handler) => { handlers[name] = handler; };
    Object.assign(a, {
        chunks, skills: {}, transform: zoomIdentity, hits: null,
        pinned: null, hovered: null, navigating: false, userMoved: false,
        draw() {}, fitView() { this.fitted = (this.fitted || 0) + 1; },
        centerOn(c) { this.userMoved = true; this.centered = c; },
        zoom: { translateBy: 'translateBy' },
        zoomBy: f => calls.push(['zoomBy', f]),
        container: { addEventListener: listener },
        canvas: { style: {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), addEventListener: listener }
    });
    a.buildQuadtree();
    return { a, handlers, classes, close, link, calls, panel };
}

test('a plain click pins without blinking the hover preview away', () => {
    const chunk = { x: 20, y: 20, post: '/p/a/', title: 'A', section: 'projects', text: 'a' };
    const { a, handlers, classes } = mount([chunk]);
    a.setupPointer();
    handlers.mousemove({ clientX: 20, clientY: 20 });
    assert.ok(classes.has('visible'), 'hover preview is up');

    a.setupZoom();
    a.zoom.on('start')();                       // d3 fires this on every mousedown
    assert.ok(classes.has('visible'), 'mousedown alone must not hide the preview');
    assert.equal(a.navigating, true);

    // An actual drag does clear it, and marks the view as the reader's.
    a.zoom.on('zoom')({ transform: zoomIdentity, sourceEvent: { type: 'mousemove' } });
    assert.equal(a.hovered, null);
    assert.ok(!classes.has('visible'));
    assert.equal(a.userMoved, true);

    // A programmatic transform (fit, centerOn) is not the reader moving.
    a.userMoved = false;
    a.zoom.on('zoom')({ transform: zoomIdentity });
    assert.equal(a.userMoved, false);
});

test('keyboard drives the map: step, open, pan, zoom, reset, clear', () => {
    const chunks = [
        { x: 0, y: 0, post: '/p/a/', title: 'A', section: 'projects', text: 'a', anchor: 'x' },
        { x: 40, y: 40, post: '/p/b/', title: 'B', section: 'writing', text: 'b' }
    ];
    const { a, handlers, classes, link, calls } = mount(chunks);
    a.setupKeyboard();
    const key = (k, extra = {}) => {
        let prevented = false;
        handlers.keydown({ key: k, preventDefault: () => { prevented = true; }, ...extra });
        return prevented;
    };

    assert.ok(key('n'));
    assert.equal(a.pinned, chunks[0]);
    assert.equal(a.centered, chunks[0]);
    assert.ok(classes.has('visible') && classes.has('pinned'));

    assert.ok(key('n'));
    assert.equal(a.pinned, chunks[1]);
    assert.ok(key('p'));
    assert.equal(a.pinned, chunks[0]);
    assert.ok(key('p'), 'wraps backwards past the start');
    assert.equal(a.pinned, chunks[1]);

    assert.ok(key('Enter'));
    assert.equal(link.clicked, 1, 'Enter follows the pinned paragraph');

    assert.ok(key('ArrowRight'));
    assert.equal(a.userMoved, true);
    assert.equal(calls.at(-1)[0], 'translateBy');
    const [dx, dy] = calls.at(-1)[1];
    assert.ok(dx < 0 && dy === 0);
    key('ArrowRight', { shiftKey: true });
    assert.ok(Math.abs(calls.at(-1)[1][0]) > Math.abs(dx), 'shift pans further');

    assert.ok(key('+'));
    assert.equal(calls.at(-1)[0], 'zoomBy');
    assert.ok(calls.at(-1)[1] > 1);
    assert.ok(key('-'));
    assert.ok(calls.at(-1)[1] < 1);

    assert.ok(key('0'));
    assert.equal(a.userMoved, false);
    assert.equal(a.pinned, null);
    assert.equal(a.fitted, 1);

    a.pinned = chunks[0];
    assert.ok(key('Escape'));
    assert.equal(a.pinned, null);
    assert.ok(!classes.has('visible'));

    assert.equal(key('q'), false, 'unhandled keys fall through to the browser');
    assert.equal(key('n', { metaKey: true }), false, 'browser shortcuts are left alone');
});

test('n and p walk the search hits while a search is active', () => {
    const chunks = [
        { x: 0, y: 0, post: '/p/a/', title: 'A', section: 'projects', text: 'a' },
        { x: 40, y: 40, post: '/p/b/', title: 'B', section: 'writing', text: 'b' },
        { x: 80, y: 80, post: '/p/c/', title: 'C', section: 'writing', text: 'c' }
    ];
    const { a, handlers } = mount(chunks);
    a.setupKeyboard();
    a.hits = new Map([[2, 0.9], [0, 0.4]]);     // best match first, skipping chunk 1
    handlers.keydown({ key: 'n', preventDefault() {} });
    assert.equal(a.pinned, chunks[2]);
    handlers.keydown({ key: 'n', preventDefault() {} });
    assert.equal(a.pinned, chunks[0]);
});

/* Skill matching is exact string equality on lowercased taxonomy terms, in both
   build_atlas.mjs and layouts/graph/list.json. A tag that is capitalised or
   misspelled here does not error, it just silently never matches. */
test('every skills.json tag and category is lowercase and matches real content', () => {
    const terms = { tags: new Set(), categories: new Set() };
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(file);
        if (!entry.name.endsWith('.md') || entry.name.startsWith('_')) return;
        const front = fs.readFileSync(file, 'utf8').match(/^---\s*\n([\s\S]*?)\n---/)?.[1];
        for (const key of Object.keys(terms)) {
            front?.match(new RegExp(`^${key}:\\s*\\[(.*)\\]`, 'm'))?.[1]
                .split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
                .forEach(v => terms[key].add(v.toLowerCase()));
        }
    });
    ['projects', 'writing'].forEach(s => walk(path.join(root, 'content', s)));

    for (const skill of skills) {
        for (const [key, values] of [['tags', skill.tags], ['categories', skill.categories]]) {
            for (const value of values || []) {
                assert.equal(value, value.toLowerCase(), `${skill.id}: ${key} entry "${value}" must be lowercase`);
                assert.ok(terms[key].has(value), `${skill.id}: ${key} entry "${value}" matches no post`);
            }
        }
    }
});
