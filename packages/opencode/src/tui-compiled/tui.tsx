import { memo as _$memo } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createTextNode as _$createTextNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createComponent as _$createComponent } from "opentui:runtime-module:%40opentui%2Fsolid";
import { effect as _$effect } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insertNode as _$insertNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insert as _$insert } from "opentui:runtime-module:%40opentui%2Fsolid";
import { setProp as _$setProp } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createElement as _$createElement } from "opentui:runtime-module:%40opentui%2Fsolid";
/** @jsxImportSource @opentui/solid */

/**
 * Read-only OpenTUI sidebar for the Antigravity plugin.
 *
 * Mirrors the fleet sibling layout (see `anthropic-auth-live` /
 * `openai-auth-live` `packages/opencode/src/tui.tsx`): a single bordered
 * column with a labelled header badge, a Quota section that lists one
 * `AccountBlock` per visible account, a Routing section that surfaces the
 * most recent session route, and a Health section that only appears when
 * something is wrong. The Antigravity data model is richer than the
 * Claude/Codex one (per-account Gemini + Non-Gemini quota pools, a health
 * score, and per-session routing decisions), so the fleet components are
 * adapted rather than copied verbatim:
 *
 * - `QuotaRow` reads `remainingPercent + resetAt` from the Antigravity
 *   `SidebarQuotaEntry` shape and colors via `quotaTone` (remaining
 *   threshold) instead of `usageTone` (used threshold).
 * - `AccountBlock` derives its status word (`active` / `idle` /
 *   `cooling` / `off` / `blocked`) from the Antigravity account state and
 *   surfaces health as a muted secondary line rather than a top-level
 *   bar — fleet parity for "Quota first, health second".
 * - `Routing` resolves to a single `Route` `StatRow` carrying the most
 *   recent `activeRouting` entry, since Antigravity does not maintain a
 *   per-session sidebar state alongside the slot-rendered tree.
 *
 * Hard rules for this file:
 *
 * - NO direct writes to the host terminal anywhere in the render path.
 *   The host terminal is the frame buffer; one stray byte corrupts every
 *   subsequent cell. Errors flow through `createTuiFileLogger()`.
 * - NO imports from `./plugin/storage`, `./plugin/accounts`, OAuth code,
 *   or anything that touches tokens.
 * - The component uses Solid's `onCleanup` to release the polling timer
 *   on unmount so a route change can never leak an interval.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSlot } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "opentui:runtime-module:solid-js";
import { createRpcClient } from "./rpc/rpc-client";
import { getRpcDir } from "./rpc/rpc-dir";
import { readSidebarState } from "./sidebar-state";
import { openCommandDialog } from "./tui/command-dialogs";
import { createTuiFileLogger } from "./tui/file-logger";
import { computeEffectiveOrder, DEFAULT_PREFS, DEFAULT_SLOT_ORDER, PLUGIN_KEY, queueTuiPreferenceUpdate, readTuiPreferencesFile, resolveAntigravityAuthPrefs, watchTuiPreferences } from "./tui-preferences";
const ID = 'cortexkit.antigravity-auth';
const POLL_INTERVAL_MS = 2000;
const RPC_POLL_MS = 500;
const SINGLE_BORDER = {
  type: 'single'
};

// Read package metadata from either the raw src/ entry or its generated
// src/tui-compiled/ counterpart. Avoid a JSON import because package.json sits
// outside the declaration build's rootDir.
const PLUGIN_VERSION = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const packageFile of [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json')]) {
    try {
      const raw = readFileSync(packageFile, 'utf8');
      const version = JSON.parse(raw).version;
      if (version) return version;
    } catch {
      // Try the path for the other TUI entry layout.
    }
  }
  return '';
})();
// Module-scoped state — TEST ISOLATION CONTRACT:
//
// `rpcPollStarted`, notification cursor/deduplication state, `rpcInFlight`, and the lazy
// `sidebarController` below persist across tests via the cached ES
// module Bun loads once per `--isolate` file. Tests must NOT assert
// fresh-process behaviour from these variables — by the time the first
// `startRpcNotificationPolling` runs, all four carry stale values from
// prior tests in the same file. Test isolation comes from:
//   1. fresh-importing `tui.tsx` via a cache-busted dynamic `import`
//      so the module re-evaluates with fresh module-scoped bindings, and
//   2. constructing a fresh `SidebarController` via
//      `createSidebarController(prefs)` and passing it through
//      `SidebarPanel.props.controller` — never through
//      `getSidebarController()`, which lazily seeds the module-scoped
//      singleton.
let rpcPollStarted = false;
const notificationCursorBySession = new Map();
const dispatchedNotificationIds = new Set();
let rpcInFlight = false;
const GLOBAL_NOTIFICATION_CURSOR = '__global__';
const MAX_NOTIFICATION_CURSORS = 256;
const QUOTA_LABELS = {
  gemini: 'Gm',
  'non-gemini': 'NG'
};
const QUOTA_ORDER = ['gemini', 'non-gemini'];
const WINDOW_GUTTER = {
  weekly: '7d',
  '5h': '5h'
};

// --- Theme tokens ----------------------------------------------------------
//
// The sidebar pulls its colors from the live host theme (`api.theme.current`
// — a Solid-friendly getter that re-emits when the user switches theme).
// Every render path resolves through `toneColor(theme, tone)` with a
// sibling-style `??` fallback chain, so the sidebar always tracks the
// active theme and never hardcodes an ANSI literal.
//
// `FALLBACK_THEME` is the safety net for tests and any future host that
// does not implement the theme surface. The fields the sidebar actually
// uses are populated; the rest of the TuiThemeCurrent fields are left
// undefined and the `??` chain in `toneColor` falls through cleanly.

const FALLBACK_THEME = {
  primary: '#3b82f6',
  secondary: '#a855f7',
  accent: '#7c3aed',
  error: '#ef4444',
  warning: '#eab308',
  success: '#22c55e',
  info: '#0ea5e9',
  text: '#e5e7eb',
  textMuted: '#6b7280',
  selectedListItemText: '#ffffff',
  background: '#0b0d12',
  backgroundPanel: '#11131a',
  backgroundElement: '#1a1d27',
  backgroundMenu: '#1a1d27',
  border: '#2a2d3a',
  borderActive: '#7c3aed',
  borderSubtle: '#2a2d3a',
  diffAdded: '#22c55e',
  diffRemoved: '#ef4444',
  diffContext: '#6b7280',
  diffHunkHeader: '#7c3aed',
  diffHighlightAdded: '#166534',
  diffHighlightRemoved: '#7f1d1d',
  diffAddedBg: '#0a1f12',
  diffRemovedBg: '#1f0a0a',
  diffContextBg: '#0b0d12',
  diffLineNumber: '#4b5563',
  diffAddedLineNumberBg: '#0a1f12',
  diffRemovedLineNumberBg: '#1f0a0a',
  markdownText: '#e5e7eb',
  markdownHeading: '#7c3aed',
  markdownLink: '#3b82f6',
  markdownLinkText: '#60a5fa',
  markdownCode: '#22c55e',
  markdownBlockQuote: '#6b7280',
  markdownEmph: '#eab308',
  markdownStrong: '#7c3aed',
  markdownHorizontalRule: '#2a2d3a',
  markdownListItem: '#7c3aed',
  markdownListEnumeration: '#a855f7',
  markdownImage: '#3b82f6',
  markdownImageText: '#60a5fa',
  markdownCodeBlock: '#11131a',
  syntaxComment: '#6b7280',
  syntaxKeyword: '#a855f7',
  syntaxFunction: '#3b82f6',
  syntaxVariable: '#e5e7eb',
  syntaxString: '#22c55e',
  syntaxNumber: '#eab308',
  syntaxType: '#7c3aed',
  syntaxOperator: '#e5e7eb',
  syntaxPunctuation: '#6b7280',
  thinkingOpacity: 0.6
};

// Mirror the fleet siblings' tone chain: every tone falls through to a
// sibling token, so a sparse custom theme still renders readably.
function toneColor(theme, tone) {
  switch (tone) {
    case 'ok':
      return theme.success ?? theme.accent;
    case 'warn':
      return theme.warning ?? theme.accent;
    case 'err':
      return theme.error ?? theme.accent;
    case 'muted':
      return theme.textMuted ?? theme.text;
    case 'accent':
      return theme.accent ?? theme.text;
    default:
      return theme.text;
  }
}
function quotaTone(usedPct, appearance) {
  if (usedPct < appearance.warnThreshold) return 'ok';
  if (usedPct < appearance.errorThreshold) return 'warn';
  return 'err';
}
function quotaBarSegments(usedPct, appearance) {
  const width = appearance.barWidth;
  const usedCells = Math.max(0, Math.min(Math.round(usedPct / 100 * width), width));
  const tone = quotaTone(usedPct, appearance);
  return [{
    text: appearance.barFilledChar.repeat(usedCells),
    tone
  }, {
    text: appearance.barEmptyChar.repeat(width - usedCells),
    tone
  }].filter(segment => segment.text.length > 0);
}
const EMPTY_STATE = {
  version: 1,
  checkedAt: 0,
  accounts: [],
  activeRouting: {},
  routingAuthoritative: false
};
function resolveLogger(logger) {
  if (logger) return logger;
  try {
    return createTuiFileLogger();
  } catch {
    // Fall back to a stub that drops everything — the sidebar must still
    // render even if file logging cannot be initialized.
    return noopLogger();
  }
}
function noopLogger() {
  const drop = () => undefined;
  return {
    debug: drop,
    info: drop,
    warn: drop,
    error: drop,
    getLogPath: () => undefined
  };
}

// Module-scoped controller singleton, initialized at plugin startup. The
// watcher is intentionally never disposed — collapse/prefs state survives
// sidebar remounts (route changes) for the lifetime of the TUI process,
// mirroring the fleet siblings.
//
// TEST ISOLATION: this singleton, like `rpcPollStarted` above, persists
// across tests via the cached ES module. Tests construct a controller
// via `createSidebarController(prefs)` and pass it through
// `SidebarPanel.props.controller` — they MUST NOT rely on this lazy
// singleton for isolation. See the block above for the full contract.
let sidebarController = null;

// The TUI may unmount and remount sidebar_content when the user switches
// views. A remount re-runs the component body, so any signal created inside
// the component would reset to its seed. The controller lives in the plugin
// closure (process lifetime) and owns the durable prefs/collapse signals
// plus the single shared watcher subscription, so collapse and live pref
// reloads survive the remount.
//
// Exported so tests can construct a controller with a controlled initial
// prefs snapshot without touching the module-scoped singleton.
export function createSidebarController(initialPrefs) {
  const [prefs, setPrefs] = createSignal(initialPrefs);
  const seedCollapsed = initialPrefs.rememberCollapsed && initialPrefs.collapsed != null ? initialPrefs.collapsed : initialPrefs.startCollapsed;
  const [collapsed, setCollapsed] = createSignal(seedCollapsed);
  let lastPersistedCollapsed = initialPrefs.collapsed;
  let lastApplied = JSON.stringify(initialPrefs);

  // The watcher lives for the plugin/process lifetime — it is intentionally
  // never disposed. Collapse guard mirrors the race-fix in toggleCollapsed:
  // lastPersistedCollapsed is advanced only once our own write lands, so
  // watcher echoes of the previous persisted value are rejected by the
  // `!==` check and cannot revert a user click.
  watchTuiPreferences(() => {
    void (async () => {
      const next = resolveAntigravityAuthPrefs(await readTuiPreferencesFile());
      const serialized = JSON.stringify(next);
      if (serialized === lastApplied) return;
      lastApplied = serialized;
      setPrefs(next);
      if (next.rememberCollapsed && next.collapsed != null && next.collapsed !== lastPersistedCollapsed) {
        lastPersistedCollapsed = next.collapsed;
        setCollapsed(next.collapsed);
      }
    })();
  });
  function toggleCollapsed() {
    const next = !collapsed();
    setCollapsed(next);
    if (prefs().rememberCollapsed) {
      void queueTuiPreferenceUpdate(PLUGIN_KEY, ['collapsed'], next).then(() => {
        lastPersistedCollapsed = next;
      });
    }
  }
  return {
    prefs,
    collapsed,
    toggleCollapsed
  };
}

// Lazy module-scoped accessor used by the plugin entry. Tests should NOT go
// through this — they construct their own controller via createSidebarController
// and pass it via SidebarPanelProps.controller.
function getSidebarController() {
  if (!sidebarController) {
    sidebarController = createSidebarController(DEFAULT_PREFS);
  }
  return sidebarController;
}

// --- Shared helpers (fleet shape, antigravity data) ------------------------

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Render a "reset in Nm/Nh/NdNh" string from an epoch-ms reset time.
// Empty string when no resetAt is cached. The fleet's `formatResetIn`
// reads ISO strings; Antigravity persists resetAt as a numeric epoch, so
// the wrapper adapts to that without changing the shape of the output.
function formatResetIn(resetAt, now) {
  if (!resetAt) return '';
  const ms = resetAt - now();
  if (ms <= 0) return 'now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) {
    const rm = mins % 60;
    return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`;
  }
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return rh > 0 ? `${days}d${rh}h` : `${days}d`;
}
function formatError(value) {
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// --- Fleet components (adapted to antigravity data) ------------------------

// Section header — fleet pattern: bold title, themed text color, top margin
// for vertical breathing room between sections.
function SectionHeader(props) {
  return (() => {
    var _el$ = _$createElement("box"),
      _el$2 = _$createElement("text"),
      _el$3 = _$createElement("b");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "width", '100%');
    _$setProp(_el$, "marginTop", 1);
    _$insertNode(_el$2, _el$3);
    _$insert(_el$3, () => props.title);
    _$effect(_$p => _$setProp(_el$2, "fg", toneColor(props.theme(), 'text'), _$p));
    return _el$;
  })();
}

// Fleet StatRow: muted label left, value (optionally tone-tinted, bold)
// right. Mirrors the layout the Claude/Codex sidebars use for routing
// rows, plan rows, and "resets N" rows.
function StatRow(props) {
  return (() => {
    var _el$4 = _$createElement("box"),
      _el$5 = _$createElement("text"),
      _el$6 = _$createElement("text"),
      _el$7 = _$createElement("b");
    _$insertNode(_el$4, _el$5);
    _$insertNode(_el$4, _el$6);
    _$setProp(_el$4, "width", '100%');
    _$setProp(_el$4, "flexDirection", 'row');
    _$setProp(_el$4, "justifyContent", 'space-between');
    _$insert(_el$5, () => props.label);
    _$insertNode(_el$6, _el$7);
    _$insert(_el$7, () => props.value);
    _$effect(_p$ => {
      var _v$ = props.theme().textMuted,
        _v$2 = toneColor(props.theme(), props.tone ?? 'text');
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$5, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$6, "fg", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$4;
  })();
}

// Fleet CollapsedRow: muted label left, caller-supplied value right. Used
// for the collapsed sidebar view; the Antigravity adapter renders one
// CollapsedRow per visible account (Claude's sibling collapses to a
// single primary-quota line, but Antigravity's multi-quota model fits a
// per-account row better when the sidebar is collapsed).
function CollapsedRow(props) {
  return (() => {
    var _el$8 = _$createElement("box"),
      _el$9 = _$createElement("text");
    _$insertNode(_el$8, _el$9);
    _$setProp(_el$8, "width", '100%');
    _$setProp(_el$8, "flexDirection", 'row');
    _$setProp(_el$8, "justifyContent", 'space-between');
    _$insert(_el$9, () => props.label);
    _$insert(_el$8, () => props.children, null);
    _$effect(_$p => _$setProp(_el$9, "fg", props.theme().textMuted, _$p));
    return _el$8;
  })();
}

// Fleet QuotaRow, adapted to Antigravity's `remainingPercent + resetAt`
// shape. The left group stacks label + bar + pct in fixed columns so
// bars line up across rows; the right group carries the reset countdown
// when the plugin has cached a reset time. Tone is read off the
// remaining percentage via the antigravity threshold rules — the fleet's
// `usageTone` would invert the polarity (healthy = high remaining vs
// healthy = low used), so we keep the antigravity-local `quotaTone`.
function QuotaRow(props) {
  const used = () => props.entry ? 100 - clamp(props.entry.remainingPercent, 0, 100) : null;
  const reset = () => props.entry ? formatResetIn(props.entry.resetAt, props.now) : '';
  return _$createComponent(Show, {
    get when() {
      return used() != null;
    },
    get fallback() {
      return (() => {
        var _el$14 = _$createElement("box"),
          _el$15 = _$createElement("text"),
          _el$16 = _$createElement("text");
        _$insertNode(_el$14, _el$15);
        _$insertNode(_el$14, _el$16);
        _$setProp(_el$14, "width", '100%');
        _$setProp(_el$14, "flexDirection", 'row');
        _$setProp(_el$14, "justifyContent", 'space-between');
        _$insert(_el$15, () => props.label.padEnd(3));
        _$insertNode(_el$16, _$createTextNode(`—`));
        _$effect(_p$ => {
          var _v$6 = props.theme().textMuted,
            _v$7 = props.theme().textMuted;
          _v$6 !== _p$.e && (_p$.e = _$setProp(_el$15, "fg", _v$6, _p$.e));
          _v$7 !== _p$.t && (_p$.t = _$setProp(_el$16, "fg", _v$7, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$14;
      })();
    },
    get children() {
      var _el$0 = _$createElement("box"),
        _el$1 = _$createElement("box"),
        _el$10 = _$createElement("text"),
        _el$11 = _$createElement("box"),
        _el$12 = _$createElement("text");
      _$insertNode(_el$0, _el$1);
      _$setProp(_el$0, "width", '100%');
      _$setProp(_el$0, "flexDirection", 'row');
      _$setProp(_el$0, "justifyContent", 'space-between');
      _$insertNode(_el$1, _el$10);
      _$insertNode(_el$1, _el$11);
      _$insertNode(_el$1, _el$12);
      _$setProp(_el$1, "flexDirection", 'row');
      _$setProp(_el$10, "width", 3);
      _$setProp(_el$10, "flexShrink", 0);
      _$insert(_el$10, () => props.label);
      _$setProp(_el$11, "flexShrink", 0);
      _$setProp(_el$11, "flexDirection", 'row');
      _$insert(_el$11, _$createComponent(For, {
        get each() {
          return quotaBarSegments(used() ?? 0, props.appearance);
        },
        children: segment => (() => {
          var _el$18 = _$createElement("text");
          _$insert(_el$18, () => segment.text);
          _$effect(_$p => _$setProp(_el$18, "fg", toneColor(props.theme(), segment.tone), _$p));
          return _el$18;
        })()
      }));
      _$insert(_el$12, () => ` ${String(Math.round(used() ?? 0)).padStart(3)}%`);
      _$insert(_el$0, _$createComponent(Show, {
        get when() {
          return reset();
        },
        get children() {
          var _el$13 = _$createElement("text");
          _$insert(_el$13, reset);
          _$effect(_$p => _$setProp(_el$13, "fg", props.theme().textMuted, _$p));
          return _el$13;
        }
      }), null);
      _$effect(_p$ => {
        var _v$3 = props.theme().textMuted,
          _v$4 = props.appearance.barWidth,
          _v$5 = toneColor(props.theme(), quotaTone(used() ?? 0, props.appearance));
        _v$3 !== _p$.e && (_p$.e = _$setProp(_el$10, "fg", _v$3, _p$.e));
        _v$4 !== _p$.t && (_p$.t = _$setProp(_el$11, "width", _v$4, _p$.t));
        _v$5 !== _p$.a && (_p$.a = _$setProp(_el$12, "fg", _v$5, _p$.a));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined
      });
      return _el$0;
    }
  });
}

// Fleet AccountBlock, adapted to Antigravity's per-account data. Header
// row is account label (left) + status word (right). The body renders one
// QuotaRow per present quota group in the fleet's stable order, then a
// muted secondary line with the account's health score and, when
// relevant, a cooldown countdown. Status word priorities (first match
// wins):
//   - `off` when the account is disabled
//   - `cooling` when cooldownUntil is still in the future
//   - `active` when current === true
//   - `idle` for the fallback (current === false) case
function AccountBlock(props) {
  const active = () => props.active ?? props.account.current;
  const statusWord = () => {
    if (!props.account.enabled) return 'off';
    const cd = props.account.cooldownUntil;
    if (typeof cd === 'number' && cd > props.now()) return 'cooling';
    return active() ? 'active' : 'idle';
  };
  const statusTone = () => {
    if (!props.account.enabled) return 'muted';
    const cd = props.account.cooldownUntil;
    if (typeof cd === 'number' && cd > props.now()) return 'warn';
    return active() ? 'ok' : 'muted';
  };
  const cooldownMs = () => {
    const cd = props.account.cooldownUntil;
    if (typeof cd !== 'number') return 0;
    return Math.max(0, cd - props.now());
  };
  const healthText = () => {
    const base = `health ${Math.round(clamp(props.account.health, 0, 100))}`;
    return cooldownMs() > 0 ? `${base} · cooling ${formatWait(cooldownMs())}` : base;
  };
  return (() => {
    var _el$19 = _$createElement("box"),
      _el$20 = _$createElement("box"),
      _el$21 = _$createElement("text"),
      _el$22 = _$createElement("b"),
      _el$23 = _$createElement("text"),
      _el$24 = _$createElement("b"),
      _el$25 = _$createElement("box"),
      _el$26 = _$createElement("text");
    _$insertNode(_el$19, _el$20);
    _$insertNode(_el$19, _el$25);
    _$setProp(_el$19, "width", '100%');
    _$setProp(_el$19, "flexDirection", 'column');
    _$insertNode(_el$20, _el$21);
    _$insertNode(_el$20, _el$23);
    _$setProp(_el$20, "width", '100%');
    _$setProp(_el$20, "flexDirection", 'row');
    _$setProp(_el$20, "justifyContent", 'space-between');
    _$insertNode(_el$21, _el$22);
    _$insert(_el$22, () => props.account.label);
    _$insertNode(_el$23, _el$24);
    _$insert(_el$24, statusWord);
    _$insert(_el$19, _$createComponent(For, {
      each: QUOTA_ORDER,
      children: key => {
        const poolEntry = props.account.quota[key];
        const windows = poolEntry?.windows;
        // Legacy: no windows array — render a single row with the pool label.
        const hasWindows = windows && windows.length > 0;
        if (!hasWindows) {
          return _$createComponent(QuotaRow, {
            get theme() {
              return props.theme;
            },
            get appearance() {
              return props.appearance;
            },
            get label() {
              return QUOTA_LABELS[key];
            },
            entry: poolEntry,
            get now() {
              return props.now;
            }
          });
        }
        return _$memo(() => windows.map((w, wi) => _$createComponent(QuotaRow, {
          get theme() {
            return props.theme;
          },
          get appearance() {
            return props.appearance;
          },
          get label() {
            return wi === 0 ? `${QUOTA_LABELS[key]} ${WINDOW_GUTTER[w.window] ?? w.window}` : `   ${WINDOW_GUTTER[w.window] ?? w.window}`;
          },
          get entry() {
            return {
              remainingPercent: w.remainingPercent,
              resetAt: w.resetAt
            };
          },
          get now() {
            return props.now;
          }
        })));
      }
    }), _el$25);
    _$insertNode(_el$25, _el$26);
    _$setProp(_el$25, "width", '100%');
    _$setProp(_el$25, "flexDirection", 'row');
    _$insert(_el$26, () => `   ${healthText()}`);
    _$effect(_p$ => {
      var _v$8 = props.marginTop ?? 0,
        _v$9 = props.theme().text,
        _v$0 = toneColor(props.theme(), statusTone()),
        _v$1 = props.theme().textMuted;
      _v$8 !== _p$.e && (_p$.e = _$setProp(_el$19, "marginTop", _v$8, _p$.e));
      _v$9 !== _p$.t && (_p$.t = _$setProp(_el$21, "fg", _v$9, _p$.t));
      _v$0 !== _p$.a && (_p$.a = _$setProp(_el$23, "fg", _v$0, _p$.a));
      _v$1 !== _p$.o && (_p$.o = _$setProp(_el$26, "fg", _v$1, _p$.o));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined
    });
    return _el$19;
  })();
}
function formatWait(ms) {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
}
export function resolveQuotaDialogActiveId(state, sessionId) {
  return (sessionId ? state.activeRouting[sessionId]?.accountId : undefined) ?? state.accounts.find(account => account.current)?.id;
}
export function QuotaDialogContent(props) {
  const prefs = props.controller.prefs;
  const [state, setState] = createSignal(EMPTY_STATE);
  const refresh = () => {
    setState(readSidebarState());
  };
  createEffect(() => {
    const timer = setInterval(refresh, prefs().pollMs);
    onCleanup(() => clearInterval(timer));
  });
  setTimeout(refresh, 0);
  const theme = () => props.api.theme.current;
  const visibleAccounts = () => {
    if (prefs().sections.fallbackAccounts) return state().accounts;
    return state().accounts.filter(account => account.current);
  };
  const activeId = () => resolveQuotaDialogActiveId(state(), props.sessionId);
  return (() => {
    var _el$27 = _$createElement("box"),
      _el$28 = _$createElement("box"),
      _el$29 = _$createElement("box"),
      _el$30 = _$createElement("text"),
      _el$31 = _$createElement("b");
    _$insertNode(_el$27, _el$28);
    _$setProp(_el$27, "flexDirection", 'column');
    _$setProp(_el$27, "padding", 2);
    _$setProp(_el$27, "width", '100%');
    _$setProp(_el$27, "alignItems", 'center');
    _$insertNode(_el$28, _el$29);
    _$setProp(_el$28, "flexDirection", 'column');
    _$setProp(_el$28, "width", 58);
    _$insertNode(_el$29, _el$30);
    _$setProp(_el$29, "width", '100%');
    _$setProp(_el$29, "justifyContent", 'center');
    _$setProp(_el$29, "marginBottom", 1);
    _$insertNode(_el$30, _el$31);
    _$insertNode(_el$31, _$createTextNode(`Antigravity Quota`));
    _$insert(_el$28, _$createComponent(For, {
      get each() {
        return visibleAccounts();
      },
      children: (account, index) => _$createComponent(AccountBlock, {
        theme: theme,
        get appearance() {
          return prefs().appearance;
        },
        account: account,
        get active() {
          return activeId() === account.id;
        },
        now: () => Date.now(),
        get marginTop() {
          return index() === 0 ? 0 : 1;
        }
      })
    }), null);
    _$effect(_$p => _$setProp(_el$30, "fg", theme().text, _$p));
    return _el$27;
  })();
}

// --- SidebarPanel ----------------------------------------------------------

export function SidebarPanel(props) {
  const logger = resolveLogger(props.logger);
  const now = props.now ?? (() => Date.now());
  const pollMs = props.pollIntervalMs ?? POLL_INTERVAL_MS;
  const controller = props.controller ?? getSidebarController();
  const collapsed = controller.collapsed;
  const prefs = controller.prefs;
  // Live host theme — falls back to a sensible dark palette when the host
  // does not expose one. Solid tracks `theme()` so a theme switch re-renders
  // every styled span/border without a manual subscription.
  const theme = () => props.theme?.() ?? FALLBACK_THEME;
  const [state, setState] = createSignal({
    loaded: EMPTY_STATE,
    lastReadAt: 0,
    lastError: null
  });
  const refresh = () => {
    try {
      const loaded = readSidebarState(props.stateFile);
      setState({
        loaded,
        lastReadAt: now(),
        lastError: null
      });
    } catch (error) {
      logger.warn('sidebar-poll-failed', {
        error: formatError(error)
      });
      setState(prev => ({
        ...prev,
        lastReadAt: now(),
        lastError: formatError(error)
      }));
    }
  };
  onMount(() => {
    refresh();
    const interval = setInterval(refresh, pollMs);
    onCleanup(() => clearInterval(interval));
  });
  const hasData = () => state().loaded.accounts.length > 0;
  const backoffActive = () => {
    const until = state().loaded.quotaBackoffUntil;
    return typeof until === 'number' && until > now();
  };
  const lastError = () => state().lastError ?? state().loaded.lastError;
  const degraded = () => backoffActive() || !!lastError();
  // Honors sections.fallbackAccounts. Both the expanded (AccountBlock list)
  // and the collapsed (CollapsedRow list) paths use the same filter so the
  // user sees the same account set in either mode.
  const visibleAccounts = () => {
    const showFallback = prefs().sections.fallbackAccounts;
    if (showFallback) return state().loaded.accounts;
    return state().loaded.accounts.filter(account => account.current);
  };
  const currentRoute = () => {
    const routes = state().loaded.activeRouting;
    const entry = props.sessionId ? routes[props.sessionId] : Object.values(routes).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!entry) return null;
    return {
      strategy: entry.strategy,
      family: entry.modelFamily,
      style: entry.headerStyle
    };
  };

  // Header badge: ▼/▶ {label}. The fleet shows the version string on the
  // right when no degraded state is present; the antigravity adapter keeps
  // that right-alignment and surfaces `degraded` as a "LIMITED" badge
  // instead of the "1/1 ready" count the previous revision rendered.
  const headerLabel = () => {
    const name = prefs().header.label;
    return !hasData() ? name : collapsed() ? `\u25b6 ${name}` : `\u25bc ${name}`;
  };
  return (() => {
    var _el$33 = _$createElement("box"),
      _el$34 = _$createElement("box"),
      _el$35 = _$createElement("box"),
      _el$36 = _$createElement("text"),
      _el$37 = _$createElement("b");
    _$insertNode(_el$33, _el$34);
    _$setProp(_el$33, "width", '100%');
    _$setProp(_el$33, "flexDirection", 'column');
    _$setProp(_el$33, "border", SINGLE_BORDER);
    _$setProp(_el$33, "paddingTop", 1);
    _$setProp(_el$33, "paddingBottom", 1);
    _$setProp(_el$33, "paddingLeft", 1);
    _$setProp(_el$33, "paddingRight", 1);
    _$insertNode(_el$34, _el$35);
    _$setProp(_el$34, "width", '100%');
    _$setProp(_el$34, "flexDirection", 'row');
    _$setProp(_el$34, "justifyContent", 'space-between');
    _$setProp(_el$34, "alignItems", 'center');
    _$setProp(_el$34, "onMouseDown", () => {
      // Mirror the fleet guard: only toggle when there is data to expand
      // into. Without this a click on the empty-awaiting header would just
      // toggle the affordance for nothing.
      if (hasData()) controller.toggleCollapsed();
    });
    _$insertNode(_el$35, _el$36);
    _$setProp(_el$35, "paddingLeft", 1);
    _$setProp(_el$35, "paddingRight", 1);
    _$insertNode(_el$36, _el$37);
    _$insert(_el$37, headerLabel);
    _$insert(_el$34, _$createComponent(Show, {
      get when() {
        return degraded();
      },
      get fallback() {
        return _$createComponent(Show, {
          get when() {
            return prefs().header.showVersion && PLUGIN_VERSION !== '';
          },
          get children() {
            var _el$42 = _$createElement("text");
            _$insert(_el$42, `v${PLUGIN_VERSION}`);
            _$effect(_$p => _$setProp(_el$42, "fg", theme().textMuted, _$p));
            return _el$42;
          }
        });
      },
      get children() {
        var _el$38 = _$createElement("box"),
          _el$39 = _$createElement("text"),
          _el$40 = _$createElement("b");
        _$insertNode(_el$38, _el$39);
        _$setProp(_el$38, "paddingLeft", 1);
        _$setProp(_el$38, "paddingRight", 1);
        _$insertNode(_el$39, _el$40);
        _$insertNode(_el$40, _$createTextNode(`LIMITED`));
        _$effect(_p$ => {
          var _v$10 = theme().warning,
            _v$11 = theme().background;
          _v$10 !== _p$.e && (_p$.e = _$setProp(_el$38, "backgroundColor", _v$10, _p$.e));
          _v$11 !== _p$.t && (_p$.t = _$setProp(_el$39, "fg", _v$11, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$38;
      }
    }), null);
    _$insert(_el$33, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!collapsed())() && hasData();
      },
      get children() {
        return (() => {
          const account = () => visibleAccounts().find(entry => entry.current) ?? visibleAccounts()[0];
          const used = () => {
            const q = account()?.quota;
            const entry = q?.gemini ?? q?.['non-gemini'];
            return entry ? 100 - clamp(entry.remainingPercent, 0, 100) : null;
          };
          const poolText = key => {
            const entry = account()?.quota[key];
            if (!entry) return `${QUOTA_LABELS[key]}: —`;
            const pct = Math.round(100 - clamp(entry.remainingPercent, 0, 100));
            // Show binding window when available, else just pool label.
            const bindingWindow = entry.windows?.reduce((best, w) => best === null || w.remainingPercent < best.remainingPercent ? w : best, null);
            const gutter = bindingWindow ? ` ${WINDOW_GUTTER[bindingWindow.window] ?? bindingWindow.window}` : '';
            return `${QUOTA_LABELS[key]}${gutter}: ${pct}%`;
          };
          const unavailable = () => {
            const selected = account();
            return selected != null && (!selected.enabled || selected.cooldownUntil != null && selected.cooldownUntil > now());
          };
          return _$createComponent(Show, {
            get when() {
              return account();
            },
            children: selected => _$createComponent(CollapsedRow, {
              theme: theme,
              get label() {
                return selected().label;
              },
              get children() {
                var _el$43 = _$createElement("box"),
                  _el$44 = _$createElement("text"),
                  _el$45 = _$createElement("b"),
                  _el$46 = _$createElement("text");
                _$insertNode(_el$43, _el$44);
                _$insertNode(_el$43, _el$46);
                _$setProp(_el$43, "flexDirection", 'row');
                _$insertNode(_el$44, _el$45);
                _$insert(_el$45, (() => {
                  var _c$ = _$memo(() => !!(account()?.quota.gemini == null && account()?.quota['non-gemini'] == null));
                  return () => _c$() ? '—' : `${poolText('gemini')} · ${poolText('non-gemini')}`;
                })());
                _$insert(_el$46, () => unavailable() ? ' ⊘' : ' ●');
                _$effect(_p$ => {
                  var _v$15 = toneColor(theme(), used() == null ? 'muted' : quotaTone(used() ?? 0, prefs().appearance)),
                    _v$16 = toneColor(theme(), unavailable() ? 'err' : quotaTone(used() ?? 0, prefs().appearance));
                  _v$15 !== _p$.e && (_p$.e = _$setProp(_el$44, "fg", _v$15, _p$.e));
                  _v$16 !== _p$.t && (_p$.t = _$setProp(_el$46, "fg", _v$16, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$43;
              }
            })
          });
        })();
      }
    }), null);
    _$insert(_el$33, _$createComponent(Show, {
      get when() {
        return !collapsed() || !hasData();
      },
      get children() {
        return _$createComponent(Show, {
          get when() {
            return hasData();
          },
          get fallback() {
            return (() => {
              var _el$47 = _$createElement("box"),
                _el$48 = _$createElement("text");
              _$insertNode(_el$47, _el$48);
              _$setProp(_el$47, "marginTop", 1);
              _$setProp(_el$47, "width", '100%');
              _$insertNode(_el$48, _$createTextNode(`Waiting for quota…`));
              _$effect(_$p => _$setProp(_el$48, "fg", theme().textMuted, _$p));
              return _el$47;
            })();
          },
          get children() {
            return [_$createComponent(Show, {
              get when() {
                return prefs().sections.quota;
              },
              get children() {
                return [_$createComponent(SectionHeader, {
                  theme: theme,
                  title: "Quota"
                }), _$createComponent(For, {
                  get each() {
                    return visibleAccounts();
                  },
                  children: (account, index) => _$createComponent(AccountBlock, {
                    theme: theme,
                    get appearance() {
                      return prefs().appearance;
                    },
                    account: account,
                    now: now,
                    get marginTop() {
                      return index() === 0 ? 0 : 1;
                    }
                  })
                })];
              }
            }), _$createComponent(Show, {
              get when() {
                return prefs().sections.routing;
              },
              get children() {
                return [_$createComponent(SectionHeader, {
                  theme: theme,
                  title: "Routing"
                }), _$createComponent(Show, {
                  get when() {
                    return currentRoute();
                  },
                  get fallback() {
                    return _$createComponent(StatRow, {
                      theme: theme,
                      label: "Route",
                      value: "\u2014",
                      tone: "muted"
                    });
                  },
                  children: route => _$createComponent(StatRow, {
                    theme: theme,
                    label: "Route",
                    get value() {
                      return `${route().strategy ? `${route().strategy} · ` : ''}${route().family}: ${route().style}`;
                    },
                    tone: "accent"
                  })
                })];
              }
            }), _$createComponent(Show, {
              get when() {
                return _$memo(() => !!degraded())() && prefs().sections.health;
              },
              get children() {
                return [_$createComponent(SectionHeader, {
                  theme: theme,
                  title: "Health"
                }), _$createComponent(Show, {
                  get when() {
                    return backoffActive();
                  },
                  get children() {
                    return _$createComponent(StatRow, {
                      theme: theme,
                      label: "Quota API",
                      get value() {
                        return `backoff ${formatResetIn(state().loaded.quotaBackoffUntil, now)}`;
                      },
                      tone: "warn"
                    });
                  }
                }), _$createComponent(Show, {
                  get when() {
                    return lastError();
                  },
                  get children() {
                    return _$createComponent(StatRow, {
                      theme: theme,
                      label: "Last error",
                      get value() {
                        return lastError() ?? '';
                      },
                      tone: "err"
                    });
                  }
                })];
              }
            })];
          }
        });
      }
    }), null);
    _$effect(_p$ => {
      var _v$12 = theme().borderActive,
        _v$13 = theme().accent,
        _v$14 = theme().background;
      _v$12 !== _p$.e && (_p$.e = _$setProp(_el$33, "borderColor", _v$12, _p$.e));
      _v$13 !== _p$.t && (_p$.t = _$setProp(_el$35, "backgroundColor", _v$13, _p$.t));
      _v$14 !== _p$.a && (_p$.a = _$setProp(_el$36, "fg", _v$14, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$33;
  })();
}

/**
 * Solid slot registry binding exposed for hosts that want to mount the
 * sidebar inside their renderer. Hosts that already own a slot registry can
 * use `createSlot` directly; we re-export for convenience and to keep the
 * contract visible at the module entry point.
 */
