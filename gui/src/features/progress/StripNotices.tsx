import { useState } from 'react';
import { Check, CircleHelp, ListChecks, RotateCcw } from 'lucide-react';

import { IconButton } from '../../components/ui/icon-button.js';
import { InlinePlanMarkdown } from '../../components/InlinePlanMarkdown.js';
import { AnswerBox } from '../plan/AnswerBox.js';
import { questionWhy, whenText, whoName } from '../plan/planView.js';
import { ReopenForm } from './ProgressPanel.js';
import type { PlanClose, PlanQuestion } from './stripPlan.js';

export interface PlanQuestionBarProps {
  item: PlanQuestion;
  /** How many more wait after this one. */
  more: number;
  busy: boolean;
  error?: string;
  /** Resolves true once the answer is in the plan. */
  onAnswer: (answer: string) => Promise<boolean>;
  onShowAll: () => void;
}

/**
 * A question in the plan that waits for the developer, answered above the chat. The answer goes into the
 * plan, where the AI reads it. The box takes several lines; Ctrl+Enter or the button sends it.
 */
export function PlanQuestionBar({ item, more, busy, error, onAnswer, onShowAll }: PlanQuestionBarProps) {
  const why = questionWhy(item.detail);
  return (
    <div role="group" aria-label="A question in the plan waits for your answer" className="flex items-start gap-2.5 border-t border-[color-mix(in_oklab,var(--state-needs)_45%,transparent)] bg-[color-mix(in_oklab,var(--state-needs)_7%,var(--card))] px-3 py-2">
      <CircleHelp aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--state-needs)]" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-[11px] text-muted-foreground">{item.context}</p>
        <p className="line-clamp-3 break-words text-[13px] leading-snug text-foreground"><InlinePlanMarkdown content={item.title} /></p>
        {why && <p className="line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">{why}</p>}
        <AnswerBox question={item.title} detail={item.detail} busy={busy} error={error} onAnswer={onAnswer} />
        {more > 0 && (
          <button type="button" onClick={onShowAll} className="cursor-pointer text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded">
            {more === 1 ? '1 more waits for you' : `${more} more wait for you`}
          </button>
        )}
      </div>
    </div>
  );
}

const CLOSE_WORDS: Record<string, string> = { done: 'finished', dropped: 'dropped', later: 'put off', reopened: 'reopened' };

export interface AiClosedBarProps {
  workspace: string;
  entry: PlanClose;
  /** The milestone's name, without its code. */
  title: string;
  /** How many more the AI closed since the developer last looked. */
  more: number;
  /** Resolves to an error message, or null once it is reopened. */
  onReopen: (reason: string) => Promise<string | null>;
  onSeen: () => void;
  onOpenPlan: () => void;
}

/**
 * What the AI closed while the developer was in the chat: it finishes milestones itself, so it says so
 * here, where the developer is, with Reopen one click away.
 */
export function AiClosedBar({ workspace, entry, title, more, onReopen, onSeen, onOpenPlan }: AiClosedBarProps) {
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const when = whenText(entry.at);
  const canReopen = entry.action !== 'reopened';
  return (
    <div role="group" aria-label="What the AI closed" className="border-t border-border bg-card px-3 py-1.5">
      <div className="flex items-center gap-2 text-[12px]">
        <ListChecks aria-hidden="true" className="size-4 shrink-0 text-[var(--state-done)]" />
        <p className="min-w-0 flex-1 truncate" title={entry.note ? `${title}: ${entry.note}` : title}>
          <span className="font-medium">{whoName(entry.by)}</span> {CLOSE_WORDS[entry.action] ?? entry.action} &ldquo;{title}&rdquo;
          {entry.note && <span className="text-muted-foreground">: {entry.note}</span>}
          {when && <span className="text-muted-foreground"> · {when}</span>}
          {more > 0 && <span className="text-muted-foreground"> · {more} more</span>}
        </p>
        <div className="flex shrink-0 items-center">
          {canReopen && !reopening && <IconButton label={`Reopen "${title}"`} icon={<RotateCcw />} onClick={() => { setReopening(true); setError(undefined); }} />}
          <IconButton label="Open the plan" icon={<ListChecks />} onClick={onOpenPlan} />
          <IconButton label="Got it" icon={<Check />} onClick={onSeen} />
        </div>
      </div>
      {reopening && (
        <ReopenForm
          id={`${workspace}-strip-reopen-${entry.itemId}`} title={title} reason={reason} pending={pending} error={error}
          onChange={setReason}
          onSubmit={() => {
            setPending(true);
            void onReopen(reason.trim()).then((failure) => {
              setPending(false);
              if (failure) { setError(failure); return; }
              setReopening(false); setReason('');
            });
          }}
          onCancel={() => { setReopening(false); setError(undefined); }}
        />
      )}
    </div>
  );
}
