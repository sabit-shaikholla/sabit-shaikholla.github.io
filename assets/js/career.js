// Career page behaviour. Content is rendered by layouts/career/list.html from
// data/career.json; this script adds the trajectory chart, the scroll-drawn
// timeline, Ask my career (keywords first, then in-browser MiniLM for meaning),
// skill evidence, the detail sheet, citations and the email button.
(() => {
    const dataEl = document.getElementById('career-data');
    if (!dataEl) return;
    const DATA = JSON.parse(dataEl.textContent);
    const $ = s => document.querySelector(s);
    const $$ = s => Array.from(document.querySelectorAll(s));

    const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm';
    const MIN_SIM = 0.36;
    const TOP_K = 8;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const KIND = { work: 'Work', education: 'Education', research: 'Research' };
    const LANES = [
        { k: 'ai', label: 'AI / LLM', color: 'var(--lane-ai)', h: 48 },
        { k: 'sys', label: 'Engineering', color: 'var(--lane-sys)', h: 48 },
        { k: 'res', label: 'Research', color: 'var(--lane-res)', h: 48 },
        { k: 'edu', label: 'Education', color: 'var(--lane-edu)', h: 64 }
    ];

    // Query expansion for the instant keyword pass
    const SYN = {
        lead: ['led ', 'team', 'engineers', 'coordinat'], team: ['led ', 'team', 'engineers', 'coordinat'], manage: ['led ', 'team', 'engineers'],
        kafka: ['kafka', 'event-driven', 'redis'], event: ['event-driven', 'kafka'],
        evaluation: ['ragas', 'faithfulness', 'evaluation', 'relevance', 'benchmark'], eval: ['ragas', 'faithfulness', 'evaluation', 'benchmark'],
        inference: ['sglang', 'vllm', 'tokens/s', 'time-to-first-token', 'on-premise'], serving: ['sglang', 'vllm', 'tokens/s'],
        llm: ['llm', 'rag', 'ragas', 'sglang', 'vllm', 'agent'], rag: ['rag', 'search relevance', 'confluence'],
        retrieval: ['rag', 'search relevance', 'nearest-neighbour'], search: ['rag', 'search relevance'],
        hallucination: ['hallucination', 'faithfulness', 'ragas'], agents: ['agent', 'apm'], agent: ['agent', 'apm'],
        cost: ['$300k', 'costs'], savings: ['$300k', 'costs'],
        reliability: ['uptime', '99.99', 'outages', 'monitoring', 'incidents', 'mttr'], uptime: ['uptime', '99.99', 'outages'],
        testing: ['test', 'defects', 'bugs', 'automation', 'uat'], quality: ['defects', 'bugs', 'test', 'crash-free'], uat: ['uat', 'test scenarios'],
        devops: ['devops', 'deployments', 'mttr', 'release'], release: ['release', 'deployments', 'time-to-market'],
        microservices: ['microservices', 'monolithic', 'api gateway'], architecture: ['architecture', 'microservices', 'integration layer', 'monolithic'],
        solution: ['solution architecture', 'architecture baseline', 'api contracts', 'interface contracts'], architect: ['solution architecture', 'architecture', 'api contracts'],
        requirements: ['requirements', 'specifications', 'stakeholders', 'clarification'], stakeholders: ['stakeholders', 'requirements', 'business'],
        delivery: ['delivery', 'release', 'time-to-market', 'throughput'], api: ['api'],
        billing: ['billing', 'bss/oss', 'order', 'provisioning', 'crm', 'service bus'], telecom: ['bss/oss', 'billing', 'superapp', 'provisioning'],
        portal: ['self-service portal', 'portal'], satisfaction: ['satisfaction', 'nps', 'complaints', 'support tickets'],
        flags: ['feature flag', 'feature-flag'], feature: ['feature flag', 'feature-flag', 'features'],
        nlp: ['nlp', 'analytics', 'nps'], customers: ['nps', 'complaints', 'self-service', 'users'], mobile: ['ios', 'android', 'mobile', 'superapp'],
        data: ['data', 'pandas', 'scikit-learn', 'sql', 'tableau', 'k-means', 'exploratory'], python: ['python', 'pandas', 'scikit-learn'],
        ml: ['predictive', 'k-means', 'scikit-learn', 'clustering'], machine: ['predictive', 'k-means', 'scikit-learn', 'clustering'],
        dashboards: ['tableau', 'dashboards'], decision: ['mcdm', 'decision'],
        research: ['industry 4.0', 'publications', 'paper', 'maturity'], papers: ['paper', 'publications', 'icact'],
        scholarship: ['scholarship', 'stipend', 'erasmus']
    };
    const STOP = new Set('a an the and or of in on at to for with my me i you your did do does have has how what who when where which experience experienced ever any about'.split(' '));

    /* ---------------- Dates ---------------- */
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const TODAY = new Date();
    const ym = s => { if (!s) return [TODAY.getFullYear(), TODAY.getMonth() + 1]; const [y, m] = s.split('-').map(Number); return [y, m]; };
    const fmt = s => s ? `${MON[ym(s)[1] - 1]} ${ym(s)[0]}` : 'Now';
    const toT = s => { const [y, m] = ym(s); return y + (m - 1) / 12; };
    const dur = (a, b) => {
        const [y1, m1] = ym(a), [y2, m2] = ym(b);
        const n = (y2 - y1) * 12 + (m2 - m1) + 1, y = Math.floor(n / 12), m = n % 12;
        return [y ? `${y} yr${y > 1 ? 's' : ''}` : '', m ? `${m} mo${m > 1 ? 's' : ''}` : ''].filter(Boolean).join(' ');
    };
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const norm = s => String(s).replace(/\s+/g, ' ').trim();

    const ROLE = {};
    DATA.entries.forEach(e => e.roles.forEach(r => { ROLE[r.id] = Object.assign({}, r, { entry: e }); }));
    const POSTS = DATA.posts || {};

    // The page was built at some point in the past; keep durations of current roles honest
    $$('.career .dur[data-start]').forEach(el => { el.textContent = dur(el.dataset.start, el.dataset.end); });
    $$('.career .entry').forEach(li => {
        li.dataset.range = `${fmt(li.dataset.start)} – ${fmt(li.dataset.end)}\n${dur(li.dataset.start, li.dataset.end)}`;
    });
    $$('.career .wins li').forEach(li => { li.dataset.orig = li.innerHTML; li.dataset.plain = norm(li.textContent); });

    /* ---------------- Trajectory chart ---------------- */
    const MARKS = [];
    DATA.entries.forEach(e => e.roles.forEach(r => {
        const c = r.chart;
        if (!c) return;
        MARKS.push({
            lane: c.lane, type: 'bar', row: c.row || 0, ref: r.id, a: r.start, b: c.end || r.end,
            label: c.label, short: c.short, outside: c.outside,
            tt: (r.rank ? `${r.rank} · ` : '') + r.title, sub: c.sub || e.org
        });
    }));
    Object.keys(POSTS).forEach(k => {
        const p = POSTS[k];
        if (p.ai) MARKS.push({ lane: 'ai', type: 'dot', ref: k, post: k, a: p.d, tt: p.t, sub: `Write-up · ${fmt(p.d)}` });
    });
    DATA.publications.forEach(p => MARKS.push({
        lane: 'res', type: 'dot', ref: p.owner, pub: p.id, a: p.ym, tt: p.title,
        sub: `${p.venue} · ${p.cites == null ? 'no' : p.cites} citations`
    }));

    const chartEl = $('#chart');
    const tip = $('#tip');
    let lastW = 0;

    function drawChart() {
        const W = chartEl.clientWidth || 900;
        if (W === lastW) return;
        lastW = W;
        const narrow = W < 620;
        const padL = narrow ? 96 : 124, padR = 20, top = 26;
        const t0 = 2015.4, t1 = toT(null) + 0.3;
        const x = t => padL + (t - t0) / (t1 - t0) * (W - padL - padR);
        const laneY = {};
        let y = top;
        LANES.forEach(l => { laneY[l.k] = y + l.h / 2; y += l.h; });
        const plotB = y, H = y + 30;
        const tw = s => s.length * 6.5 + 8;
        const color = k => LANES.find(l => l.k === k).color;

        let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">`;
        for (let yr = 2016; yr <= Math.floor(t1); yr++) {
            const gx = x(yr);
            s += `<line class="grid" x1="${gx}" x2="${gx}" y1="${top - 4}" y2="${plotB}"/>`;
            if (!narrow || yr % 2 === 0) s += `<text x="${gx}" y="${plotB + 20}" text-anchor="middle">${narrow ? '’' + String(yr).slice(2) : yr}</text>`;
        }
        const nx = x(toT(null));
        s += `<line class="now" x1="${nx}" x2="${nx}" y1="${top - 10}" y2="${plotB}"/><text x="${nx}" y="${top - 14}" text-anchor="end">Now</text>`;
        LANES.forEach(l => {
            s += `<circle cx="5" cy="${laneY[l.k]}" r="4" style="fill:${l.color}"/><text class="lane-label" x="16" y="${laneY[l.k] + 4}">${l.label}</text>`;
        });
        MARKS.forEach((m, i) => {
            const cy = laneY[m.lane] + (m.lane === 'edu' ? (m.row ? 12 : -8) : 0);
            const attrs = `class="mark" tabindex="0" data-i="${i}" data-ref="${m.ref}"`;
            if (m.type === 'bar') {
                const x1 = x(toT(m.a)) + 1, x2 = x(toT(m.b)) - 1, w = Math.max(4, x2 - x1);
                const lab = m.outside ? null : (tw(m.label) < w ? m.label : (m.short && tw(m.short) < w ? m.short : null));
                s += `<g ${attrs}>
                    <rect x="${x1}" y="${cy - 12}" width="${Math.max(w, 24)}" height="24" style="fill:transparent"/>
                    <rect class="vis" x="${x1}" y="${cy - 5}" width="${w}" height="10" rx="4" style="fill:${color(m.lane)}"/>
                    ${lab ? `<text class="bar-label" x="${x1 + 2}" y="${cy - 10}">${esc(lab)}</text>` : ''}
                    ${m.outside ? `<text class="bar-label" x="${x2 + 8}" y="${cy + 4}">${esc(m.label)}</text>` : ''}
                </g>`;
            } else {
                const cx = x(toT(m.a) + 1 / 24);
                s += `<g ${attrs}>
                    <rect x="${cx - 12}" y="${cy - 12}" width="24" height="24" style="fill:transparent"/>
                    <circle class="vis" cx="${cx}" cy="${cy}" r="4.5" style="fill:${color(m.lane)};stroke:var(--ground);stroke-width:2"/>
                </g>`;
            }
        });
        chartEl.innerHTML = s + '</svg>';
        applySelection();
    }

    function showTip(g) {
        const m = MARKS[g.dataset.i];
        const shell = chartEl.parentElement.getBoundingClientRect();
        const r = g.querySelector('.vis').getBoundingClientRect();
        const range = m.type === 'bar' ? `${fmt(m.a)} – ${fmt(m.b)} · ${dur(m.a, m.b)}` : '';
        tip.innerHTML = `<b>${esc(m.tt)}</b>${esc(m.sub)}${range ? `<div class="mono">${range}</div>` : ''}`;
        tip.classList.add('on');
        const tr = tip.getBoundingClientRect();
        const left = Math.max(0, Math.min(r.left - shell.left + r.width / 2 - tr.width / 2, shell.width - tr.width));
        let topY = r.top - shell.top - tr.height - 10;
        if (topY < 0) topY = r.bottom - shell.top + 10;
        tip.style.left = `${left}px`;
        tip.style.top = `${topY}px`;
    }
    const hideTip = () => tip.classList.remove('on');
    function activate(g) {
        const m = MARKS[g.dataset.i];
        if (m.post && POSTS[m.post]) location.href = POSTS[m.post].url;
        else go(m.pub || m.ref);
    }
    chartEl.addEventListener('pointerover', e => { const g = e.target.closest('.mark'); if (g) showTip(g); });
    chartEl.addEventListener('pointerout', e => { if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('.mark')) hideTip(); });
    chartEl.addEventListener('focusin', e => { const g = e.target.closest('.mark'); if (g) showTip(g); });
    chartEl.addEventListener('focusout', hideTip);
    chartEl.addEventListener('click', e => { const g = e.target.closest('.mark'); if (g) activate(g); });
    chartEl.addEventListener('keydown', e => {
        const g = e.target.closest('.mark');
        if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); activate(g); }
    });

    /* ---------------- Shared selection: chart + timeline ---------------- */
    let selection = null;
    function applySelection() {
        $$('#chart .mark').forEach(g => g.classList.toggle('dim', !!selection && !selection.has(g.dataset.ref)));
        $$('.career .entry').forEach(li => {
            const roles = Array.from(li.querySelectorAll('[data-role]')).map(d => d.dataset.role);
            li.classList.toggle('dim', !!selection && !roles.some(r => selection.has(r)));
        });
    }

    function go(id) {
        const el = document.getElementById(id);
        if (!el) return;
        const entry = el.closest('.entry');
        if (entry && entry.hidden) setFilter('all');
        el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
        el.setAttribute('tabindex', '-1');
        el.focus({ preventScroll: true });
    }

    /* ---------------- Ask my career ---------------- */
    const askInput = $('#ask');
    const askStatus = $('#ask-status');
    const tl = $('#tl');
    const reEsc = s => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
    let engine = null, enginePromise = null, INDEX = null, VECS = null, searchSeq = 0;

    function highlight(html, terms) {
        return html.split(/(<[^>]+>)/).map(part => part.startsWith('<') ? part :
            terms.reduce((acc, t) => acc.replace(new RegExp(`(^|[^a-z0-9])(${reEsc(t.trim())})`, 'gi'), '$1<mark>$2</mark>'), part)).join('');
    }
    function clearSearchUI() {
        tl.classList.remove('searching');
        $$('.career .wins li.hit').forEach(li => { li.classList.remove('hit'); li.innerHTML = li.dataset.orig; });
    }
    function expand(q) {
        const terms = new Set();
        q.split(/[^a-z0-9$.\/+-]+/).filter(w => w.length > 1 && !STOP.has(w)).forEach(w => {
            terms.add(w);
            Object.keys(SYN).forEach(k => { if (w.startsWith(k) || (w.length >= 3 && k.startsWith(w))) SYN[k].forEach(t => terms.add(t)); });
        });
        return Array.from(terms);
    }

    function ensureEngine() {
        if (engine) return Promise.resolve();
        if (enginePromise) return enginePromise;
        enginePromise = (async () => {
            const [idxRes, binRes, mod] = await Promise.all([fetch(DATA.index), fetch(DATA.vectors), import(TRANSFORMERS_CDN)]);
            if (!idxRes.ok || !binRes.ok) throw new Error('career index unavailable');
            INDEX = await idxRes.json();
            VECS = new Float32Array(await binRes.arrayBuffer());
            mod.env.allowLocalModels = false;
            engine = await mod.pipeline('feature-extraction', INDEX.model, { dtype: 'q8' });
            if (askInput.value.trim()) runSearch(askInput.value);
        })().catch(() => {
            enginePromise = null;
            $('#ask-note').textContent = 'The language model could not load, so matching uses keywords only.';
        });
        return enginePromise;
    }

    async function semanticHits(q) {
        const out = await engine(q, { pooling: 'mean', normalize: true });
        const qv = out.data, D = INDEX.dims;
        return INDEX.items
            .map((it, n) => { let s = 0; for (let d = 0; d < D; d++) s += qv[d] * VECS[n * D + d]; return { it, s }; })
            .sort((a, b) => b.s - a.s)
            .filter((h, rank) => h.s >= MIN_SIM && rank < TOP_K)
            .map(h => h.it);
    }

    function renderHits(hitRoles, hitLis, terms, raw) {
        clearSearchUI();
        hitLis.forEach(li => { li.classList.add('hit'); li.innerHTML = highlight(li.dataset.orig, terms); });
        if (!hitRoles.size) {
            selection = null;
            askStatus.textContent = engine
                ? `No close match for “${raw.trim()}”. Try “inference”, “billing” or “team”.`
                : 'No keyword match yet. Loading the language model to match by meaning…';
        } else {
            selection = hitRoles;
            tl.classList.add('searching');
            const n = hitLis.size;
            askStatus.textContent = `${n} matching result${n === 1 ? '' : 's'} in ${hitRoles.size} role${hitRoles.size === 1 ? '' : 's'}`;
        }
        applySelection();
        updateRail();
    }

    async function runSearch(raw) {
        const seq = ++searchSeq;
        const q = raw.trim().toLowerCase();
        $$('#suggest .chip').forEach(c => c.setAttribute('aria-pressed', String(c.textContent.toLowerCase() === q)));
        if (!q) { clearSearchUI(); selection = null; askStatus.textContent = ''; applySelection(); updateRail(); return; }
        clearSkill();

        const terms = expand(q);
        const matches = t => terms.some(term => new RegExp(`(^|[^a-z0-9])${reEsc(term.trim())}`, 'i').test(t));
        const hitRoles = new Set(), hitLis = new Set();
        $$('.career [data-role]').forEach(div => {
            const r = ROLE[div.dataset.role];
            div.querySelectorAll('.wins li').forEach(li => { if (matches(li.dataset.plain)) { hitLis.add(li); hitRoles.add(r.id); } });
            if (matches([r.rank, r.title, r.summary].concat(r.stack || []).filter(Boolean).join(' '))) hitRoles.add(r.id);
        });
        renderHits(hitRoles, hitLis, terms, raw);

        if (!engine) { ensureEngine(); return; }
        const sem = await semanticHits(q);
        if (seq !== searchSeq) return;
        sem.forEach(it => {
            const div = document.querySelector(`.career [data-role="${it.role}"]`);
            if (!div) return;
            hitRoles.add(it.role);
            if (it.i < 0) return;
            const li = div.querySelector(`.wins li[data-i="${it.i}"]`);
            if (li && li.dataset.plain === norm(it.text)) hitLis.add(li);
        });
        renderHits(hitRoles, hitLis, terms, raw);
    }

    $('#suggest').addEventListener('click', e => {
        const c = e.target.closest('.chip');
        if (!c) return;
        askInput.value = c.textContent;
        runSearch(c.textContent);
    });
    let debounce;
    askInput.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => runSearch(askInput.value), 160); });
    askInput.addEventListener('focus', () => { ensureEngine(); }, { once: true });
    document.addEventListener('keydown', e => {
        if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); askInput.focus(); }
    });

    /* ---------------- Skills evidence ---------------- */
    const evidence = $('#evidence');
    const evidenceEmpty = evidence.innerHTML;
    let skillKey = null;
    function clearSkill() {
        skillKey = null;
        $$('[data-skill]').forEach(b => b.setAttribute('aria-pressed', 'false'));
        evidence.innerHTML = evidenceEmpty;
    }
    function selectSkill(key) {
        if (skillKey === key) { clearSkill(); selection = null; applySelection(); return; }
        askInput.value = '';
        clearSearchUI();
        askStatus.textContent = '';
        const [gi, si] = key.split('-').map(Number);
        const sk = DATA.skills[gi].items[si];
        skillKey = key;
        $$('[data-skill]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.skill === key)));
        selection = new Set(sk.roles.concat(sk.posts));
        const roles = sk.roles.filter(id => ROLE[id]).map(id => {
            const r = ROLE[id];
            return `<button class="more" type="button" data-go="${id}">${esc(r.title)}, ${esc(r.entry.org)} · ${fmt(r.start)} – ${fmt(r.end)}</button>`;
        }).join('');
        const posts = sk.posts.filter(k => POSTS[k]).map(k => `<a href="${POSTS[k].url}">${esc(POSTS[k].t)}</a>`).join('');
        const n = sk.roles.length;
        evidence.innerHTML = `<h4>${esc(sk.name)}</h4>
            <p>${esc(sk.note || `Used in ${n} role${n > 1 ? 's' : ''}.`)} The chart and timeline now highlight ${n > 1 ? 'these roles' : 'this role'}.</p>
            <div class="ev-row"><span>Roles</span>${roles}</div>
            ${posts ? `<div class="ev-row"><span>Writing</span>${posts}</div>` : ''}`;
        applySelection();
        updateRail();
    }

    /* ---------------- Filters and sorting ---------------- */
    function setFilter(f) {
        $$('#filter button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.f === f)));
        $$('.career .entry').forEach(li => { li.hidden = !(f === 'all' || li.dataset.kind === f); });
        updateRail();
    }
    $('#filter').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setFilter(b.dataset.f); });
    $('#pub-sort').addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b) return;
        $$('#pub-sort button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        const list = $('#pubs');
        $$('#pubs .pub')
            .sort((p, q) => b.dataset.s === 'cites' ? (+q.dataset.cites) - (+p.dataset.cites) : q.dataset.ym.localeCompare(p.dataset.ym))
            .forEach(li => list.appendChild(li));
    });

    /* ---------------- Scroll-drawn rail + pinned year ---------------- */
    const rail = $('.career .rail');
    const yearN = $('#year-n'), yearR = $('#year-r');
    function updateRail() {
        const rr = rail.getBoundingClientRect(), c = innerHeight * 0.5;
        rail.style.setProperty('--h', `${Math.max(0, rr.height - 8)}px`);
        const p = reduce ? 1 : Math.max(0, Math.min(1, (c - rr.top) / rr.height));
        rail.style.setProperty('--p', p.toFixed(4));
        const shown = $$('.career .entry').filter(li => !li.hidden);
        let cur = shown[0];
        shown.forEach(li => {
            const reached = reduce || li.querySelector('.node').getBoundingClientRect().top < c;
            li.classList.toggle('reached', reached);
            if (reached) cur = li;
        });
        if (cur) {
            yearN.textContent = cur.dataset.year;
            yearN.classList.toggle('now', cur.dataset.year === 'Now');
            yearR.textContent = cur.dataset.range;
        }
    }
    let ticking = false;
    addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => { updateRail(); ticking = false; });
    }, { passive: true });
    addEventListener('resize', () => { drawChart(); updateRail(); });

    /* ---------------- Detail sheet, citations, toast, email ---------------- */
    const sheet = $('#sheet'), sheetIn = $('#sheet-in');
    function openRole(id) {
        const r = ROLE[id], e = r.entry;
        const related = (r.related || []).filter(k => POSTS[k]);
        sheetIn.innerHTML = `
            <div class="sheet-top"><div>
                <div class="kind">${KIND[e.kind]} · ${esc(e.org)}${r.rank ? ` · ${esc(r.rank)}` : ''}</div>
                <h3 id="sheet-title">${esc(r.title)}</h3>
                <div class="meta" style="margin-top:6px"><span>${fmt(r.start)} – ${fmt(r.end)}</span><span>${dur(r.start, r.end)}</span><span>${esc(e.place)}</span></div>
            </div><button class="close" type="button" aria-label="Close">×</button></div>
            ${r.summary ? `<p class="summary">${esc(r.summary)}</p>` : ''}
            <h4>Results</h4><ul class="wins">${r.wins.map(w => `<li>${w}</li>`).join('')}</ul>
            ${(r.stack || []).length ? `<h4>Stack</h4><div class="stack">${r.stack.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
            ${related.length ? `<h4>Related writing</h4><ul class="related">${related.map(k => `<li><a href="${POSTS[k].url}">${esc(POSTS[k].t)}</a></li>`).join('')}</ul>` : ''}`;
        sheet.showModal();
    }
    sheet.addEventListener('click', e => { if (e.target === sheet || e.target.closest('.close')) sheet.close(); });

    const toastEl = $('#toast');
    let toastTimer;
    function toast(msg) {
        toastEl.textContent = msg;
        toastEl.classList.add('on');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove('on'), 2400);
    }
    async function copy(text, ok, fail) {
        try { await navigator.clipboard.writeText(text); toast(ok); } catch (_) { fail(); }
    }
    function bibtex(p) {
        const person = a => a === 'et al.' ? 'others' : `${a.split(' ').slice(-1)[0]}, ${a.split(' ').slice(0, -1).join(' ')}`;
        const year = ym(p.ym)[0];
        const key = p.authors[0].split(' ').slice(-1)[0].toLowerCase() + year + p.title.split(/\W+/)[0].toLowerCase();
        const journal = p.type === 'Journal';
        return `@${journal ? 'article' : 'inproceedings'}{${key},
  title     = {${p.title}},
  author    = {${p.authors.map(person).join(' and ')}},
  ${journal ? 'journal  ' : 'booktitle'} = {${p.venue}},
  year      = {${year}},${p.doi ? `\n  doi       = {${p.doi}},` : `\n  url       = {${p.href}},`}
}`;
    }

    document.addEventListener('click', e => {
        const t = e.target.closest('.career [data-go], .career [data-sheet], .career [data-cite], .career [data-skill]');
        if (!t) return;
        if (t.dataset.go) go(t.dataset.go);
        else if (t.dataset.sheet) openRole(t.dataset.sheet);
        else if (t.dataset.skill) selectSkill(t.dataset.skill);
        else if (t.dataset.cite) {
            const bib = bibtex(DATA.publications.find(p => p.id === t.dataset.cite));
            copy(bib, 'BibTeX copied', () => {
                sheetIn.innerHTML = `<div class="sheet-top"><h3 id="sheet-title">Cite this paper</h3><button class="close" type="button" aria-label="Close">×</button></div><pre>${esc(bib)}</pre>`;
                sheet.showModal();
                toast('The browser blocked copying. Select the BibTeX to copy it.');
            });
        }
    });

    const emailBtn = $('#copy-email');
    if (emailBtn) {
        const email = emailBtn.dataset.email;
        emailBtn.addEventListener('click', () => copy(email, 'Email address copied', () => toast(email)));
    }

    drawChart();
    updateRail();
    if (document.fonts) document.fonts.ready.then(() => { lastW = 0; drawChart(); updateRail(); });
})();
