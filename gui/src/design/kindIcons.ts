import { File, FileCode, FileImage, FileText, Globe, GitCommitHorizontal, StickyNote, type LucideIcon } from 'lucide-react';

/** What a card is: a note, a commit, a picture, or the type of a file (the words the cards have always shown). */
export type KindLabelKind = 'note' | 'commit' | 'picture' | 'html' | 'pdf' | 'markdown' | 'other';

/** The icon of each kind (the file cards draw the same ones where a picture would be). */
export const KIND_ICON: Record<KindLabelKind, LucideIcon> = {
  note: StickyNote, commit: GitCommitHorizontal, picture: FileImage, html: Globe, pdf: FileText, markdown: FileCode, other: File,
};
