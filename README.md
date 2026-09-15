# sabit-shaikholla.github.io

Personal website built with Hugo (PaperMod), deployed to GitHub Pages via GitHub Actions.

## Design system

`assets/css/extended/design-system.css` holds the site-wide tokens (colors, type, radii)
and restyles PaperMod's components through its CSS variables, so the theme submodule stays
untouched. Light values live on `:root`, dark values on `:root[data-theme="dark"]`.
Typefaces: Instrument Sans (display) and JetBrains Mono (data, code), loaded in
`layouts/partials/extend_head.html`; body text uses the system font stack.

## Career page (`/career/`)

Everything on the page comes from `data/career.json`: roles, results, publications,
skills, languages and certifications (newest first, dates as `YYYY-MM`, `end: null` for
current roles). `layouts/career/list.html` renders it server-side, and
`assets/js/career.js` adds the trajectory chart, the scroll-drawn timeline, skill
evidence, citations and **Ask my career**.

Ask my career matches keywords instantly, then loads `all-MiniLM-L6-v2` in the visitor's
browser (the same model as the Content Atlas) to match by meaning against a prebuilt index.
After editing `data/career.json`, rebuild the index and commit the output:

```bash
npm run build:career   # writes static/career/career-index.json + career-vectors.bin
```

`/resume/` redirects to `/career/`.

## Explore (`/explore/`)

Two views of the site's content, switched by `layouts/partials/explore_tabs.html`:
the Content Atlas at `/explore/` and the Content Graph at `/explore/graph/`.
Old `/atlas/` and `/graph/` links redirect.

## Knowledge Graph embeddings (optional)

The Content Graph (`/explore/graph/`) combines tag-based links with semantic similarity edges computed from
[Gemini embeddings](https://ai.google.dev/gemini-api/docs/embeddings) (`scripts/embed_graph.py`).

### GitHub Actions (CI)

1. Create a key in Google AI Studio.
2. Add it as a repository secret named **`GEMINI_API_KEY`**
   (Settings → Secrets and variables → Actions).
3. Push — the workflow runs `scripts/embed_graph.py` before `hugo build`.
   The key is never written to the repo or the built site; only similarity edge
   weights end up in the public `static/graph/embeddings.json`.

### Local development

```bash
echo "GEMINI_API_KEY=your_key_here" > .env   # gitignored
python3 scripts/embed_graph.py
hugo server
```

### How it works

- Embeddings are cached in `scripts/embeddings-cache.json` (committed) keyed by content hash,
  so the API is only called for new/changed content — safe to commit, contains no secrets.
- Post pairs with cosine similarity ≥ 0.45 (max 6 per post) become "semantic edges",
  rendered as dashed links in the graph. Combined with shared-tag edges, the
  community detection uses the hybrid weights.
- If `embeddings.json` is missing or stale, the graph falls back to tag-based links only,
  and the CI embedding step is non-fatal so a missing key never blocks a deploy.

### Skill areas

`data/skills.json` defines curated skill hubs (RAG & Retrieval, Agentic Systems,
LLM Evaluation, …). The graph template links posts to skills by tag/category overlap,
and community detection is seeded by these hubs so clusters carry the skill's name
and color. Skill descriptions are embedded with the same Gemini model so skills sit
in the right semantic neighborhood.

### Semantic layout

`embed_graph.py` also writes a 2D PCA projection of every node's embedding
(`positions` in `embeddings.json`). The "semantic layout" toggle on the graph page
pins nodes to these embedding-space coordinates instead of the force simulation.

## Content Atlas (`/explore/`)

A chunk-level semantic map: every paragraph is embedded with
`all-MiniLM-L6-v2` and projected to 2D with UMAP, colored by skill area.
Search embeds the query **in the visitor's browser** (transformers.js loads the
same model) and cosine-ranks against int8-quantized chunk vectors — a fully
client-side retrieval pipeline, no backend.

```bash
npm install            # once: @huggingface/transformers + umap-js
npm run build:atlas    # regenerates static/atlas/* after content changes
```

- First run downloads the ONNX model (~25 MB) to the local HF cache.
- Chunk embeddings are cached in `scripts/atlas-cache.json` (committed) keyed by
  text hash; the build is deterministic (seeded UMAP), so unchanged content
  produces byte-identical output.
- Outputs (`static/atlas/atlas.json` + `atlas-vectors.bin`) are committed;
  CI never needs Node dependencies.
