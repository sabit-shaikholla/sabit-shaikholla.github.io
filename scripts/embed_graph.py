#!/usr/bin/env python3
"""
Generate semantic similarity edges + embedding-space positions for the
Knowledge Graph.

- Reads posts from content/{projects,writing} and skill areas from
  data/skills.json (skills are embedded from their name + description so
  they land in the right semantic neighborhood)
- Embeds everything with Gemini (gemini-embedding-001) via REST (no deps)
- Caches embeddings by content hash in scripts/embeddings-cache.json
  (committed) so the API is only called for new/changed content
- Writes to assets/graph/embeddings.json:
    links     - post-to-post edges above a similarity threshold
    positions - 2D PCA projection of every node (posts + skills) used by
                the graph's "semantic layout" mode

API key is read from the GEMINI_API_KEY environment variable only.
Locally you can put it in a gitignored .env file in the repo root.
"""

import hashlib
import json
import math
import os
import re
import sys
import urllib.request

try:  # macOS framework Pythons ship without CA certs; use certifi if available
    import certifi
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
except ImportError:
    pass

SECTIONS = ("projects", "writing")
MODEL = "gemini-embedding-001"
OUTPUT_DIM = 768
SIM_THRESHOLD = 0.45       # minimum cosine similarity to become an edge
MAX_EDGES_PER_NODE = 6     # keep the graph readable
MAX_INPUT_CHARS = 4000     # embedding input budget per post

POSITION_SCALE = 350       # PCA coords are scaled to roughly [-350, 350]

CACHE_PATH = os.path.join(os.path.dirname(__file__), "embeddings-cache.json")
SKILLS_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "skills.json")
OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "assets", "graph", "embeddings.json")

FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def load_dotenv():
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if os.path.exists(env_path):
        for line in open(env_path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def parse_post(path):
    raw = open(path, encoding="utf-8").read()
    m = FM_RE.match(raw)
    front, body = (m.group(1), raw[m.end():]) if m else ("", raw)

    title_m = re.search(r'^title:\s*["\']?(.+?)["\']?\s*$', front, re.MULTILINE)
    title = title_m.group(1) if title_m else os.path.splitext(os.path.basename(path))[0]

    draft_m = re.search(r"^draft:\s*true\s*$", front, re.MULTILINE | re.IGNORECASE)
    if draft_m:
        return None

    # crude markdown cleanup - good enough for embeddings
    text = re.sub(r"```.*?```", " ", body, flags=re.DOTALL)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[#>*`_|-]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()

    return (title + ". " + text)[:MAX_INPUT_CHARS]


def post_files(d):
    """Hugo supports both standalone Markdown files and leaf bundles
    (dir/index.md). Stop at a leaf bundle: the other Markdown files inside it
    are page resources, not posts. Mirrors postFiles() in build_atlas.mjs."""
    if os.path.isfile(os.path.join(d, "index.md")):
        yield os.path.join(d, "index.md")
        return
    for name in sorted(os.listdir(d)):
        path = os.path.join(d, name)
        if os.path.isdir(path):
            yield from post_files(path)
        elif name.endswith(".md") and not name.startswith("_"):
            yield path


def collect_posts(root):
    posts = []  # (id, text, hash)
    for section in SECTIONS:
        d = os.path.join(root, "content", section)
        if not os.path.isdir(d):
            continue
        for path in post_files(d):
            parsed = parse_post(path)
            if parsed is None:
                continue
            slug = os.path.relpath(path, d).replace(os.sep, "/")
            slug = re.sub(r"(^|/)index\.md$", "", slug)
            slug = re.sub(r"\.md$", "", slug)
            node_id = f"/{section}/{slug}/" if slug else f"/{section}/"
            content_hash = hashlib.sha256(parsed.encode()).hexdigest()[:16]
            posts.append((node_id, parsed, content_hash))
    return posts


def embed_batch(texts, api_key):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:batchEmbedContents"
    payload = {
        "requests": [
            {
                "model": f"models/{MODEL}",
                "content": {"parts": [{"text": t}]},
                "outputDimensionality": OUTPUT_DIM,
            }
            for t in texts
        ]
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
    return [e["values"] for e in data["embeddings"]]


def collect_skills():
    """Skill hub nodes from data/skills.json, embedded as name + description."""
    if not os.path.exists(SKILLS_PATH):
        return []
    data = json.load(open(SKILLS_PATH, encoding="utf-8"))
    items = []
    for s in data.get("skills", []):
        text = f"{s['name']}. {s.get('description', '')}".strip()
        content_hash = hashlib.sha256(text.encode()).hexdigest()[:16]
        items.append((f"skill:{s['id']}", text, content_hash))
    return items


def normalize(v):
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def cosine(a, b):
    return sum(x * y for x, y in zip(a, b))


def pca_2d(vectors):
    """2D PCA via power iteration with deflation. Fine at this scale
    (tens of vectors) and keeps the script dependency-free."""
    ids = list(vectors)
    n, dim = len(ids), len(vectors[ids[0]])
    if n < 3:
        return {pid: [0.0, 0.0] for pid in ids}

    mean = [sum(vectors[pid][d] for pid in ids) / n for d in range(dim)]
    centered = {pid: [vectors[pid][d] - mean[d] for d in range(dim)] for pid in ids}

    def principal_component(rows, seed):
        v = [math.sin(seed + i) for i in range(dim)]  # deterministic start
        v = normalize(v)
        for _ in range(60):
            # implicit covariance product: sum_i (x_i . v) x_i
            new = [0.0] * dim
            for row in rows:
                proj = sum(a * b for a, b in zip(row, v))
                for d in range(dim):
                    new[d] += proj * row[d]
            v = normalize(new)
        return v

    rows = [centered[pid] for pid in ids]
    pc1 = principal_component(rows, 1.0)
    # deflate: remove pc1 component, then find pc2
    deflated = []
    for row in rows:
        proj = sum(a * b for a, b in zip(row, pc1))
        deflated.append([row[d] - proj * pc1[d] for d in range(dim)])
    pc2 = principal_component(deflated, 2.0)

    coords = {}
    for pid in ids:
        row = centered[pid]
        coords[pid] = [
            sum(a * b for a, b in zip(row, pc1)),
            sum(a * b for a, b in zip(row, pc2)),
        ]
    max_abs = max((abs(c) for xy in coords.values() for c in xy), default=1.0) or 1.0
    scale = POSITION_SCALE / max_abs
    return {pid: [round(x * scale, 1), round(y * scale, 1)] for pid, (x, y) in coords.items()}


def main():
    root = os.path.join(os.path.dirname(__file__), "..")
    load_dotenv()
    api_key = os.environ.get("GEMINI_API_KEY", "")

    posts = collect_posts(root)
    if not posts:
        print("No posts found.", file=sys.stderr)
        sys.exit(1)
    skills = collect_skills()
    items = posts + skills

    cache = {}
    if os.path.exists(CACHE_PATH):
        cache = json.load(open(CACHE_PATH))

    to_embed = [(pid, text, h) for pid, text, h in items if cache.get(pid, {}).get("hash") != h]
    if to_embed:
        if not api_key:
            print(f"ERROR: {len(to_embed)} item(s) need embeddings but GEMINI_API_KEY is not set.", file=sys.stderr)
            print("Set it in your shell or in a gitignored .env file.", file=sys.stderr)
            sys.exit(2)
        print(f"Embedding {len(to_embed)} new/changed item(s) with {MODEL}...")
        vectors = embed_batch([t for _, t, _ in to_embed], api_key)
        for (pid, _, h), vec in zip(to_embed, vectors):
            cache[pid] = {"hash": h, "vector": normalize(vec)}
    else:
        print("All embeddings up to date (cache hit).")

    with open(CACHE_PATH, "w") as f:
        json.dump(cache, f, sort_keys=True)

    # Drop cache entries for deleted posts/skills
    # Sorted, not a set: set iteration order varies with PYTHONHASHSEED, which
    # would reorder the output JSON on every run and churn the committed diff.
    live_ids = sorted({pid for pid, _, _ in items})
    vectors = {pid: cache[pid]["vector"] for pid in live_ids if pid in cache}

    # Pairwise similarities: post-to-post only (skills connect via curated
    # membership edges from the Hugo template, not fuzzy similarity)
    post_ids = [pid for pid, _, _ in posts if pid in vectors]
    edges = []
    neighbor_count = {pid: 0 for pid in post_ids}
    pairs = []
    for i in range(len(post_ids)):
        for j in range(i + 1, len(post_ids)):
            sim = cosine(vectors[post_ids[i]], vectors[post_ids[j]])
            if sim >= SIM_THRESHOLD:
                pairs.append((post_ids[i], post_ids[j], sim))
    # Strongest first, cap per node
    pairs.sort(key=lambda p: -p[2])
    for a, b, sim in pairs:
        if neighbor_count[a] >= MAX_EDGES_PER_NODE or neighbor_count[b] >= MAX_EDGES_PER_NODE:
            continue
        neighbor_count[a] += 1
        neighbor_count[b] += 1
        edges.append({"source": a, "target": b, "similarity": round(sim, 4)})

    # 2D embedding-space positions for the semantic layout (posts + skills)
    positions = pca_2d(vectors)

    out = {"model": MODEL, "threshold": SIM_THRESHOLD, "links": edges, "positions": positions}
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(out, f, sort_keys=True)

    print(f"Wrote {len(edges)} semantic edges + {len(positions)} positions -> {os.path.relpath(OUT_PATH)}")


if __name__ == "__main__":
    main()
