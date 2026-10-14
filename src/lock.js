import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const FILE = 'data/bot.lock';

/** Защита от двойного запуска: две копии бота на одной базе отвечают на нажатия дважды и ломают SQLite. */
export function acquireLock() {
  mkdirSync('data', { recursive: true });
  if (existsSync(FILE)) {
    const pid = Number(readFileSync(FILE, 'utf8'));
    if (pid && pid !== process.pid) {
      let alive = true;
      try { process.kill(pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
      if (alive) {
        console.error(`Бот уже запущен (PID ${pid}). Закройте другое окно или вкладку с ботом и повторите запуск.`);
        process.exit(2);
      }
    }
  }
  writeFileSync(FILE, String(process.pid));
  const release = () => {
    try { if (readFileSync(FILE, 'utf8') === String(process.pid)) unlinkSync(FILE); } catch { /* уже удалён */ }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
}
