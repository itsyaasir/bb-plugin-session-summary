// Session Summary — frontend entry.
//
// A button in the thread header opens a popover with four sections:
// Environment, Context, Connectors, and Changes (the thread's pull requests
// and issues in one list). Sections fold and can be dragged into a new order;
// each row with more to say expands. The header button is a toggle: the
// popover stays open until it is pressed again. The reads run only while it
// is open.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  definePluginApp,
  experimental_copyToClipboard as copyToClipboard,
  experimental_Icon as Icon,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  useBbNavigate,
  useSdk,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import {
  formatTokens,
  rpcContract,
  workItemKey,
  type IssueStatus,
  type ItemStatuses,
  type PullRequestStatus,
  type SessionSummary,
} from "./contract.ts";

type Environment = NonNullable<SessionSummary["environment"]>;
type Context = NonNullable<SessionSummary["context"]>;
type Category = Context["categories"][number];
type Connector = SessionSummary["connectors"][number];
type WorkItem = SessionSummary["changes"]["workItems"][number];

declare const __BB_PLUGIN_ID__: string | undefined;

const PLUGIN_ID = typeof __BB_PLUGIN_ID__ === "string" ? __BB_PLUGIN_ID__ : undefined;

/**
 * A portalled popover leaves the plugin's root element, so it carries the
 * attributes that scope the plugin's styles and mark it as a host overlay.
 */
function portalScopeProps() {
  return {
    "data-bb-portaled-overlay": "",
    "data-bb-plugin-root": "",
    ...(PLUGIN_ID === undefined ? {} : { "data-bb-plugin": PLUGIN_ID }),
  };
}

// ── Layout: section order, folded sections, open ─────────────────────────
//
// A per-viewer preference, so it lives in localStorage keyed by plugin id.
// One store serves every header (split panes) so they stay in step.

const SECTION_IDS = ["environment", "context", "connectors", "changes"] as const;
type SectionId = (typeof SECTION_IDS)[number];
/** Pull requests and Issues were sections, then groups inside Changes. */
const OLD_CHANGES_IDS: readonly unknown[] = ["pullRequests", "issues"];

interface Layout {
  order: SectionId[];
  collapsed: SectionId[];
  /** Whether the popover was left open, so it comes back open. */
  pinned: boolean;
}

const LAYOUT_KEY = `${PLUGIN_ID ?? "session-summary"}:layout`;
const DEFAULT_LAYOUT: Layout = { order: [...SECTION_IDS], collapsed: [], pinned: false };
let cachedLayout: Layout | undefined;
const layoutListeners = new Set<() => void>();

function isSectionId(value: unknown): value is SectionId {
  return typeof value === "string" && (SECTION_IDS as readonly string[]).includes(value);
}

function readLayout(): Layout {
  if (cachedLayout !== undefined) return cachedLayout;
  let layout = DEFAULT_LAYOUT;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
    if (typeof raw === "object" && raw !== null) {
      const value = raw as Partial<Record<keyof Layout, unknown>>;
      // Changes takes the place of the first old Pull requests or Issues.
      const stored: unknown[] = Array.isArray(value.order) ? value.order : [];
      const order = [...new Set(stored.map((id) => (OLD_CHANGES_IDS.includes(id) ? "changes" : id)).filter(isSectionId))];
      layout = {
        // Sections added in a later version join at the end.
        order: [...order, ...SECTION_IDS.filter((id) => !order.includes(id))],
        collapsed: Array.isArray(value.collapsed) ? value.collapsed.filter(isSectionId) : [],
        pinned: value.pinned === true,
      };
    }
  } catch {
    // Storage blocked or corrupt: fall back to the defaults.
  }
  cachedLayout = layout;
  return layout;
}

function updateLayout(change: (layout: Layout) => Layout): void {
  cachedLayout = change(readLayout());
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(cachedLayout));
  } catch {
    // Keep the in-memory layout for this session.
  }
  for (const listener of layoutListeners) listener();
}

function subscribeLayout(listener: () => void): () => void {
  layoutListeners.add(listener);
  return () => layoutListeners.delete(listener);
}

const useLayout = () => useSyncExternalStore(subscribeLayout, readLayout);

/** Move `id` to just before or after `target`. */
function moveSection(order: SectionId[], id: SectionId, target: SectionId, after: boolean): SectionId[] {
  if (id === target) return order;
  const rest = order.filter((item) => item !== id);
  const index = rest.indexOf(target) + (after ? 1 : 0);
  return [...rest.slice(0, index), id, ...rest.slice(index)];
}

// ── Header button and popover ────────────────────────────────────────────

/** Gap between the popover and the right end of the header bar. */
const BAR_END_GAP = 8;

/**
 * The header bar the button sits in: the widest ancestor that is still about
 * as tall as one header row. Its right edge is where the right panel starts.
 */
function headerBar(trigger: HTMLElement): HTMLElement | null {
  const rowHeight = trigger.getBoundingClientRect().height * 2.5;
  let bar: HTMLElement | null = null;
  for (let node = trigger.parentElement; node !== null && node !== document.body; node = node.parentElement) {
    if (node.getBoundingClientRect().height > rowHeight) break;
    bar = node;
  }
  return bar;
}

