import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { BRAND_NAME } from '../brand.js';
import { Popover, PopoverPopup, PopoverTrigger } from '../components/ui/popover.js';
import { cn } from '../lib/utils.js';

export type UpdateStep = 'idle' | 'checking' | 'downloading' | 'downloaded' | 'error';

export interface UpdateNoticeProps {
  currentVersion: string;
  latestVersion: string;
  step: UpdateStep;
  progress?: number;
  error?: string | null;
  releaseNotes?: string | null;
  releaseUrl: string;
  /** Only the desktop app can install; a browser just links to the release. */
  canInstall: boolean;
  busy: boolean;
  onDownload: () => void;
  onRestart: () => void;
  onLater: () => void;
}

const SEEN_KEY = 'contextspace_update_seen_v1';

/** Whether this version has been shown before, remembered per device so its dot pulses only the first time. */
function firstSight(version: string): boolean {
  try { return localStorage.getItem(SEEN_KEY) !== version; } catch { return false; }
}
function markSeen(version: string) {
  try { localStorage.setItem(SEEN_KEY, version); } catch { /* the pulse may repeat; nothing else depends on it */ }
}

const actionClass = 'inline-flex h-7 items-center rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50';

/**
 * A new version as a small dot beside the version number instead of a banner above the work. Its popover has the
 * same content and actions the banner had. A failed download turns the dot to the warning colour, and the failed
 * check or download is still reported by the alert bar over the page.
 */
export function UpdateNotice({
  currentVersion, latestVersion, step, progress = 0, error, releaseNotes, releaseUrl, canInstall, busy, onDownload, onRestart, onLater,
}: UpdateNoticeProps) {
  const failed = step === 'error';
  const [fresh] = useState(() => firstSight(latestVersion));
  const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    markSeen(latestVersion);
    if (!(fresh && reduced)) return;
    // The live region is already mounted and empty; filling it a moment later is what a screen reader announces.
    const timer = setTimeout(() => setAnnouncement(`Update available: v${latestVersion}`), 600);
    return () => clearTimeout(timer);
  }, [fresh, reduced, latestVersion]);
  const title = failed ? `${BRAND_NAME} update needs attention` : step === 'downloaded' ? 'Update ready to install' : step === 'downloading' ? 'Downloading update…' : `A new version of ${BRAND_NAME} is available`;
  const label = failed ? 'Update needs attention' : step === 'downloaded' ? 'Update ready to install' : step === 'downloading' ? `Downloading update ${Math.round(progress)}%` : `Update available: v${currentVersion} to v${latestVersion}`;
  return (
    <>
    <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
    <Popover>
      <PopoverTrigger
        aria-label={label} title={label} data-testid="update-dot"
        className="relative grid size-6 cursor-pointer place-items-center rounded-md transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
      >
        {busy
          ? <RefreshCw aria-hidden="true" className="size-3 animate-spin text-muted-foreground" />
          : <span aria-hidden="true" data-testid="update-dot-mark" className={cn('size-2 rounded-full', failed ? 'bg-[var(--state-needs)]' : 'bg-primary', fresh && !failed && 'animate-[pulse_1.6s_ease-in-out_3] motion-reduce:animate-none')} />}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-[min(22rem,calc(100vw-2rem))]">
        <section aria-label={title} className="space-y-2 text-sm">
          <h3 className="font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">
            {failed
              ? (error || 'The update could not be completed. You can retry or use the release page.')
              : step === 'downloaded'
                ? `Restart ${BRAND_NAME} when convenient to install it.`
                : step === 'downloading'
                  ? `Downloading from GitHub Releases… ${Math.round(progress)}%`
                  : `v${currentVersion} to v${latestVersion}: the latest features and bug fixes.`}
          </p>
          {step === 'downloading' && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Update download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
              <div className="h-full bg-primary transition-all" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
            </div>
          )}
          {releaseNotes && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium text-foreground focus-visible:outline-2 focus-visible:outline-ring">Release notes</summary>
              <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap">{releaseNotes}</p>
            </details>
          )}
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {canInstall && step === 'downloaded' && (
              <button type="button" onClick={onRestart} className="inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-ring">Restart &amp; Install</button>
            )}
            {canInstall && step !== 'downloaded' && (
              <button type="button" onClick={onDownload} disabled={busy} className="inline-flex h-7 items-center rounded-md bg-primary px-2.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
                {failed ? 'Retry download' : busy ? 'Downloading…' : 'Download update'}
              </button>
            )}
            <a href={releaseUrl} target="_blank" rel="noreferrer" className={actionClass}>View release</a>
            <button type="button" onClick={onLater} disabled={busy} className={actionClass}>Later</button>
          </div>
        </section>
      </PopoverPopup>
    </Popover>
    </>
  );
}
