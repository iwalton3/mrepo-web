/**
 * VDX-Web Component Library Type Definitions
 *
 * Professional UI components with cl-* prefix.
 * All components use the VDX framework's defineComponent.
 */

import type { HtmlTemplate } from './framework.js';

// =============================================================================
// Common Types
// =============================================================================

/**
 * Option object for select-like components
 */
export interface SelectOption<T = unknown> {
  label: string;
  value: T;
  disabled?: boolean;
  [key: string]: unknown;
}

/**
 * Button severity/variant
 */
export type ButtonSeverity = 'primary' | 'secondary' | 'success' | 'danger' | 'warning' | 'info';

/**
 * Position for icons, tooltips, etc.
 */
export type Position = 'left' | 'right' | 'top' | 'bottom';

/**
 * Common change event detail
 */
export interface ChangeEventDetail<T = unknown> {
  value: T;
}

// =============================================================================
// Button Components
// =============================================================================

/**
 * cl-button - Styled button component
 *
 * @example
 * <cl-button label="Submit" severity="primary" on-click="${this.handleSubmit}"></cl-button>
 * <cl-button label="Cancel" severity="secondary" outlined></cl-button>
 * <cl-button loading disabled>Processing...</cl-button>
 */
export interface ClButtonProps {
  /** Button text label */
  label?: string;
  /** Icon to display (text/emoji) */
  icon?: string;
  /** Icon position */
  iconpos?: 'left' | 'right';
  /** Button style variant */
  severity?: ButtonSeverity;
  /** Outline style (transparent background) */
  outlined?: boolean;
  /** Text style (no background or border) */
  text?: boolean;
  /** Disabled state */
  disabled?: boolean;
  /** Loading state (shows spinner) */
  loading?: boolean;
}

/**
 * cl-menu - Dropdown menu button
 *
 * @example
 * <cl-menu
 *   label="Actions"
 *   items="${menuItems}"
 *   on-select="${this.handleSelect}">
 * </cl-menu>
 */
export interface ClMenuProps {
  /** Menu button label */
  label?: string;
  /** Menu items */
  items?: Array<{
    label: string;
    icon?: string;
    command?: () => void;
    disabled?: boolean;
    separator?: boolean;
  }>;
  /** Icon for menu button */
  icon?: string;
  /** Popup mode */
  popup?: boolean;
}

/**
 * cl-split-button - Button with dropdown menu
 */
export interface ClSplitButtonProps {
  /** Primary button label */
  label?: string;
  /** Menu items */
  items?: Array<{ label: string; command?: () => void }>;
  /** Button severity */
  severity?: ButtonSeverity;
  /** Disabled state */
  disabled?: boolean;
}

/**
 * cl-breadcrumb - Navigation breadcrumb
 */
export interface ClBreadcrumbProps {
  /** Breadcrumb items */
  items?: Array<{
    label: string;
    url?: string;
    icon?: string;
  }>;
  /** Home item (first item) */
  home?: { icon?: string; url?: string };
}

// =============================================================================
// Form Components
// =============================================================================

/**
 * cl-input-text - Text input with validation
 *
 * @example
 * <cl-input-text
 *   label="Username"
 *   placeholder="Enter username"
 *   required
 *   x-model="username">
 * </cl-input-text>
 */
export interface ClInputTextProps {
  /** Current value */
  value?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Disabled state */
  disabled?: boolean;
  /** Required validation */
  required?: boolean;
  /** Regex pattern validation */
  pattern?: string;
  /** Minimum length validation */
  minlength?: number;
  /** Maximum length validation */
  maxlength?: number;
  /** External error message */
  error?: string;
  /** Field label */
  label?: string;
  /** Help text shown below input */
  helptext?: string;
}

/**
 * cl-input-number - Number input with increment/decrement
 */
export interface ClInputNumberProps {
  /** Current value */
  value?: number;
  /** Minimum value */
  min?: number;
  /** Maximum value */
  max?: number;
  /** Step increment */
  step?: number;
  /** Disabled state */
  disabled?: boolean;
  /** Field label */
  label?: string;
  /** Show increment/decrement buttons */
  showbuttons?: boolean;
  /** Button layout: 'stacked' or 'horizontal' */
  buttonlayout?: 'stacked' | 'horizontal';
}

