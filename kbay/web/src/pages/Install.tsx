import { useEffect, useState } from 'react';
import { Button, Card, PageHeader } from '../components/ui';

// Plain instructions for saving the portal to an Android home screen (a PWA, no app store).
interface PromptEvent extends Event { prompt: () => Promise<void> }

export function InstallSteps() {
  const [prompt, setPrompt] = useState<PromptEvent | null>(null);
  useEffect(() => {
    const h = (e: Event) => { e.preventDefault(); setPrompt(e as PromptEvent); };
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);
  const installed = window.matchMedia?.('(display-mode: standalone)').matches;
  if (installed) return <p className="text-sm text-[var(--good)]">K-BAY is installed on this device.</p>;
  return (
    <div className="space-y-3 text-sm">
      {prompt ? <Button variant="primary" className="w-full" onClick={() => prompt.prompt()}>Install K-BAY on this device</Button> : null}
      <ol className="list-decimal space-y-2 pl-5">
        <li>Open this page in <b>Chrome</b> on your Android phone or tablet.</li>
        <li>Tap the <b>⋮</b> menu at the top right.</li>
        <li>Tap <b>Add to Home screen</b> (or <b>Install app</b>), then <b>Install</b>.</li>
        <li>Open <b>K-BAY</b> from your home screen. It works like a normal app.</li>
        <li>When asked, <b>allow notifications</b> so you get approvals and reminders.</li>
      </ol>
      <p className="text-[var(--muted)]">iPhone: open in Safari, tap Share, then “Add to Home Screen”.</p>
    </div>
  );
}

export function Install() {
  return (
    <>
      <PageHeader title="Install the app" sub="Save K-BAY to your home screen." />
      <Card><InstallSteps /></Card>
    </>
  );
}