/**
 * How far to shift an end-aligned popover so its right edge lines up with
 * the header bar's, just before the right panel.
 */
// The theme's accent and muted look alike in dark mode; a primary tint reads.
const PRIMARY_TINT_HOVER = "hover:bg-[color-mix(in_oklab,var(--primary)_16%,transparent)] hover:text-[var(--primary)]";
const PRIMARY_TINT_OPEN =
  "data-[state=open]:bg-[color-mix(in_oklab,var(--primary)_16%,transparent)] data-[state=open]:text-[var(--primary)]";

function useBarEndOffset(trigger: HTMLElement | null, enabled: boolean): number {
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    // Keep the last offset while closed: the closing animation runs in place.
    if (!enabled || trigger === null) return;
    const bar = headerBar(trigger);
    if (bar === null) return setOffset(0);
    const measure = () => {
      const gap = bar.getBoundingClientRect().right - trigger.getBoundingClientRect().right - BAR_END_GAP;
      // Radix moves an end-aligned popover right for a negative offset.
      setOffset(gap > 0 ? -Math.round(gap) : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [trigger, enabled]);
  return offset;
}

/**
 * Keep the panel's reads in BB's query cache before it opens. The summary is
 * cheap and stays fresh once the button was pointed at; GitHub statuses can
 * run `gh`, so they load only while the pointer is on the button or it's open.
 */
function useWarmSummary(threadId: string, summary: boolean, statuses: boolean): void {
  useRpcQuery({ contract: rpcContract, method: "session_summary", input: { threadId }, enabled: summary });
  useRpcQuery({ contract: rpcContract, method: "work_item_statuses", input: { threadId }, enabled: statuses });
}

/** True once `ms` passed: a skeleton for a read that answers quickly only flickers. */
function useAfter(ms: number): boolean {
  const [passed, setPassed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setPassed(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return passed;
}

function SessionSummaryButton({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const layout = useLayout();
  // Left open, it comes back open when the header mounts again.
  const [open, setOpen] = useState(layout.pinned);
  const restoring = useRef(layout.pinned);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const barEndOffset = useBarEndOffset(trigger, open && !isCompactViewport);
  const alignOffset = isCompactViewport ? 0 : barEndOffset;
  // Pointing at the button starts the reads, so the panel opens on data.
  const [warm, setWarm] = useState(open);
  const [hovering, setHovering] = useState(false);
  useWarmSummary(threadId, warm || open, hovering || open);
  const startWarming = () => {
    setWarm(true);
    setHovering(true);
  };

  // Outside clicks and Escape are refused below, so only the header button
  // opens or closes it.
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    updateLayout((current) => ({ ...current, pinned: next }));
  };
  const stayOpen = (event: Event) => event.preventDefault();

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        ref={setTrigger}
        onPointerEnter={startWarming}
        onPointerLeave={() => setHovering(false)}
        onFocus={startWarming}
        onBlur={() => setHovering(false)}
        aria-label="Session summary"
        aria-pressed={open}
        title={open ? "Close session summary" : "Open session summary (stays open until you press this again)"}
        className={`relative inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-all duration-150 hover:bg-[color-mix(in_oklab,var(--foreground)_10%,transparent)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${PRIMARY_TINT_OPEN} data-[state=open]:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_35%,transparent)]`}
      >
        <Icon name="Layers" className="size-4" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...portalScopeProps()}
          align="end"
          alignOffset={alignOffset}
          sideOffset={14}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            // Restoring an open popover must not steal focus from the composer.
            if (restoring.current) event.preventDefault();
            restoring.current = false;
          }}
          onInteractOutside={stayOpen}
          onEscapeKeyDown={stayOpen}
          className="z-50 flex max-h-[var(--radix-popover-content-available-height)] flex-col text-popover-foreground outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          style={{ width: isCompactViewport ? "calc(100vw - 24px)" : 400 }}
        >
          {/* Reads the cache useWarmSummary filled, so it opens without a wait. */}
          <SummaryPanel threadId={threadId} layout={layout} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SummaryPanel({ threadId, layout }: { threadId: string; layout: Layout }) {
  const query = useRpcQuery({ contract: rpcContract, method: "session_summary", input: { threadId } });
  const statusQuery = useRpcQuery({ contract: rpcContract, method: "work_item_statuses", input: { threadId } });
  const summary = query.data;
  const statuses = statusQuery.data ?? {};
  const changes = summary === undefined ? null : groupChanges(summary, statuses);

  // Running checks change without any bb event; look again while they run.
  const checksRunning = changes?.pullRequests.some((pr) => pr.status?.checks.state === "pending") ?? false;
  const refetchStatuses = statusQuery.refetch;
  useEffect(() => {
    if (!checksRunning) return;
    const timer = setInterval(() => void refetchStatuses(), 30_000);
    return () => clearInterval(timer);
  }, [checksRunning, refetchStatuses]);

  const slow = useAfter(200);
  const [dragging, setDragging] = useState<SectionId | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: SectionId; after: boolean } | null>(null);

  if (summary === undefined || changes === null) {
    if (query.error === null) return slow ? <PanelSkeleton /> : null;
    return (
      <p className={`${CARD} px-4 py-6 text-center text-sm text-muted-foreground`}>
        Could not load the summary: {query.error.message}
      </p>
    );
  }

  const changeCount = changes.pullRequests.length + changes.issues.length;
  // A section with nothing to show is left out altogether.
  const sections: Record<SectionId, { title: string; empty: boolean; count?: number; trailing?: ReactNode; body: ReactNode }> = {
    environment: {
      title: "Environment",
      empty: summary.environment === null,
      body: summary.environment && <EnvironmentBody threadId={threadId} environment={summary.environment} />,
    },
    context: {
      title: "Context",
      empty: summary.context === null,
      trailing: contextTrailing(summary.context),
      body: summary.context && <ContextBody context={summary.context} />,
    },
    connectors: {
      title: "Connectors",
      empty: summary.connectors.length === 0,
      count: summary.connectors.length,
      body: <ConnectorsBody connectors={summary.connectors} />,
    },
    changes: {
      title: "Changes",
      empty: changeCount === 0,
      count: changeCount,
      trailing: statusQuery.isFetching ? "checking…" : undefined,
      body: <ChangesBody pullRequests={changes.pullRequests} issues={changes.issues} />,
    },
  };

  function toggle(id: SectionId) {
    updateLayout((current) => ({
      ...current,
      collapsed: current.collapsed.includes(id)
        ? current.collapsed.filter((item) => item !== id)
        : [...current.collapsed, id],
    }));
  }

  const visible = layout.order.filter((id) => !sections[id].empty);

  const move = (id: SectionId, target: SectionId, after: boolean) =>
    updateLayout((current) => ({ ...current, order: moveSection(current.order, id, target, after) }));
  const moveBy = (id: SectionId, step: -1 | 1) => {
    const index = visible.indexOf(id);
    const target = visible[index + step];
    if (target !== undefined) move(id, target, step === 1);
  };

  return (
    /* Padding keeps the cards' shadows inside the scroll area. It scrolls
          only past the window's height, and without a scrollbar. */
    <div className="-m-2 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {visible.length === 0 ? (
          <p className={`${CARD} px-4 py-6 text-center text-sm text-muted-foreground`}>Nothing to show yet.</p>
        ) : null}
        {visible.map((id, index) => {
          const section = sections[id];
          return (
            <Section
              key={id}
              id={id}
              title={section.title}
              count={section.count}
              trailing={section.trailing}
              collapsed={layout.collapsed.includes(id)}
              onToggle={() => toggle(id)}
              isFirst={index === 0}
              isLast={index === visible.length - 1}
              dragging={dragging === id}
              dropEdge={dropTarget?.id === id && dragging !== id ? (dropTarget.after ? "bottom" : "top") : null}
              onDragStart={() => setDragging(id)}
              onDragEnd={() => {
                setDragging(null);
                setDropTarget(null);
              }}
              onDragOverSection={(after) => {
                if (dragging !== null) setDropTarget({ id, after });
              }}
              onDropSection={(after) => {
                if (dragging !== null) move(dragging, id, after);
                setDragging(null);
                setDropTarget(null);
              }}
              onMoveBy={(step) => moveBy(id, step)}
            >
              {section.body}
            </Section>
          );
        })}
      </div>
  );
}

