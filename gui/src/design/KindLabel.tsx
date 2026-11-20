import { cn } from '../lib/utils.js';
import { KIND_ICON, type KindLabelKind } from './kindIcons.js';

/** An icon and the word, in the muted colour at the Board's meta size (12 px on screen at the Area's 0.9 zoom), weight 400: no box, no fill, no border. */
export const KIND_LABEL = 'inline-flex shrink-0 items-center gap-1 text-[length:var(--type-board-meta-size)] font-normal leading-[var(--type-board-meta-leading)] text-muted-foreground';

export interface KindLabelProps {
  kind: KindLabelKind;
  className?: string;
}

/** The kind of a card, in its title row ("note", "commit", "picture", a file type). The icon is decoration; the word is the text. It is not pressable. */
export function KindLabel({ kind, className }: KindLabelProps) {
  const Icon = KIND_ICON[kind];
  return <span className={cn(KIND_LABEL, className)}><Icon aria-hidden="true" className="size-3.5 shrink-0" />{kind}</span>;
}
