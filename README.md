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
   weights end up in `assets/graph/embeddings.json`, published fingerprinted.

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

## Tags and categories

Two rules, both enforced by `npm test`:

1. **One spelling per term, written the way it should read.** Hugo derives a
   term's display name from how posts spell it, and when posts disagree (`ai` in
   one, `AI` in another) it picks build-order dependently — writing `"AI"` can
   make the whole site render `Ai`. Slug-style values humanize badly on top of
   that (`vector-search` becomes `Vector-Search`), so write `"Vector Search"`,
   `"GitHub Pages"`, `"LangGraph"`. The slug is unchanged either way.
2. **Pin a label only when it cannot be a tag value.** `"llama.cpp"` would mint
   `/tags/llama.cpp/`, and Hugo force-capitalises the first letter of
   `"watchOS"`. Those get a term page, which sets the label and leaves the URL
   alone:

   ```
   content/tags/llama-cpp/_index.md   ->   title: "llama.cpp"   (/tags/llama-cpp/)
   ```

Skill matching in `data/skills.json` is exact string equality against the
lowercased term, in both `build_atlas.mjs` and `layouts/graph/list.json`. So a
skill tag must be the lowercase of what posts write — `"vector search"`, not
`"vector-search"`. A test enforces that every entry is lowercase and matches
real content; a stale entry would otherwise just silently never match.

## Content Atlas (`/explore/`)

A chunk-level semantic map: every paragraph is embedded with
`all-MiniLM-L6-v2` and projected to 2D with UMAP, colored by skill area.
Search embeds the query **in the visitor's browser** (transformers.js loads the
same model) and cosine-ranks against int8-quantized chunk vectors — a fully
client-side retrieval pipeline, no backend.

```bash
npm ci                # install locked build dependencies
npm run build:atlas   # regenerates assets/atlas/* after content changes
npm test              # content coverage, anchors, taxonomy, layout, interaction
```

- First run downloads the ONNX model (~25 MB) to the local HF cache.
- Chunk embeddings are cached in `scripts/atlas-cache.json` (committed) keyed by
  text hash; the build is deterministic (seeded UMAP), so unchanged content
  produces byte-identical output. `embed_graph.py` is reproducible too.
- Both standalone Markdown posts and Hugo leaf bundles (`article/index.md`) in
  `content/projects` and `content/writing` are included, including nested posts;
  drafts, section indexes, and bundle resources are excluded. `embed_graph.py`
  walks content the same way, so the two Explore views cover the same posts.
- UMAP uses a broader 30-neighbor neighborhood and a 0.25 minimum distance to
  keep small topics near the rest of the map without crowding their dots.
- `anchorize()` reproduces Hugo's GitHub-style heading IDs, including the
  typographer's dash and quote folding. A test resolves every "Read in context"
  link against the built HTML, so a drifting anchor fails rather than silently
  landing at the top of a page.
- Hover previews do not intercept the pointer, and a plain mousedown no longer
  blinks one away. Select a dot to pin its details and enable the article link.
  The map is keyboard-operable: arrows pan, `+`/`-` zoom, `0` resets, `n`/`p`
  step through paragraphs (through the search hits while a search is active),
  Enter opens, Escape clears.
- The generated data lives in `assets/`, not `static/`, so only the
  content-fingerprinted copy ships. That covers the Atlas JSON, the search
  vectors, and the graph's `embeddings.json`: an updated page cannot reuse a
  stale sidecar or pair the map with mismatched vectors, and the client also
  rejects a vector file whose size does not match the map.
- Outputs (`assets/atlas/*`, `assets/graph/embeddings.json`) and both embedding
  caches are committed for local previews. Deployment runs `npm ci`, rebuilds the
  Atlas, and tests it before Hugo, so a new article cannot silently leave the
  deployed Atlas stale. CI caches the downloaded model; Atlas embedding needs no
  API key (graph embeddings do — without `GEMINI_API_KEY` the committed
  `embeddings.json` is reused, and the coverage test reports what it misses).
- `ci.yml` runs the suite strictly on pull requests. The deploy runs the same
  suite with `ATLAS_LAYOUT_ADVISORY=1`, which turns the UMAP-spacing check into a
  warning so layout quality can never block publishing a post.
