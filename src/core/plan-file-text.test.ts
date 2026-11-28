import { describe, expect, it } from 'vitest';
import { renderPlanFileInstructions } from './plan-file-text.js';

describe('renderPlanFileInstructions Plan-Step line', () => {
  it('tells AIs on the database to add the trailer', () => {
    const text = renderPlanFileInstructions(true);
    expect(text).toContain('add `Plan-Step: <id>` with that item’s id (`ctxspace plan` marks Now) as a trailer line next to the others at the end of the message, such as `Co-Authored-By`.');
    expect(text).not.toContain('`ctxspace plan now` shows');
  });

  it('leaves the text for workspaces still on files alone', () => {
    expect(renderPlanFileInstructions()).not.toContain('Plan-Step');
  });
});

describe('renderPlanFileInstructions file link line', () => {
  it('tells AIs on the database to link a picture or document to its item with card.add', () => {
    expect(renderPlanFileInstructions(true)).toContain('link it to that item with the op `{"op":"card.add","path":"<path>","step":"<id>"}` in a `ctxspace plan apply` batch instead of writing its path into the item’s text.');
  });

  it('leaves the text for workspaces still on files alone', () => {
    expect(renderPlanFileInstructions()).not.toContain('card.add');
  });
});

describe('renderPlanFileInstructions op shapes (DB4c)', () => {
  it('lists the common ops with their fields on the database, in at most 9 lines', () => {
    const text = renderPlanFileInstructions(true);
    for (const shape of [
      '{"op":"tick","id":"<id>"}',
      '{"op":"detail","id":"<id>","rev":<rev>,"text":"<ALL the detail lines under the item: it replaces them, so start with the old lines you read>"}',
      '{"op":"edit","id":"<id>","find":"<old words>","replace":"<new words>"}',
      '{"op":"add","kind":"step","text":"<words>","under":"<id>"}',
      '{"op":"add","kind":"decision","text":"<question>","under":"<id>","suggested":["<a>","<b>"],"ifNoAnswer":"<a>"}',
      '{"op":"answer","id":"<decision id>","answer":"<their words>","rev":<rev>}',
      '{"op":"now","id":"<step id>"}',
    ]) expect(text).toContain(shape);
    // card.add is shown once, in the bullet that says when to use it
    expect(text.split('{"op":"card.add","path":"<path>","step":"<id>"}')).toHaveLength(2);
    expect(text).toContain('`ctxspace plan apply --help` lists every op and field');
    // Every added line counts, the blank one too: from the intro to the line before the next bullet.
    const lines = text.split('\n');
    const start = lines.findIndex((line) => line.startsWith('Common ops'));
    const next = lines.findIndex((line, i) => i > start && line.startsWith('- ') && !line.startsWith('- `{'));
    expect(next, 'a bullet must follow the block, or the count measures nothing').toBeGreaterThan(start);
    expect(next - start).toBeLessThanOrEqual(9);
  });

  it('leaves the text for workspaces still on files alone', () => {
    expect(renderPlanFileInstructions()).not.toContain('apply --help');
  });
});
