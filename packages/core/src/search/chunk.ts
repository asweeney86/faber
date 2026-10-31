/**
 * Split text into roughly `chunkChars`-sized pieces on paragraph boundaries,
 * with a small overlap so sentences straddling a boundary are still findable.
 */
export function chunkText(text: string, chunkChars: number, maxChunks: number): string[] {
  const clean = text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const paras = clean.split(/\n\n+/);
  const chunks: string[] = [];
  let cur = "";
  const overlap = Math.floor(chunkChars * 0.15);

  const push = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = cur.length > overlap ? cur.slice(-overlap) : "";
  };

  for (const p of paras) {
    if (p.length > chunkChars) {
      // A single huge paragraph (sheets CSV, minified text): flush what we have, then hard-split
      // it with the overlap coming from the stride alone.
      if (cur.trim()) chunks.push(cur.trim());
      cur = "";
      for (let i = 0; i < p.length; i += chunkChars - overlap) {
        chunks.push(p.slice(i, i + chunkChars));
        if (chunks.length >= maxChunks) return chunks;
        if (i + chunkChars >= p.length) break;
      }
      continue;
    }
    if (cur.length + p.length + 2 > chunkChars) push();
    cur += (cur ? "\n\n" : "") + p;
    if (chunks.length >= maxChunks) return chunks;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.slice(0, maxChunks);
}
