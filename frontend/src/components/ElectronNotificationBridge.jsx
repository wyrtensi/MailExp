import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { manualSyncAccountIds } from '../utils/mailboxSync.js';
import { installCapacitorNativeBridge } from '../utils/capacitorNativeBridge.js';
import { createBoundedActionIdTracker, isTrustedNativeMessage } from '../utils/nativeActionSecurity.js';
import { copyInstallCommandAndQuitOrWarn } from '../utils/updateInstall.js';
import { mailboxBusyOr } from '../utils/mailboxBusy.js';
import i18n from '../i18n.js';

function linuxInstructionPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  if (!normalized) return null;
  return normalized.replace(/^\/home\/[^/]+(?=\/)/, '$HOME');
}

function getLinuxInstallCommandFromPath(filePath) {
  const normalized = linuxInstructionPath(filePath);
  if (!normalized) return null;

  const escaped = normalized.startsWith('$HOME/')
    ? normalized.replace(/(["\\`])/g, '\\$1')
    : normalized.replace(/(["\\$`])/g, '\\$1');
  const quotedPath = `"${escaped}"`;

  if (/\.deb$/i.test(normalized)) return `sudo apt install ${quotedPath}`;
  if (/\.rpm$/i.test(normalized)) return `sudo dnf install ${quotedPath}`;
  return null;
}

function isLinuxPackagePath(filePath) {
  return /\.(deb|rpm)$/i.test(String(filePath || ''));
}

export default function ElectronNotificationBridge() {
  const addNotification = useStore(state => state.addNotification);
  const openCompose = useStore(state => state.openCompose);
  const setSelectedAccount = useStore(state => state.setSelectedAccount);
  const setSelectedMessage = useStore(state => state.setSelectedMessage);
  const setSearchQuery = useStore(state => state.setSearchQuery);
  const totalUnread = useStore(state => state.unreadCounts.total);
  const lastActionRef = useRef({ action: null, time: 0 });
  const processedActionIdsRef = useRef(createBoundedActionIdTracker());
  const [nativeBridgeReady, setNativeBridgeReady] = useState(() => Boolean(window.mailexpertNative));

  useEffect(() => {
    let cancelled = false;
    installCapacitorNativeBridge().then(() => {
      if (!cancelled) setNativeBridgeReady(Boolean(window.mailexpertNative));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!nativeBridgeReady) return undefined;
    window.__mailexpertNativeBridgeReady = true;

    return () => {
      window.__mailexpertNativeBridgeReady = false;
    };
  }, [nativeBridgeReady]);

  useEffect(() => {
    if (!nativeBridgeReady) return;
    window.mailexpertNative?.badges?.setUnreadCount?.(totalUnread || 0);
  }, [nativeBridgeReady, totalUnread]);

  useEffect(() => {
    if (!nativeBridgeReady) return undefined;
    const unsubscribe = window.mailexpertNative?.notifications?.onPush?.((notification) => {
      addNotification({
        type: notification.type === 'negative' ? 'error' : notification.type,
        title: notification.title,
        body: notification.body || notification.message,
      });
    });

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [addNotification, nativeBridgeReady]);

  useEffect(() => {
    if (!nativeBridgeReady) return undefined;
    const unsubscribe = window.mailexpertNative?.updates?.onStatus?.((status) => {
      if (status?.type !== 'downloaded') return;

      const platform = window.mailexpertNative?.platform;
      const filePath = status?.data?.filePath || status?.data?.updatePath || '';
      const installCommand = status?.data?.installCommand
        || (platform === 'linux' ? getLinuxInstallCommandFromPath(filePath) : null);
      const manualInstall = Boolean(
        status?.data?.manualInstall
        || installCommand
        || (platform === 'linux' && (isLinuxPackagePath(filePath) || status?.data?.manual))
      );
      const t = i18n.t.bind(i18n);
      addNotification({
        type: 'success',
        title: t('notifications.desktop.updateReady'),
        body: manualInstall
          ? (installCommand
            ? t('notifications.desktop.updateVerifiedCommand', { command: installCommand })
            : t('notifications.desktop.updateVerified'))
          : t('notifications.desktop.updateDownloaded'),
        allowWrap: true,
        persistent: true,
        actionLabel: manualInstall ? i18n.t('notifications.desktop.copyAndQuit') : t('notifications.desktop.install'),
        onAction: async () => {
          if (manualInstall) {
            await copyInstallCommandAndQuitOrWarn(
              window.mailexpertNative?.updates,
              { installCommand, filePath },
              addNotification,
              t,
            );
            return;
          }

          const result = await window.mailexpertNative?.updates?.installDownloaded?.();
          if (result?.reason === 'manual-install-required' && result.installCommand) {
            addNotification({
              type: 'success',
              title: t('notifications.desktop.updateReady'),
              body: t('notifications.desktop.updateVerifiedCommand', { command: result.installCommand }),
              allowWrap: true,
              persistent: true,
              actionLabel: i18n.t('notifications.desktop.copyAndQuit'),
              onAction: async () => {
                await copyInstallCommandAndQuitOrWarn(
                  window.mailexpertNative?.updates,
                  { installCommand: result.installCommand, filePath },
                  addNotification,
                  t,
                );
              },
            });
            return;
          }

          if (result && result.installed === false) {
            addNotification({
              type: 'error',
              title: t('notifications.desktop.installFailed'),
              body: t('notifications.desktop.installFailedBody'),
            });
          }
        },
      });
    });

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [addNotification, nativeBridgeReady]);

  useEffect(() => {
    if (!nativeBridgeReady) return;
    if (window.mailexpertNative?.platform !== 'android') return;
    window.mailexpertNative?.updates?.check?.(false)?.catch?.(() => {});
  }, [nativeBridgeReady]);

  useEffect(() => {
    if (!nativeBridgeReady) return undefined;
    const getPayloadMessage = (payload) => {
      const state = useStore.getState();
      return payload?.message || state.messages.find((item) => item.id === payload?.messageId) || null;
    };

    const openMessageFromPayload = (payload) => {
      const messageId = payload?.messageId;
      if (!messageId) return null;

      const folder = payload.folder || 'INBOX';
      const message = getPayloadMessage(payload);
      const state = useStore.getState();

      setSearchQuery('');
      if (payload.accountId) {
        setSelectedAccount(payload.accountId, folder);
      }

      if (message && !state.messages.some((item) => item.id === message.id)) {
        useStore.setState((current) => ({
          messages: [{ ...message, account_id: message.account_id || payload.accountId }, ...current.messages],
        }));
      }

      window.dispatchEvent(new CustomEvent('mailexpert:refresh'));
      window.setTimeout(() => setSelectedMessage(messageId), 0);
      return message;
    };

    const normalizeAddressList = (value) => {
      if (Array.isArray(value)) return value;
      try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };

    const openReplyFromPayload = (payload) => {
      const message = getPayloadMessage(payload);
      if (!message) return;

      const replyTo = normalizeAddressList(message.reply_to ?? message.replyTo);
      const replyTarget = replyTo[0]?.email
        ? replyTo[0]
        : {
            name: message.from_name || message.fromName || '',
            email: message.from_email || message.fromEmail || '',
          };
      const sender = replyTarget.email ? [replyTarget] : [];
      const rawSubject = (message.subject || '').trim();
      const subject = rawSubject.startsWith('Re:') ? rawSubject : rawSubject ? `Re: ${rawSubject}` : 'Re:';
      const originalMessageId = message.message_id || message.messageId;
      const priorInReplyTo = message.in_reply_to || message.inReplyTo;

      openCompose({
        to: sender,
        cc: [],
        subject,
        body: '',
        inReplyTo: originalMessageId,
        references: [priorInReplyTo, originalMessageId].filter(Boolean).join(' ').trim() || null,
        accountId: message.account_id || message.accountId || payload.accountId,
        isReply: true,
        originalFrom: sender,
        allRecipients: [],
      });
    };

    const runNativeAction = async (payload) => {
      const action = typeof payload === 'string' ? payload : payload?.action;
      const id = typeof payload === 'object' ? payload?.id : null;

      if (!action) return;
      if (id && !processedActionIdsRef.current.remember(id)) return;

      const now = Date.now();
      const last = lastActionRef.current;

      if (!id && last.action === action && now - last.time < 500) return;
      lastActionRef.current = { action, time: now };

      try {
        if (action === 'new-mail') {
          openCompose(payload?.composeData || {});
          return;
        }

        if (action === 'open-message') {
          openMessageFromPayload(payload);
          return;
        }

        if (action === 'reply-message') {
          openReplyFromPayload(payload);
          return;
        }

        if (action === 'delete-message') {
          const messageId = payload?.messageId;
          if (!messageId) return;

          try {
            await api.deleteMessage(messageId);
          } catch (err) {
            addNotification({
              type: 'error',
              title: i18n.t('messageList.deleted.failTitle'),
              body: mailboxBusyOr(err, i18n.t.bind(i18n), i18n.t('messageList.deleted.failBody')),
            });
            return;
          }
          useStore.getState().removeMessage(messageId);
          window.dispatchEvent(new CustomEvent('mailexpert:refresh'));
          return;
        }

        if (action === 'star-message') {
          const messageId = payload?.messageId;
          if (!messageId) return;

          try {
            await api.markStarred(messageId, true);
          } catch (err) {
            addNotification({
              type: 'error',
              title: i18n.t('common.actionFailed.star'),
              body: mailboxBusyOr(err, i18n.t.bind(i18n), i18n.t('common.actionFailed.body')),
            });
            return;
          }
          useStore.getState().updateMessage(messageId, { is_starred: true });
          return;
        }

        if (action === 'sync') {
          try {
            addNotification({
              type: 'info',
              title: i18n.t('notifications.desktop.syncStarted'),
              body: i18n.t('notifications.desktop.syncStartedBody'),
            });
            // Sync is per mailbox: ask for every enabled IMAP mailbox.
            const { accounts } = useStore.getState();
            await Promise.all(manualSyncAccountIds(accounts).map((accountId) => api.syncNow(accountId)));
          } catch (error) {
            addNotification({
              type: 'error',
              title: i18n.t('common.actionFailed.sync'),
              body: mailboxBusyOr(error, i18n.t.bind(i18n), error.message || i18n.t('common.actionFailed.body')),
            });
          }
        }
      } finally {
        if (id) {
          window.mailexpertNative?.actions?.ack?.(id);
        }
      }
    };

    const handleNativeAction = (event) => {
      runNativeAction(event.detail);
    };

    const handleNativeMessage = (event) => {
      if (!isTrustedNativeMessage(event)) return;
      if (event.data?.type === 'mailexpert:native-action') {
        runNativeAction(event.data.payload);
      } else if (event.data?.type === 'mailexpert:native-actions-ready') {
        drainInjectedActions();
      }
    };

    const drainInjectedActions = () => {
      const actions = Array.isArray(window.__mailexpertPendingNativeActions)
        ? window.__mailexpertPendingNativeActions.splice(0)
        : [];
      actions.forEach(runNativeAction);
    };

    const unsubscribe = window.mailexpertNative?.actions?.onAction?.((payload) => {
      runNativeAction(payload);
    });

    window.mailexpertNative?.actions?.getPending?.()
      .then((actions = []) => {
        actions.forEach(runNativeAction);
      })
      .catch(() => {});

    drainInjectedActions();
    window.addEventListener('mailexpert:native-action', handleNativeAction);
    window.addEventListener('mailexpert:native-actions-ready', drainInjectedActions);
    window.addEventListener('message', handleNativeMessage);
    return () => {
      window.removeEventListener('mailexpert:native-action', handleNativeAction);
      window.removeEventListener('mailexpert:native-actions-ready', drainInjectedActions);
      window.removeEventListener('message', handleNativeMessage);
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [addNotification, nativeBridgeReady, openCompose, setSearchQuery, setSelectedAccount, setSelectedMessage]);

  return null;
}
