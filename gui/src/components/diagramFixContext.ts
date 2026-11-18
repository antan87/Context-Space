import { createContext } from 'react';
import type { DiagramFullScreenState } from '../lib/diagram.js';

/** Only an editable answer reader provides this action, scoped to its document body. */
export const DiagramFixContext = createContext<((error: string) => void | Promise<unknown>) | undefined>(undefined);

/** Host full-screen capability: only hosts with an explicit Full screen or Expand control provide this. */
export const DiagramFullScreenContext = createContext<DiagramFullScreenState>('none');
