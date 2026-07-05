/**
 * VDX-Web Router Type Definitions
 *
 * Client-side routing with support for:
 * - Hash-based routing (default)
 * - HTML5 History API routing (with <base> tag)
 * - Lazy loading routes with dynamic imports
 * - Route guards and hooks
 * - URL parameters and query strings
 */

import type { Store } from './framework.js';

// =============================================================================
// Route Configuration
// =============================================================================

/**
 * Configuration for a single route
 */
export interface RouteConfig {
  /**
   * Component tag name to render for this route.
   * Must be a registered custom element.
   * Optional if `redirect` is specified.
   * @example 'home-page', 'user-profile'
   */
  component?: string;

  /**
   * Optional lazy load function using dynamic import.
   * Called before first navigation to this route.
   * @example () => import('./pages/home.js')
   */
  load?: () => Promise<unknown>;

  /**
   * Optional capability requirement for access control.
   * Enforced by the router via checkCapability (fails closed:
   * denied if no checkCapability is configured).
   * @example 'admin', 'authenticated'
   */
  require?: string;

  /**
   * Optional metadata for the route.
   * Available in route hooks and component.
   * @example { title: 'Home', sidebar: true }
   */
  meta?: Record<string, unknown>;

  /**
   * Optional nested routes.
   * Paths are prefixed with parent path.
   */
  routes?: Record<string, RouteConfig>;

  /**
   * Redirect to another path.
   * Supports parameter substitution with $1, $2, etc. for captured params,
   * or :paramName for named parameters.
   * @example '/new-path/', '/$1/', '/:id/'
   */
  redirect?: string;
}

/**
 * Route definitions map.
 * Keys are path patterns, values are route configurations.
 *
 * @example
 * {
 *   '/': { component: 'home-page' },
 *   '/users/:id/': { component: 'user-profile' },
 *   '/admin/': {
 *     component: 'admin-layout',
 *     require: 'admin',
 *     routes: {
 *       '/dashboard/': { component: 'admin-dashboard' }
 *     }
 *   }
 * }
 */
export type RouteDefinitions = Record<string, RouteConfig>;

// =============================================================================
// Route State
// =============================================================================

/**
 * URL parameters extracted from route pattern.
 * @example For route '/users/:id/' with URL '/users/123/', params = { id: '123' }
 */
export type RouteParams = Record<string, string>;

/**
 * Query string parameters.
 * @example For URL '?page=2&sort=name', query = { page: '2', sort: 'name' }
 */
export type QueryParams = Record<string, string>;

/**
 * Current route state (available via router.currentRoute store)
 */
export interface RouteState {
  /** Current path (without query string) */
  path: string;
  /** Query string parameters */
  query: QueryParams;
  /** URL parameters from route pattern */
  params: RouteParams;
  /** Current component tag name */
  component: string | null;
  /** Route metadata */
  meta: Record<string, unknown>;
}

// =============================================================================
// Route Hooks
// =============================================================================

/**
 * Context passed to navigation hooks
 */
export interface NavigationContext {
  /** Target path */
  path: string;
  /** Query parameters */
  query: QueryParams;
  /** URL parameters */
  params: RouteParams;
  /** Matched route configuration */
  route: RouteConfig;
  /** Route metadata */
  meta: Record<string, unknown>;
}

/**
 * Before-navigation hook function.
 * Return false to cancel navigation.
 *
 * @example
 * router.beforeEach(({ route }) => {
 *   if (route.require === 'admin' && !isAdmin()) {
 *     router.navigate('/login');
 *     return false;
 *   }
 * });
 */
export type BeforeHook = (context: NavigationContext) => boolean | void | Promise<boolean | void>;

/**
 * After-navigation hook function.
 *
 * @example
 * router.afterEach(({ path }) => {
 *   analytics.trackPageView(path);
 * });
 */
export type AfterHook = (context: NavigationContext) => void | Promise<void>;

// =============================================================================
// Router Class
// =============================================================================

/**
 * Context passed to capability checks and unauthorized handlers.
 */
export interface CapabilityContext {
  /** Path being navigated to */
  path: string;
  /** Parsed query parameters */
  query: Record<string, string>;
  /** Extracted route parameters */
  params: Record<string, string>;
  /** The matched route config */
  route: RouteConfig;
}

/**
 * Router construction options.
 */
export interface RouterOptions {
  /**
   * Called for routes with a `require` field; return true (or a promise
   * resolving to true) to allow navigation. Routes with `require` are
   * DENIED if no checkCapability is configured (fail closed).
   */
  checkCapability?: (required: string, context: CapabilityContext) => boolean | Promise<boolean>;
  /**
   * Called when a `require` check fails.
   * Defaults to rendering the /404 route.
   */
  onUnauthorized?: (context: CapabilityContext & { require: string }) => void;
}

/**
 * Router class for managing client-side navigation.
 *
 * @example
 * const router = new Router({
 *   '/': { component: 'home-page' },
 *   '/about/': { component: 'about-page' }
 * });
 *
 * router.setOutlet(document.querySelector('router-outlet'));
 */
export class Router {
  /**
   * Create a new router instance.
   *
   * @param routes - Route configuration map
   * @param options - Router options (capability enforcement hooks)
   */
  constructor(routes: RouteDefinitions, options?: RouterOptions);

