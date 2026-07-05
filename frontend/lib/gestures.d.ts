/**
 * TypeScript definitions for the row-gestures controller.
 *
 * The controller owns all gesture state (drag index, drop gap, long-press
 * timers, indicator classes); components bind their `on-*` attributes to the
 * thin delegating handler methods. See gestures.js for the passive-safety
 * invariant governing which touch handlers may be bound `-passive`.
 */

/**
 * Translate an insertion gap for a remove-then-insert reorder API (splice the
 * source out, then splice it in). Returns the `to` index: `gap > from ? gap-1 : gap`.
 */
export function gapToRemoveInsertIndex(from: number, gap: number): number;

/**
 * Identity pass-through for reorder APIs that already treat their target as an
 * insertion gap (they do the remove-shift internally). Documented for symmetry.
 */
export function gapToGapIndex(from: number, gap: number): number;

/**
 * Where a group of rows lands when moved to `gap`: `target` is the insertion
 * index after removing selected rows before the gap; `newIndices` are the
 * resulting contiguous positions.
 */
export function groupReorderTargets(
  fromIndices: number[],
  gap: number
): { target: number; newIndices: number[] };

/**
 * True when dropping `fromIndices` at `gap` leaves order unchanged (single row:
 * gaps `i` and `i+1`; group: any gap inside/hugging a contiguous selected run).
 */
export function isNoopGap(fromIndices: number[], gap: number): boolean;

/** Optional selection adapter enabling group drag. */
export interface GestureSelection {
  /** Whether the row at `i` is selected. */
  isSelected(i: number): boolean;
  /** Current selected indices (any order; the controller sorts). */
  indices(): number[];
}

/** Class names applied to the hovered row to show the insertion edge. */
export interface GestureIndicator {
  /** Applied when inserting before the hovered row (default 'drag-over'). */
  before?: string;
  /** Applied when inserting after the hovered row (default 'drag-over-below'). */
  after?: string;
}

/** Minimal shape of a windowing controller consumed as a collaborator. */
export interface GestureWindowing {
  readonly scrollTop: number;
  readonly totalHeight: number;
}

export interface RowGestureOptions {
  /** Fixed row height in px (required; touch-drag target math). */
  itemHeight: number | (() => number);
  /** Optional windowing collaborator for virtualized touch-drag index math. */
  windowing?: GestureWindowing;
  /** Total row count for gap clamping. Required when no `windowing` is given. */
  count?: () => number;
  /** Semantic tap callback (mouse click or clean touch tap). */
  onTap?(index: number, e: Event): void;
  /** Long-press (touch hold) callback. */
  onLongPress?(index: number, e: Event): void;
  /** Context-menu (right-click) callback. */
  onContextMenu?(index: number, e: Event): void;
  /**
   * REQUIRED to enable reorder features. `fromIndices` is always an array
   * (single drag = `[i]`); `gap` is the insertion gap (0..count), already
   * clamped and no-op-filtered.
   */
  onReorder?(fromIndices: number[], gap: number): void;
  /** Selection adapter; enables group drag when a selected row is dragged. */
  selection?: GestureSelection;
  /** Indicator class names (default { before: 'drag-over', after: 'drag-over-below' }). */
  indicator?: GestureIndicator;
  /** Long-press hold duration in ms (default 500). */
  longPressMs?: number;
  /** Movement in px that cancels a long-press (default 10). */
  slop?: number;
  /** Class on the actively dragged row (default 'dragging'). */
  draggingClass?: string;
  /** Class on the other rows in a group drag (default 'group-dragging'). */
  groupDraggingClass?: string;
  /** Builds a selector for a row index (default `[data-index="${index}"]`). */
  rowSelector?: (index: number) => string;
  /** Element scrolled by touch-drag edge autoscroll (default: host). */
  scrollContainer?: HTMLElement | (() => HTMLElement | null);
}

export interface RowGestureController {
  /** Coarse touch-capability probe (bind draggable="${!g.isTouchDevice()}"). */
  isTouchDevice(): boolean;

  /** Mouse/synthesized click -> onTap (guards against touch double-fire). */
  click(index: number, e: Event): void;
  /** Right-click -> onContextMenu. */
  contextMenu(index: number, e: Event): void;

  /** PASSIVE-SAFE (never preventDefaults): arm long-press. Bind -passive. */
  touchStart(index: number, e: Event): void;
  /** PASSIVE-SAFE (never preventDefaults): cancel long-press past slop. Bind -passive. */
  touchMove(e: Event): void;
  /** MAY preventDefault (ghost-tap suppression). Fires onTap for a clean tap. */
  touchEnd(index: number, e: Event): void;

  /** Begin desktop drag; capture the moving set. */
  dragStart(index: number, e: Event): void;
  /** Compute + show the insertion edge (preventDefaults). */
  dragOver(index: number, e: Event): void;
  /** Remove the indicator when leaving the row. */
  dragLeave(e: Event): void;
  /** Commit a desktop drop -> onReorder(fromIndices, gap). */
  drop(index: number, e: Event): void;
  /** End a desktop drag; clear classes/state. */
  dragEnd(e: Event): void;

  /** Begin a touch drag from the handle (preventDefaults). */
  handleTouchStart(index: number, e: Event): void;
  /** Track the touch drag: indicator + edge autoscroll (preventDefaults). */
  handleTouchMove(e: Event): void;
  /** Commit the touch drag -> onReorder(fromIndices, gap) (preventDefaults). */
  handleTouchEnd(e: Event): void;

  /** Abort any in-flight gesture and clear transient classes/timers. */
  cancel(): void;
  /** Full teardown; the controller no-ops afterwards. */
  destroy(): void;
}

/**
 * Create a row-gestures controller. Call in a component's data() with
 * `host = this`; tear down in unmounted() via destroy().
 */
export function createRowGestures(
  host: HTMLElement,
  options: RowGestureOptions
): RowGestureController;
