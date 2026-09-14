// Content Atlas: chunk-level semantic map with in-browser neural search.
// Every dot is a paragraph, positioned by UMAP over MiniLM embeddings,
// colored by skill area. Search embeds the query locally (transformers.js)
// and cosine-ranks against int8-quantized chunk vectors.
// Dependencies: D3 (zoom/quadtree/contours); transformers.js lazy-loaded on demand.

const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm';

class Atlas {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        if (!this.container) return;

        this.chunks = [];
        this.skills = {};
        this.meta = null;
        this.hovered = null;
        this.pinned = null;
        this.hits = null;              // Map(index -> similarity) when a search is active
        this.transform = d3.zoomIdentity;
        this.contours = [];
        this.engine = null;            // transformers.js feature-extraction pipeline
        this.vectors = null;           // Int8Array of chunk embeddings
        this.vecNorms = null;
        this.reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;

        this.init();
    }

    /* ---------------- Theme ---------------- */

    // Canvas colors follow the site design tokens (design-system.css)
    theme() {
        const dark = document.documentElement.dataset.theme !== 'light';
        const css = getComputedStyle(document.documentElement);
        const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
        return {
            bg: token('--surface', dark ? '#16181B' : '#F1F3F5'),
            dot: token('--ink-2', dark ? '#A3A9B1' : '#5B6069'),
            contour: dark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(21, 23, 26, 0.09)',
            dimOpacity: dark ? 0.12 : 0.15,
            ring: token('--ink', dark ? '#F2F4F6' : '#15171A')
        };
    }

    /* ---------------- Init ---------------- */

    async init() {
        try {
            const res = await fetch(this.container.dataset.source || '/atlas/atlas.json');
            if (!res.ok) throw new Error('Failed to load atlas data');
            const data = await res.json();
            this.meta = data.meta;
            this.skills = data.skills || {};
            this.chunks = data.chunks;

            this.setupCanvas();
            this.computeContours();
            this.buildQuadtree();
            this.fitView();
            this.setupZoom();
            this.setupPointer();
            this.setupSearch();
            this.buildLegend();
            this.updateStats();
            this.draw();

            new MutationObserver(() => this.draw())
                .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

            let resizeTimer;
            window.addEventListener('resize', () => {
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(() => { this.setupCanvas(); this.fitView(); this.draw(); }, 200);
            });
        } catch (e) {
            console.error('Atlas initialization failed:', e);
            this.container.innerHTML = '<div class="atlas-error">Error loading atlas data.</div>';
        }
    }

    setupCanvas() {
        if (!this.canvas) {
            this.canvas = document.createElement('canvas');
            this.container.appendChild(this.canvas);
            this.ctx = this.canvas.getContext('2d');
        }
        const { width, height } = this.container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.width = width; this.height = height;
        this.canvas.width = width * dpr;
        this.canvas.height = height * dpr;
        this.canvas.style.width = width + 'px';
        this.canvas.style.height = height + 'px';
        this.dpr = dpr;
    }

    /* Density contours computed once in data space (grid mapped back). */
    computeContours() {
        const G = 720, PAD = 60;
        const xs = this.chunks.map(c => c.x), ys = this.chunks.map(c => c.y);
        const x0 = Math.min(...xs) - PAD, x1 = Math.max(...xs) + PAD;
        const y0 = Math.min(...ys) - PAD, y1 = Math.max(...ys) + PAD;
        const gx = x => (x - x0) / (x1 - x0) * G;
        const gy = y => (y - y0) / (y1 - y0) * G;
        const density = d3.contourDensity()
            .x(c => gx(c.x)).y(c => gy(c.y))
            .size([G, G]).bandwidth(14).thresholds(7)(this.chunks);
        // store polygons mapped back to data coords
        const dx = v => x0 + v / G * (x1 - x0);
        const dy = v => y0 + v / G * (y1 - y0);
        this.contours = density.map(c => ({
            polygons: c.coordinates.map(poly => poly.map(ring => ring.map(([px, py]) => [dx(px), dy(py)])))
        }));
        this.bounds = { x0, x1, y0, y1 };
    }

    buildQuadtree() {
        this.quadtree = d3.quadtree()
            .x(c => c.x).y(c => c.y)
            .addAll(this.chunks);
    }

    fitView() {
        const { x0, x1, y0, y1 } = this.bounds;
        const k = 0.92 * Math.min(this.width / (x1 - x0), this.height / (y1 - y0));
        const tx = this.width / 2 - k * (x0 + x1) / 2;
        const ty = this.height / 2 - k * (y0 + y1) / 2;
        this.transform = d3.zoomIdentity.translate(tx, ty).scale(k);
        if (this.zoom) d3.select(this.canvas).call(this.zoom.transform, this.transform);
    }

    setupZoom() {
        this.zoom = d3.zoom()
            .scaleExtent([0.2, 12])
            .on('zoom', ev => { this.transform = ev.transform; this.draw(); });
        d3.select(this.canvas).call(this.zoom).call(this.zoom.transform, this.transform);
        const get = id => document.getElementById(id);
        const zoomBy = f => d3.select(this.canvas)
            .transition().duration(this.reduceMotion ? 0 : 300)
            .call(this.zoom.scaleBy, f);
        if (get('atlas-zoom-in')) get('atlas-zoom-in').onclick = () => zoomBy(1.5);
        if (get('atlas-zoom-out')) get('atlas-zoom-out').onclick = () => zoomBy(1 / 1.5);
        if (get('atlas-fit')) get('atlas-fit').onclick = () => {
            this.pinned = null; this.hidePanel(); this.fitView(); this.draw();
        };
    }

    /* ---------------- Rendering ---------------- */

    dotRadius() {
        return 3.2 * Math.pow(this.transform.k, 0.25);
    }

    color(chunk) {
        return this.skills[chunk.skill]?.color || '#7A808A';
    }

    draw() {
        const t = this.theme();
        const ctx = this.ctx;
        const tr = this.transform;
        ctx.save();
        ctx.scale(this.dpr, this.dpr);
        ctx.fillStyle = t.bg;
        ctx.fillRect(0, 0, this.width, this.height);
        ctx.translate(tr.x, tr.y);
        ctx.scale(tr.k, tr.k);

        // Density contours (structure hint)
        ctx.strokeStyle = t.contour;
        ctx.lineWidth = 1 / tr.k;
        this.contours.forEach(c => {
            ctx.beginPath();
            c.polygons.forEach(poly => poly.forEach(ring => {
                ring.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
                ctx.closePath();
            }));
            ctx.stroke();
        });

        const r = this.dotRadius() / tr.k;
        const focus = this.pinned || this.hovered;
        const searching = this.hits !== null;

        this.chunks.forEach((c, i) => {
            const isHit = searching && this.hits.has(i);
            const isFocus = c === focus;
            const samePost = focus && c.post === focus.post;
            let alpha = 0.85;
            if (searching) alpha = isHit ? 1 : t.dimOpacity;
            else if (focus) alpha = (isFocus || samePost) ? 1 : 0.3;

            ctx.globalAlpha = alpha;
            ctx.fillStyle = this.color(c);
            ctx.beginPath();
            ctx.arc(c.x, c.y, isFocus ? r * 1.8 : (isHit ? r * 1.5 : r), 0, 2 * Math.PI);
            ctx.fill();

            if (isFocus || isHit) {
                ctx.globalAlpha = 1;
                ctx.strokeStyle = isFocus ? t.ring : this.color(c);
                ctx.lineWidth = 1.4 / tr.k;
                ctx.beginPath();
                ctx.arc(c.x, c.y, (isFocus ? r * 1.8 : r * 1.5) + 2.5 / tr.k, 0, 2 * Math.PI);
                ctx.stroke();
            }
        });
        ctx.globalAlpha = 1;
        ctx.restore();
    }

    /* ---------------- Pointer ---------------- */

    setupPointer() {
        const pick = ev => {
            const rect = this.canvas.getBoundingClientRect();
            const [mx, my] = [ev.clientX - rect.left, ev.clientY - rect.top];
            const [dxp, dyp] = this.transform.invert([mx, my]);
            const found = this.quadtree.find(dxp, dyp, 14 / this.transform.k);
            return found || null;
        };
        this.canvas.addEventListener('mousemove', ev => {
            const c = pick(ev);
            if (c !== this.hovered) {
                this.hovered = c;
                this.canvas.style.cursor = c ? 'pointer' : 'grab';
                if (!this.pinned) c ? this.showPanel(c, false) : this.hidePanel();
                this.draw();
            }
        });
        this.canvas.addEventListener('click', ev => {
            const c = pick(ev);
            if (c) {
                this.pinned = c;
                this.showPanel(c, true);
            } else {
                this.pinned = null;
                this.hidePanel();
            }
            this.draw();
        });
        this.canvas.addEventListener('mouseleave', () => {
            this.hovered = null;
            if (!this.pinned) this.hidePanel();
            this.draw();
        });
    }

    /* ---------------- Panel ---------------- */

    escape(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    showPanel(chunk, pinnedMode) {
        const panel = document.getElementById('atlas-panel');
        if (!panel) return;
        const skill = this.skills[chunk.skill];
        const href = chunk.anchor ? `${chunk.post}#${chunk.anchor}` : chunk.post;
        const sim = this.hits?.get(this.chunks.indexOf(chunk));
        panel.innerHTML = `
            ${pinnedMode ? '<button class="atlas-panel-close" title="Close" aria-label="Close details panel">&times;</button>' : ''}
            <div class="atlas-panel-meta">
                <span class="atlas-panel-section">${this.escape(chunk.section)}</span>
                ${skill ? `<span class="atlas-panel-skill"><span class="atlas-dot" style="background:${skill.color}"></span>${this.escape(skill.name)}</span>` : ''}
                ${sim !== undefined ? `<span class="atlas-panel-sim">similarity ${sim.toFixed(2)}</span>` : ''}
            </div>
            <div class="atlas-panel-title">${this.escape(chunk.title)}</div>
            ${chunk.heading ? `<div class="atlas-panel-heading">§ ${this.escape(chunk.heading)}</div>` : ''}
            <p class="atlas-panel-text">${this.escape(chunk.text)}</p>
            <a class="atlas-panel-open" href="${href}">Read in context &rarr;</a>
        `;
        panel.classList.add('visible');
        const closeBtn = panel.querySelector('.atlas-panel-close');
        if (closeBtn) closeBtn.onclick = () => { this.pinned = null; this.hidePanel(); this.draw(); };
    }

    hidePanel() {
        document.getElementById('atlas-panel')?.classList.remove('visible');
    }

    /* ---------------- Legend & stats ---------------- */

    buildLegend() {
        const legend = document.getElementById('atlas-legend');
        if (!legend) return;
        const counts = {};
        this.chunks.forEach(c => { if (c.skill) counts[c.skill] = (counts[c.skill] || 0) + 1; });
        legend.innerHTML = Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .map(([id, n]) => {
                const s = this.skills[id];
                return `<div class="atlas-legend-item"><span class="atlas-dot" style="background:${s.color}"></span>${this.escape(s.name)} <span class="atlas-legend-count">${n}</span></div>`;
            }).join('');
    }

    updateStats() {
        const el = document.getElementById('atlas-stats');
        if (!el) return;
        const m = this.meta;
        el.innerHTML = `${m.count} paragraphs &middot; ${m.posts} posts &middot; embedded with <code>${this.escape(m.model.split('/').pop())}</code> (${m.dims}-d) &middot; UMAP projection &middot; search runs entirely in your browser`;
    }

    /* ---------------- In-browser semantic search ---------------- */

    setStatus(msg, spinning) {
        const el = document.getElementById('atlas-search-status');
        if (!el) return;
        el.textContent = msg || '';
        el.classList.toggle('spinning', !!spinning);
    }

    async ensureEngine() {
        if (this.engine) return;
        if (this._enginePromise) return this._enginePromise;
        this._enginePromise = (async () => {
            this.setStatus('Downloading model to your browser (~25 MB, cached after first load)…', true);
            const [mod, binRes] = await Promise.all([
                import(TRANSFORMERS_CDN),
                fetch('/atlas/atlas-vectors.bin')
            ]);
            if (!binRes.ok) throw new Error('vectors unavailable');
            const buf = await binRes.arrayBuffer();
            this.vectors = new Int8Array(buf);
            const D = this.meta.dims;
            this.vecNorms = new Float32Array(this.chunks.length);
            for (let i = 0; i < this.chunks.length; i++) {
                let s = 0;
                for (let d = 0; d < D; d++) { const v = this.vectors[i * D + d]; s += v * v; }
                this.vecNorms[i] = Math.sqrt(s) || 1;
            }
            mod.env.allowLocalModels = false;
            let lastPct = -1;
            this.engine = await mod.pipeline('feature-extraction', this.meta.model, {
                dtype: 'q8',
                progress_callback: p => {
                    if (p.status === 'progress' && p.total) {
                        const pct = Math.round(p.loaded / p.total * 100);
                        if (pct !== lastPct) {
                            lastPct = pct;
                            this.setStatus(`Downloading model to your browser… ${pct}%`, true);
                        }
                    }
                }
            });
            this.setStatus('Model ready — your query never leaves this page.');
        })().catch(e => {
            this._enginePromise = null;
            this.setStatus('Could not load the search model (network blocked?). The map still works.');
            throw e;
        });
        return this._enginePromise;
    }

    async runSearch(query) {
        query = query.trim();
        const resultsEl = document.getElementById('atlas-search-results');
        if (!query) { this.clearSearch(); return; }
        try {
            await this.ensureEngine();
        } catch (e) { return; }

        this.setStatus('Searching…', true);
        const out = await this.engine(query, { pooling: 'mean', normalize: true });
        const q = out.data; // Float32Array, unit norm
        const D = this.meta.dims;
        const scored = [];
        for (let i = 0; i < this.chunks.length; i++) {
            let dot = 0;
            for (let d = 0; d < D; d++) dot += q[d] * this.vectors[i * D + d];
            scored.push({ i, sim: dot / this.vecNorms[i] });
        }
        scored.sort((a, b) => b.sim - a.sim);
        const top = scored.slice(0, 8);

        this.hits = new Map(top.map(s => [s.i, s.sim]));
        this.pinned = null;
        this.hidePanel();
        this.draw();
        this.setStatus(`Top matches for “${query}” — cosine similarity, computed locally.`);

        if (resultsEl) {
            resultsEl.innerHTML = top.map(s => {
                const c = this.chunks[s.i];
                const skill = this.skills[c.skill];
                const pct = Math.round(Math.max(0, s.sim) * 100);
                return `<button class="atlas-result" data-i="${s.i}">
                    <span class="atlas-result-bar" style="width:${pct}%; background:${skill?.color || '#7A808A'}"></span>
                    <span class="atlas-result-sim">${s.sim.toFixed(2)}</span>
                    <span class="atlas-result-body"><b>${this.escape(c.title)}</b>${c.heading ? ' § ' + this.escape(c.heading) : ''}<br><span class="atlas-result-text">${this.escape(c.text.slice(0, 140))}…</span></span>
                </button>`;
            }).join('');
            resultsEl.classList.add('visible');
            resultsEl.querySelectorAll('.atlas-result').forEach(btn => {
                btn.onclick = () => {
                    const c = this.chunks[+btn.dataset.i];
                    this.pinned = c;
                    this.centerOn(c);
                    this.showPanel(c, true);
                    this.draw();
                };
            });
        }
    }

    clearSearch() {
        this.hits = null;
        const resultsEl = document.getElementById('atlas-search-results');
        if (resultsEl) { resultsEl.innerHTML = ''; resultsEl.classList.remove('visible'); }
        this.setStatus(this.engine ? 'Model ready — your query never leaves this page.' : '');
        this.draw();
    }

    centerOn(chunk) {
        const k = Math.max(this.transform.k, 2.5);
        const t = d3.zoomIdentity
            .translate(this.width / 2 - k * chunk.x, this.height / 2 - k * chunk.y)
            .scale(k);
        d3.select(this.canvas)
            .transition().duration(this.reduceMotion ? 0 : 500)
            .call(this.zoom.transform, t);
    }

    setupSearch() {
        const form = document.getElementById('atlas-search-form');
        const input = document.getElementById('atlas-search');
        const clearBtn = document.getElementById('atlas-search-clear');
        if (!form || !input) return;

        // Kick off model download on first focus so it's ready by first query
        input.addEventListener('focus', () => { this.ensureEngine().catch(() => {}); }, { once: true });
        form.addEventListener('submit', ev => {
            ev.preventDefault();
            this.runSearch(input.value);
        });
        input.addEventListener('keydown', ev => {
            if (ev.key === 'Escape') { input.value = ''; this.clearSearch(); input.blur(); }
        });
        if (clearBtn) clearBtn.onclick = () => { input.value = ''; this.clearSearch(); };
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.ContentAtlas = new Atlas('atlas-container');
});
