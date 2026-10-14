/**
 * Права по названиям ролей — как в оригинальном боте: роль «Генеральный Прокурор» сразу даёт права ГП,
 * «Заместитель Генерального Прокурора» — права ЗГП и т.д. Настраивать ничего не нужно; в /settings → Доступ
 * можно добавить права другим ролям или, наоборот, снять право с роли (тогда название роли его не даёт).
 */
export const norm = (s) => String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const word = (w) => new RegExp(`(^| )${w}( |$)`);
// роли-«отделы» вроде «Офис Генерального прокурора» или «Сотрудник ОГП» — не должность, высокие права им не даём
const DEPARTMENT = /офис|огп|отдел|департамент|сотрудник|состав|owner|владел/;

/** Порядок важен: срабатывает первое подходящее правило (сначала самые конкретные должности) */
export const RULES = [
  {
    label: 'Генеральный прокурор', perms: ['full', 'senior'],
    test: (n) => !DEPARTMENT.test(n) && ((/генеральн\S* прокурор/.test(n) && !/заместител|советник|помощник|старш/.test(n)) || word('гп').test(n)),
  },
  {
    label: 'Заместитель ГП', perms: ['approve', 'staff', 'monitor', 'assign', 'mentoring', 'senior'],
    test: (n) => !DEPARTMENT.test(n) && (/заместител\S* генеральн/.test(n) || word('згп').test(n)),
  },
  {
    label: 'Советник ГП', perms: ['approve', 'senior', 'mentoring'], // переназначать жалобы — от ЗГП
    test: (n) => !DEPARTMENT.test(n) && (/советник\S* генеральн/.test(n) || word('сгп').test(n)),
  },
  { label: 'Помощник прокурора', perms: ['prosecutor', 'case_register'], test: (n) => /помощник\S* прокурор/.test(n) },
  { label: 'Прокурор', perms: ['prosecutor', 'case_register'], test: (n) => /прокурор/.test(n) && !DEPARTMENT.test(n) },
  { label: 'Судья', perms: ['judge'], test: (n) => /(^| )судь/.test(n) },
];

export const isVacationRole = (n) => n === 'отпуск' || n === 'в отпуске' || /^отпуск /.test(n);

/** Должность по названию роли (или null) */
export const ruleFor = (roleName) => RULES.find((r) => r.test(norm(roleName))) ?? null;
/** Права, которые даёт само название роли */
export const namePerms = (roleName) => ruleFor(roleName)?.perms ?? [];
