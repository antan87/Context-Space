import { useState, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardFrame,
  CardHeader,
  CardPanel,
  CardTitle,
  Checkbox,
  Composer,
  ContextRing,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Field,
  FieldDescription,
  FieldLabel,
  foldSurface,
  FreshDot,
  IconButton,
  Input,
  Kbd,
  KbdGroup,
  KindLabel,
  Label,
  Mark,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  Pill,
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
  Radio,
  RadioGroup,
  rowSurface,
  ScrollArea,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  Separator,
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
  Skeleton,
  Spinner,
  StatusBadge,
  StepCheck,
  Switch,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  Textarea,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  type KindLabelKind,
  type PillTone,
} from '../design/index.js';

/** One piece on the page: its name as a heading (the spec finds it there), and its states under it. */
function Piece({ id, name, note, children }: { id: string; name: string; note?: string; children: ReactNode }) {
  return (
    <section data-testid={`design-piece-${id}`} aria-labelledby={`design-piece-${id}-title`} className="space-y-2 rounded-lg border border-border bg-card p-4">
      <h3 id={`design-piece-${id}-title`} className="text-sm font-semibold text-foreground">{name}</h3>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">{children}</div>
    </section>
  );
}

/** One state of a piece, with its name under it. */
function State({ name, children }: { name: string; children: ReactNode }) {
  return (
    <figure className="m-0 flex flex-col items-start gap-1.5">
      <div className="flex min-h-8 items-center gap-2">{children}</div>
      <figcaption className="text-xs text-muted-foreground">{name}</figcaption>
    </figure>
  );
}

const KINDS: KindLabelKind[] = ['note', 'commit', 'picture', 'html', 'pdf', 'markdown', 'other'];
const PILL_TONES: PillTone[] = ['neutral', 'accent', 'ai', 'needs', 'done', 'reopened', 'warning'];
const MILESTONES = [{ state: 'done' as const }, { state: 'done' as const }, { state: 'in_progress' as const }, { state: 'upcoming' as const }];

const noop = () => {};