/**
 * cl-input-password - Password input with visibility toggle
 */
export interface ClInputPasswordProps {
  /** Current value */
  value?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Disabled state */
  disabled?: boolean;
  /** Show visibility toggle button */
  togglemask?: boolean;
  /** Field label */
  label?: string;
  /** Show password strength meter */
  feedback?: boolean;
}

/**
 * cl-input-search - Search input with clear button
 */
export interface ClInputSearchProps {
  /** Current value */
  value?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Disabled state */
  disabled?: boolean;
  /** Field label */
  label?: string;
}

/**
 * cl-input-mask - Input with formatting mask
 */
export interface ClInputMaskProps {
  /** Current value */
  value?: string;
  /** Mask pattern (e.g., '(999) 999-9999') */
  mask?: string;
  /** Placeholder character */
  slotchar?: string;
  /** Disabled state */
  disabled?: boolean;
  /** Field label */
  label?: string;
}

/**
 * cl-textarea - Multi-line text input
 */
export interface ClTextareaProps {
  /** Current value */
  value?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Number of visible rows */
  rows?: number;
  /** Auto-resize based on content */
  autoResize?: boolean;
  /** Disabled state */
  disabled?: boolean;
  /** Field label */
  label?: string;
  /** Maximum character count */
  maxlength?: number;
  /** Show character counter */
  showCount?: boolean;
}

/**
 * cl-checkbox - Checkbox input
 */
export interface ClCheckboxProps {
  /** Checked state */
  value?: boolean;
  /** Checkbox label */
  label?: string;
  /** Disabled state */
  disabled?: boolean;
  /** Indeterminate state */
  indeterminate?: boolean;
}

/**
 * cl-toggle - Toggle switch
 */
export interface ClToggleProps {
  /** Checked state */
  value?: boolean;
  /** Toggle label */
  label?: string;
  /** Disabled state */
  disabled?: boolean;
  /** On label text */
  onlabel?: string;
  /** Off label text */
  offlabel?: string;
}

/**
 * cl-radio-button - Radio button group
 */
export interface ClRadioButtonProps {
  /** Selected value */
  value?: unknown;
  /** Available options */
  options?: SelectOption[];
  /** Option label field */
  optionlabel?: string;
  /** Option value field */
  optionvalue?: string;
  /** Group name */
  name?: string;
  /** Disabled state */
  disabled?: boolean;
  /** Field label */
  label?: string;
}

/**
 * cl-slider - Range slider
 */
export interface ClSliderProps {
  /** Current value */
  value?: number;
  /** Minimum value */
  min?: number;
  /** Maximum value */
  max?: number;
  /** Step increment */
  step?: number;
  /** Disabled state */
  disabled?: boolean;
  /** Vertical orientation */
  orientation?: 'horizontal' | 'vertical';
  /** Show range (two handles) */
  range?: boolean;
}

/**
 * cl-calendar - Date picker
 */
export interface ClCalendarProps {
  /** Selected date(s) */
  value?: Date | Date[] | null;
  /** Selection mode */
  selectionmode?: 'single' | 'multiple' | 'range';
  /** Show time picker */
  showtime?: boolean;
  /** Time only mode */
  timeonly?: boolean;
  /** Disabled state */
  disabled?: boolean;
  /** Inline mode (no popup) */
  inline?: boolean;
  /** Minimum selectable date */
  mindate?: Date;
  /** Maximum selectable date */
  maxdate?: Date;
  /** Date format string */
  dateformat?: string;
  /** Field label */
  label?: string;
  /** Placeholder text */
  placeholder?: string;
}

// =============================================================================
// Selection Components
// =============================================================================

/**
 * cl-dropdown - Single select dropdown
 *
 * @example
 * <cl-dropdown
 *   options="${countries}"
 *   optionlabel="name"
 *   optionvalue="code"
 *   filter
 *   x-model="selectedCountry">
 * </cl-dropdown>
 */
