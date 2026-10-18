import { db } from './db.js';

/* Кого считать «жалобой на руководство» — теперь решает иерархия (src/hierarchy.js, /hierarchy). */
const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е');

/**
 * Прокуроры из базы, которых называют нарушителями в жалобе (по имени после «|» в нике).
 * Их нельзя назначать на эту жалобу.
 */
export function accusedIds(violator) {
  if (!violator) return [];
  const t = norm(violator);
  return db.prepare('SELECT user_id, name FROM prosecutors').all().filter((p) => {
    const words = norm(p.name.split('|').pop().trim()).split(/\s+/).filter((w) => w.length >= 3);
    return words.length > 0 && words.join('').length >= 5 && words.every((w) => t.includes(w));
  }).map((p) => p.user_id);
}
