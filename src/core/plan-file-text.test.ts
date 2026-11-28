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
