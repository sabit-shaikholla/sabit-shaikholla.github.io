// Knowledge Graph Visualization
// Features: community detection (label propagation), cluster hulls with auto-labels,
// fuzzy search, section filters, click-to-inspect details panel, theme awareness.
// Dependencies: D3.js, Force-Graph

class KnowledgeGraph {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        if (!this.container) return;

        this.graph = null;
        this.rawData = { nodes: [], links: [] };   // full dataset
        this.data = { nodes: [], links: [] };      // filtered dataset

        // State
        this.highlightNodes = new Set();
        this.highlightLinks = new Set();
        this.hoverNode = null;
        this.selectedNode = null;
        this.adjacency = new Map();               // id -> Map(otherId -> weight)
        this.activeFilters = new Set();           // sections currently hidden
        this.clusters = new Map();                // clusterId -> { label, color }
        this.mode = '2d';                         // '2d' | '3d'
        this.layoutMode = 'force';                // 'force' | 'semantic'
        this.positions = null;                    // id -> [x, y] in embedding space (PCA)
        this.semanticMeta = null;                 // { model, count } from embeddings.json
        this.nodeById = new Map();
        this.reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;

        // Community palette: the seven skill colors from data/skills.json (validated for
        // colorblind separation and 3:1 contrast on both theme surfaces), then a neutral
        // "other" gray so an eighth cluster never gets a made-up hue
        this.palette = [
            '#0B8BA3', '#5A5FD8', '#BC7612', '#B8508A', '#3E8E41', '#2F7FD1', '#D0583A',
            '#7A808A'
        ];

