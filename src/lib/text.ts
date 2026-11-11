/** Small, dependency-free text utilities shared by the pipeline stages. */

const STOP = new Set(
  `a an the and or but if then than so of in on at to from by for with without into over under after before
  as is are was were be been being has have had do does did will would can could should may might must
  this that these those it its he she they them his her their we our you your i not no new says said say
  amid against about up down out off more most also how why what when where who which while during here
  check details know all top live updates latest news watch video today india indian`.split(/\s+/),
);

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

export type Vec = Map<string, number>;

/** TF-IDF vectors for a small corpus of documents; title tokens count double. */
export function tfidfVectors(docs: { title: string; summary: string }[]): Vec[] {
  const bags = docs.map((d) => {
    const bag = new Map<string, number>();
    for (const t of tokens(d.title)) bag.set(t, (bag.get(t) ?? 0) + 2);
    for (const t of tokens(d.summary)) bag.set(t, (bag.get(t) ?? 0) + 1);
    return bag;
  });
  const df = new Map<string, number>();
  for (const bag of bags) for (const t of bag.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  return bags.map((bag) => {
    const v: Vec = new Map();
    let norm = 0;
    for (const [t, tf] of bag) {
      const w = (1 + Math.log(tf)) * Math.log(1 + n / (df.get(t) ?? 1));
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  });
}

export function cosine(a: Vec, b: Vec): number {
  const [s, l] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of s) {
    const o = l.get(t);
    if (o) dot += w * o;
  }
  return dot;
}

/* ---------- near-identical text (wire copy) ---------- */

const HASHES = 64;

function fnv1a(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * MinHash signature over 4-word shingles. We store this instead of the
 * article text: it lets us tell that two outlets ran the same copy without
 * keeping anyone's words.
 */
export function fingerprint(text: string): number[] | null {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);
  if (words.length < 40) return null;
  const sig = new Array<number>(HASHES).fill(0xffffffff);
  for (let i = 0; i + 4 <= words.length; i++) {
    const sh = words.slice(i, i + 4).join(" ");
    const base = fnv1a(sh, 0);
    for (let k = 0; k < HASHES; k++) {
      // cheap family of hash functions derived from one base hash
      const h = (Math.imul(base ^ (k * 0x9e3779b1), 0x85ebca6b) ^ (base >>> (k % 16))) >>> 0;
      if (h < sig[k]) sig[k] = h;
    }
  }
  return sig;
}

/** Estimated Jaccard similarity of two fingerprints (0..1). */
export function fingerprintSimilarity(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length !== b.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

/* ---------- copy measurements ---------- */

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

const ABBREV = /\b(Mr|Mrs|Ms|Dr|Prof|Rs|St|Sr|Jr|No|Gen|Col|Lt|Capt|Sgt|Hon|Justice|vs|Inc|Ltd|Co|Corp|[A-Z])\.(?=\s|[A-Z])/g;

/** Split copy into sentences, keeping common abbreviations and initials whole. */
export function splitSentences(s: string): string[] {
  const masked = s.replace(ABBREV, "$1\u0001");
  return masked
    .split(/(?<=[.!?]["'”’)\]]?)\s+(?=["'“‘(\[]?[A-Z0-9₹$])/)
    .map((x) => x.replace(/\u0001/g, ".").trim())
    .filter(Boolean);
}

export const oneLine = (s: string, max = 240) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};
