import { memo as _$memo } from "opentui:runtime-module:%40opentui%2Fsolid";
import { effect as _$effect } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createTextNode as _$createTextNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insertNode as _$insertNode } from "opentui:runtime-module:%40opentui%2Fsolid";
import { insert as _$insert } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createComponent as _$createComponent } from "opentui:runtime-module:%40opentui%2Fsolid";
import { setProp as _$setProp } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createElement as _$createElement } from "opentui:runtime-module:%40opentui%2Fsolid";
/** @jsxImportSource @opentui/solid */

/**
 * Read-only OpenTUI sidebar for the Antigravity plugin.
 *
 * The plugin writes a redacted snapshot of the account pool to the file
 * resolved by `getSidebarStateFile()`. This component polls that file every
 * 2 seconds and renders a compact panel: one block per account (label, health
 * bar, cooldown, per-model quota bars), a "active session route" row, and
 * stale/backoff status indicators.
 *
 * Hard rules for this file:
 *
 * - NO direct writes to the host terminal anywhere in the render path. The
 *   host terminal is the frame buffer; one stray byte corrupts every
 *   subsequent cell. Errors flow through `createTuiFileLogger()`.
 * - NO imports from `./plugin/storage`, `./plugin/accounts`, OAuth code, or
 *   anything that touches tokens. The sidebar is a read-only view of an
 *   already-redacted snapshot.
 * - The component uses Solid's `onCleanup` to release the polling timer on
 *   unmount so a route change can never leak an interval.
 */

