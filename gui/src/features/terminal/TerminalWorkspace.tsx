import { useRef, type ComponentProps } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { History, ListTree } from 'lucide-react';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { goToWorkspace, parseWorkspacePath } from '../chat/chatRoute.js';
import { useOpenFileReference } from '../workspace-shell/useOpenFileReference.js';
import { hasModifier, modifierLabel, usePaneHotkey } from './usePaneHotkey.js';
import { SessionDeck } from './SessionDeck.js';
import { WhereAreWeNotices, WhereAreWeSummary } from '../progress/WhereAreWeStrip.js';
import { useWhereAreWe } from '../progress/useWhereAreWe.js';

/**
 * A workspace's chat: where the work stands in the toolbar of its terminal sessions, and what waits for the
 * developer above it while something does. So the chat keeps two bars above its content.
 *
 * Code and documents open in the panel beside the chat, from the workspace rail, never in a second
 * panel inside the chat. Paths the CLI prints open there too. The toolbar's Code button and
 * Ctrl/Cmd+Shift+E open and close Code; Docs has its place on the rail, and Ctrl/Cmd+Shift+D toggles
 * it from the keyboard, so there is no second Docs button here. The session history is about these sessions, so
 * its way in is here, next to them, and not on the rail.
 */
export function TerminalWorkspace({ workspacePath, repoPaths, ...props }: Pick<ComponentProps<typeof SessionDeck>, 'workspace' | 'active' | 'launch' | 'consumeLaunch' | 'onStatusChange' | 'onBackgroundOutput'> & { workspacePath: string; repoPaths?: string[] }) {
  const navigate = useNavigate();
  const location = useLocation();
  const here = parseWorkspacePath(location.pathname);
  const section = here?.workspace === props.workspace ? here.section : null;
  const openFile = useOpenFileReference(props.workspace, workspacePath, repoPaths);
  // How the strip above the chat types a suggestion into the prompt. The pane fills it in once connected.
  const fillPromptRef = useRef<((text: string) => boolean) | null>(null);
  // How the strip hears that the developer replied in the chat, so it can close the question the AI asked.
  const replyRef = useRef<((target: string) => void) | null>(null);

  const toggleSection = (target: 'changes' | 'documents' | 'sessions') => {
    goToWorkspace(navigate, props.workspace, section === target ? 'chat' : target);
  };

  // Bound to modified keys so they still work while the PTY owns the keyboard. Gated on `active`:
  // the dock keeps every open tab mounted, and an ungated listener would act for all of them.
  //
  // Code answers to Ctrl/Cmd+Shift+E. Shift+C is accepted as an alias, but the terminal claims that
  // combination for copy-selection, so the alias only resolves when focus is outside the PTY.
  usePaneHotkey((event) => {
    if (!hasModifier(event, { shift: true })) return;
    const key = event.key.toLowerCase();
    if (key === 'e' || key === 'c') {
      event.preventDefault();
      toggleSection('changes');
    } else if (key === 'd') {
      event.preventDefault();
      toggleSection('documents');
    }
  }, { enabled: props.active });

  const mod = modifierLabel();
  const inspectorControls = [
    <Button key="code" size="xs" variant={section === 'changes' ? 'secondary' : 'ghost'} aria-pressed={section === 'changes'}
      aria-keyshortcuts="Control+Shift+E Meta+Shift+E" title={`Show the code beside the chat (${mod}+Shift+E)`} onClick={() => toggleSection('changes')}>
      <ListTree className="size-3" />Code
    </Button>,
    <IconButton key="history" label="Session history" aria-pressed={section === 'sessions'} onClick={() => toggleSection('sessions')}
      icon={<History />} className={section === 'sessions' ? 'bg-secondary text-foreground' : 'text-muted-foreground'} />,
  ];

  const strip = useWhereAreWe({ workspace: props.workspace, active: props.active, fillPrompt: text => fillPromptRef.current?.(text) ?? false, replyRef, openFile: reference => { void openFile(reference); } });

  return <div className="flex h-full min-h-0 flex-col">
    <WhereAreWeNotices strip={strip} />
    <div className="min-h-0 min-w-0 flex-1">
      <SessionDeck {...props} fillPromptRef={fillPromptRef} onReply={target => replyRef.current?.(target)} inspectorControls={inspectorControls}
        summary={<WhereAreWeSummary strip={strip} />} onOpenFileReference={reference => { void openFile(reference); }} />
    </div>
  </div>;
}