export const sidebar_content = createSlot;
export function startRpcNotificationPolling(options) {
  if (rpcPollStarted) return;
  rpcPollStarted = true;
  options.schedule(async () => {
    if (rpcInFlight) return;
    rpcInFlight = true;
    try {
      const sessionId = options.currentSessionId();
      const cursorKey = sessionId ?? GLOBAL_NOTIFICATION_CURSOR;
      let cursor = notificationCursorBySession.get(cursorKey) ?? 0;
      const notifications = await options.pending(cursor, sessionId);
      for (const notification of [...notifications].sort((a, b) => a.id - b.id)) {
        if (notification.id <= cursor) continue;
        cursor = Math.max(cursor, notification.id);
        if (dispatchedNotificationIds.has(notification.id)) continue;
        dispatchedNotificationIds.add(notification.id);
        if (dispatchedNotificationIds.size > 100) {
          const oldestId = dispatchedNotificationIds.values().next().value;
          if (oldestId !== undefined) dispatchedNotificationIds.delete(oldestId);
        }
        await options.dispatch(notification);
      }
      if (!notificationCursorBySession.has(cursorKey)) {
        while (notificationCursorBySession.size >= MAX_NOTIFICATION_CURSORS) {
          const oldest = notificationCursorBySession.keys().next().value;
          if (oldest === undefined) break;
          notificationCursorBySession.delete(oldest);
        }
      }
      notificationCursorBySession.set(cursorKey, cursor);
    } catch (error) {
      // Surface the swallowed error through the file logger rather than
      // stdout/stderr (the host terminal is the frame buffer — any byte
      // written here corrupts every subsequent cell). Without this, a
      // transient RPC outage is invisible to operators. The catch stays
      // because one failed poll must never break the next — the scheduler
      // is a setInterval and a thrown error there would crash the
      // process.
      options.logger.warn('rpc-poll-failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      rpcInFlight = false;
    }
  }, RPC_POLL_MS);
}
const tui = async api => {
  const logger = resolveLogger(undefined);
  const prefsRoot = await readTuiPreferencesFile();
  if (!sidebarController) {
    sidebarController = createSidebarController(resolveAntigravityAuthPrefs(prefsRoot));
  }
  const rpcClient = createRpcClient(getRpcDir(api.state.path.directory ?? ''), process.pid);
  startRpcNotificationPolling({
    pending: (lastReceivedId, sessionId) => rpcClient.pendingNotifications(lastReceivedId, sessionId),
    currentSessionId: () => {
      const current = api.route.current;
      const resolved = typeof current === 'function' ? current() : current;
      return resolved?.params?.sessionID;
    },
    dispatch: async notification => {
      logger.debug('rpc-notification-received', {
        command: notification.payload.command,
        id: notification.id,
        sessionId: notification.sessionId
      });
      // Call the imperative dispatcher directly — the prior
      // two-phase `collectDialogFlow` + `renderDialogFlow` is gone.
      // The dispatcher awaits `apply`, toasts the result, then clears
      // (or replaces for multi-step flows). The RPC `apply` accepts the
      // optional `timeoutMs` knob so account add / refresh can opt into
      // the 120s RPC timeout without the dialog layer having to know
      // about it.
      if (notification.payload.command === 'antigravity-quota') {
        api.ui.dialog.setSize('xlarge');
        api.ui.dialog.replace(() => _$createComponent(QuotaDialogContent, {
          api: api,
          get controller() {
            return getSidebarController();
          },
          get sessionId() {
            return notification.sessionId;
          }
        }));
        return;
      }
      openCommandDialog(api, notification.payload, (command, args, options) => rpcClient.apply({
        command,
        arguments: args,
        sessionId: notification.sessionId
      }, options));
    },
    schedule: (poll, intervalMs) => {
      setInterval(() => void poll(), intervalMs);
    },
    logger
  });

  // The host supplies the live theme via `api.theme.current` — the slot
  // callback's closure captures `api` so the accessor always reads the
  // current theme. A Solid re-render follows whenever the user switches.
  const liveTheme = () => api.theme.current;
  api.slots.register({
    order: computeEffectiveOrder(prefsRoot, PLUGIN_KEY, DEFAULT_SLOT_ORDER),
    slots: {
      sidebar_content: (_context, {
        session_id: sessionId
      }) => _$createComponent(SidebarPanel, {
        logger: logger,
        theme: liveTheme,
        sessionId: sessionId
      })
    }
  });
};
const plugin = {
  id: ID,
  tui
};
export default plugin;