import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAcknowledgeQuestions, useChangePlan, usePlan, useProgressFacts, useReopenMilestone, useWorkGuidance, useWorkspaceChanges } from '../../lib/api/queries.js';
import type { OpenQuestion } from '../../types.js';
import { activeProposals, answersQuestion, freshReveals, latestNext, nextAction, type NextAction } from './progressView.js';
import { aiCloses, planQuestionsForYou, readSeenCloses, rememberSeenCloses } from './stripPlan.js';
import { useScreenFeed } from './useScreenFeed.js';

const NOTICE_MS = 6000;
/** How far back what the AI closed is shown when the developer has not looked here before. */
const CLOSES_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface WhereAreWeProps {
  workspace: string;
  /** Whether this workspace is the one on screen. Hidden ones neither poll nor listen. */
  active: boolean;
  /** Types text into the chat prompt without sending it. False when the chat is not connected. */
  fillPrompt: (text: string) => boolean;
  /** Set by the strip: called with the CLI's target when the developer sends a line to it in this chat. */
  replyRef?: { current: ((target: string) => void) | null };
  openFile: (reference: { path: string; line?: number }) => void;
}

/**
 * Everything the strip knows and does: the facts, the plan's questions and what the AI closed, the AI's
 * suggestions and reveals, and the panel's state. The summary sits in the chat's toolbar and the notices
 * above it, so the chat keeps two bars above its content.
 */
export function useWhereAreWe({ workspace, active, fillPrompt, replyRef, openFile }: WhereAreWeProps) {
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [section, setSection] = useState<'open' | 'milestones'>();
  const [notice, setNotice] = useState('');
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [seenCloses, setSeenCloses] = useState(() => readSeenCloses(workspace) ?? new Date(Date.now() - CLOSES_WINDOW_MS).toISOString());
  const factsQuery = useProgressFacts(workspace, active);
  const guidanceQuery = useWorkGuidance(active ? workspace : null);
  const planQuery = usePlan(active ? workspace : null);
  const changePlan = useChangePlan(workspace);
  const changesQuery = useWorkspaceChanges(workspace, active && expanded);
  const feed = useScreenFeed(workspace, active);
  const reopen = useReopenMilestone(workspace);
  const acknowledge = useAcknowledgeQuestions(workspace);
  const facts = factsQuery.data;
  const plan = planQuery.data;

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  // The assignment changes rarely, so it is read again when the panel opens rather than polled.
  const refetchGuidance = guidanceQuery.refetch;
  useEffect(() => { if (expanded) void refetchGuidance(); }, [expanded, refetchGuidance]);

  // The questions still open, oldest first, unless they could not be read.
  const questions = useMemo(() => (facts && !facts.unavailable.some((entry) => entry.source === 'questions') ? facts.openQuestions : []), [facts]);
  const planQuestions = useMemo(() => planQuestionsForYou(plan, questions), [plan, questions]);
  const closes = useMemo(() => aiCloses(plan, seenCloses), [plan, seenCloses]);
  // A line the developer sends to the assistant is their reply, so it closes what the AI asked. Read through refs:
  // the terminal calls this from its key handler, long after this render.
  const openQuestions = useRef<readonly OpenQuestion[]>([]);
  useEffect(() => { openQuestions.current = questions; }, [questions]);
  const acknowledgeMutate = acknowledge.mutate;
  useEffect(() => {
    if (!replyRef) return;
    replyRef.current = (target) => {
      const open = openQuestions.current;
      if (!answersQuestion(target, open)) return;
      openQuestions.current = [];
      acknowledgeMutate(undefined, {
        onSuccess: () => setNotice('Your reply answered the question.'),
        // Still open, so the next line the developer sends tries again.
        onError: () => {
          if (openQuestions.current.length === 0) openQuestions.current = open;
          setNotice('Your reply could not be recorded as the answer. Your next reply tries again.');
        },
      });
    };
    return () => { replyRef.current = null; };
  }, [replyRef, acknowledgeMutate]);

  // What the AI shows, or notes on a line, opens beside the chat as it arrives; what the stream replays from before does not.
  const revealSince = useRef(0);
  const revealed = useRef(new Set<string>());
  const openFileRef = useRef(openFile);
  useEffect(() => { openFileRef.current = openFile; });
  useEffect(() => { revealSince.current = Date.now(); revealed.current = new Set(); }, [workspace, active]);
  useEffect(() => {
    for (const reveal of freshReveals(feed.events, revealSince.current, revealed.current)) {
      revealed.current.add(reveal.id);
      openFileRef.current(reveal.target);
    }
  }, [feed.events]);

  const action = useMemo(() => (facts ? nextAction(facts, latestNext(feed.events)) : null), [facts, feed.events]);
  const proposals = useMemo(() => (facts ? activeProposals(feed.events, facts, dismissed) : []), [facts, feed.events, dismissed]);

  const fill = (text: string) => {
    setNotice(fillPrompt(text) ? 'Added to the chat prompt. Press Enter to send it.' : 'The chat is not connected, so nothing was added.');
  };
  const openPanel = (focus?: 'open' | 'milestones') => { setSection(focus); setExpanded(true); };
  const closePanel = () => { setExpanded(false); toggleRef.current?.focus(); };
  const runNext = (next: NextAction) => {
    if (next.kind === 'panel') { openPanel(next.section); return; }
    if (next.target) openFile(next.target);
    fill(next.prompt);
  };
  const answerInPlan = async (id: string, answer: string) => {
    try {
      await changePlan.mutateAsync({ change: { type: 'answer', id, answer }, ifRevision: plan?.revision });
      setNotice('Your answer is in the plan.');
      return true;
    } catch {
      return false;
    }
  };
  const reopenInPlan = async (id: string, reason: string): Promise<string | null> => {
    try {
      await changePlan.mutateAsync({ change: { type: 'reopen', id, reason }, ifRevision: plan?.revision });
      setNotice('Reopened. Tell the AI what is wrong in the chat.');
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Could not reopen it.';
    }
  };
  const seeCloses = () => {
    const newest = closes[0]?.at;
    if (!newest) return;
    rememberSeenCloses(workspace, newest);
    setSeenCloses(newest);
  };

  return {
    workspace, panelId, toggleRef, expanded, section, notice, facts, factsQuery, guidance: guidanceQuery.data, plan, questions, planQuestions, closes, openFile,
    action, proposals, changes: changesQuery, acknowledge, reopen, changePlan, navigate,
    fill, openPanel, closePanel, runNext, answerInPlan, reopenInPlan, seeCloses, setExpanded, setSection,
    dismissProposal: (eventId: string) => setDismissed((current) => new Set(current).add(eventId)),
  };
}

export type WhereAreWe = ReturnType<typeof useWhereAreWe>;
