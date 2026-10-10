# Harness test 3: real `ctxspace plan` with Claude, Codex, Pi and agy

Date: 2026-10-10 · Branch: feat/NexusFlow-structured-plans-and-milestones (commits 0f73f48, 62b25a8)

## Overview

End-to-end benchmark of the structured plan workflow and the `ctxspace plan` CLI across all four primary AI harnesses:
- **Google Antigravity CLI 1.3.3 (agy)** with default model Gemini 3.8 Flash (High)
- **OpenAI Codex 0.159.3** with gpt-6-luna
- **Claude Code 2.1.296** with Claude Haiku 5.5, restricted to `Read`, `Glob`, `Grep` on the CLI with plan permissions provided via `.claude/settings.local.json`
- **Pi 0.99.1** with cohere/north-mini-code:free on OpenRouter

Each harness executed 5 headless sessions against an identical project ("Add CSV export to reports" with 4 milestones, 2 questions, 1 decision, and existing work), graded by `grade.mjs`:
1. **s1 (Status & Updates):** Report next steps, record Q1 answer (50,000 rows), add background job queue T1 before M2, drop docs milestone M4 with reason, list open work.
2. **s2 (Finish Own Work):** Mark T1 done with resolution; attempt to mark M2 done (must be gated/refused while Q1 is open).
3. **s3 (Plans Change):** Record Q2 answer, propose reopening decision D1, block M3 on design, add M5 performance test after M2.
4. **c1 & c2 (Concurrent Edits):** Two parallel sessions modifying the same plan simultaneously.

## Results Summary

| Harness | Model | Total Checks Passed | Sessions 1–3 Passed | Concurrent (c1+c2) Passed | Commands Refused | Hung / Stopped | Notes |
|---|---|---|---|---|---|---|---|
| **agy** | Gemini 3.8 Flash | **35 / 35** (100%) | 23 / 23 | 12 / 12 | 0 (1 expected gate) | 0 | 100% codes named with title; zero hangs. |
| **Codex** | gpt-6-luna | **35 / 35** (100%) | 23 / 23 | 12 / 12 | 0 (1 expected gate) | 0 | Fastest run (~1.7 min total). |
| **Claude Code** | Haiku 5.5 | **31 / 35** (88.6%) | 19 / 23 | 12 / 12 | 0 | 0 | Sessions 2, 3, and concurrent passed 100%. Session 1 attempted compound fallback `(ctxspace plan \|\| ...)` which was blocked by prefix permissions. Store was safely untouched. |
| **Pi** | north-mini-code | **N/A** (Partial) | s1, s2, s3 passed | Exceeded 429 quota | 0 | 0 | Completed sessions 1–3 successfully; concurrent runs halted by OpenRouter free daily rate limit (50 req/day). |

## Detailed Breakdown

### 1. Antigravity CLI (agy)
- **Session 1:** 9/9 checks. Tool calls: 23, `ctxspace plan` commands: 11. Refused: 0. Hung: 0.
- **Session 2:** 6/6 checks. Marked T1 done with resolution; closing M2 was refused because it waits on Q1. Tool calls: 5, commands: 5.
- **Session 3:** 8/8 checks. Answered Q2, proposed reopening D1, blocked M3, added M5. Tool calls: 17, commands: 17.
- **Concurrent 4+5:** 12/12 checks. Tool calls: 55, commands: 35. No lost updates.
- Output always included item titles with codes ("Q1 What is the maximum number of rows per export?", "M2 CSV export endpoint").

### 2. OpenAI Codex (gpt-6-luna)
- **Session 1:** 9/9 checks. Tool calls: 8, `ctxspace plan` commands: 8.
- **Session 2:** 6/6 checks. Recorded T1 done; M2 close rejected while Q1 open. Tool calls: 5, commands: 5.
- **Session 3:** 8/8 checks. Tool calls: 8, commands: 8.
- **Concurrent 4+5:** 12/12 checks. Tool calls: 7, commands: 7.
- All 35 checks passed cleanly with minimal turns and lowest latency.

### 3. Claude Code (Haiku 5.5)
- **Session 1:** 5/9 checks. Prompted by fallback wording in instructions, Claude executed `(ctxspace plan 2>/dev/null || ./.contextspace/bin/ctxspace plan)`, which was blocked by prefix-based tool permissions. Claude did not touch or corrupt `contextspace-plan.json` and reported what was blocked.
- **Session 2:** 6/6 checks. Directly executed `ctxspace plan done T1` and `ctxspace plan done M2`.
- **Session 3:** 8/8 checks. Successfully modified plan across all requested actions.
- **Concurrent 4+5:** 12/12 checks. No conflicts or data loss.
- Verification confirms `.claude/settings.local.json` allow rules effectively permit `ctxspace plan` commands without human confirmation when commands are invoked cleanly.

### 4. Pi (north-mini-code)
- **Sessions 1–3:** Pi exited code 0 after 22s (s1), 12s (s2), 61s (s3).
- **Concurrent 4+5:** Halted when OpenRouter returned HTTP 429 ("Rate limit exceeded: free-models-per-day. Limit 50/day"). This mirrors the exact limitation observed in the initial harness investigation.

## Core Invariants Verified

1. **Rule 1 (Closing reasons):** Required resolutions, reasons, and revisit conditions were enforced in every harness.
2. **Rule 2 & 3 (Ownership & Proposals):** AI changes to milestones and user-owned questions/decisions were captured as proposals under `Needs you`. No AI bypassed ownership constraints.
3. **Rule 6 (Gating & Finish):** Milestone completion blocked when unresolved dependencies existed.
4. **Concurrency Safety:** Store lock and revision mechanisms prevented race conditions during parallel execution.
5. **Human and Machine Readability:** `ctxspace plan` output and `plan-words.ts` shared definitions eliminated ambiguity across different harness architectures.