export interface ClDropdownProps {
  /** Available options */
  options?: Array<SelectOption | string>;
  /** Selected value */
  value?: unknown;
  /** Placeholder text when no selection */
  placeholder?: string;
  /** Disabled state */
  disabled?: boolean;
  /** Enable filter/search */
  filter?: boolean;
  /** Field label */
  label?: string;
  /** Option label field (for objects) */
  optionlabel?: string;
  /** Option value field (for objects) */
  optionvalue?: string;
}

/**
 * cl-multiselect - Multiple selection dropdown
 */
export interface ClMultiselectProps {
  /** Available options */
  options?: Array<SelectOption | string>;
  /** Selected values */
  value?: unknown[];
  /** Placeholder text when no selection */
  placeholder?: string;
  /** Disabled state */
  disabled?: boolean;
  /** Enable filter/search */
  filter?: boolean;
  /** Field label */
  label?: string;
  /** Option label field */
  optionlabel?: string;
  /** Option value field */
  optionvalue?: string;
  /** Maximum items to show before "+N more" */
  maxselectedlabels?: number;
  /** Show checkbox for each option */
  showcheckbox?: boolean;
}

/**
 * cl-autocomplete - Input with suggestions
 */
export interface ClAutocompleteProps {
  /** Current value */
  value?: string;
  /** Suggestions to display */
  suggestions?: string[];
  /** Placeholder text */
  placeholder?: string;
  /** Disabled state */
  disabled?: boolean;
  /** Minimum characters before search */
  minlength?: number;
  /** Allow multiple selections */
  multiple?: boolean;
  /** Field label */
  label?: string;
  /** Custom complete function */
  completemethod?: (query: string) => void | Promise<void>;
}

/**
 * cl-chips - Input with chips/tags
 */
export interface ClChipsProps {
  /** Current values */
  value?: string[];
  /** Placeholder text */
  placeholder?: string;
  /** Disabled state */
  disabled?: boolean;
  /** Maximum number of chips */
  max?: number;
  /** Field label */
  label?: string;
  /** Separator character for adding chips */
  separator?: string;
}

// =============================================================================
// Panel Components
// =============================================================================

/**
 * cl-accordion - Collapsible panels
 */
export interface ClAccordionProps {
  /** Allow multiple panels open */
  multiple?: boolean;
  /** Index(es) of active panel(s) */
  activeindex?: number | number[];
}

/**
 * cl-card - Content card container
 */
export interface ClCardProps {
  /** Card title */
  title?: string;
  /** Card subtitle */
  subtitle?: string;
  /** Header content (slot available) */
  header?: string;
  /** Footer content (slot available) */
  footer?: string;
}

/**
 * cl-tabview - Tabbed content panels
 */
export interface ClTabviewProps {
  /** Index of active tab */
  activeindex?: number;
}

/**
 * cl-fieldset - Grouped form fields with legend
 */
export interface ClFieldsetProps {
  /** Legend text */
  legend?: string;
  /** Collapsible mode */
  toggleable?: boolean;
  /** Collapsed state */
  collapsed?: boolean;
}

/**
 * cl-splitter - Resizable split panels
 */
export interface ClSplitterProps {
  /** Split layout */
  layout?: 'horizontal' | 'vertical';
  /** Gutter size in pixels */
  guttersize?: number;
  /** Initial panel sizes as percentages */
  panelsizes?: number[];
  /** Minimum panel size in percentage */
  minsize?: number;
}

/**
 * cl-stepper - Step-by-step wizard
 */
export interface ClStepperProps {
  /** Current step index */
  activeindex?: number;
  /** Linear mode (must complete steps in order) */
  linear?: boolean;
  /** Orientation */
  orientation?: 'horizontal' | 'vertical';
}

// =============================================================================
// Overlay Components
// =============================================================================

