import type { Database } from "bun:sqlite";
import type { Person, PersonDetail } from "@faber/shared";
import { docsInOrder } from "./docs";

const PERSON_SELECT = `SELECT p.id, p.name, p.email,
  COUNT(DISTINCT dp.doc_id) AS doc_count, MAX(d.last_seen_at) AS last_seen_at
  FROM people p
  JOIN doc_people dp ON dp.person_id = p.id
  JOIN documents d ON d.id = dp.doc_id`;

/** People who appear in at least one document, most documents first. */
export function listPeople(db: Database): Person[] {
  return db.query<Person, []>(`${PERSON_SELECT} GROUP BY p.id ORDER BY doc_count DESC, last_seen_at DESC, p.name`).all();
}

export function getPerson(db: Database, id: string): PersonDetail | null {
  const p = db.query<Person, [string]>(`${PERSON_SELECT} WHERE p.id = ? GROUP BY p.id`).get(id);
  if (!p) return null;
  const docIds = db
    .query<{ id: string }, [string]>(
      `SELECT DISTINCT d.id FROM doc_people dp JOIN documents d ON d.id = dp.doc_id WHERE dp.person_id = ? ORDER BY d.last_seen_at DESC`,
    )
    .all(id)
    .map((r) => r.id);
  const related_people = db
    .query<{ id: string; name: string; count: number }, [string, string]>(
      `SELECT p2.id, p2.name, COUNT(DISTINCT dp2.doc_id) AS count
       FROM doc_people dp1
       JOIN doc_people dp2 ON dp2.doc_id = dp1.doc_id AND dp2.person_id != dp1.person_id
       JOIN people p2 ON p2.id = dp2.person_id
       WHERE dp1.person_id = ? AND p2.id != ?
       GROUP BY p2.id ORDER BY count DESC, p2.name LIMIT 12`,
    )
    .all(id, id);
  return { ...p, docs: docsInOrder(db, docIds), related_people };
}

/** Drop people no longer linked to any document (after re-enrichment or deletes). */
export function prunePeople(db: Database) {
  db.run(`DELETE FROM people WHERE id NOT IN (SELECT person_id FROM doc_people)`);
}
