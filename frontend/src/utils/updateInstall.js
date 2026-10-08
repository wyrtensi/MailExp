// Shared "Copy & Quit" action for manual (Linux package) updates. The Electron
// main process copies the install command and quits, but the clipboard write can
// fail and then returns { copied: false } without quitting, so the user must be told. `t` is the
// i18n translate function.
export async function copyInstallCommandAndQuitOrWarn(updates, { installCommand, filePath } = {}, addNotification, t) {
  const result = await updates?.copyInstallCommandAndQuit?.({ installCommand, filePath });
  if (!result?.copied) {
    addNotification({
      type: 'error',
      title: t('notifications.desktop.copyFailed'),
      body: t('notifications.desktop.copyFailedBody'),
    });
  }
  return result;
}