        this.init();
    }

    /* ---------------- Theme ---------------- */

    // Canvas colors follow the site design tokens (design-system.css)
    theme() {
        const dark = document.documentElement.dataset.theme !== 'light';
        const css = getComputedStyle(document.documentElement);
        const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
        const ink = token('--ink', dark ? '#F2F4F6' : '#15171A');
        return {
            bg: token('--surface', dark ? '#16181B' : '#F1F3F5'),
            panelBg: dark ? 'rgba(22, 24, 27, 0.78)' : 'rgba(241, 243, 245, 0.82)',
            text: ink,
            textMuted: token('--ink-2', dark ? '#A3A9B1' : '#5B6069'),
            ring: ink,
            link: dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(21, 23, 26, 0.16)',
            linkHighlight: dark ? 'rgba(69, 198, 219, 0.7)' : 'rgba(8, 117, 138, 0.6)',
            hullOpacity: dark ? 0.07 : 0.08,
            dimOpacity: dark ? 0.1 : 0.14
        };
    }

    watchTheme() {
        new MutationObserver(() => {
            if (this.graph) this.graph.backgroundColor(this.theme().bg);
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    /* ---------------- Init ---------------- */

    async init() {
        try {
            const dataUrl = this.container.dataset.source || '/graph/index.json';
            const res = await fetch(dataUrl);
            if (!res.ok) throw new Error('Failed to load graph data');

            this.rawData = await res.json();
            await this.mergeSemanticLinks();
            this.buildAdjacency(this.rawData);
            this.detectCommunities(this.rawData);
            this.applyFilters();
            this.createGraph();
            this.setupUI();
            this.watchTheme();
        } catch (e) {
            console.error('Graph initialization failed:', e);
            this.container.innerHTML = '<div class="graph-error">Error loading graph data.</div>';
        }
    }

    /* Merge AI-embedding similarity edges (assets/graph/embeddings.json) into
       the tag-based edge set. Hybrid weight = tag overlap + semantic similarity.
       The URL is fingerprinted by the template, so it always matches this build. */
    async mergeSemanticLinks() {
        try {
            const url = this.container.dataset.embeddings;
            if (!url) return;
            const res = await fetch(url);
            if (!res.ok) return;
            const semantic = await res.json();
            // The generator writes root-relative post ids; node ids carry the
            // site's base path. They only coincide when the site is at the root.
            const base = (this.container.dataset.source || '/').replace(/explore\/graph\/index\.json$/, '');
            const localize = id => id.startsWith('skill:') ? id : base + id.replace(/^\//, '');
            this.positions = semantic.positions
                ? Object.fromEntries(Object.entries(semantic.positions).map(([id, p]) => [localize(id), p]))
                : null;
            if (!semantic.links?.length) return;
            this.semanticMeta = { model: semantic.model, count: semantic.links.length };

            const byPair = new Map();
            this.rawData.links.forEach(l => {
                byPair.set([l.source, l.target].sort().join('|'), l);
            });

            semantic.links.forEach(raw => {
                const sl = { ...raw, source: localize(raw.source), target: localize(raw.target) };
                const key = [sl.source, sl.target].sort().join('|');
                const existing = byPair.get(key);
                if (existing) {
                    existing.tagWeight = existing.value || 0; // preserve breakdown for tooltips
                    existing.value = existing.tagWeight + Math.round(sl.similarity * 4);
                    existing.semantic = true;
                    existing.similarity = sl.similarity;
                } else {
                    const link = {
                        source: sl.source, target: sl.target,
                        value: Math.max(1, Math.round(sl.similarity * 4)),
                        semantic: true, semanticOnly: true, similarity: sl.similarity
                    };
                    this.rawData.links.push(link);
                    byPair.set(key, link);
                }
            });
        } catch (e) {
            console.info('Semantic graph data unavailable, using tag-based links only.');
        }
    }

    buildAdjacency(data) {
        this.adjacency.clear();
        this.nodeById = new Map(data.nodes.map(n => [n.id, n]));
        data.nodes.forEach(n => this.adjacency.set(n.id, new Map()));
        data.links.forEach(l => {
            const s = this.linkEnd(l.source), t = this.linkEnd(l.target);
            this.adjacency.get(s).set(t, l.value || 1);
            this.adjacency.get(t).set(s, l.value || 1);
        });
        data.nodes.forEach(n => {
            n.val = this.adjacency.get(n.id).size; // degree for sizing
        });
    }

    linkEnd(end) {
        return typeof end === 'object' ? end.id : end;
    }

    /* Seeded PRNG (mulberry32) so community detection is deterministic:
       same content -> same clusters, colors, and legend on every load. */
    seededRandom(seed) {
        return () => {
            seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /* Weighted label propagation seeded by skill hubs: skills are locked to
       their own label, so posts converge onto skill-anchored communities and
       clusters inherit the skill's curated name and color. Posts that end up
       in a skill-free community fall back to tag-frequency labels. */
    detectCommunities(data) {
        const byId = new Map(data.nodes.map(n => [n.id, n]));
        const labelOf = new Map(data.nodes.map(n => [n.id, n.id]));
        const locked = new Set(data.nodes.filter(n => n.section === 'skill').map(n => n.id));

        // Seed each post with its strongest skill so propagation starts from
        // the curated taxonomy instead of coalescing on an arbitrary post
        data.nodes.forEach(n => {
            if (locked.has(n.id)) return;
            let best = null, bestW = 0;
            (this.adjacency.get(n.id) || new Map()).forEach((w, otherId) => {
                if (locked.has(otherId) && w > bestW) { bestW = w; best = otherId; }
            });
            if (best) labelOf.set(n.id, best);
        });

        const ids = data.nodes.map(n => n.id).sort();
        const rand = this.seededRandom(ids.length * 2654435761);

        for (let iter = 0; iter < 12; iter++) {
            let changed = false;
            // stable shuffle for tie-breaking (seeded, so identical across loads)
            const order = [...ids]
                .map(id => ({ id, k: rand() }))
                .sort((a, b) => a.k - b.k)
                .map(o => o.id);
            for (const id of order) {
                if (locked.has(id)) continue;
                const scores = new Map(); // label -> total edge weight
                this.adjacency.get(id).forEach((w, otherId) => {
                    const lbl = labelOf.get(otherId);
                    // skill anchors count a bit extra so hubs win close ties
                    scores.set(lbl, (scores.get(lbl) || 0) + w * (locked.has(lbl) ? 1.5 : 1));
                });
                if (!scores.size) continue;
                let best = labelOf.get(id), bestScore = -1;
                scores.forEach((score, lbl) => {
                    if (score > bestScore) { bestScore = score; best = lbl; }
                });
                if (best !== labelOf.get(id)) { labelOf.set(id, best); changed = true; }
            }
            if (!changed) break;
        }

        // Renumber clusters 0..k; skill-anchored clusters take the skill's
        // name and color, the rest get top shared tags + palette colors
        const remap = new Map();
        const members = new Map();
        data.nodes.forEach(n => {
            const raw = labelOf.get(n.id);
            if (!remap.has(raw)) {
                remap.set(raw, remap.size);
                members.set(remap.get(raw), []);
            }
            const cid = remap.get(raw);
            n.cluster = cid;
            members.get(cid).push(n);
        });

        this.clusters.clear();
        remap.forEach((cid, raw) => {
            const nodes = members.get(cid);
            const anchor = locked.has(raw) ? byId.get(raw) : null;
            if (anchor) {
                this.clusters.set(cid, {
                    label: anchor.name,
                    color: anchor.color || this.palette[cid % this.palette.length],
                    skill: true
                });
                return;
            }
            const tagFreq = {};
            nodes.forEach(n => (n.tags || []).forEach(t => tagFreq[t] = (tagFreq[t] || 0) + 1));
            const top = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]);
            this.clusters.set(cid, {
                label: top.length ? top.join(' · ') : (nodes[0].section || 'misc'),
                color: this.palette[cid % this.palette.length]
            });
        });
    }

    applyFilters() {
        const hidden = this.activeFilters;
        const nodes = this.rawData.nodes.filter(n => !hidden.has(n.section));
        const ids = new Set(nodes.map(n => n.id));
        const links = this.rawData.links.filter(l => {
            const s = this.linkEnd(l.source), t = this.linkEnd(l.target);
            return ids.has(s) && ids.has(t);
        }).map(l => ({
            source: this.linkEnd(l.source), target: this.linkEnd(l.target),
            value: l.value, semantic: l.semantic, semanticOnly: l.semanticOnly,
            similarity: l.similarity, tagWeight: l.tagWeight, kind: l.kind
        }));

        // Fresh node copies so the force simulation doesn't carry stale positions across filters
        this.data = { nodes: nodes.map(n => ({ ...n })), links };
        this.buildAdjacency(this.data);
        this.applyLayout(false);
        if (this.graph) {
            this._didInitialFit = false; // fresh nodes start at origin: refit after settle
            this.graph.graphData(this.data);
        }
    }

    /* ---------------- Rendering ---------------- */

    createGraph() {
        if (this.mode === '3d') this.createGraph3D();
        else this.createGraph2D();
    }

    /* Config shared by both renderers. */
    applyCommon(g, width, height, t) {
        g.width(width)
            .height(height)
            .backgroundColor(t.bg)
            .graphData(this.data)
            .nodeId('id')

            // Physics: strong ties pull closer
            .d3Force('charge', d3.forceManyBody().strength(-160))
            .d3Force('link', d3.forceLink().id(n => n.id)
                .distance(l => 90 / Math.min(l.value || 1, 4))
                .strength(l => Math.min(0.2 * (l.value || 1), 0.9)))

            // Nodes
            .nodeRelSize(4)
            .nodeVal(n => this.nodeVal(n))
            .nodeColor(n => this.clusters.get(n.cluster)?.color)

            // Links: thicker & brighter with shared-tag weight; skill membership
            // edges are tinted with the skill's color
            .linkColor(l => {
                if (this.highlightLinks.has(l)) return this.theme().linkHighlight;
                if (l.kind === 'skill') {
                    const skill = this.nodeById.get(this.linkEnd(l.source));
                    if (skill?.color) {
                        const { r, g, b } = this.hexToRgb(skill.color);
                        return `rgba(${r},${g},${b},0.22)`;
                    }
                }
                return this.theme().link;
            })
            .linkWidth(l => this.highlightLinks.has(l) ? 1.6 : 0.5 + 0.35 * Math.min(l.value || 1, 5))
            .linkDirectionalParticles(l => (!this.reduceMotion && this.highlightLinks.has(l)) ? 2 : 0)
            .linkDirectionalParticleWidth(1.5)
            .linkLabel(l => this.linkTooltip(l))

            // Interactions
            .onNodeHover(node => this.handleHover(node))
            .onNodeClick(node => this.selectNode(node))
            .onBackgroundClick(() => this.deselect());
        return g;
    }

    nodeVal(n) {
        // Skill hubs get a size boost so they read as anchors
        return n.val * 0.8 + 2 + (n.section === 'skill' ? 4 : 0);
    }

    nodeRadius(n) {
        return Math.sqrt(Math.max(0, this.nodeVal(n))) * 4;
    }

    /* Hover tooltip on edges: explains WHY two nodes are connected. */
    linkTooltip(l) {
        const parts = [];
        if (l.kind === 'skill') parts.push('skill membership');
        if (l.tagWeight || (!l.semanticOnly && l.kind !== 'skill')) {
            const n = l.tagWeight ?? l.value;
            parts.push(`${n} shared tag${n === 1 ? '' : 's'}`);
        }
        if (l.similarity) parts.push(`semantic similarity ${l.similarity.toFixed(2)}`);
        if (!parts.length) return null;
        const s = this.nodeById.get(this.linkEnd(l.source));
        const t = this.nodeById.get(this.linkEnd(l.target));
        return `<div class="graph-tip"><b>${this.escape(s?.name || '')} &harr; ${this.escape(t?.name || '')}</b><span>${parts.join(' &middot; ')}</span></div>`;
    }

    /* Animation durations collapse to 0 under prefers-reduced-motion */
    anim(ms) {
        return this.reduceMotion ? 0 : ms;
    }

    createGraph2D() {
        const { width, height } = this.container.getBoundingClientRect();
        const t = this.theme();

        this.graph = this.applyCommon(ForceGraph()(this.container), width, height, t)
            .d3Force('center', d3.forceCenter(0, 0))

            // Custom canvas rendering (labels, glow, pointer area)
            .nodeCanvasObject((node, ctx, globalScale) => this.drawNode(node, ctx, globalScale))
            .nodePointerAreaPaint((node, color, ctx) => {
                const r = this.nodeRadius(node);
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(node.x, node.y, r + 2, 0, 2 * Math.PI, false);
                ctx.fill();
            })

            // Cluster hulls + labels under everything
            .onRenderFramePre((ctx, globalScale) => this.drawClusters(ctx, globalScale))

            .linkLineDash(l => l.semanticOnly ? [4, 3] : null);

        this.fitOnceSettled();
        this.setupWindowEvents();
    }

    createGraph3D() {
        const { width, height } = this.container.getBoundingClientRect();
        const t = this.theme();

        this.graph = this.applyCommon(ForceGraph3D()(this.container), width, height, t)
            // Canvas overlays don't exist in WebGL; tooltips carry the info instead
            .nodeLabel(n => {
                const cluster = this.clusters.get(n.cluster);
                return `<div class="graph-tip"><b>${this.escape(n.name)}</b>
                    <span>${n.section}${cluster ? ' · ' + this.escape(cluster.label) : ''}</span></div>`;
            })
            .linkOpacity(0.25)
            .linkResolution(4);

        this.fitOnceSettled();
        this.setupWindowEvents();
    }

    /* zoomToFit before the simulation settles is degenerate (all nodes at
       origin -> near-infinite zoom -> blank canvas). Wait for the engine. */
    fitOnceSettled() {
        this._didInitialFit = false;
        this.graph.onEngineStop(() => {
            if (this._didInitialFit) return;
            this._didInitialFit = true;
            this.graph.zoomToFit(this.anim(this.mode === '3d' ? 1000 : 800), 60);
        });
    }

    /* three.js is heavy, so the 3D renderer is only fetched on first use. */
    ensure3DLib() {
        if (window.ForceGraph3D) return Promise.resolve();
        if (!this._lib3dPromise) {
            this._lib3dPromise = new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = 'https://cdn.jsdelivr.net/npm/3d-force-graph@1.80.0/dist/3d-force-graph.min.js';
                s.integrity = 'sha384-Y7bC2PBKu8ujxtvo5+Z61OeGdSVRzFsYWBK4i5dnL/U6aFDTodk61qOUkTfInaxS';
                s.crossOrigin = 'anonymous';
                s.onload = resolve;
                s.onerror = () => { this._lib3dPromise = null; reject(new Error('Failed to load 3D renderer')); };
                document.head.appendChild(s);
            });
        }
        return this._lib3dPromise;
    }

    async toggleMode() {
        const next = this.mode === '2d' ? '3d' : '2d';
        if (next === '3d') {
            const btn = document.getElementById('mode-3d');
            if (btn) btn.disabled = true;
            try {
                await this.ensure3DLib();
            } catch (e) {
                console.error(e);
                return;
            } finally {
                if (btn) btn.disabled = false;
            }
        }
        this.mode = next;
        this.deselect();
        // Semantic pins are a 2D feature: release them in 3D, restore on return
        const layoutBtn = document.getElementById('layout-toggle');
        if (next === '3d') {
            this.data.nodes.forEach(n => { delete n.fx; delete n.fy; });
            if (layoutBtn) layoutBtn.disabled = true;
        } else {
            if (layoutBtn) layoutBtn.disabled = false;
        }
        // Tear down current renderer and start fresh
        try { this.graph && this.graph._destructor && this.graph._destructor(); } catch (e) { /* noop */ }
        this.container.querySelectorAll('canvas, .scene-container').forEach(el => el.remove());
        this.createGraph();
        if (next === '2d') this.applyLayout(true);
    }

    drawClusters(ctx, globalScale) {
        if (!this.data.nodes.length) return;
        const t = this.theme();

        const byCluster = new Map();
        this.data.nodes.forEach(n => {
            if (n.x === undefined) return;
            if (!byCluster.has(n.cluster)) byCluster.set(n.cluster, []);
            byCluster.get(n.cluster).push(n);
        });

        byCluster.forEach((nodes, cid) => {
            if (nodes.length < 3) return;
            const pts = nodes.map(n => [n.x, n.y]);
            const hull = d3.polygonHull(pts);
            if (!hull) return;

            // Pad hull outward from centroid
            const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
            const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
            const pad = 16;
            const padded = hull.map(([x, y]) => {
                const dx = x - cx, dy = y - cy;
                const d = Math.hypot(dx, dy) || 1;
                return [x + dx / d * pad, y + dy / d * pad];
            });

            const color = this.clusters.get(cid)?.color || '#888';
            ctx.beginPath();
            padded.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
            ctx.closePath();
            const rgb = this.hexToRgb(color);
            ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${t.hullOpacity})`;
            ctx.fill();
            ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.25)`;
            ctx.lineWidth = 1 / globalScale;
            ctx.stroke();

            // Cluster label at centroid
            const label = this.clusters.get(cid)?.label;
            if (label) {
                const fs = Math.max(11 / globalScale, 3.5);
                ctx.font = `600 ${fs}px "JetBrains Mono", monospace`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.85)`;
                ctx.fillText(label.toUpperCase(), cx, cy);
            }
        });
    }

    drawNode(node, ctx, globalScale) {
        const t = this.theme();
        const isHovered = node === this.hoverNode;
        const isSelected = node === this.selectedNode;
        const isHighlight = this.highlightNodes.has(node.id);
        const isDimmed = (this.hoverNode || this.selectedNode) && !isHighlight && !isSelected && !isHovered;

        if (isDimmed) ctx.globalAlpha = t.dimOpacity;

        const r = this.nodeRadius(node);
        const isSkill = node.section === 'skill';
        const color = node.color || this.clusters.get(node.cluster)?.color || '#888';

        if (isHighlight || isHovered || isSelected) {
            const glowStrength = isHovered || isSelected ? 3.2 : 2.0;
            const glow = ctx.createRadialGradient(node.x, node.y, r * 0.5, node.x, node.y, r * glowStrength);
            glow.addColorStop(0, color);
            glow.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(node.x, node.y, r * glowStrength, 0, 2 * Math.PI, false);
            ctx.fill();
        }

        if (isSkill) {
            // Skill hubs: ring + translucent core so they read as anchors, not posts
            const rgb = this.hexToRgb(color);
            ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.3)`;
            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
            ctx.fill();
            ctx.strokeStyle = color;
            ctx.lineWidth = Math.max(1.6, 2 / globalScale);
            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
            ctx.stroke();
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(node.x, node.y, r * 0.35, 0, 2 * Math.PI, false);
            ctx.fill();
        } else {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
            ctx.fill();
        }

        if (isSelected) {
            ctx.strokeStyle = t.ring;
            ctx.lineWidth = 1.5 / globalScale;
            ctx.beginPath();
            ctx.arc(node.x, node.y, r + 3, 0, 2 * Math.PI, false);
            ctx.stroke();
        }

        // Labels: skills + hovered/selected/neighbors always; everyone when zoomed in
        let show = false, fontSize = 12 / globalScale, weight = 'normal',
            textColor = t.text, bgOpacity = 0.75;

        if (isHovered || isSelected) {
            show = true; fontSize = 13.5 / globalScale; weight = 'bold';
            textColor = t.text;
            bgOpacity = 0.92;
        } else if (isSkill) {
            show = true; fontSize = Math.max(12.5 / globalScale, 4); weight = '600';
            bgOpacity = 0.8;
        } else if (isHighlight) {
            show = true; textColor = t.textMuted; bgOpacity = 0.55;
        } else if (globalScale > 1.8 || this.data.nodes.length <= 20) {
            show = true; textColor = t.textMuted; bgOpacity = 0.55;
        }

        if (show) {
            ctx.font = `${weight} ${fontSize}px "JetBrains Mono", monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const label = node.name || node.id;
            const w = ctx.measureText(label).width;
            const bh = fontSize + 6;
            const bx = node.x - w / 2 - 4, by = node.y + r + 2;

            ctx.fillStyle = t.panelBg.replace(/[\d.]+\)$/, `${bgOpacity})`);
            ctx.fillRect(bx, by, w + 8, bh);
            ctx.fillStyle = textColor;
            ctx.fillText(label, node.x, by + bh / 2);
        }

        ctx.globalAlpha = 1;
    }

    hexToRgb(hex) {
        const m = hex.replace('#', '');
        const int = parseInt(m.length === 3 ? m.split('').map(c => c + c).join('') : m, 16);
        return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
    }

    /* ---------------- Interaction ---------------- */

    handleHover(node) {
        this.hoverNode = node || null;
        this.updateHighlights();
        this.container.style.cursor = node ? 'pointer' : null;
    }

    updateHighlights() {
        this.highlightNodes.clear();
        this.highlightLinks.clear();
        const focus = this.hoverNode || this.selectedNode;
        if (focus) {
            this.highlightNodes.add(focus.id);
            (this.adjacency.get(focus.id) || new Map()).forEach((_, otherId) => {
                this.highlightNodes.add(otherId);
                const link = this.data.links.find(l => {
                    const s = this.linkEnd(l.source), t = this.linkEnd(l.target);
                    return (s === focus.id && t === otherId) || (s === otherId && t === focus.id);
                });
                if (link) this.highlightLinks.add(link);
            });
        }
    }

    selectNode(node) {
        this.selectedNode = node;
        this.updateHighlights();
        if (this.mode === '3d') {
            if (node.x === undefined) { this.showPanel(node); return; } // simulation hasn't placed it yet
            const dist = 90;
            const ratio = 1 + dist / Math.hypot(node.x, node.y, node.z || 1);
            this.graph.cameraPosition(
                { x: node.x * ratio, y: node.y * ratio, z: (node.z || 0) * ratio },
                node, this.anim(800)
            );
        } else {
            this.graph.centerAt(node.x, node.y, this.anim(500));
            if (this.graph.zoom() < 1.6) this.graph.zoom(1.8, this.anim(500));
        }
        this.showPanel(node);
    }

    deselect() {
        this.selectedNode = null;
        this.updateHighlights();
        this.hidePanel();
    }

    focusFromSearch(id) {
        const node = this.data.nodes.find(n => n.id === id);
        if (node) {
            // ensure simulation has placed nodes
            this.graph.d3ReheatSimulation();
            this.selectNode(node);
        }
    }

    /* ---------------- UI: panel, search, filters ---------------- */

    showPanel(node) {
        const panel = document.getElementById('graph-panel');
        if (!panel) return;

        const isSkill = node.section === 'skill';
        const cluster = this.clusters.get(node.cluster);
        const maxNeighbors = isSkill ? 12 : 6;
        const neighbors = [...(this.adjacency.get(node.id) || new Map()).entries()]
            .map(([id, w]) => ({ node: this.nodeById.get(id), w }))
            .filter(e => e.node)
            .sort((a, b) => b.w - a.w)
            .slice(0, maxNeighbors);

        panel.innerHTML = `
            <button class="graph-panel-close" title="Close" aria-label="Close details panel">&times;</button>
            <div class="graph-panel-section">${isSkill ? 'skill area' : this.escape(node.section)}</div>
            <h3 class="graph-panel-title">${this.escape(node.name)}</h3>
            ${node.date ? `<div class="graph-panel-date">${node.date}</div>` : ''}
            ${!isSkill && cluster ? `<div class="graph-panel-cluster"><span class="legend-dot" style="background:${cluster.color}"></span>${this.escape(cluster.label)}</div>` : ''}
            ${node.summary ? `<p class="graph-panel-summary">${this.escape(node.summary)}</p>` : ''}
            ${(node.tags || []).length ? `<div class="graph-panel-tags">${node.tags.map(t => `<span class="graph-tag">${this.escape(t)}</span>`).join('')}</div>` : ''}
            ${neighbors.length ? `<div class="graph-panel-related"><div class="graph-panel-subtitle">${isSkill ? 'Posts in this area' : 'Strongest connections'}</div>${neighbors.map(e =>
                `<a class="graph-related-item" href="#" data-id="${e.node.id}">
                    <span>${this.escape(e.node.name)}</span><span class="graph-related-weight">${e.w}</span>
                </a>`).join('')}</div>` : ''}
            ${isSkill ? '' : `<a class="graph-panel-open" href="${node.id}">Open article &rarr;</a>`}
        `;
        panel.classList.add('visible');

        panel.querySelector('.graph-panel-close').onclick = () => this.deselect();
        panel.querySelectorAll('.graph-related-item').forEach(a => {
            a.onclick = ev => { ev.preventDefault(); this.focusFromSearch(a.dataset.id); };
        });
    }

    hidePanel() {
        document.getElementById('graph-panel')?.classList.remove('visible');
    }

    escape(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    setupUI() {
        this.setupControls();
        this.setupSearch();
        this.setupFilters();
        this.buildLegend();
        this.updateStats();
    }

    /* "This graph is an AI artifact" stats line */
    updateStats() {
        const el = document.getElementById('graph-stats');
        if (!el) return;
        const posts = this.rawData.nodes.filter(n => n.section !== 'skill').length;
        const skills = this.rawData.nodes.length - posts;
        const semantic = this.rawData.links.filter(l => l.semantic).length;
        let html = `${posts} posts &middot; ${skills} skill areas &middot; ${this.rawData.links.length} connections`;
        if (this.semanticMeta) {
            html += ` &mdash; ${semantic} semantic, embedded with <code>${this.escape(this.semanticMeta.model)}</code>`;
        }
        el.innerHTML = html;
    }

    buildLegend() {
        const legend = document.getElementById('graph-legend');
        if (!legend) return;
        const counts = new Map();
        this.rawData.nodes.forEach(n => counts.set(n.cluster, (counts.get(n.cluster) || 0) + 1));
        const clusterItems = [...this.clusters.entries()]
            .filter(([cid]) => (counts.get(cid) || 0) > 1)
            .sort(([, a], [, b]) => (b.skill ? 1 : 0) - (a.skill ? 1 : 0))
            .map(([cid, c]) =>
                `<div class="legend-item"><div class="legend-dot" style="background:${c.color}"></div>${this.escape(c.label)} <span class="legend-count">${counts.get(cid)}</span></div>`);
        const edgeItems = [
            `<div class="legend-item"><span class="legend-line"></span>shared tags</div>`,
            this.semanticMeta ? `<div class="legend-item"><span class="legend-line legend-line-dashed"></span>semantic</div>` : ''
        ];
        legend.innerHTML = clusterItems.concat(edgeItems).join('');
    }

    setupControls() {
        const get = id => document.getElementById(id);
        if (get('zoom-in')) get('zoom-in').onclick = () => this.zoomBy(1.5);
        if (get('zoom-out')) get('zoom-out').onclick = () => this.zoomBy(1 / 1.5);
        if (get('zoom-fit')) get('zoom-fit').onclick = () => { this.deselect(); this.graph.zoomToFit(this.anim(400), 60); };
        if (get('mode-3d')) get('mode-3d').onclick = () => this.toggleMode();

        const layoutBtn = get('layout-toggle');
        if (layoutBtn) {
            if (!this.positions) layoutBtn.style.display = 'none'; // no embedding positions shipped
            layoutBtn.onclick = () => {
                this.layoutMode = this.layoutMode === 'force' ? 'semantic' : 'force';
                layoutBtn.classList.toggle('active', this.layoutMode === 'semantic');
                layoutBtn.setAttribute('aria-pressed', this.layoutMode === 'semantic');
                this.applyLayout(true);
            };
        }

        const fsBtn = get('graph-fullscreen');
        if (fsBtn) {
            fsBtn.onclick = () => this.toggleFullscreen();
            document.addEventListener('keydown', e => {
                if (e.key === 'Escape' && document.querySelector('.graph-wrapper.fullscreen')) {
                    this.toggleFullscreen();
                }
            });
        }
    }

    toggleFullscreen() {
        const wrapper = this.container.closest('.graph-wrapper');
        if (!wrapper) return;
        const on = wrapper.classList.toggle('fullscreen');
        document.getElementById('graph-fullscreen')?.setAttribute('aria-pressed', on);
        document.body.style.overflow = on ? 'hidden' : '';
        const { width, height } = this.container.getBoundingClientRect();
        this.graph.width(width).height(height);
        this.graph.zoomToFit(this.anim(400), 60);
    }

    /* ---------------- Semantic (embedding-space) layout ---------------- */

    /* Pin nodes to their 2D PCA position in embedding space. Positions are
       precomputed by scripts/embed_graph.py; a light collision pass keeps
       labels readable. Nodes without a vector fall back to the centroid of
       their positioned neighbors. */
    applyLayout(refit) {
        if (this.mode === '3d') return;
        if (this.layoutMode === 'semantic' && this.positions) {
            const placed = this.resolveSemanticPositions();
            this.data.nodes.forEach(n => {
                const p = placed.get(n.id);
                if (p) { n.fx = p[0]; n.fy = p[1]; }
            });
        } else {
            this.data.nodes.forEach(n => { delete n.fx; delete n.fy; });
        }
        if (this.graph && refit) {
            this._didInitialFit = false;
            this.graph.d3ReheatSimulation();
        }
    }

    resolveSemanticPositions() {
        const placed = new Map();
        this.data.nodes.forEach(n => {
            const p = this.positions[n.id];
            if (p) placed.set(n.id, [p[0], p[1]]);
        });
        // fallback: centroid of positioned neighbors
        this.data.nodes.forEach(n => {
            if (placed.has(n.id)) return;
            const pts = [...(this.adjacency.get(n.id) || new Map()).keys()]
                .map(id => placed.get(id)).filter(Boolean);
            if (pts.length) {
                placed.set(n.id, [
                    pts.reduce((s, p) => s + p[0], 0) / pts.length + 20,
                    pts.reduce((s, p) => s + p[1], 0) / pts.length + 20
                ]);
            } else {
                placed.set(n.id, [0, 0]);
            }
        });
        // deterministic collision relaxation so nearby nodes don't overlap
        const ids = [...placed.keys()].sort();
        const minSep = 30;
        for (let iter = 0; iter < 40; iter++) {
            let moved = false;
            for (let i = 0; i < ids.length; i++) {
                for (let j = i + 1; j < ids.length; j++) {
                    const a = placed.get(ids[i]), b = placed.get(ids[j]);
                    let dx = b[0] - a[0], dy = b[1] - a[1];
                    let d = Math.hypot(dx, dy);
                    if (d >= minSep) continue;
                    if (d < 0.01) { dx = 1; dy = 0; d = 1; } // coincident: push apart on x
                    const push = (minSep - d) / 2 / d;
                    a[0] -= dx * push; a[1] -= dy * push;
                    b[0] += dx * push; b[1] += dy * push;
                    moved = true;
                }
            }
            if (!moved) break;
        }
        return placed;
    }

    zoomBy(factor) {
        if (this.mode === '3d') {
            const cam = this.graph.camera().position;
            const k = 1 / factor;
            this.graph.cameraPosition({ x: cam.x * k, y: cam.y * k, z: cam.z * k }, undefined, this.anim(300));
        } else {
            this.graph.zoom(this.graph.zoom() * factor, this.anim(400));
        }
    }

    setupSearch() {
        const input = document.getElementById('graph-search');
        const results = document.getElementById('graph-search-results');
        if (!input || !results) return;

        results.setAttribute('role', 'listbox');
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-expanded', 'false');
        input.setAttribute('aria-controls', 'graph-search-results');
        let activeIdx = -1;

        const close = () => {
            results.classList.remove('visible');
            input.setAttribute('aria-expanded', 'false');
            activeIdx = -1;
        };

        const setActive = idx => {
            const items = results.querySelectorAll('.graph-search-item');
            if (!items.length) return;
            activeIdx = ((idx % items.length) + items.length) % items.length;
            items.forEach((el, i) => {
                el.classList.toggle('active', i === activeIdx);
                el.setAttribute('aria-selected', i === activeIdx);
            });
        };

        const search = q => {
            q = q.trim().toLowerCase();
            if (q.length < 2) { close(); return; }
            const matches = this.data.nodes
                .map(n => {
                    let score = 0;
                    const name = (n.name || '').toLowerCase();
                    if (name.includes(q)) score += 10 + (name.startsWith(q) ? 5 : 0);
                    (n.tags || []).forEach(tag => { if (tag.toLowerCase().includes(q)) score += 4; });
                    if (n.section === 'skill' && (n.summary || '').toLowerCase().includes(q)) score += 2;
                    return { n, score };
                })
                .filter(m => m.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, 8);

            if (!matches.length) { close(); return; }
            results.innerHTML = matches.map(m =>
                `<button class="graph-search-item" role="option" data-id="${m.n.id}">${m.n.section === 'skill' ? '<span class="graph-search-kind">skill</span> ' : ''}${this.escape(m.n.name)}</button>`).join('');
            results.classList.add('visible');
            input.setAttribute('aria-expanded', 'true');
            activeIdx = -1;
            results.querySelectorAll('.graph-search-item').forEach(btn => {
                btn.onclick = () => {
                    input.value = btn.textContent.replace(/^skill\s+/, '');
                    close();
                    this.focusFromSearch(btn.dataset.id);
                };
            });
        };

        input.addEventListener('input', () => search(input.value));
        input.addEventListener('keydown', e => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive(activeIdx + 1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive(activeIdx - 1);
            } else if (e.key === 'Enter') {
                const items = results.querySelectorAll('.graph-search-item');
                const target = items[activeIdx >= 0 ? activeIdx : 0];
                if (target) target.click();
            } else if (e.key === 'Escape') {
                close();
                input.blur();
            }
        });
        document.addEventListener('click', e => {
            if (!input.contains(e.target) && !results.contains(e.target)) results.classList.remove('visible');
        });
    }

    setupFilters() {
        const wrap = document.getElementById('graph-filters');
        if (!wrap) return;
        const sections = [...new Set(this.rawData.nodes.map(n => n.section))].sort();

        wrap.innerHTML = sections.map(s => {
            const count = this.rawData.nodes.filter(n => n.section === s).length;
            const label = s === 'skill' ? 'skills' : s;
            return `<button class="graph-chip active" data-section="${s}" aria-pressed="true">${label} <span class="graph-chip-count">${count}</span></button>`;
        }).join('');

        wrap.querySelectorAll('.graph-chip').forEach(chip => {
            chip.onclick = () => {
                const s = chip.dataset.section;
                if (this.activeFilters.has(s)) {
                    this.activeFilters.delete(s);
                    chip.classList.add('active');
                    chip.setAttribute('aria-pressed', 'true');
                } else {
                    this.activeFilters.add(s);
                    chip.classList.remove('active');
                    chip.setAttribute('aria-pressed', 'false');
                }
                this.deselect();
                this.applyFilters();
            };
        });
    }

    setupWindowEvents() {
        if (this._windowEventsBound) return;
        this._windowEventsBound = true;
        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                const { width, height } = this.container.getBoundingClientRect();
                this.graph.width(width).height(height);
            }, 200);
        });
        // Save CPU when the tab is hidden
        document.addEventListener('visibilitychange', () => {
            if (!this.graph) return;
            document.hidden ? this.graph.pauseAnimation() : this.graph.resumeAnimation();
        });
    }
}

// Auto-init
document.addEventListener('DOMContentLoaded', () => {
    window.KnowledgeGraph = new KnowledgeGraph('graph-container');
});
