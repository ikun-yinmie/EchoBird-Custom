// Feedback page — guides users to capture failing logs and send them to the
// admin mailbox. Two-step flow:
//   1. Copy last 30 backend log lines straight to clipboard (the same
//      stream that appears in the dev-mode CMD window, sourced from
//      `<app_log_dir>/echobird.log`).
//   2. Copy the admin mailbox (admin@xinjk.de5.net) and compose an email
//      there with the copied logs + a short description.

import { useState } from 'react';
import { Check, ClipboardCopy, Mail } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useToast } from '../../components/Toast';
import { readLogTail } from '../../api/tauri';
import { copyText } from '../../utils/copyText';

// Admin mailbox that receives feedback emails (with the copied log tail).
const SUPPORT_EMAIL = 'admin@xinjk.de5.net';
// Lines of backend log to copy. 30 is empirically enough to capture
// one user action + its failure trail without overflowing an email body.
const LOG_TAIL_LINES = 30;

export function FeedbackMain() {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [justCopied, setJustCopied] = useState(false);
  const [emailCopied, setEmailCopied] = useState(false);

  const copyLogTail = async () => {
    try {
      const text = await readLogTail(LOG_TAIL_LINES);
      if (!text) {
        showToast('warning', t('feedback.step1.empty'));
        return;
      }
      if (!(await copyText(text))) throw new Error('clipboard unavailable');
      setJustCopied(true);
      window.setTimeout(() => setJustCopied(false), 2000);
      showToast('success', t('feedback.step1.copied'));
    } catch (e) {
      console.error('[Feedback] copyLogTail failed', e);
      showToast('error', t('feedback.step1.failed'));
    }
  };

  return (
    <div className="max-w-2xl mx-auto py-8 px-2 space-y-8">
      <header className="space-y-3">
        <h1 className="cjk-title text-2xl">{t('feedback.title')}</h1>
        <p className="text-cyber-text-secondary leading-relaxed">{t('feedback.intro')}</p>
      </header>

      <section className="rounded-lg border border-cyber-border bg-cyber-bg-secondary/40 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <ClipboardCopy size={18} className="text-cyber-accent" />
          <h2 className="font-semibold">{t('feedback.step1.title')}</h2>
        </div>
        <p className="text-sm text-cyber-text-secondary leading-relaxed">
          {t('feedback.step1.desc')}
        </p>
        <button
          onClick={copyLogTail}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-cyber-accent/15 hover:bg-cyber-accent/25 border border-cyber-accent/40 text-cyber-accent transition-colors text-sm font-medium"
        >
          {justCopied ? <Check size={14} /> : <ClipboardCopy size={14} />}
          {justCopied ? t('feedback.step1.copied') : t('feedback.step1.button')}
        </button>
      </section>

      <section className="rounded-lg border border-cyber-border bg-cyber-bg-secondary/40 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Mail size={18} className="text-cyber-accent" />
          <h2 className="font-semibold">{t('feedback.step2.title')}</h2>
        </div>
        <p className="text-sm text-cyber-text-secondary leading-relaxed">
          {t('feedback.step2.desc')}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => {
              // Copy the email address to clipboard rather than firing a
              // mailto: URL — most users don't have a desktop mail client
              // configured, and a missing handler launches OS picker noise.
              void copyText(SUPPORT_EMAIL).then((ok) => {
                setEmailCopied(ok);
                showToast(
                  ok ? 'success' : 'error',
                  t(ok ? 'feedback.step1.copied' : 'feedback.step1.failed')
                );
                if (ok) window.setTimeout(() => setEmailCopied(false), 2000);
              });
            }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-cyber-accent/15 hover:bg-cyber-accent/25 border border-cyber-accent/40 text-cyber-accent transition-colors text-sm font-medium"
          >
            {emailCopied ? <Check size={14} /> : <Mail size={14} />}
            {emailCopied ? t('feedback.step1.copied') : t('feedback.step2.button')}
          </button>
        </div>
        <div className="rounded-md border border-cyber-border/60 bg-cyber-bg-secondary/60 px-3 py-2.5 text-sm font-mono text-cyber-text-secondary select-all">
          {SUPPORT_EMAIL}
        </div>
      </section>
    </div>
  );
}