// ── Sections and rows ────────────────────────────────────────────────────

/** Placeholder cards for the first load, shaped like the real ones. */
function PanelSkeleton() {
  const bar = "animate-pulse rounded-md bg-muted";
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading session summary">
      {[3, 2, 2].map((rows, card) => (
        <div key={card} className={`${CARD} flex flex-col gap-2.5 px-3.5 py-3`}>
          <div className={`${bar} h-3.5 w-24`} />
          {Array.from({ length: rows }, (_, row) => (
            <div key={row} className="flex items-center gap-2.5">
              <div className={`${bar} size-[22px] shrink-0`} />
              <div className={`${bar} h-3`} style={{ width: `${[72, 55, 64][(card + row) % 3]}%` }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** A floating card: faint border, frosted fill, soft shadow. */
const CARD =
  "rounded-2xl border border-[color-mix(in_oklab,var(--border)_55%,transparent)] bg-[color-mix(in_oklab,var(--popover)_90%,transparent)] shadow-[0_1px_2px_rgba(0,0,0,0.04),0_10px_28px_-14px_rgba(0,0,0,0.3)] backdrop-blur-xl";

function Section({
  id,
  title,
  count,
  trailing,
  collapsed,
  onToggle,
  isFirst,
  isLast,
  dragging,
  dropEdge,
  onDragStart,
  onDragEnd,
  onDragOverSection,
  onDropSection,
  onMoveBy,
  children,
}: {
  id: SectionId;
  title: string;
  count?: number;
  trailing?: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  isFirst: boolean;
  isLast: boolean;
  dragging: boolean;
  dropEdge: "top" | "bottom" | null;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverSection: (after: boolean) => void;
  onDropSection: (after: boolean) => void;
  onMoveBy: (step: -1 | 1) => void;
  children: ReactNode;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const bodyId = `session-summary-${id}`;
  const isAfter = (event: DragEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2;
  };
  const onGripKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp" && !isFirst) {
      event.preventDefault();
      onMoveBy(-1);
    } else if (event.key === "ArrowDown" && !isLast) {
      event.preventDefault();
      onMoveBy(1);
    }
  };

  return (
    <section
      ref={sectionRef}
      aria-label={title}
      className={`group/section shrink-0 transition-opacity ${CARD} ${dragging ? "opacity-40" : ""}`}
      style={
        dropEdge === null
          ? undefined
          : // A line in the gap above or below the card shows where it lands.
            { boxShadow: `0 ${dropEdge === "top" ? "-6px" : "6px"} 0 -4px var(--primary)` }
      }
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDragOverSection(isAfter(event));
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDropSection(isAfter(event));
      }}
    >
      <div className={`flex items-center gap-2 px-3.5 pt-3 ${collapsed ? "pb-3" : "pb-1.5"}`}>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={onToggle}
          className="-ml-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-[13px] font-semibold tracking-tight text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span>{title}</span>
          <Icon
            name="ChevronDown"
            fallback="ArrowDown"
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${collapsed ? "-rotate-90" : ""}`}
          />
          {count === undefined || count === 0 ? null : (
            <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium leading-4 tabular-nums text-muted-foreground">
              {count}
            </span>
          )}
        </button>
        <span className="flex-1" />
        {trailing === undefined ? null : (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{trailing}</span>
        )}
        <button
          type="button"
          draggable
          aria-label={`Move ${title}. Drag, or use the up and down arrow keys.`}
          title="Drag to reorder"
          onKeyDown={onGripKey}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", id);
            if (sectionRef.current !== null) event.dataTransfer.setDragImage(sectionRef.current, 12, 12);
            onDragStart();
          }}
          onDragEnd={onDragEnd}
          className="inline-flex size-5 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing group-hover/section:opacity-100"
        >
          <Icon name="DragDropVertical" fallback="ArrowUpDown" className="size-3.5" />
        </button>
      </div>
      {collapsed ? null : (
        <div id={bodyId} className="px-2 pb-2.5">
          {children}
        </div>
      )}
    </section>
  );
}

/**
 * A row that expands to show `children`. Clicking anywhere on the row toggles
 * it, except on a link or button inside it, so titles stay clickable links.
 */
function ExpandableRow({
  leading,
  title,
  trailing,
  label,
  children,
}: {
  leading: ReactNode;
  title: ReactNode;
  trailing?: ReactNode;
  label: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const expandable = children !== undefined && children !== null && children !== false;
  const onRowClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!expandable || (event.target as HTMLElement).closest("a, button") !== null) return;
    setOpen((value) => !value);
  };
  return (
    <li>
      <div
        onClick={onRowClick}
        className={`flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1.5 text-sm transition-colors ${expandable ? "cursor-pointer hover:bg-accent/60" : ""}`}
      >
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
            onClick={() => setOpen((value) => !value)}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon
              name="ChevronRight"
              fallback="ArrowRight"
              className={`size-3 transition-transform ${open ? "rotate-90" : ""}`}
            />
          </button>
        ) : (
          <span className="size-4 shrink-0" aria-hidden />
        )}
        {leading}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {trailing}
      </div>
      {open && expandable ? (
        <div className="mb-1.5 ml-[1.375rem] mr-1.5 mt-0.5 rounded-lg bg-muted/50 px-3 py-1.5">{children}</div>
      ) : null}
    </li>
  );
}

/** An icon and a value; the icon says what the value is. */
function Row({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 px-1.5 py-1 text-sm">
      <span
        title={title}
        className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
      >
        <Icon name={icon} className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

interface MenuItem {
  label: string;
  icon: string;
  fallback?: string;
  onSelect: () => unknown;
}

/**
 * A small action menu on the popover primitive the host already shims. It
 * closes once an item succeeds, and shows why when one fails.
 */
function Menu({
  label,
  trigger,
  triggerClassName,
  items,
  align = "start",
}: {
  label: string;
  trigger: ReactNode;
  triggerClassName: string;
  items: Array<MenuItem | null | false>;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (item: MenuItem) => {
    setError(null);
    try {
      await item.onSelect();
      setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <Popover.Trigger aria-label={label} title={label} className={triggerClassName}>
        {trigger}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...portalScopeProps()}
          role="menu"
          align={align}
          sideOffset={4}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]"));
            const index = buttons.indexOf(document.activeElement as HTMLElement);
            const next = (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }}
          className={`z-[60] min-w-44 p-1 text-popover-foreground outline-none ${CARD} rounded-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95`}
        >
          {items.map((item) =>
            item ? (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                onClick={() => void run(item)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
              >
                <Icon name={item.icon} fallback={item.fallback} className="size-3.5 shrink-0 text-muted-foreground" />
                {item.label}
              </button>
            ) : null,
          )}
          {error === null ? null : <p className="max-w-60 px-2 py-1.5 text-xs text-destructive">{error}</p>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const copyText = (text: string) => copyToClipboard({ text });

/** Open a link the way bb opens links: its browser pane or the system browser. */
function useOpenUrl(): (url: string) => void {
  const navigate = useBbNavigate();
  return (url) => {
    if (!navigate.openUrl(url)) window.open(url, "_blank", "noopener");
  };
}

/** A shell in BB's terminal panel, started in the thread's folder. */
function useOpenTerminal(threadId: string): () => Promise<void> {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  return async () => {
    const terminal = await sdk.terminals.create({ cols: 100, rows: 30, scope: { kind: "thread", threadId } });
    await navigate.experimental_openTerminal({ terminalId: terminal.id });
  };
}

/**
 * `/Users/me/a/b/c/d` → `~/…/c/d`: home becomes `~`, and only the last two
 * folders stay. The full path is the menu's tooltip.
 */
function shortenPath(path: string): string {
  const home = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/.exec(path)?.[0];
  const rest = home === undefined ? path : path.slice(home.length);
  const separator = rest.includes("\\") && !rest.includes("/") ? "\\" : "/";
  const parts = rest.split(separator).filter((part) => part !== "");
  const prefix = home === undefined ? "" : "~";
  if (parts.length <= 2) return home === undefined ? path : `~${rest}`;
  return `${prefix}${separator}…${separator}${parts.slice(-2).join(separator)}`;
}

/** A value that opens a menu: looks like text, acts like a button. */
const MENU_VALUE = `max-w-full cursor-pointer rounded-md px-1.5 py-0.5 text-left outline-none transition-colors ${PRIMARY_TINT_HOVER} focus-visible:ring-2 focus-visible:ring-ring ${PRIMARY_TINT_OPEN}`;

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function percent(part: number, whole: number | null): string {
  if (whole === null || whole === 0) return "";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

// ── Environment ──────────────────────────────────────────────────────────

function EnvironmentBody({ threadId, environment: env }: { threadId: string; environment: Environment }) {
  const openTerminal = useOpenTerminal(threadId);
  const openUrl = useOpenUrl();
  const reveal = useRpcMutation({ contract: rpcContract, method: "reveal_folder" });
  const openInFinder = () => reveal.mutate({ threadId });
  // Read only for a git folder; the menu shows the item once it is known.
  const repository = useRpcQuery({
    contract: rpcContract,
    method: "repository",
    input: { threadId },
    enabled: env.kind !== "folder",
  });
  const tree = env.workingTree;
  const repositoryUrl = repository.data?.url ?? null;
  const branch = env.branch;
  const folder = env.folder;
  return (
    <div className="flex flex-col">
      {branch === null ? null : (
        <Row icon="GitBranch" title="Branch">
          <span className="flex min-w-0 items-center gap-1.5">
            <Menu
              label={`Branch ${branch}`}
              triggerClassName={`${MENU_VALUE} min-w-0 truncate bg-muted font-mono text-xs`}
              trigger={branch}
              items={[
                { label: "Open in terminal", icon: "SquareTerminal", fallback: "Terminal", onSelect: openTerminal },
                { label: "Copy branch name", icon: "Copy", onSelect: () => copyText(branch) },
              ]}
            />
            {env.kind === "worktree" ? <span className="shrink-0 text-xs text-muted-foreground">worktree</span> : null}
          </span>
        </Row>
      )}
      <Row icon="Laptop" title="Machine">
        {env.machine ?? <Muted>Unknown machine</Muted>}
      </Row>
      <Row icon="FolderOpen" title="Folder">
        {folder === null ? (
          <Muted>Unknown folder</Muted>
        ) : (
          <Menu
            label={folder}
            triggerClassName={`${MENU_VALUE} -mx-1.5 flex min-w-0 items-baseline gap-1`}
            trigger={
              <>
                {env.project === null ? null : <span className="shrink-0 font-medium">{env.project} ·</span>}
                <span className="truncate text-muted-foreground">{shortenPath(folder)}</span>
              </>
            }
            items={[
              { label: "Open in Finder", icon: "FolderOpen", onSelect: openInFinder },
              { label: "Open in terminal", icon: "SquareTerminal", fallback: "Terminal", onSelect: openTerminal },
              { label: "Copy path", icon: "Copy", onSelect: () => copyText(folder) },
              repositoryUrl !== null && {
                label: "Open repository",
                icon: "Github",
                fallback: "ExternalLink",
                onSelect: () => openUrl(repositoryUrl),
              },
            ]}
          />
        )}
      </Row>
      {tree === null ? null : (
        <Row icon="FileDiff" title="Working tree">
          {tree.fileCount === 0 ? (
            <Muted>Clean</Muted>
          ) : (
            <span>
              {tree.fileCount} {tree.fileCount === 1 ? "file" : "files"} changed{" "}
              <span style={{ color: "var(--success)" }}>+{tree.insertions}</span>{" "}
              <span className="text-destructive">−{tree.deletions}</span>
            </span>
          )}
        </Row>
      )}
    </div>
  );
}

// ── Context ──────────────────────────────────────────────────────────────

// Mid-lightness hues that read on light and dark themes; the host theme has
// no chart tokens. Reserved and free space use the theme's own muted colors.
const USED_COLORS = [
  "oklch(62% 0.16 255)",
  "oklch(66% 0.16 45)",
  "oklch(66% 0.13 165)",
  "oklch(75% 0.14 90)",
  "oklch(62% 0.15 305)",
  "oklch(62% 0.12 210)",
  "oklch(60% 0.03 260)",
];
const RESERVED_COLOR = "color-mix(in oklab, var(--muted-foreground) 35%, transparent)";
const FREE_COLOR = "var(--muted)";

function categoryColor(category: Category, usedIndex: number): string {
  if (category.kind === "reserved") return RESERVED_COLOR;
  if (category.kind === "free" || category.kind === "deferred") return FREE_COLOR;
  return USED_COLORS[Math.min(usedIndex, USED_COLORS.length - 1)]!;
}

function ContextBody({ context }: { context: Context }) {
  const window = context.windowTokens;
  const used = context.usedTokens;
  const inWindow = context.categories.filter((category) => category.kind !== "deferred");
  const deferred = context.categories.filter((category) => category.kind === "deferred");
  let usedIndex = 0;
  const colored = inWindow.map((category) => ({
    category,
    color: categoryColor(category, category.kind === "used" ? usedIndex++ : 0),
  }));

  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-baseline justify-between gap-2 px-1.5 pt-1">
        <span className="font-medium tabular-nums">
          {context.estimated ? "~" : ""}
          {used === null ? "?" : formatTokens(used)} <Muted>/ {window === null ? "?" : formatTokens(window)} tokens</Muted>
        </span>
        {context.autoCompactAtTokens === null ? null : (
          <span className="text-xs text-muted-foreground">compacts at {formatTokens(context.autoCompactAtTokens)}</span>
        )}
      </div>
      <div className="px-1.5">
        <ContextBar colored={colored} used={used} window={window} />
      </div>
      {/* Without a breakdown the bar alone says enough. */}
      {colored.length === 0 ? null : (
        <ul className="flex flex-col">
          {colored.map(({ category, color }) => (
            <CategoryRow key={category.label} category={category} color={color} window={window} />
          ))}
          {deferred.map((category) => (
            <CategoryRow key={category.label} category={category} color={FREE_COLOR} window={null} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ContextBar({
  colored,
  used,
  window,
}: {
  colored: Array<{ category: Category; color: string }>;
  used: number | null;
  window: number | null;
}) {
  const total = window ?? colored.reduce((sum, { category }) => sum + category.tokens, 0);
  const segments =
    colored.length > 0
      ? colored.filter(({ category }) => category.kind !== "free")
      : used === null
        ? []
        : [{ category: { label: "Used", tokens: used } as Category, color: USED_COLORS[0]! }];
  return (
    <div
      className="flex h-2 w-full gap-px overflow-hidden rounded-full"
      style={{ background: FREE_COLOR }}
      role="img"
      aria-label={used === null || window === null ? "Context usage" : `${formatTokens(used)} of ${formatTokens(window)} tokens`}
    >
      {total > 0
        ? segments.map(({ category, color }) => (
            <div
              key={category.label}
              title={`${category.label}: ${formatTokens(category.tokens)}`}
              style={{ width: `${(category.tokens / total) * 100}%`, background: color }}
              className="h-full shrink-0 first:rounded-l-full"
            />
          ))
        : null}
    </div>
  );
}

function CategoryRow({ category, color, window }: { category: Category; color: string; window: number | null }) {
  // The entries say where the tokens come from: memory file paths, skill and
  // agent names, MCP tools.
  return (
    <ExpandableRow
      label={category.label}
      leading={<span className="size-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />}
      title={<span className="text-xs">{category.label}</span>}
      trailing={
        <>
          <span className="text-xs tabular-nums text-muted-foreground">{formatTokens(category.tokens)}</span>
          <span className="w-11 text-right text-xs tabular-nums text-muted-foreground">
            {window === null ? "—" : percent(category.tokens, window)}
          </span>
        </>
      }
    >
      {category.entries.length === 0 ? null : (
        <ul className="py-0.5">
          {category.entries.map((entry) => (
            <li key={entry.label} className="flex gap-2 py-0.5 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 truncate" title={entry.label}>
                {entry.label}
              </span>
              <span className="tabular-nums">{formatTokens(entry.tokens)}</span>
            </li>
          ))}
          {category.more > 0 ? <li className="py-0.5 text-xs text-muted-foreground">and {category.more} more</li> : null}
        </ul>
      )}
    </ExpandableRow>
  );
}

/** Share of the window used, and cost when the provider reports it. */
function contextTrailing(context: Context | null): string | undefined {
  if (context === null) return undefined;
  const parts: string[] = [];
  if (context.usedTokens !== null && context.windowTokens) {
    parts.push(`${context.estimated ? "~" : ""}${Math.round((context.usedTokens / context.windowTokens) * 100)}%`);
  }
  if (context.cost !== null) parts.push(formatCost(context.cost));
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function formatCost(cost: NonNullable<Context["cost"]>): string {
  return cost.currency === "USD" ? `$${cost.amount.toFixed(2)}` : `${cost.amount.toFixed(2)} ${cost.currency}`;
}

// ── Connectors ───────────────────────────────────────────────────────────

function ConnectorsBody({ connectors }: { connectors: Connector[] }) {
  return (
    <ul className="flex flex-col">
      {connectors.map((connector) => (
        <ExpandableRow
          key={connector.server}
          label={connector.server}
          leading={<Icon name="ElectricPlugs" fallback="Plug02" className="size-3.5 shrink-0 text-muted-foreground" />}
          title={connector.server}
          trailing={
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {connector.toolCount === null ? "" : `${connector.toolCount} tools · `}
              {connector.calls === 0 ? "unused" : `${connector.calls} ${connector.calls === 1 ? "call" : "calls"}`}
            </span>
          }
        >
          {connector.tools.length === 0 ? null : (
            <ul className="py-0.5">
              {connector.tools.map((tool) => (
                <li key={tool.name} className="flex gap-2 py-0.5 text-xs">
                  <span className="min-w-0 flex-1 truncate font-mono" title={tool.name}>
                    {tool.name}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {tool.calls === 0 ? "—" : `${tool.calls}×`}
                  </span>
                </li>
              ))}
              {connector.moreTools > 0 ? (
                <li className="py-0.5 text-xs text-muted-foreground">and {connector.moreTools} more</li>
              ) : null}
            </ul>
          )}
        </ExpandableRow>
      ))}
    </ul>
  );
}

// ── Pull requests and issues ─────────────────────────────────────────────

/** One PR or issue this thread touched. */
interface Change<Status> {
  key: string;
  label: string;
  source: WorkItem["source"];
  url: string | null;
  /** What this thread first did to it; null for the branch's own PR. */
  action: WorkItem["action"] | null;
  status: Status | null;
  error: string | null;
}
type PrChange = Change<PullRequestStatus>;
type IssueChange = Change<IssueStatus>;

function groupChanges(
  summary: SessionSummary,
  statuses: ItemStatuses,
): { pullRequests: PrChange[]; issues: IssueChange[] } {
  const pullRequests = new Map<string, PrChange>();
  const issues = new Map<string, IssueChange>();
  const branchPr = summary.changes.pullRequest;
  if (branchPr !== null) {
    pullRequests.set(branchPr.url, {
      key: branchPr.url,
      label: `#${branchPr.number}`,
      source: "github",
      url: branchPr.url,
      action: null,
      status: branchPr,
      error: null,
    });
  }
  for (const item of summary.changes.workItems) {
    const row = statuses[workItemKey(item)];
    const status = row?.outcome === "available" ? row.status : null;
    const url = status?.url ?? item.url;
    // `#12` and `owner/repo#12` are the same PR once gh tells us its URL.
    const key = url ?? workItemKey(item);
    const base = {
      key,
      label: item.label,
      source: item.source,
      url,
      action: item.action,
      error: row?.outcome === "unavailable" ? row.message : null,
    };
    if (item.kind === "pullRequest") {
      add(pullRequests, { ...base, status: status?.kind === "pullRequest" ? status : null });
    } else {
      add(issues, { ...base, status: status?.kind === "issue" ? status : null });
    }
  }
  return { pullRequests: [...pullRequests.values()], issues: [...issues.values()] };
}

/** The first mention keeps its action; a later one may bring the status. */
function add<Status>(changes: Map<string, Change<Status>>, change: Change<Status>): void {
  const existing = changes.get(change.key);
  if (existing === undefined) changes.set(change.key, change);
  else {
    existing.action ??= change.action;
    existing.status ??= change.status;
  }
}

const MERGED_COLOR = "oklch(58% 0.2 300)";

interface StateLook {
  icon: string;
  fallback?: string;
  color: string;
  label: string;
}

const PR_STATE: Record<PullRequestStatus["state"], StateLook> = {
  open: { icon: "GitPullRequest", color: "var(--success)", label: "Open" },
  draft: { icon: "GitPullRequestDraft", color: "var(--muted-foreground)", label: "Draft" },
  merged: { icon: "GitMerge", color: MERGED_COLOR, label: "Merged" },
  closed: { icon: "GitPullRequestClosed", color: "var(--destructive)", label: "Closed" },
};

const CHECKS: Record<PullRequestStatus["checks"]["state"], StateLook | null> = {
  failing: { icon: "CircleX", fallback: "AlertCircle", color: "var(--destructive)", label: "Checks failing" },
  pending: { icon: "Clock", color: "var(--warning)", label: "Checks running" },
  passing: { icon: "CircleCheck", fallback: "Check", color: "var(--success)", label: "Checks passing" },
  none: null,
  unknown: null,
};

const ISSUE_STATE: Record<IssueStatus["state"], StateLook> = {
  open: { icon: "CircleDot", fallback: "Circle", color: "var(--success)", label: "Open" },
  completed: { icon: "CircleCheck", fallback: "Check", color: MERGED_COLOR, label: "Closed as completed" },
  not_planned: { icon: "Circle", fallback: "Minus", color: "var(--muted-foreground)", label: "Closed as not planned" },
};

/** Before gh answers, show what this thread did to the PR. */
const PR_ACTION_FALLBACK: Record<WorkItem["action"], PullRequestStatus["state"]> = {
  opened: "open",
  merged: "merged",
  closed: "closed",
};

/** Pull requests first, this branch's leading, then issues: one list. */
function ChangesBody({
  pullRequests,
  issues,
}: {
  pullRequests: PrChange[];
  issues: IssueChange[];
}) {
  return (
    <ul className="flex flex-col">
      {pullRequests.map((change) => (
        <PullRequestRow key={change.key} change={change} />
      ))}
      {issues.map((change) => (
        <IssueRow key={change.key} change={change} />
      ))}
    </ul>
  );
}

/** One PR or issue: state icon, title, and a menu to open or copy its link. */
function ChangeRow({
  change,
  title,
  state,
  stateLabel,
  extra,
  reference,
  openLabel,
}: {
  change: Change<unknown>;
  title: string;
  /** How the state icon looks; it is muted until the status is known. */
  state: StateLook;
  stateLabel: string;
  extra?: ReactNode;
  /** `#12`, or the label the thread used until the status is known. */
  reference: string;
  openLabel: string;
}) {
  const url = change.url;
  const openUrl = useOpenUrl();
  return (
    <li className="group/row flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1.5 text-sm transition-colors hover:bg-accent/50">
      <span title={stateLabel} className="inline-flex shrink-0">
        <Icon name={state.icon} fallback={state.fallback} className="size-3.5" style={{ color: state.color }} />
      </span>
      <span className="min-w-0 flex-1 truncate" title={title}>
        {title}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
        {extra}
        {reference}
      </span>
      {url === null ? (
        <span className="size-6 shrink-0" aria-hidden />
      ) : (
        <Menu
          label={`Actions for ${title}`}
          align="end"
          triggerClassName="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground"
          trigger={<Icon name="MoreHorizontal" fallback="Ellipsis" className="size-4" />}
          items={[
            { label: openLabel, icon: "ExternalLink", onSelect: () => openUrl(url) },
            { label: "Copy link", icon: "Link", onSelect: () => copyText(url) },
          ]}
        />
      )}
    </li>
  );
}

const MUTED = "var(--muted-foreground)";

function PullRequestRow({ change }: { change: PrChange }) {
  const status = change.status;
  const state = PR_STATE[status?.state ?? PR_ACTION_FALLBACK[change.action ?? "opened"]];
  const checks = status === null ? null : CHECKS[status.checks.state];
  return (
    <ChangeRow
      change={change}
      title={status?.title ?? change.label}
      openLabel="Open on GitHub"
      state={status === null ? { ...state, color: MUTED } : state}
      stateLabel={status === null ? (change.error ?? "Loading status…") : state.label}
      reference={status === null ? change.label : `#${status.number}`}
      extra={
        checks === null || status === null ? null : (
          <span title={checksLabel(status.checks, checks.label)} className="inline-flex">
            <Icon name={checks.icon} fallback={checks.fallback} className="size-3.5" style={{ color: checks.color }} />
          </span>
        )
      }
    />
  );
}

/** "Checks failing: 1 failing · 3 passed", for a tooltip. */
function checksLabel(checks: PullRequestStatus["checks"], label: string): string {
  const parts = [
    checks.failed > 0 && `${checks.failed} failing`,
    checks.pending > 0 && `${checks.pending} running`,
    checks.passed > 0 && `${checks.passed} passed`,
  ].filter(Boolean);
  return parts.length === 0 ? label : `${label}: ${parts.join(" · ")}`;
}

function IssueRow({ change }: { change: IssueChange }) {
  const status = change.status;
  const linear = change.source === "linear";
  const state = status === null ? null : ISSUE_STATE[status.state];
  return (
    <ChangeRow
      change={change}
      title={status?.title ?? change.label}
      openLabel={linear ? "Open in Linear" : "Open on GitHub"}
      state={state ?? { icon: linear ? "FileText" : "CircleDot", fallback: "FileText", color: MUTED, label: "" }}
      stateLabel={state?.label ?? (linear ? "Linear issue" : (change.error ?? "Loading status…"))}
      reference={`${status === null ? change.label : `#${status.number}`}${linear ? " · Linear" : ""}`}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "session-summary",
    title: "Session summary",
    component: SessionSummaryButton,
  });
});
