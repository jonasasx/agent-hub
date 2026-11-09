// Voice conversation (change `voice-conversation`, design D6): the wrapper an utterance wears in the session's transcript.
// Built by the hub's Custom LLM bridge, parsed by the web (the user turn shows the utterance and the «голосом» mark).

/** The rules of a spoken answer, sent with every utterance: a live process cannot change its system prompt. */
export const VOICE_TURN_RULES = [
  'Это реплика в ГОЛОСОВОМ разговоре: пользователь слышит ответ, а не читает его, возможно, он за рулём.',
  'Правила ответа:',
  '- Отвечай коротко, 1–3 предложения, разговорным русским языком.',
  '- Никакого Markdown, списков, заголовков, эмодзи и блоков кода.',
  '- Не зачитывай код и длинные пути. Опиши словами, что сделал или нашёл.',
  '- Если задача длинная — сначала коротко скажи, что начал, и потом резюмируй результат.',
  '- Если действие опасное или необратимое (удаление, деплой, git push --force, платежи) — не делай, а скажи, что отложишь до компьютера.',
  '- Если что-то непонятно — задай ОДИН уточняющий вопрос.',
].join('\n');

const TAGS = /<(\/?(?:voice-turn|rules|said)\b)/gi;
const UNTAGS = /&lt;(\/?(?:voice-turn|rules|said)\b)/gi;

/** A tag of the wrapper inside the utterance would end it early: its `<` becomes `&lt;`. */
const escBody = (t: string): string => t.replace(TAGS, '&lt;$1');
const unescBody = (t: string): string => t.replace(UNTAGS, '<$1');

export function wrapVoiceTurn(text: string): string {
  return `<voice-turn>\n<rules>\n${VOICE_TURN_RULES}\n</rules>\n<said>\n${escBody(text)}\n</said>\n</voice-turn>`;
}

const WRAPPED = /^<voice-turn>\n<rules>\n[\s\S]*?\n<\/rules>\n<said>\n([\s\S]*)\n<\/said>\n<\/voice-turn>$/;

/** The utterance of a user turn that is exactly one voice turn; null for anything else. */
export function parseVoiceTurn(turn: string): { text: string } | null {
  const m = WRAPPED.exec(turn.trim());
  return m ? { text: unescBody(m[1]!) } : null;
}

/**
 * D4.8: the user message the page sends the agent (`sendUserMessage`) when a long voice turn has ended or asks: the hub
 * speaks its result or question instead of passing the text to the session.
 */
export const VOICE_REPORT_MARKER = '[[agent-hub:voice-report]]';
