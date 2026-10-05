// The words of the error page (components/ErrorBoundary.jsx) in English and Russian. A small
// dictionary of its own rather than i18n: the page shows when something already failed, and i18n
// may be exactly that. Dependency-free on purpose.

export const BOUNDARY_TEXT = Object.freeze({
  en: Object.freeze({
    errorTitle: 'MailExpert hit an error and stopped',
    updatedTitle: 'MailExpert has been updated',
    errorBody: 'Reloading usually clears it. If it happens again right after a server update, the app and the server may be out of step: a hard reload picks up the newer version.',
    reloading: 'Loading the new version...',
    manual: 'This page is still running the previous version. Reload to continue. If the page does not load, check your connection.',
    reload: 'Reload',
    copy: 'Copy details',
    copied: 'Copied',
    footer: 'Copy the details and send them to your administrator: they point at the cause rather than the symptom.',
  }),
  ru: Object.freeze({
    errorTitle: 'В MailExpert произошла ошибка, работа остановлена',
    updatedTitle: 'MailExpert обновился',
    errorBody: 'Обычно помогает перезагрузка. Если ошибка повторяется сразу после обновления сервера, приложение и сервер могут быть разных версий: полная перезагрузка подхватит новую.',
    reloading: 'Загружаю новую версию...',
    manual: 'На этой странице всё ещё работает прежняя версия. Перезагрузите её, чтобы продолжить. Если страница не загружается, проверьте подключение.',
    reload: 'Перезагрузить',
    copy: 'Скопировать сведения',
    copied: 'Скопировано',
    footer: 'Скопируйте сведения и отправьте администратору: по ним видна причина, а не только последствие.',
  }),
});

// The language of the page: the one saved in the app (mailexpert_language, as i18n.js reads it),
// else the browser's, else English.
export function boundaryLanguage(saved, browser) {
  const pick = (value) => (typeof value === 'string' && /^ru\b/i.test(value) ? 'ru' : null);
  if (typeof saved === 'string' && saved) return pick(saved) ?? 'en';
  return pick(browser) ?? 'en';
}

// Reads the saved and browser language without trusting either to exist.
export function currentBoundaryLanguage() {
  let saved = null;
  try { saved = globalThis.localStorage?.getItem('mailexpert_language') ?? null; } catch { /* blocked storage */ }
  let browser = null;
  try { browser = globalThis.navigator?.language ?? null; } catch { /* no navigator */ }
  return boundaryLanguage(saved, browser);
}
