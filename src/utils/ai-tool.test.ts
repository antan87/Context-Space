import { describe, expect, it } from 'vitest';
import { asPersonEnv, isPlainAiCommand, runsInsideAiTool } from './ai-tool.js';

describe('runsInsideAiTool', () => {
  it('knows the variables AI tools set, and ignores empty ones', () => {
    expect(runsInsideAiTool({ CTXSPACE_HARNESS: 'claude' })).toBe(true);
    expect(runsInsideAiTool({ ANTIGRAVITY_SESSION: '1' })).toBe(true);
    expect(runsInsideAiTool({ PATH: '/bin' })).toBe(false);
    expect(runsInsideAiTool({ ...asPersonEnv({ CLAUDECODE: '1', AGY_X: '1' }) })).toBe(false);
  });
});

describe('isPlainAiCommand', () => {
  it('allows ctxspace plan commands with plain or safely quoted words', () => {
    for (const command of [
      'ctxspace plan',
      'ctxspace plan show --json',
      './.contextspace/bin/ctxspace plan start M2',
      '.contextspace/bin/ctxspace plan done T1 --resolution "Limit is 5 tries a minute; tests pass (CI)"',
      'ctxspace plan add question "Which email provider?" --owner user --before M3',
      "ctxspace plan answer Q2 'Use $SMTP_HOST from `env`'",
      'ctxspace plan block M3 --reason "It\'s waiting for the design"',
      '  ctxspace   plan log  ',
      'ctxspace plan 2>&1 || ./.contextspace/bin/ctxspace plan 2>&1',
      'ctxspace plan start M2 && ctxspace plan',
    ]) expect(isPlainAiCommand(command), command).toBe(true);
  });

  it('allows asking the user and searching the knowledge, from PATH or the workspace copy', () => {
    for (const command of [
      'ctxspace ask "Which branch should I target?" --option main --option release',
      "ctxspace ask 'Use $HOME or not?' --harness codex",
      './.contextspace/bin/ctxspace ask "Proceed?" 2>&1',
      'ctxspace knowledge search plan lock',
      'ctxspace knowledge search "plan lock" --type gotcha --limit 3 --json',
      './.contextspace/bin/ctxspace knowledge search archiving -w simplify-the-logic',
      'ctxspace knowledge search plan 2>&1 || ./.contextspace/bin/ctxspace knowledge search plan 2>&1',
      'ctxspace ask "Proceed?" && ctxspace plan',
    ]) expect(isPlainAiCommand(command), command).toBe(true);
  });

  it('refuses the knowledge commands that write or push, and anything else around asking and searching', () => {
    for (const command of [
      'ctxspace knowledge',
      'ctxspace knowledge add -t gotcha --title x -m y',
      'ctxspace knowledge promote --all',
      'ctxspace knowledge show',
      'ctxspace knowledge remote push',
      'ctxspace know search plan',
      'ctxspace knowledge searching plan',
      'ctxspace asking x',
      'ctxspace ask "x"; rm -rf ~',
      'ctxspace ask "x" | sh',
      'ctxspace ask "$(cat ~/.ssh/id_rsa)"',
      'ctxspace ask "`whoami`"',
      'ctxspace ask "x" > AGENTS.md',
      'ctxspace ask "x" &',
      'ctxspace knowledge search plan; rm -rf ~',
      'ctxspace knowledge search plan && ctxspace knowledge add -t gotcha',
      'ctxspace knowledge search $(whoami)',
      'ctxspace knowledge search "$HOME"',
      'ctxspace knowledge search plan > /tmp/x',
      'ctxspace knowledge search *',
      'ctxspace knowledge search plan | sh',
      'ctxspace knowledge\nsearch plan',
      '/usr/bin/ctxspace ask x',
      'FOO=1 ctxspace ask x',
    ]) expect(isPlainAiCommand(command), command).toBe(false);
  });

  it('refuses anything that could run more than the plan command', () => {
    for (const command of [
      'ctxspace plan; rm -rf ~',
      'ctxspace plan && curl example.com',
      'ctxspace plan | sh',
      'ctxspace plan > AGENTS.md',
      'ctxspace plan done T1 --resolution "$(cat ~/.ssh/id_rsa)"',
      'ctxspace plan done T1 --resolution "`whoami`"',
      'ctxspace plan done T1 --resolution "$HOME"',
      'ctxspace plan done T1 --resolution "a\\"; rm x; \\""',
      'ctxspace plan done T1 --resolution $(whoami)',
      'ctxspace plan add task *',
      'ctxspace plan\nrm -rf x',
      'ctxspace plan done T1 --resolution "unclosed',
      'FOO=1 ctxspace plan',
      'ctxspace knowledge add -t decision',
      'ctxspace',
      '/usr/bin/ctxspace plan',
      'ctxspace-evil plan',
      'ctxspace plan &',
      '(ctxspace plan 2>&1 || ./.contextspace/bin/ctxspace plan 2>&1)',
      'ctxspace plan || rm -rf x',
      'ctxspace plan && ctxspace knowledge add -t gotcha',
      'ctxspace plan 2>&1 | sh',
      'ctxspace plan 2>&1>AGENTS.md',
      'ctxspace plan 2>/tmp/x',
      'ctxspace plan&&rm x',
      'ctxspace plan &&',
      '&& ctxspace plan',
      '',
    ]) expect(isPlainAiCommand(command), command).toBe(false);
  });
});
