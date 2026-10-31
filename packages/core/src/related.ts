import type { Database } from "bun:sqlite";
import type { RelatedDoc } from "@faber/shared";
import { getDoc } from "./docs";
import type { VectorIndex } from "./search/vectors";

interface Candidate {
  semantic: number;
  people: string[];
  meetings: string[];
  projects: string[];
}

/**
 * Documents related to `docId` by content similarity, shared meetings, shared
 * people and shared projects. Each result explains itself with reasons.
 */
export function relatedDocs(db: Database, index: VectorIndex, docId: string, limit = 8): RelatedDoc[] {
  const cands = new Map<string, Candidate>();
  const get = (id: string) => {
    let c = cands.get(id);
    if (!c) {
      c = { semantic: 0, people: [], meetings: [], projects: [] };
      cands.set(id, c);
    }
    return c;
  };

  // Content: the doc's header vector (title + summary) and first chunks, best match per neighbour.
  for (const v of index.vectorsFor(docId).slice(0, 3)) {
    for (const hit of index.search(v, 30)) {
      if (hit.doc_id === docId) continue;
      const c = get(hit.doc_id);
      c.semantic = Math.max(c.semantic, hit.score);
    }
  }

  for (const r of db
    .query<{ doc_id: string; name: string }, [string, string]>(
      `SELECT dp2.doc_id, p.name FROM doc_people dp1
       JOIN doc_people dp2 ON dp2.person_id = dp1.person_id AND dp2.doc_id != dp1.doc_id
       JOIN people p ON p.id = dp1.person_id
       WHERE dp1.doc_id = ? AND dp2.doc_id != ?`,
    )
    .all(docId, docId)) {
    const c = get(r.doc_id);
    if (!c.people.includes(r.name)) c.people.push(r.name);
  }

  for (const r of db
    .query<{ doc_id: string; title: string }, [string, string]>(
      `SELECT dm2.doc_id, m.title FROM doc_meetings dm1
       JOIN doc_meetings dm2 ON dm2.meeting_id = dm1.meeting_id AND dm2.doc_id != dm1.doc_id
       JOIN meetings m ON m.id = dm1.meeting_id
       WHERE dm1.doc_id = ? AND dm2.doc_id != ?`,
    )
    .all(docId, docId)) {
    const c = get(r.doc_id);
    if (!c.meetings.includes(r.title)) c.meetings.push(r.title);
  }

  for (const r of db
    .query<{ doc_id: string; value: string }, [string, string]>(
      `SELECT e2.doc_id, j2.value FROM enrichments e1, json_each(e1.projects) j1
       JOIN enrichments e2 ON e2.is_current = 1 AND e2.doc_id != e1.doc_id
       JOIN json_each(e2.projects) j2 ON lower(j2.value) = lower(j1.value)
       WHERE e1.doc_id = ? AND e1.is_current = 1 AND e2.doc_id != ?`,
    )
    .all(docId, docId)) {
    const c = get(r.doc_id);
    if (!c.projects.includes(r.value)) c.projects.push(r.value);
  }

  const scored = [...cands.entries()].map(([id, c]) => {
    const score =
      Math.max(0, c.semantic) + 0.35 * Math.min(c.meetings.length, 2) + 0.15 * Math.min(c.people.length, 3) + 0.2 * Math.min(c.projects.length, 2);
    const reasons: string[] = [];
    if (c.meetings.length) reasons.push(`Same meeting: ${c.meetings.join(", ")}`);
    if (c.projects.length) reasons.push(`Project: ${c.projects.join(", ")}`);
    if (c.people.length) reasons.push(`People: ${c.people.slice(0, 3).join(", ")}${c.people.length > 3 ? ` +${c.people.length - 3}` : ""}`);
    if (c.semantic >= 0.5) reasons.push("Similar content");
    return { id, score, reasons };
  });

  return scored
    .filter((s) => s.reasons.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .flatMap(({ id, score, reasons }) => {
      const doc = getDoc(db, id);
      return doc ? [{ doc, score, reasons }] : [];
    });
}