/**
 * cl-dialog - Modal dialog
 *
 * @example
 * <cl-dialog header="Confirm" x-model="showDialog">
 *   <p>Are you sure?</p>
 *   <div slot="footer">
 *     <cl-button label="Cancel" on-click="${this.closeDialog}"></cl-button>
 *     <cl-button label="Confirm" severity="primary" on-click="${this.confirm}"></cl-button>
 *   </div>
 * </cl-dialog>
 */
export interface ClDialogProps {
  /** Dialog visibility */
  visible?: boolean;
  /** Dialog title */
  header?: string;
  /** Footer content */
  footer?: string;
  /** Modal mode (overlay background) */
  modal?: boolean;
  /** Show close button */
  closable?: boolean;
  /** Close on mask click */
  dismissablemask?: boolean;
  /** Inline style */
  style?: string;
}

/**
 * cl-sidebar - Slide-out sidebar panel
 */
export interface ClSidebarProps {
  /** Sidebar visibility */
  visible?: boolean;
  /** Position */
  position?: 'left' | 'right' | 'top' | 'bottom';
  /** Full screen mode */
  fullscreen?: boolean;
  /** Show close button */
  showcloseicon?: boolean;
  /** Modal mode */
  modal?: boolean;
  /** Dismiss on mask click */
  dismissable?: boolean;
  /** Header text */
  header?: string;
}

/**
 * cl-tooltip - Hover tooltip
 */
export interface ClTooltipProps {
  /** Tooltip content */
  content?: string;
  /** Position */
  position?: Position;
  /** Show delay in ms */
  showdelay?: number;
  /** Hide delay in ms */
  hidedelay?: number;
  /** Disabled state */
  disabled?: boolean;
}

/**
 * cl-toast - Toast notification container
 */
export interface ClToastProps {
  /** Position on screen */
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'top-center' | 'bottom-center';
  /** Default lifetime in ms */
  life?: number;
}

/**
 * Menu item for cl-action-menu
 */
export interface ActionMenuItem {
  /** Item label text */
  label?: string;
  /** Icon (text/emoji) */
  icon?: string;
  /** Click handler */
  action?: () => void;
  /** Render as separator line */
  separator?: boolean;
  /** Danger/destructive styling */
  danger?: boolean;
  /** Disabled state */
  disabled?: boolean;
  /** Active/selected state */
  active?: boolean;
  /** Keyboard shortcut hint */
  shortcut?: string;
}

/**
 * cl-action-menu - Dropdown action menu with button trigger
 *
 * @example
 * <cl-action-menu
 *   label="Actions"
 *   items="${[
 *     { label: 'Edit', icon: 'pencil', action: () => this.edit() },
 *     { label: 'Delete', danger: true, action: () => this.delete() }
 *   ]}">
 * </cl-action-menu>
 */
export interface ClActionMenuProps {
  /** Button label (default: '...') */
  label?: string;
  /** Button icon */
  icon?: string;
  /** Menu items array */
  items?: ActionMenuItem[];
  /** Dropdown position */
  position?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
  /** Disabled state */
  disabled?: boolean;
}

// =============================================================================
// Data Components
// =============================================================================

/**
 * cl-datatable - Data table with sorting, filtering, pagination
 */
export interface ClDatatableProps {
  /** Table data */
  value?: unknown[];
  /** Column definitions */
  columns?: Array<{
    field: string;
    header: string;
    sortable?: boolean;
    filterable?: boolean;
    width?: string;
    body?: (rowData: unknown) => HtmlTemplate;
  }>;
  /** Enable pagination */
  paginator?: boolean;
  /** Rows per page */
  rows?: number;
  /** Row key field for tracking */
  datakey?: string;
  /** Selected row(s) */
  selection?: unknown | unknown[];
  /** Selection mode */
  selectionmode?: 'single' | 'multiple';
  /** Sort field */
  sortfield?: string;
  /** Sort order */
  sortorder?: 1 | -1;
  /** Loading state */
  loading?: boolean;
  /** Show grid lines */
  showgridlines?: boolean;
  /** Striped rows */
  stripedrows?: boolean;
  /** Scrollable */
  scrollable?: boolean;
  /** Scroll height */
  scrollheight?: string;
}

