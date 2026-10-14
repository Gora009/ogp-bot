import { db, getSetting, setSetting } from './db.js';

/**
 * Жалобы на руководство и сотрудников офиса: в пункте «Сведения о нарушителе» есть одно из этих слов.
 * Такие жалобы получает только старший состав. Список редактируется командой /senior_keywords.
 * Короткие аббревиатуры (до 3 букв) ищутся как отдельные слова, остальное — как часть слова.
 */
/** Добавлены позже: «Прокуратура» и английские названия должностей офиса */
const ADDED_V2 = ['прокуратур', 'prosecutor', 'attorney general', 'district attorney'];
export const DEFAULT_KEYWORDS = ['прокурор', 'генеральн', 'гп', 'згп', 'сгп', 'огп', 'советник', ...ADDED_V2];

const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function getKeywords() {
  const v = getSetting('senior_keywords');
  return v === null ? [...DEFAULT_KEYWORDS] : v.split('\n').map((s) => s.trim()).filter(Boolean);
}
export const setKeywords = (list) => setSetting('senior_keywords', list.join('\n'));

// если список уже настраивали вручную — один раз дописываем в него новые слова
if (getSetting('senior_keywords') !== null && getSetting('senior_keywords_v2') !== '1') {
  setKeywords([...new Set([...getKeywords(), ...ADDED_V2])]);
}
setSetting('senior_keywords_v2', '1');

const hit = (text, kw) =>
  kw.length <= 3 ? new RegExp(`(^|[^a-zа-я0-9])${esc(kw)}([^a-zа-я0-9]|$)`).test(text) : text.includes(kw);

/** Какие слова из списка встретились в тексте нарушителя */
export function matchedKeywords(violator) {
  if (!violator) return [];
  const t = norm(violator);
  return getKeywords().filter((k) => hit(t, norm(k)));
}
export const isRestricted = (violator) => matchedKeywords(violator).length > 0;

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
