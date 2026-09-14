#!/usr/bin/env node
/**
 * Build the "Ask my career" index for /career/.
 *
 * - Reads every role from data/career.json: one item per result bullet, plus one
 *   item per role combining rank, title, organisation, summary and stack
 * - Embeds each item with all-MiniLM-L6-v2 (quantized ONNX) via
 *   @huggingface/transformers, the same model career.js loads in the browser
 *   (and the one the Content Atlas uses, so visitors download it once)
 * - Writes static/career/career-index.json (model, dims, items) and
 *   static/career/career-vectors.bin (Float32 unit vectors, items x dims)
 *
 * Run after editing data/career.json:  npm run build:career
 * If the index is stale, career.js ignores bullets whose text no longer matches
 * and keyword matching keeps working.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIMS = 384;
const DATA_PATH = path.join(ROOT, 'data', 'career.json');
const OUT_DIR = path.join(ROOT, 'static', 'career');

const plain = html => html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
const items = [];
for (const entry of data.entries) {
    for (const role of entry.roles) {
        const head = [role.rank, role.title, entry.org, role.summary, (role.stack || []).join(', ')]
            .filter(Boolean).join('. ');
        items.push({ role: role.id, i: -1, text: plain(head) });
        (role.wins || []).forEach((win, i) => items.push({ role: role.id, i, text: plain(win) }));
    }
}

console.log(`Embedding ${items.length} career items with ${MODEL_ID}…`);
const { pipeline } = await import('@huggingface/transformers');
const extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
const output = await extractor(items.map(it => it.text), { pooling: 'mean', normalize: true });
const vectors = new Float32Array(output.data);
if (vectors.length !== items.length * DIMS) {
    throw new Error(`Expected ${items.length * DIMS} values, got ${vectors.length}`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'career-vectors.bin'), Buffer.from(vectors.buffer));
fs.writeFileSync(path.join(OUT_DIR, 'career-index.json'), JSON.stringify({ model: MODEL_ID, dims: DIMS, items }));
console.log(`Wrote static/career/career-index.json and career-vectors.bin (${items.length} items).`);
