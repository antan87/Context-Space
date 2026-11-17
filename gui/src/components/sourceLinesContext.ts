import { createContext, type ReactNode } from 'react';
import type { LineRange } from '../features/board/lineNotes.js';
export const SourceLinesContext = createContext<((range: LineRange, children: ReactNode) => ReactNode) | null>(null);
