# Sample plan

Why we do this, in a paragraph.

```bash
- [ ] not a step, it is inside a fence
## not a heading either
```

## How we build

Some prose, then a loose item outside the Checkpoints list:

- [ ] Loose step outside the checkpoints
  A note under the loose step.

## Where we stopped

Ship the export first. Then the reader.

## Checkpoints

A paragraph between the heading and the first checkpoint.

- [x] **Reports export to CSV**
  Check: `npm test`
  Outcome: 12 tests pass.
  - [x] Query the report rows
  - [ ] Write the file
    A detail line under the step.
    ```text
    - [ ] a checkbox inside a fence in a detail
    ```
    - [ ] Nested step one
    - [x] Nested step two

A paragraph between two items.

  - [ ] Decide: Should archived reports be exported?
    Suggested: Yes, all of them · Only the last year
    If no answer: only the last year
- [ ] **Second checkpoint**
  Check: the workspace checks
  - [x] Decide: Which format first?
    Suggested: CSV · JSON
    Answer: CSV
  - [ ] Plain step with `code` and a <!-- comment -->
- [ ] **Third checkpoint**

## Fine tuning

- [ ] A step in a later section
- [ ] Another loose item