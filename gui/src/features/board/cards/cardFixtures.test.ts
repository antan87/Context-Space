import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { documentFileUrl, pictureSrc } from '../boardActions.js';
import { BASE_KEYS, baseFixtures, cardFixtures, FIXED_NOW, FIXTURE_ACTIONS, FIXTURE_PICTURE, fixtureTimes, PAGE_ACTIONS } from './cardFixtures.js';

/**
 * The shared card fixtures (DS7): the golden markup test and the design page draw the same ones. The golden snapshots pin
 * what they render; these pin the fixtures themselves, so a change to one is a change in the open.
 */
describe('card fixtures', () => {
  it('has the golden test\'s 44 cards, in its order', () => {
    expect(BASE_KEYS).toEqual([
      'area.default', 'areaRow.default', 'areaMini.checkpointMini', 'areaMini.questionsMini', 'areaMini.newsMini', 'areaMini.filesMini',
      'area.doneArea', 'area.planArea', 'areaFold.collapsed', 'areaFold.expanded',
      'checkpoint.open', 'checkpoint.folded', 'checkpoint.waitingFrame', 'checkpoint.planFrame',
      'lane.open', 'lane.folded', 'document.full', 'document.compact', 'commit.full', 'commit.compact',
      'placeholder.full', 'placeholder.compact', 'uncommitted.default',
      'note.full', 'note.compact', 'note.archived',
      'file.fullImage', 'file.fullDoc', 'file.compactPicture', 'file.compactDocumentRow', 'file.compactGeneric',
      'answer.text', 'answer.codeMatches', 'answer.codeChanged', 'answer.picture', 'answer.pictureMissing', 'answer.diagram',
      'step.prominent', 'step.regular', 'step.staticDone', 'step.tabbed', 'fold.default', 'more.default', 'pager.default',
    ]);
  });

  it('still makes the same nodes: the data, the sizes and the reading id of every golden card', () => {
    const nodes = baseFixtures(FIXED_NOW).map((fixture) => [fixture.key, fixture.kind, fixture.props.id, fixture.props.type, fixture.props.data, fixture.props.width, fixture.props.height, fixture.reading]);
    // The hash of the nodes as the golden test wrote them inline before they moved here. Change it only with the snapshots.
    expect(createHash('sha256').update(JSON.stringify(nodes)).digest('hex')).toBe('23b7053fff6b56e7d1b986f5e319c9cf1131d70036d941c195a5800de7a9d2a6');
  });

  it('dates every fixture from the clock it is given: the golden test\'s fixed one gives its old times', () => {
    expect(fixtureTimes(FIXED_NOW)).toEqual({
      created: '2026-11-17T11:50:00.000Z',
      updated: '2026-11-17T11:55:00.000Z',
      commit: '2026-11-17T11:58:00.000Z',
    });
    expect(fixtureTimes(new Date('2030-01-01T00:10:00.000Z')).created).toBe('2030-01-01T00:00:00.000Z');
  });

  it('adds only variants, each under a key and an id of its own (every card is a node of its own canvas, so the golden ones may share ids)', () => {
    const all = cardFixtures(FIXED_NOW);
    expect(all.slice(0, BASE_KEYS.length).map((fixture) => fixture.key)).toEqual(BASE_KEYS);
    expect(new Set(all.map((fixture) => fixture.key)).size).toBe(all.length);
    const extras = all.slice(BASE_KEYS.length);
    expect(new Set(extras.map((fixture) => fixture.props.id)).size).toBe(extras.length);
    expect(extras.every((fixture) => fixture.props.id.includes('~'))).toBe(true);
    expect(all.length).toBeGreaterThan(BASE_KEYS.length);
    // A reading card reads itself, and only the cards made to.
    for (const fixture of all) expect(fixture.reading === null || fixture.reading === fixture.props.id).toBe(true);
    expect(all.filter((fixture) => fixture.reading).map((fixture) => fixture.key).sort()).toEqual([
      'answer.textReading', 'commit.compactReading', 'commit.fullReading', 'document.compactReading', 'document.full', 'file.compactReading', 'file.fullReading',
    ].sort());
  });

  it('has a card of every one of the 17 kinds the Board registers', () => {
    const kinds = new Set(cardFixtures(FIXED_NOW).map((fixture) => fixture.kind));
    expect([...kinds].sort()).toEqual([
      'area', 'areaFold', 'areaMini', 'areaRow', 'answer', 'checkpoint', 'commit', 'document', 'file', 'fold', 'lane', 'more', 'note', 'pager', 'placeholder', 'step', 'uncommitted',
    ].sort());
  });

  it('draws a picture from the server\'s file route, except for the design page, whose resolver is its own image', () => {
    expect(pictureSrc(FIXTURE_ACTIONS, 'board-pictures/a.png')).toBe(documentFileUrl('ws-snap', 'board-pictures/a.png'));
    expect(pictureSrc(PAGE_ACTIONS, 'board-pictures/a.png')).toBe(FIXTURE_PICTURE);
    expect(FIXTURE_PICTURE.startsWith('data:image/svg+xml')).toBe(true);
    expect(FIXTURE_PICTURE).not.toContain('/api/');
    expect(FIXTURE_ACTIONS.pictureUrl).toBeUndefined();
  });
});
