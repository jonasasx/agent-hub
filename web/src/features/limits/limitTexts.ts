/**
 * Texts of the limits UI (change subscription-limits, design.md L7 «Расшифровки»): constants of the interface, never
 * from the hub. A window is looked up by its key; an unknown key shows its raw name and «окно без описания».
 */
import type { LimitsReason } from '../../api/types';

export interface WindowText {
  /** For the row and the chip: «5 ч», «7 дн». */
  short: string;
  /** For the card: «5 часов». */
  name: string;
  /** null — an unknown window. */
  desc: string | null;
}

export const WINDOW_TEXTS: Record<string, WindowText> = {
  five_hour: {
    short: '5 ч',
    name: '5 часов',
    desc: 'Скользящее окно: начинается с первого запроса после паузы и длится 5 часов. Показывает, сколько израсходовано за это время; после сброса счёт идёт заново.',
  },
  seven_day: {
    short: '7 дн',
    name: '7 дней',
    desc: 'Недельный лимит на все модели. Время сброса сообщает сервис; недельное окно сбрасывается реже 5-часового, поэтому исчерпание ждать дольше.',
  },
  seven_day_opus: { short: '7 дн Opus', name: '7 дней · Opus', desc: 'Отдельный недельный лимит на запросы к моделям Opus. Другие модели его не тратят.' },
  seven_day_sonnet: { short: '7 дн Sonnet', name: '7 дней · Sonnet', desc: 'Отдельный недельный лимит на запросы к моделям Sonnet. Другие модели его не тратят.' },
  seven_day_oauth_apps: {
    short: '7 дн прил.',
    name: '7 дней · приложения',
    desc: 'Недельный лимит запросов от приложений, подключённых к аккаунту по OAuth. Что именно сюда попадает, определяет Anthropic.',
  },
};

export const UNKNOWN_WINDOW_DESC = 'Окно без описания: сервис вернул новый тип лимита.';

export function windowText(type: string): WindowText {
  return Object.prototype.hasOwnProperty.call(WINDOW_TEXTS, type) ? WINDOW_TEXTS[type]! : { short: type, name: type, desc: null };
}

export const OVERAGE_DESC =
  'Использование сверх лимита подписки за кредиты или деньги, если оно включено в аккаунте. Хаб показывает только состояние: включён, используется, исчерпан; суммы не считает.';

export const EXHAUSTION_RULES =
  'Когда любое окно доходит до 100%, подписка отклоняет ходы до сброса этого окна. Если у подписки включено автопереключение, хаб продолжит сессию под следующей подпиской реестра; иначе в чате появится кнопка «Продолжить под другой подпиской».';

export const REFRESH_HINT = 'Обновить делает короткий служебный запрос к модели Haiku под этой подпиской: тратит малую долю 5-часового окна.';

export const QUIET_TEXT = 'Ход прошёл, лимит не исчерпан; новых процентов сервис не прислал, известные значения окон — ниже порога.';

/** A quiet check while a window holds its level (fix 2026-10-29). */
export const HELD_TEXT = 'Сервис присылает проценты не на каждый ход, поэтому у окон — последние известные значения.';

/** «нет данных: …» by reason; `agent_outdated` names the machines when they are known. */
export function reasonText(reason: LimitsReason | null, outdatedMachines: string[] = []): string {
  switch (reason) {
    case 'token_rejected':
      return 'токен отклонён';
    case 'no_runner':
      return 'нет машины в сети';
    case 'agent_outdated':
      return outdatedMachines.length ? `обновите агента на ${outdatedMachines.join(', ')}` : 'обновите агента';
    case 'probe_failed':
      return 'пробный ход не удался';
    case 'expired':
      return 'данные старше суток';
    case 'not_polled':
    case null:
    default:
      return 'ещё не проверялась';
  }
}

/** One sentence after «Нет данных: …» in the card. */
export function reasonAdvice(reason: LimitsReason | null): string {
  switch (reason) {
    case 'token_rejected':
      return 'Замените токен в реестре подписок.';
    case 'no_runner':
      return 'Пробный ход выполняет машина с агентом, а подходящей в сети нет.';
    case 'agent_outdated':
      return 'Агент машины не поддерживает лимиты (нужен протокол 1.6).';
    case 'probe_failed':
      return 'Хаб повторит позже; можно нажать «Обновить».';
    case 'expired':
      return 'Последним данным больше суток, им нельзя доверять.';
    default:
      return 'Данные появятся после первого хода сессии или пробного хода.';
  }
}

/** Texts of refresh errors (design.md L6: 404, 409 …, 429, 503). */
export function refreshErrorText(code: string | null, status: number): string {
  switch (code) {
    case 'subscription_retired':
      return 'Подписка выведена из реестра.';
    case 'token_rejected':
      return 'Токен отклонён — замените его в реестре.';
    case 'runner_offline':
      return 'Нет машины в сети для пробного хода.';
    case 'agent_outdated':
      return 'Агент машины устарел — обновите агента.';
    case 'probes_disabled':
      return 'Пробные ходы выключены в настройках хаба.';
    case 'subscriptions_disabled':
      return 'Хранение токенов не настроено на хабе.';
    default:
      return status === 404 ? 'Подписка не найдена — список обновлён.' : 'Хаб не ответил. Проверьте VPN и попробуйте ещё раз.';
  }
}