/** The design module's pieces, one by one, in the states they have. Local state only: nothing here reads or writes the server. */
export function DesignPieces() {
  const [typed, setTyped] = useState('A **note** with `code`, a list and a link.\n\n- first\n- second');
  const [mono, setMono] = useState('const answer = 42;');
  const [empty, setEmpty] = useState('');
  const [checked, setChecked] = useState(true);
  return (
    <div className="space-y-4">
      <Piece id="button" name="Button" note="One filled button per screen: the others are outline, ghost or secondary.">
        <State name="default"><Button>Save</Button></State>
        <State name="secondary"><Button variant="secondary">Secondary</Button></State>
        <State name="outline"><Button variant="outline">Outline</Button></State>
        <State name="ghost"><Button variant="ghost">Ghost</Button></State>
        <State name="link"><Button variant="link">Link</Button></State>
        <State name="destructive"><Button variant="destructive">Delete</Button></State>
        <State name="destructive outline"><Button variant="destructive-outline">Remove</Button></State>
        <State name="with an icon"><Button variant="outline"><Plus aria-hidden="true" />Add</Button></State>
        <State name="small"><Button size="sm" variant="outline">Small</Button></State>
        <State name="large"><Button size="lg" variant="outline">Large</Button></State>
        <State name="disabled"><Button disabled>Disabled</Button></State>
      </Piece>
      <Piece id="icon-button" name="IconButton">
        <State name="ghost"><IconButton label="Add" icon={<Plus aria-hidden="true" />} /></State>
        <State name="outline"><IconButton label="Delete" variant="outline" icon={<Trash2 aria-hidden="true" />} /></State>
        <State name="small"><IconButton label="Add one" size="sm" icon={<Plus aria-hidden="true" />} /></State>
        <State name="disabled"><IconButton label="Add none" disabled icon={<Plus aria-hidden="true" />} /></State>
      </Piece>
      <Piece id="badge" name="Badge and StatusBadge">
        <State name="default"><Badge>3</Badge></State>
        <State name="secondary"><Badge variant="secondary">New</Badge></State>
        <State name="outline"><Badge variant="outline">Draft</Badge></State>
        <State name="success"><Badge variant="success">Passed</Badge></State>
        <State name="warning"><Badge variant="warning">Waits</Badge></State>
        <State name="error"><Badge variant="error">Failed</Badge></State>
        <State name="info"><Badge variant="info">Info</Badge></State>
        <State name="status: success"><StatusBadge tone="success" dot>Running</StatusBadge></State>
        <State name="status: warning"><StatusBadge tone="warning" dot>Behind</StatusBadge></State>
        <State name="status: danger"><StatusBadge tone="danger" dot>Stopped</StatusBadge></State>
        <State name="status: accent"><StatusBadge tone="accent">Now</StatusBadge></State>
        <State name="status: neutral"><StatusBadge>Idle</StatusBadge></State>
      </Piece>
      <Piece id="card-frame" name="CardFrame" note="The Board card's article. Its states, with a line of content each.">
        {([
          ['normal', {}],
          ['fresh', { fresh: true }],
          ['pinned', { pinned: true }],
          ['archived', { archived: true }],
          ['reading', { reading: true }],
          ['compact', { compact: true }],
          ['pressable', { onPress: noop }],
        ] as const).map(([name, props]) => (
          <State key={name} name={name}>
            <div className="h-16 w-44">
              <CardFrame labelledBy={`design-frame-${name}`} {...props}>
                <p id={`design-frame-${name}`} className="text-[13px] font-semibold leading-5">A card, {name}</p>
              </CardFrame>
            </div>
          </State>
        ))}
      </Piece>
      <Piece id="pill" name="Pill" note="A state in a word, in each of its tones.">
        {PILL_TONES.map((tone) => <State key={tone} name={tone}><Pill tone={tone}>{tone}</Pill></State>)}
      </Piece>
      <Piece id="kind-label" name="KindLabel" note="The kind of a card: an icon and the word, muted, at the Board's meta size, no box.">
        {KINDS.map((kind) => <State key={kind} name={kind}><KindLabel kind={kind} /></State>)}
      </Piece>
      <Piece id="mark" name="Mark">
        <State name="AI"><Mark ai label="Claude, 5 min ago" /></State>
        <State name="you"><Mark ai={false} label="You, 5 min ago" /></State>
      </Piece>
      <Piece id="fresh-dot" name="FreshDot">
        <State name="block"><FreshDot /></State>
        <State name="inline"><span className="text-[13px]"><FreshDot inline />New since you looked</span></State>
      </Piece>
      <Piece id="step-check" name="StepCheck">
        <State name="unchecked"><StepCheck checked={false} label="Mark a step done" title="Mark done" disabled={false} busy={false} pressable testId="design-step-unchecked" onToggle={noop} /></State>
        <State name="checked"><StepCheck checked label="Mark a step not done" title="Mark not done" disabled={false} busy={false} pressable testId="design-step-checked" onToggle={noop} /></State>
        <State name="busy"><StepCheck checked={false} label="Mark a busy step done" title="Saving" disabled={false} busy pressable={false} testId="design-step-busy" onToggle={noop} /></State>
        <State name="disabled"><StepCheck checked={false} label="Mark a locked step done" title="Read only" disabled busy={false} pressable={false} testId="design-step-disabled" onToggle={noop} /></State>
      </Piece>
      <Piece id="row-surface" name="rowSurface and foldSurface" note="The surfaces of an Area's rows.">
        <State name="Now"><div className={`${rowSurface({ now: true })} w-56 py-2 text-[13px]`}>Now: write the page</div></State>
        <State name="Next up"><div className={`${rowSurface({ now: true })} w-56 py-2 text-[13px]`}>Next up: look at it</div></State>
        <State name="quiet"><div className={`${rowSurface({ now: false })} w-56 py-2 text-[13px]`}>A step, quiet</div></State>
        <State name="folded"><div className={`${foldSurface(false)} w-56 py-2 text-[13px]`}>A folded row</div></State>
        <State name="current fold"><div className={`${foldSurface(true)} w-56 py-2 text-[13px]`}>The current folded row</div></State>
      </Piece>
      <Piece id="composer" name="Composer" note="The multi-line field of the Board's writing surfaces.">
        <State name="empty"><Composer aria-label="Empty composer" value={empty} onChange={setEmpty} placeholder="Write Markdown, lists, notes, or links..." rows={3} className="w-72" /></State>
        <State name="typed"><Composer aria-label="Typed composer" value={typed} onChange={setTyped} rows={3} className="w-72" /></State>
        <State name="mono"><Composer aria-label="Mono composer" value={mono} onChange={setMono} mono rows={3} className="w-72" /></State>
        <State name="disabled"><Composer aria-label="Disabled composer" value="Cannot be changed" onChange={noop} disabled rows={3} className="w-72" /></State>
      </Piece>
      <Piece id="input" name="Input, Textarea and Field">
        <State name="input"><Input aria-label="Sample input" placeholder="A title" className="w-56" /></State>
        <State name="input, disabled"><Input aria-label="Disabled input" disabled value="Disabled" readOnly className="w-56" /></State>
        <State name="textarea"><Textarea aria-label="Sample textarea" placeholder="A few lines" className="w-56" /></State>
        <State name="field">
          <Field className="w-56"><FieldLabel>Name</FieldLabel><Input placeholder="A name" /><FieldDescription>Shown on the card.</FieldDescription></Field>
        </State>
        <State name="label"><Label>A label</Label></State>
      </Piece>
      <Piece id="choices" name="Checkbox, Switch, Radio and Select">
        <State name="checkbox"><Checkbox aria-label="Sample checkbox" checked={checked} onCheckedChange={(value) => setChecked(Boolean(value))} /></State>
        <State name="checkbox, disabled"><Checkbox aria-label="Disabled checkbox" disabled /></State>
        <State name="switch"><Switch aria-label="Sample switch" defaultChecked /></State>
        <State name="switch, off"><Switch aria-label="Switch off" /></State>
        <State name="radio group">
          <RadioGroup defaultValue="a" aria-label="Sample radio group">
            <Label className="flex items-center gap-2"><Radio value="a" />First</Label>
            <Label className="flex items-center gap-2"><Radio value="b" />Second</Label>
          </RadioGroup>
        </State>
        <State name="select">
          <Select defaultValue="one">
            <SelectTrigger aria-label="Sample select" className="w-40"><SelectValue /></SelectTrigger>
            <SelectPopup><SelectItem value="one">One</SelectItem><SelectItem value="two">Two</SelectItem></SelectPopup>
          </Select>
        </State>
      </Piece>
      <Piece id="tabs" name="Tabs">
        <Tabs defaultValue="media" className="w-72">
          <TabsList><TabsTab value="media">Media</TabsTab><TabsTab value="notes">Notes</TabsTab></TabsList>
          <TabsPanel value="media" className="text-[13px]">Two pictures.</TabsPanel>
          <TabsPanel value="notes" className="text-[13px]">Three notes.</TabsPanel>
        </Tabs>
      </Piece>
      <Piece id="alert" name="Alert, Empty and Card">
        <div className="w-72 space-y-2">
          <Alert><AlertTitle>Heads up</AlertTitle><AlertDescription>The default alert.</AlertDescription></Alert>
          <Alert variant="warning"><AlertTitle>Warning</AlertTitle><AlertDescription>Work is blocked.</AlertDescription></Alert>
          <Alert variant="error"><AlertTitle>Error</AlertTitle><AlertDescription>Something failed.</AlertDescription></Alert>
        </div>
        <Empty className="w-72 rounded-lg border border-dashed border-border p-6 md:p-6">
          <EmptyHeader><EmptyTitle>Nothing yet</EmptyTitle><EmptyDescription>Cards you add show up here.</EmptyDescription></EmptyHeader>
        </Empty>
        <Card className="w-72"><CardHeader><CardTitle>A card</CardTitle></CardHeader><CardPanel className="text-[13px]">The generic card of the controls.</CardPanel></Card>
      </Piece>
      <Piece id="small-things" name="Kbd, Separator, Skeleton, Spinner, ScrollArea and ContextRing">
        <State name="kbd"><KbdGroup><Kbd>Ctrl</Kbd><Kbd>Enter</Kbd></KbdGroup></State>
        <State name="separator"><Separator className="w-24" /></State>
        <State name="skeleton"><Skeleton className="h-4 w-32" /></State>
        <State name="spinner"><Spinner className="size-5" /></State>
        <State name="context ring"><ContextRing milestones={MILESTONES} size={32} currentIndex={2} /></State>
        <State name="scroll area">
          <ScrollArea className="h-16 w-40 rounded-md border border-border"><div className="p-2 text-[13px]">{Array.from({ length: 8 }, (_, i) => <p key={i}>Line {i + 1}</p>)}</div></ScrollArea>
        </State>
      </Piece>
      <Piece id="overlays" name="Dialog, AlertDialog, Sheet, Menu, Popover and Tooltip" note="Each one opens here and changes nothing.">
        <State name="dialog">
          <Dialog>
            <DialogTrigger render={<Button variant="outline" />}>Open dialog</DialogTrigger>
            <DialogPopup>
              <DialogHeader><DialogTitle>A dialog</DialogTitle><DialogDescription>It opens on this page and saves nothing.</DialogDescription></DialogHeader>
              <DialogFooter><DialogClose render={<Button variant="outline" />}>Close</DialogClose></DialogFooter>
            </DialogPopup>
          </Dialog>
        </State>
        <State name="alert dialog">
          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="destructive-outline" />}>Open alert dialog</AlertDialogTrigger>
            <AlertDialogPopup>
              <AlertDialogHeader><AlertDialogTitle>Sure?</AlertDialogTitle><AlertDialogDescription>Nothing is deleted here.</AlertDialogDescription></AlertDialogHeader>
              <AlertDialogFooter><AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose></AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </State>
        <State name="sheet">
          <Sheet>
            <SheetTrigger render={<Button variant="outline" />}>Open sheet</SheetTrigger>
            <SheetPopup><SheetHeader><SheetTitle>A sheet</SheetTitle><SheetDescription>A panel from the side.</SheetDescription></SheetHeader></SheetPopup>
          </Sheet>
        </State>
        <State name="menu">
          <Menu>
            <MenuTrigger render={<Button variant="outline" />}>Open menu</MenuTrigger>
            <MenuPopup><MenuItem>First</MenuItem><MenuItem>Second</MenuItem></MenuPopup>
          </Menu>
        </State>
        <State name="popover">
          <Popover>
            <PopoverTrigger render={<Button variant="outline" />}>Open popover</PopoverTrigger>
            <PopoverPopup><PopoverTitle>A popover</PopoverTitle><PopoverDescription>A small panel by its button.</PopoverDescription></PopoverPopup>
          </Popover>
        </State>
        <State name="tooltip">
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" />}>Hover me</TooltipTrigger>
            <TooltipPopup>A tooltip</TooltipPopup>
          </Tooltip>
        </State>
      </Piece>
    </div>
  );
}
