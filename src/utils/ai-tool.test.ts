import { describe, expect, it } from 'vitest';
import { asPersonEnv, isPlainPlanCommand, runsInsideAiTool } from './ai-tool.js';

describe('runsInsideAiTool', () => {
  it('knows the variables AI tools set, and ignores empty ones', () => {
    expect(runsInsideAiTool({ CTXSPACE_HARNESS: 'claude' })).toBe(true);
    expect(runsInsideAiTool({ ANTIGRAVITY_SESSION: '1' })).toBe(true);
    expect(runsInsideAiTool({ PATH: '/bin' })).toBe(false);
    expect(runsInsideAiTool({ ...asPersonEnv({ CLAUDECODE: '1', AGY_X: '1' }) })).toBe(false);
  });
});

describe('isPlainPlanCommand', () => {
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
    ]) expect(isPlainPlanCommand(command), command).toBe(true);
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
    ]) expect(isPlainPlanCommand(command), command).toBe(false);
  });
});
