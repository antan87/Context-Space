/**
 * Follow the thread: resolving the chain of connected cards (links, steps, commits)
 * so selecting a card lights up its entire thread and dims unrelated cards.
 */

import type { BoardCard, BoardLink } from './boardData.js';
import type { BoardNode } from './boardLayout.js';
import { parseCommitNodeId } from './boardActions.js';

export interface ThreadInput {
  selectedId: string;
  nodes?: BoardNode[];
  links?: BoardLink[];
  cards?: BoardCard[];
}

/**
 * Computes the set of node IDs belonging to the connected thread of `selectedId`.
 * Follows:
 * 1. Direct and transitive connections in `links`
 * 2. Cards sharing the same plan `step`
 * 3. Commits associated with the same step or linked cards
 */
export function findThreadChain(input: ThreadInput): Set<string> {
  const { selectedId, nodes = [], links = [], cards = [] } = input;
  const chain = new Set<string>();
  if (!selectedId) return chain;

  chain.add(selectedId);

  const cardsById = new Map<string, BoardCard>();
  for (const c of cards) {
    cardsById.set(c.id, c);
  }

  // 1. Match card's step
  const selectedCard = cardsById.get(selectedId);
  const activeStep = selectedCard?.step;
  if (activeStep) {
    for (const c of cards) {
      if (c.step === activeStep) {
        chain.add(c.id);
      }
    }
  }

  // 2. Transitive link traversal (up to 5 hops to prevent runaway loops)
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 5) {
    changed = false;
    iterations++;
    for (const link of links) {
      const fromMatch = chain.has(link.from);
      const toMatch = chain.has(link.to);
      if (fromMatch && !chain.has(link.to)) {
        chain.add(link.to);
        changed = true;
      }
      if (toMatch && !chain.has(link.from)) {
        chain.add(link.from);
        changed = true;
      }
    }
  }

  // 3. Connect commits linked to cards or steps in the chain
  for (const node of nodes) {
    if (node.type === 'commit') {
      const parsed = parseCommitNodeId(node.id);
      if (parsed) {
        for (const id of Array.from(chain)) {
          if (id.includes(parsed.sha) || parsed.sha.includes(id)) {
            chain.add(node.id);
          }
        }
      }
    }
  }

  return chain;
}
