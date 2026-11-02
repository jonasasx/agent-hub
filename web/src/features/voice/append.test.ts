// Requirement (voice-input): Завершение записи и вставка текста.
import { describe, expect, it } from 'vitest';
import { appendDictation } from './append';

describe('appendDictation', () => {
  it('Пустой черновик: the text as it is', () => {
    expect(appendDictation('', 'Привет')).toBe('Привет');
  });
  it('Дописывание через пробел', () => {
    expect(appendDictation('Сделай так:', 'проверь логи')).toBe('Сделай так: проверь логи');
  });
  it('Черновик кончается переводом строки: no space', () => {
    expect(appendDictation('Пункт 1\n', 'Пункт 2')).toBe('Пункт 1\nПункт 2');
  });
  it('a draft ending with a space or a tab gets no second space', () => {
    expect(appendDictation('Да ', 'нет')).toBe('Да нет');
    expect(appendDictation('Да\t', 'нет')).toBe('Да\tнет');
  });
  it('the recognised text is trimmed; an empty one leaves the draft as it was', () => {
    expect(appendDictation('Да', '  нет \n')).toBe('Да нет');
    expect(appendDictation('Да', '   ')).toBe('Да');
  });
});