  /**
   * Capability check for routes with `require` (may be assigned after
   * construction, but prefer passing via options so the initial route
   * is also checked).
   */
  checkCapability: ((required: string, context: CapabilityContext) => boolean | Promise<boolean>) | null;

  /** Handler invoked when a `require` check fails (default: render /404). */
  onUnauthorized: ((context: CapabilityContext & { require: string }) => void) | null;

  /**
   * Reactive store containing current route state.
   * Subscribe to be notified of route changes.
   *
   * @example
   * router.currentRoute.subscribe(({ path }) => {
   *   document.title = `My App - ${path}`;
   * });
   */
  currentRoute: Store<RouteState>;

  /**
   * Whether using HTML5 History API (true) or hash routing (false).
   * Determined by presence of <base href="..."> tag.
   */
  readonly useHTML5: boolean;

  /**
   * Base URL for routing.
   * For HTML5 mode, this is the base tag href.
   * For hash mode, this includes the # character.
   */
  readonly base: string;

  /**
   * Set the outlet element where routed components will be rendered.
   *
   * @param element - Router outlet element (typically <router-outlet>)
   *
   * @example
   * router.setOutlet(document.querySelector('router-outlet'));
   */
  setOutlet(element: HTMLElement): void;

  /**
   * Navigate to a path (adds history entry).
   *
   * @param path - Path to navigate to
   * @param query - Optional query parameters
   *
   * @example
   * router.navigate('/about');
   * router.navigate('/search', { q: 'test', page: '2' });
   */
  navigate(path: string, query?: QueryParams): void;

  /**
   * Replace current route without adding history entry.
   *
   * @param path - Path to navigate to
   * @param query - Optional query parameters
   *
   * @example
   * router.replace('/login'); // Won't show in back button history
   */
  replace(path: string, query?: QueryParams): void;

  /**
   * Go back in browser history.
   */
  back(): void;

  /**
   * Go forward in browser history.
   */
  forward(): void;

  /**
   * Register a before-navigation hook.
   * Return false to cancel navigation.
   *
   * @param fn - Hook function
   *
   * @example
   * router.beforeEach(async ({ route }) => {
   *   if (route.require && !await checkAuth(route.require)) {
   *     router.navigate('/login');
   *     return false;
   *   }
   * });
   */
  beforeEach(fn: BeforeHook): void;

  /**
   * Register an after-navigation hook.
   *
   * @param fn - Hook function
   *
   * @example
   * router.afterEach(({ path, meta }) => {
   *   document.title = meta.title || 'My App';
   * });
   */
  afterEach(fn: AfterHook): void;

  /**
   * Generate URL for a route (respects routing mode).
   *
   * @param path - Route path
   * @param query - Optional query parameters
   * @returns Complete URL (hash or HTML5 based on mode)
   *
   * @example
   * router.url('/about'); // '#/about' or '/app/about'
   * router.url('/search', { q: 'test' }); // '#/search?q=test'
   */
  url(path: string, query?: QueryParams): string;

  /**
   * Merge additional routes into the routing table. Same-path definitions
   * are replaced (keeping their pattern-matching position); new paths are
   * appended. The current location is re-evaluated.
   */
  addRoutes(routes: RouteDefinitions): void;

  /**
   * Clean up router resources and release the singleton
   * (allows enableRouting() to create a fresh router again).
   */
  destroy(): void;
}

// =============================================================================
// Functions
// =============================================================================

/**
 * Get the singleton router instance.
 *
 * @returns The router instance, or null if not yet created
 *
 * @example
 * import { getRouter } from './lib/router.js';
 *
 * const router = getRouter();
 * router?.navigate('/home');
 */
export function getRouter(): Router | null;

/**
 * Enable routing for a specific outlet element.
 * First call creates the singleton router. Subsequent calls warn and merge:
 * new routes fold into the existing table (same-path definitions replaced),
 * provided options are applied, and the outlet is reattached. Call
 * getRouter().destroy() first for a fresh router.
 *
 * @param outlet - Router outlet element
 * @param routes - Route configuration
 * @param options - Router options (checkCapability, onUnauthorized)
 * @returns The singleton router instance
 *
 * @example
 * import { enableRouting } from './lib/router.js';
 *
 * const router = enableRouting(
 *   document.querySelector('router-outlet'),
 *   {
 *     '/': {
 *       component: 'home-page',
 *       load: () => import('./pages/home.js')
 *     },
 *     '/users/:id/': {
 *       component: 'user-profile'
 *     }
 *   }
 * );
 */
export function enableRouting(
  outlet: HTMLElement,
  routes: RouteDefinitions,
  options?: RouterOptions
): Router;

// =============================================================================
// Components (registered automatically)
// =============================================================================

/**
 * Router link component for navigation.
 * Generates appropriate href based on routing mode.
 *
 * @example
 * <router-link to="/about">About Us</router-link>
 * <router-link to="/users/123">User Profile</router-link>
 */
declare global {
  interface HTMLElementTagNameMap {
    'router-link': HTMLElement & {
      /** Target path */
      to: string;
    };
    'router-outlet': HTMLElement;
  }
}
