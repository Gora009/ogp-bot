import { getSetting, setSetting } from './db.js';
import { cfg } from './util.js';

/**
 * Настройки, которые меняются в /settings. Хранятся в базе; значение из .env — только запасное
 * (для старых установок), по умолчанию — разумные значения ниже. Читаются при каждом обращении,
 * поэтому изменения действуют сразу, без перезапуска бота.
 */
const num = (key, env, def) => {
  const v = getSetting(key) ?? process.env[env];
  return v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? def : Number(v);
};

export const conf = {
  /** Через сколько секунд бот сам назначает жалобу: 0 — сразу, -1 — не назначать */
  autoAssignSec: () => num('auto_assign_seconds', 'AUTO_ASSIGN_SECONDS', 0),
  /** Срок закрытия жалобы, часов от подачи на форуме */
  deadlineHours: () => num('deadline_hours', 'DEADLINE_HOURS', 72),
  /** Напоминания исполнителю — через сколько часов после подачи */
  reminderHours: () => (getSetting('reminder_hours') ?? '24,48').split(',').map(Number).filter((h) => h > 0).sort((a, b) => a - b),
  /** Повтор исполнителю после просрочки, каждые N часов (0 — не повторять) */
  repeatHours: () => num('overdue_repeat_hours', 'OVERDUE_REPEAT_HOURS', 2),
  /** Роль «Отпуск» */
  vacationRoleId: () => getSetting('vacation_role_id') || cfg('VACATION_ROLE_ID'),
  /** Сервер Прокуратуры (для /check_members и /invite_missing) */
  prosecutionGuildId: () => getSetting('prosecution_guild_id') || cfg('PROSECUTION_GUILD_ID'),
};

export const setConf = (key, value) => setSetting(key, value === null ? '' : String(value));

/** «сразу» / «через 30 с» / «вручную» — для показа в настройках и справке */
export function autoAssignText() {
  const s = conf.autoAssignSec();
  if (s < 0) return 'вручную (бот сам не назначает)';
  if (s === 0) return 'сразу при появлении жалобы';
  return `через ${s} с, если никто не назначил`;
}
