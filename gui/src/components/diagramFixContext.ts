import { createContext } from 'react';

/** Only an editable answer reader provides this action, scoped to its document body. */
export const DiagramFixContext = createContext<((error: string) => void | Promise<unknown>) | undefined>(undefined);