/**
 * cl-tree - Tree view component
 */
export interface ClTreeProps {
  /** Tree nodes */
  value?: Array<{
    key: string;
    label: string;
    icon?: string;
    children?: unknown[];
    leaf?: boolean;
    data?: unknown;
  }>;
  /** Selection mode */
  selectionmode?: 'single' | 'multiple' | 'checkbox';
  /** Selected key(s) */
  selectionkeys?: string | string[];
  /** Expanded key(s) */
  expandedkeys?: string[];
  /** Loading state */
  loading?: boolean;
  /** Enable filtering */
  filter?: boolean;
  /** Filter mode */
  filtermode?: 'lenient' | 'strict';
}

/**
 * cl-paginator - Pagination controls
 */
export interface ClPaginatorProps {
  /** First record index */
  first?: number;
  /** Records per page */
  rows?: number;
  /** Total record count */
  totalrecords?: number;
  /** Rows per page options */
  rowsperpageoptions?: number[];
  /** Show first/last buttons */
  showfirstlasticon?: boolean;
  /** Show page links */
  showpagelinks?: boolean;
  /** Template layout */
  template?: string;
}

/**
 * cl-virtual-list - Virtualized scrolling list
 * Supports self-scrolling, parent scrolling, or window scrolling
 */
export interface ClVirtualListProps {
  /** List items */
  items?: unknown[];
  /** Item height in pixels (default: 50) */
  itemheight?: number;
  /** Number of extra items to render above/below viewport (default: 10) */
  buffersize?: number;
  /** Render function for each item */
  renderitem?: (item: unknown, index: number) => HtmlTemplate;
  /** Function to get unique key for memoization */
  keyfn?: (item: unknown) => string | number;
  /** Container height (only for scrollContainer="self") */
  height?: string;
  /** Message when list is empty */
  emptymessage?: string;
  /** Show loading spinner */
  loading?: boolean;
  /** Enable selection */
  selectable?: boolean;
  /** Currently selected index */
  selectedindex?: number;
  /** Scroll mode: 'self' | 'parent' | 'window' | CSS selector */
  scrollcontainer?: 'self' | 'parent' | 'window' | string;
}

/**
 * cl-orderable-list - Drag-to-reorder list
 */
export interface ClOrderableListProps {
  /** List items */
  value?: unknown[];
  /** Label field for display */
  optionlabel?: string;
  /** Enable drag handle */
  draghandle?: boolean;
}

// =============================================================================
// Misc Components
// =============================================================================

/**
 * cl-spinner - Loading spinner
 */
export interface ClSpinnerProps {
  /** Spinner size */
  size?: 'small' | 'medium' | 'large';
  /** Fill available space */
  fill?: boolean;
}

/**
 * cl-progressbar - Progress indicator
 */
export interface ClProgressbarProps {
  /** Progress value (0-100) */
  value?: number;
  /** Indeterminate mode (animated) */
  mode?: 'determinate' | 'indeterminate';
  /** Show percentage label */
  showvalue?: boolean;
}

/**
 * cl-badge - Status badge/tag
 */
export interface ClBadgeProps {
  /** Badge value/text */
  value?: string | number;
  /** Severity/color */
  severity?: 'success' | 'info' | 'warning' | 'danger';
  /** Dot style (no value shown) */
  dot?: boolean;
  /** Badge size */
  size?: 'normal' | 'large' | 'xlarge';
}

/**
 * cl-alert - Alert message box
 */
export interface ClAlertProps {
  /** Alert severity */
  severity?: 'success' | 'info' | 'warning' | 'error';
  /** Show close button */
  closable?: boolean;
  /** Alert title */
  title?: string;
  /** Show icon */
  showicon?: boolean;
}

/**
 * cl-colorpicker - Color picker input
 */
export interface ClColorPickerProps {
  /** Selected color (hex) */
  value?: string;
  /** Disabled state */
  disabled?: boolean;
  /** Inline mode */
  inline?: boolean;
  /** Format */
  format?: 'hex' | 'rgb' | 'hsb';
  /** Field label */
  label?: string;
}

