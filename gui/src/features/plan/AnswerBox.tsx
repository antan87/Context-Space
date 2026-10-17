import { useRef, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Textarea } from '../../components/ui/textarea.js';
import { suggestedAnswers } from './planView.js';

export interface AnswerBoxProps {
  question: string;
  /** The question's detail, where the AI keeps the answers it suggests. */
  detail?: string;
  /** Another change to the plan is on its way. */
  busy?: boolean;
  error?: string;
  /** Resolves true once the answer is in the plan. */
  onAnswer: (answer: string) => Promise<boolean>;
}

/**
 * How the developer answers a plan question, wherever it is shown. A suggested answer goes into the box, to send
 * as it is or to change; the box takes several lines, and Ctrl+Enter or the button sends it. The answer goes into
 * the plan, where every AI reads it.
 */
export function AnswerBox({ question, detail, busy = false, error, onAnswer }: AnswerBoxProps) {
  const [answer, setAnswer] = useState('');
  const [sending, setSending] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const options = suggestedAnswers(detail);
  const submit = () => {
    const text = answer.trim();
    if (!text || busy || sending) return;
    setSending(true);
    void onAnswer(text).then((ok) => { setSending(false); if (ok) setAnswer(''); });
  };
  return <>
    {options.length > 0 && <div role="group" aria-label="Suggested answers" className="flex flex-wrap gap-1.5">
      {options.map((option) => <Button key={option} size="xs" variant="outline" title="Puts this answer in the box" onClick={() => { setAnswer(option); form.current?.querySelector('textarea')?.focus(); }}>{option}</Button>)}
    </div>}
    <form ref={form} className="flex items-end gap-1.5" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <Textarea
        aria-label={`Your answer to ${question.replace(/\*\*|`/g, '')}`} rows={1} value={answer} placeholder="Your answer"
        className="max-h-32 flex-1 text-xs" style={{ minHeight: '2rem' }}
        onChange={(event) => setAnswer(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); } }}
      />
      <Button type="submit" size="xs" disabled={busy || sending || !answer.trim()}>{sending ? 'Saving…' : 'Answer'}</Button>
    </form>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </>;
}
