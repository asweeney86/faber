import type { Database } from "bun:sqlite";
import type { Meeting, MeetingDetail } from "@faber/shared";
import { newId, now } from "./db";
import { docsInOrder } from "./docs";

/**
 * Recurring meetings share a title ("Billing v2 sync"), sometimes with a date or
 * counter appended. Normalise those away so every occurrence maps to one series.
 */
export function seriesKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b\d{1,4}[/.-]\d{1,2}(?:[/.-]\d{1,4})?\b/g, " ")
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/g, " ")
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/g, " ")
    .replace(/#\d+\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Link a document to the meeting it was opened from. Returns the meeting id, or null for an unusable title. */
export function linkDocToMeeting(db: Database, docId: string, meeting: { title: string; url?: string }, ts = now()): string | null {
  const title = meeting.title.trim().slice(0, 200);
  const key = seriesKey(title);
  if (!key) return null;
  return db.transaction(() => {
    let id = db.query<{ id: string }, [string]>(`SELECT id FROM meetings WHERE series_key = ?`).get(key)?.id;
    if (!id) {
      id = newId();
      db.run(`INSERT INTO meetings (id, series_key, title, url, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`, [
        id,
        key,
        title,
        meeting.url ?? null,
        ts,
        now(),
      ]);
    } else {
      db.run(`UPDATE meetings SET title = ?, url = COALESCE(?, url), last_seen_at = MAX(last_seen_at, ?) WHERE id = ?`, [
        title,
        meeting.url ?? null,
        ts,
        id,
      ]);
    }
    db.run(`INSERT OR IGNORE INTO doc_meetings (doc_id, meeting_id, linked_at) VALUES (?, ?, ?)`, [docId, id, ts]);
    return id;
  })();
}

const MEETING_SELECT = `SELECT m.id, m.title, m.url, m.last_seen_at,
  (SELECT COUNT(*) FROM doc_meetings x WHERE x.meeting_id = m.id) AS doc_count FROM meetings m`;

export function listMeetings(db: Database): Meeting[] {
  return db.query<Meeting, []>(`${MEETING_SELECT} ORDER BY m.last_seen_at DESC`).all();
}

export function getMeeting(db: Database, id: string): MeetingDetail | null {
  const m = db.query<Meeting, [string]>(`${MEETING_SELECT} WHERE m.id = ?`).get(id);
  if (!m) return null;
  const ids = db
    .query<{ doc_id: string }, [string]>(
      `SELECT dm.doc_id FROM doc_meetings dm JOIN documents d ON d.id = dm.doc_id WHERE dm.meeting_id = ? ORDER BY d.last_seen_at DESC`,
    )
    .all(id)
    .map((r) => r.doc_id);
  return { ...m, docs: docsInOrder(db, ids) };
}