import { createSlot } from "opentui:runtime-module:%40opentui%2Fsolid";
import { createSignal, For, onCleanup, onMount, Show } from "opentui:runtime-module:solid-js";
import { createRpcClient } from "./rpc/rpc-client";
import { getRpcDir } from "./rpc/rpc-dir";
import { readSidebarState } from "./sidebar-state";
import { ANSI } from "./tui/ansi";
import { collectDialogFlow, renderDialogFlow } from "./tui/command-dialogs";
import { createTuiFileLogger } from "./tui/file-logger";
const POLL_INTERVAL_MS = 2000;
const STALE_AFTER_MS = 15_000;
const RPC_POLL_MS = 500;
let rpcPollStarted = false;
let lastNotificationId = 0;
let rpcInFlight = false;
const QUOTA_LABELS = {
  claude: 'Claude',
  'gemini-pro': 'Gemini Pro',
  'gemini-flash': 'Gemini Flash'
};
const QUOTA_ORDER = ['claude', 'gemini-pro', 'gemini-flash'];
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
export function SidebarPanel(props) {
  const logger = resolveLogger(props.logger);
  const now = props.now ?? (() => Date.now());
  const pollMs = props.pollIntervalMs ?? POLL_INTERVAL_MS;
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
  return (() => {
    var _el$ = _$createElement("box");
    _$setProp(_el$, "flexDirection", 'column');
    _$setProp(_el$, "paddingX", 1);
    _$setProp(_el$, "paddingY", 1);
    _$insert(_el$, _$createComponent(ShowHeader, {
      state: state,
      now: now
    }), null);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return state().loaded.accounts.length > 0;
      },
      get fallback() {
        return _$createComponent(AwaitingState, {
          now: now,
          get state() {
            return state();
          }
        });
      },
      get children() {
        return [_$createComponent(ActiveRoute, {
          get state() {
            return state();
          }
        }), _$createComponent(RoutingStatus, {
          get state() {
            return state();
          },
          now: now
        }), (() => {
          var _el$2 = _$createElement("box");
          _$setProp(_el$2, "flexDirection", 'column');
          _$setProp(_el$2, "marginTop", 1);
          _$insert(_el$2, _$createComponent(For, {
            get each() {
              return state().loaded.accounts;
            },
            children: account => _$createComponent(AccountBlock, {
              account: account,
              now: now
            })
          }));
          return _el$2;
        })(), _$createComponent(FooterState, {
          get state() {
            return state();
          },
          now: now
        })];
      }
    }), null);
    return _el$;
  })();
}
function ShowHeader(props) {
  // `loaded` is read inside JSX so Solid tracks the signal — without the
  // accessor wrapper the header would freeze at the value captured when
  // the component body first ran, never reflecting subsequent polls.
  const loaded = () => props.state().loaded;
  return (() => {
    var _el$3 = _$createElement("box"),
      _el$4 = _$createElement("text"),
      _el$6 = _$createElement("text"),
      _el$7 = _$createTextNode(`/`),
      _el$8 = _$createTextNode(` ready`);
    _$insertNode(_el$3, _el$4);
    _$insertNode(_el$3, _el$6);
    _$setProp(_el$3, "flexDirection", 'row');
    _$setProp(_el$3, "justifyContent", 'space-between');
    _$insertNode(_el$4, _$createTextNode(`Antigravity`));
    _$insertNode(_el$6, _el$7);
    _$insertNode(_el$6, _el$8);
    _$insert(_el$6, () => loaded().accounts.filter(a => a.enabled).length, _el$7);
    _$insert(_el$6, () => loaded().accounts.length, _el$8);
    return _el$3;
  })();
}
function AwaitingState(props) {
  const lastError = props.state.lastError ?? props.state.loaded.lastError;
  return (() => {
    var _el$9 = _$createElement("box"),
      _el$0 = _$createElement("text"),
      _el$12 = _$createElement("text"),
      _el$13 = _$createTextNode(`waiting for first poll · last tried `);
    _$insertNode(_el$9, _el$0);
    _$insertNode(_el$9, _el$12);
    _$setProp(_el$9, "flexDirection", 'column');
    _$setProp(_el$9, "marginTop", 1);
    _$insertNode(_el$0, _$createTextNode(`Awaiting Antigravity state`));
    _$insert(_el$9, _$createComponent(Show, {
      when: lastError,
      get children() {
        var _el$10 = _$createElement("text"),
          _el$11 = _$createTextNode(`last error: `);
        _$insertNode(_el$10, _el$11);
        _$insert(_el$10, lastError ?? '', null);
        _$effect(_$p => _$setProp(_el$10, "fg", ANSI.dim, _$p));
        return _el$10;
      }
    }), _el$12);
    _$insertNode(_el$12, _el$13);
    _$insert(_el$12, () => formatTime(props.now()), null);
    _$effect(_$p => _$setProp(_el$12, "fg", ANSI.dim, _$p));
    return _el$9;
  })();
}
function ActiveRoute(props) {
  const routes = Object.entries(props.state.loaded.activeRouting);
  if (routes.length === 0) {
    return (() => {
      var _el$14 = _$createElement("box"),
        _el$15 = _$createElement("text");
      _$insertNode(_el$14, _el$15);
      _$setProp(_el$14, "flexDirection", 'row');
      _$setProp(_el$14, "marginTop", 1);
      _$insertNode(_el$15, _$createTextNode(`no active session route`));
      _$effect(_$p => _$setProp(_el$15, "fg", ANSI.dim, _$p));
      return _el$14;
    })();
  }
  const [, route] = routes[0];
  const account = props.state.loaded.accounts.find(entry => entry.id === route.accountId);
  const label = account?.label ?? route.accountId;
  return (() => {
    var _el$17 = _$createElement("box"),
      _el$18 = _$createElement("text"),
      _el$19 = _$createTextNode(`routing → `),
      _el$20 = _$createTextNode(` via `),
      _el$21 = _$createTextNode(` (`),
      _el$22 = _$createTextNode(`)`);
    _$insertNode(_el$17, _el$18);
    _$setProp(_el$17, "flexDirection", 'row');
    _$setProp(_el$17, "marginTop", 1);
    _$insertNode(_el$18, _el$19);
    _$insertNode(_el$18, _el$20);
    _$insertNode(_el$18, _el$21);
    _$insertNode(_el$18, _el$22);
    _$insert(_el$18, () => route.modelFamily, _el$20);
    _$insert(_el$18, label, _el$21);
    _$insert(_el$18, () => route.headerStyle, _el$22);
    return _el$17;
  })();
}
function RoutingStatus(props) {
  const {
    loaded
  } = props.state;
  const isStale = props.now() - loaded.checkedAt > STALE_AFTER_MS;
  const isAuthoritative = loaded.routingAuthoritative;
  if (isAuthoritative && !isStale) return null;
  return (() => {
    var _el$23 = _$createElement("box"),
      _el$24 = _$createElement("text");
    _$insertNode(_el$23, _el$24);
    _$setProp(_el$23, "flexDirection", 'row');
    _$insert(_el$24, isStale ? 'stale routing snapshot' : 'routing snapshot not authoritative');
    _$effect(_$p => _$setProp(_el$24, "fg", isStale ? ANSI.yellow : ANSI.dim, _$p));
    return _el$23;
  })();
}
function AccountBlock(props) {
  const {
    account
  } = props;
  const inCooldown = typeof account.cooldownUntil === 'number' && account.cooldownUntil > props.now();
  const remainingCooldownMs = inCooldown && typeof account.cooldownUntil === 'number' ? Math.max(0, account.cooldownUntil - props.now()) : 0;
  return (() => {
    var _el$25 = _$createElement("box"),
      _el$26 = _$createElement("box"),
      _el$27 = _$createElement("text"),
      _el$28 = _$createTextNode(` `),
      _el$29 = _$createElement("text"),
      _el$32 = _$createElement("box");
    _$insertNode(_el$25, _el$26);
    _$insertNode(_el$25, _el$32);
    _$setProp(_el$25, "flexDirection", 'column');
    _$setProp(_el$25, "borderStyle", 'rounded');
    _$setProp(_el$25, "paddingX", 1);
    _$setProp(_el$25, "paddingY", 0);
    _$setProp(_el$25, "marginBottom", 1);
    _$insertNode(_el$26, _el$27);
    _$insertNode(_el$26, _el$29);
    _$setProp(_el$26, "flexDirection", 'row');
    _$setProp(_el$26, "justifyContent", 'space-between');
    _$insertNode(_el$27, _el$28);
    _$insert(_el$27, () => account.current ? '●' : '○', _el$28);
    _$insert(_el$27, () => account.label, null);
    _$insert(_el$29, () => account.enabled ? 'on' : 'off');
    _$insert(_el$25, _$createComponent(HealthBar, {
      get health() {
        return account.health;
      }
    }), _el$32);
    _$insert(_el$25, _$createComponent(Show, {
      when: inCooldown,
      get children() {
        var _el$30 = _$createElement("text"),
          _el$31 = _$createTextNode(`cooldown `);
        _$insertNode(_el$30, _el$31);
        _$insert(_el$30, () => formatWait(remainingCooldownMs), null);
        _$effect(_$p => _$setProp(_el$30, "fg", ANSI.yellow, _$p));
        return _el$30;
      }
    }), _el$32);
    _$setProp(_el$32, "flexDirection", 'column');
    _$setProp(_el$32, "marginTop", 0);
    _$insert(_el$32, _$createComponent(For, {
      each: QUOTA_ORDER,
      children: key => {
        const entry = account.quota[key];
        return _$createComponent(QuotaBar, {
          key: key,
          entry: entry
        });
      }
    }));
    _$effect(_p$ => {
      var _v$ = account.current ? ANSI.green : ANSI.dim,
        _v$2 = account.enabled ? ANSI.green : ANSI.dim;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$25, "borderColor", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$29, "fg", _v$2, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$25;
  })();
}
function HealthBar(props) {
  const filled = Math.round(clamp(props.health, 0, 100) / 10);
  const empty = 10 - filled;
  const bar = `${'█'.repeat(filled)}${'░'.repeat(empty)}`;
  const color = props.health >= 60 ? ANSI.green : ANSI.yellow;
  return (() => {
    var _el$33 = _$createElement("box"),
      _el$34 = _$createElement("text"),
      _el$35 = _$createTextNode(`health `),
      _el$36 = _$createTextNode(` `);
    _$insertNode(_el$33, _el$34);
    _$setProp(_el$33, "flexDirection", 'row');
    _$insertNode(_el$34, _el$35);
    _$insertNode(_el$34, _el$36);
    _$setProp(_el$34, "fg", color);
    _$insert(_el$34, bar, _el$36);
    _$insert(_el$34, () => Math.round(props.health), null);
    return _el$33;
  })();
}
function QuotaBar(props) {
  return _$createComponent(Show, {
    get when() {
      return props.entry;
    },
    get fallback() {
      return (() => {
        var _el$37 = _$createElement("box"),
          _el$38 = _$createElement("text"),
          _el$39 = _$createTextNode(` —`);
        _$insertNode(_el$37, _el$38);
        _$setProp(_el$37, "flexDirection", 'row');
        _$insertNode(_el$38, _el$39);
        _$insert(_el$38, () => QUOTA_LABELS[props.key], _el$39);
        _$effect(_$p => _$setProp(_el$38, "fg", ANSI.dim, _$p));
        return _el$37;
      })();
    },
    children: entry => (() => {
      var _el$40 = _$createElement("box");
      _$setProp(_el$40, "flexDirection", 'row');
      _$insert(_el$40, _$createComponent(QuotaBarLine, {
        get entry() {
          return entry();
        },
        get label() {
          return QUOTA_LABELS[props.key];
        }
      }));
      return _el$40;
    })()
  });
}
function QuotaBarLine(props) {
  const remaining = clamp(props.entry.remainingPercent, 0, 100);
  const filled = Math.round(remaining / 10);
  const empty = 10 - filled;
  const color = remaining < 20 ? ANSI.red : remaining < 50 ? ANSI.yellow : ANSI.green;
  const bar = `${'▰'.repeat(filled)}${'▱'.repeat(empty)}`;
  return (() => {
    var _el$41 = _$createElement("text"),
      _el$42 = _$createTextNode(` `),
      _el$43 = _$createTextNode(` `),
      _el$44 = _$createTextNode(`%`);
    _$insertNode(_el$41, _el$42);
    _$insertNode(_el$41, _el$43);
    _$insertNode(_el$41, _el$44);
    _$setProp(_el$41, "fg", color);
    _$insert(_el$41, () => props.label, _el$42);
    _$insert(_el$41, bar, _el$43);
    _$insert(_el$41, () => Math.round(remaining), _el$44);
    return _el$41;
  })();
}
function FooterState(props) {
  const {
    loaded,
    lastError
  } = props.state;
  const backoffActive = typeof loaded.quotaBackoffUntil === 'number' && loaded.quotaBackoffUntil > props.now();
  if (!backoffActive && !lastError) return null;
  return (() => {
    var _el$45 = _$createElement("box");
    _$setProp(_el$45, "flexDirection", 'column');
    _$setProp(_el$45, "marginTop", 1);
    _$insert(_el$45, _$createComponent(Show, {
      when: backoffActive,
      get children() {
        var _el$46 = _$createElement("text"),
          _el$47 = _$createTextNode(`quota backoff until `);
        _$insertNode(_el$46, _el$47);
        _$insert(_el$46, () => formatTime(loaded.quotaBackoffUntil ?? 0), null);
        _$effect(_$p => _$setProp(_el$46, "fg", ANSI.yellow, _$p));
        return _el$46;
      }
    }), null);
    _$insert(_el$45, _$createComponent(Show, {
      when: lastError,
      get children() {
        var _el$48 = _$createElement("text"),
          _el$49 = _$createTextNode(`last error: `);
        _$insertNode(_el$48, _el$49);
        _$insert(_el$48, lastError ?? '', null);
        _$effect(_$p => _$setProp(_el$48, "fg", ANSI.red, _$p));
        return _el$48;
      }
    }), null);
    return _el$45;
  })();
}
function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
function formatWait(ms) {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
}
function formatTime(epoch) {
  if (!epoch) return 'never';
  const date = new Date(epoch);
  return date.toISOString().replace('T', ' ').slice(0, 19);
}
function formatError(value) {
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
      const notifications = await options.pending(lastNotificationId, sessionId);
      for (const notification of [...notifications].sort((a, b) => a.id - b.id)) {
        if (notification.id <= lastNotificationId) continue;
        lastNotificationId = Math.max(lastNotificationId, notification.id);
        await options.dispatch(notification);
      }
    } catch {} finally {
      rpcInFlight = false;
    }
  }, RPC_POLL_MS);
}
const tui = async api => {
  const logger = resolveLogger(undefined);
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
        command: notification.command,
        id: notification.id,
        sessionId: notification.sessionId
      });
      await openCommandDialogFromNotification(api, rpcClient, notification);
    },
    schedule: (poll, intervalMs) => {
      setInterval(() => void poll(), intervalMs);
    }
  });
  api.slots.register({
    slots: {
      sidebar_content: () => _$createComponent(SidebarPanel, {
        logger: logger
      })
    }
  });
};

/**
 * Mount the OpenTUI dialog for an inbound RPC notification.
 *
 * Each modal command maps to a single-dialog flow rendered through
 * the host's `DialogSelect` (or confirm/prompt for sub-steps). Errors
 * here are deliberately swallowed — the host may have multiple
 * incoming notifications queued and one bad render must not break
 * the next one.
 */
async function openCommandDialogFromNotification(api, rpcClient, notification) {
  try {
    const flow = await collectDialogFlow(notification.command, '', {
      settings: {
        get: () => ({
          log_level: 'info'
        })
      }
    });
    await renderDialogFlow({
      api: api,
      flow,
      apply: async (command, args) => {
        const result = await rpcClient.apply({
          command,
          arguments: args,
          sessionId: notification.sessionId
        });
        return {
          text: result.text
        };
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await api.client.app.log({
        service: 'antigravity.tui',
        level: 'warn',
        message: 'dialog-open-failed',
        extra: {
          command: notification.command,
          error: message
        }
      });
    } catch {
      // ignore — host may not expose app.log
    }
  }
}
export default tui;