/**
 * cl-fileupload - File upload component
 */
export interface ClFileUploadProps {
  /** Upload mode */
  mode?: 'basic' | 'advanced';
  /** Accept file types */
  accept?: string;
  /** Maximum file size in bytes */
  maxfilesize?: number;
  /** Allow multiple files */
  multiple?: boolean;
  /** Upload URL */
  url?: string;
  /** Auto upload on select */
  auto?: boolean;
  /** Choose button label */
  chooselabel?: string;
  /** Disabled state */
  disabled?: boolean;
}

// =============================================================================
// Layout Components
// =============================================================================

/**
 * cl-shell - Application shell with sidebar and header
 */
export interface ClShellProps {
  /** Show sidebar */
  sidebar?: boolean;
  /** Sidebar collapsed state */
  collapsed?: boolean;
  /** Header height */
  headerheight?: string;
  /** Sidebar width */
  sidebarwidth?: string;
}

// =============================================================================
// Global Element Declarations
// =============================================================================

declare global {
  interface HTMLElementTagNameMap {
    // Button components
    'cl-button': HTMLElement & ClButtonProps;
    'cl-menu': HTMLElement & ClMenuProps;
    'cl-split-button': HTMLElement & ClSplitButtonProps;
    'cl-breadcrumb': HTMLElement & ClBreadcrumbProps;

    // Form components
    'cl-input-text': HTMLElement & ClInputTextProps;
    'cl-input-number': HTMLElement & ClInputNumberProps;
    'cl-input-password': HTMLElement & ClInputPasswordProps;
    'cl-input-search': HTMLElement & ClInputSearchProps;
    'cl-input-mask': HTMLElement & ClInputMaskProps;
    'cl-textarea': HTMLElement & ClTextareaProps;
    'cl-checkbox': HTMLElement & ClCheckboxProps;
    'cl-toggle': HTMLElement & ClToggleProps;
    'cl-radio-button': HTMLElement & ClRadioButtonProps;
    'cl-slider': HTMLElement & ClSliderProps;
    'cl-calendar': HTMLElement & ClCalendarProps;

    // Selection components
    'cl-dropdown': HTMLElement & ClDropdownProps;
    'cl-multiselect': HTMLElement & ClMultiselectProps;
    'cl-autocomplete': HTMLElement & ClAutocompleteProps;
    'cl-chips': HTMLElement & ClChipsProps;

    // Panel components
    'cl-accordion': HTMLElement & ClAccordionProps;
    'cl-card': HTMLElement & ClCardProps;
    'cl-tabview': HTMLElement & ClTabviewProps;
    'cl-fieldset': HTMLElement & ClFieldsetProps;
    'cl-splitter': HTMLElement & ClSplitterProps;
    'cl-stepper': HTMLElement & ClStepperProps;

    // Overlay components
    'cl-dialog': HTMLElement & ClDialogProps;
    'cl-sidebar': HTMLElement & ClSidebarProps;
    'cl-tooltip': HTMLElement & ClTooltipProps;
    'cl-toast': HTMLElement & ClToastProps;
    'cl-action-menu': HTMLElement & ClActionMenuProps;

    // Data components
    'cl-datatable': HTMLElement & ClDatatableProps;
    'cl-tree': HTMLElement & ClTreeProps;
    'cl-paginator': HTMLElement & ClPaginatorProps;
    'cl-virtual-list': HTMLElement & ClVirtualListProps;
    'cl-orderable-list': HTMLElement & ClOrderableListProps;

    // Misc components
    'cl-spinner': HTMLElement & ClSpinnerProps;
    'cl-progressbar': HTMLElement & ClProgressbarProps;
    'cl-badge': HTMLElement & ClBadgeProps;
    'cl-alert': HTMLElement & ClAlertProps;
    'cl-colorpicker': HTMLElement & ClColorPickerProps;
    'cl-fileupload': HTMLElement & ClFileUploadProps;

    // Layout components
    'cl-shell': HTMLElement & ClShellProps;
  }
}

export {};
