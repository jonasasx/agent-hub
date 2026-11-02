/** AskUserQuestion input of the mock scenarios (M4b): single with a recommended option, multi, own answer. */
export const QUESTIONS = {
  questions: [
    {
      header: 'База',
      question: 'Какую базу взять?',
      multiSelect: false,
      options: [
        { label: 'Postgres (Recommended)', description: 'Уже есть в кластере' },
        { label: 'SQLite', description: 'Файл рядом с сервисом' },
      ],
    },
    { header: 'Проверки', question: 'Что прогнать перед выкаткой?', multiSelect: true, options: [{ label: 'Юнит-тесты' }, { label: 'e2e' }, { label: 'Нагрузку' }] },
    { header: 'Имя', question: 'Как назвать сервис?', multiSelect: false, options: [{ label: 'ledger-api' }, { label: 'money' }] },
  ],
};
