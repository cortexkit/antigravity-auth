import { createComponent as _$createComponent } from "opentui:runtime-module:%40opentui%2Fsolid";
/** @jsxImportSource @opentui/solid */

/**
 * OpenTUI dialog tree for the /antigravity-* slash commands.
 *
 * Each command renders a `DialogSelect` (or `DialogConfirm`/`DialogPrompt`
 * for destructive / freeform input) whose options map to arguments the
 * RPC `apply` endpoint understands. The component deliberately does
 * NOT mark options with the host's hide-property — the host `DialogSelect`
 * HIDES such options, and the contract requires invalid actions stay
 * visible with an explanatory description, rejected in `onSelect`
 * instead. See the `no hide-property option scan` in the verification
 * gates.
 *
 * The dialog tree is mounted by `tui.tsx` in response to an RPC
 * notification. Multi-step account/killswitch flows go through
 * `api.ui.dialog.replace()` so a sub-flow replaces the prior dialog
 * without leaving a stack of stale menus.
 */

/**
 * One selectable action in the dialog flow.
 *
 * `description` is rendered as the help text. `key` is a stable string
 * the dialog uses to identify the selection when calling the RPC apply.
 */

/**
 * The structured dialog tree for a single command.
 *
 * `payload` is the `OpenDialogPayload` the TUI's RPC poll receives;
 * `actions` are the options the dialog renders; `cancelLabel` is the
 * always-present cancel control. Pure data — no Solid, no host API
 * imports — so unit tests can pin the contract without spinning up a
 * renderer.
 */

const CANCEL_LABEL = 'Cancel';

/**
 * Build the structured dialog flow for `command`.
 *
 * `argumentsText` is the raw slash-command arguments the user typed
 * (e.g. `cli_first=true`). Knobs on the payload shape mirror the
 * fields `applyCommand` accepts — the dialog tree never reaches into
 * the apply path itself; the TUI hands the user selection back to
 * RPC and `applyCommand` resolves it on the server.
 *
 * Pure function — no host API access, no Solid. Tested in
 * `command-dialogs.test.tsx`.
 */
export async function collectDialogFlow(command, argumentsText, context) {
  switch (command) {
    case 'antigravity-quota':
      return {
        command,
        title: 'Antigravity quota',
        description: 'Refresh Antigravity quota for the active account pool.',
        actions: [{
          key: 'refresh',
          label: 'Refresh quota',
          description: 'Run a live quota check against every account.'
        }, {
          key: 'status',
          label: 'Show status',
          description: 'Display the cached quota snapshot for each account.'
        }],
        cancelLabel: CANCEL_LABEL,
        payload: {
          command,
          text: 'Antigravity quota',
          knobs: {
            mode: argumentsText === 'refresh' ? 'refresh' : 'status'
          }
        }
      };
    case 'antigravity-account':
      return {
        command,
        title: 'Antigravity accounts',
        description: 'Add, refresh, or remove Antigravity accounts.',
        actions: [{
          key: 'add',
          label: 'Add account',
          description: 'Open the OAuth flow to add a new account.'
        }, {
          key: 'refresh',
          label: 'Refresh account',
          description: 'Re-authenticate an existing account (120s timeout).'
        }, {
          key: 'remove',
          label: 'Remove account',
          description: 'Delete an account from the local pool.'
        }],
        cancelLabel: CANCEL_LABEL,
        payload: {
          command,
          text: 'Antigravity accounts',
          knobs: {
            action: 'list'
          }
        }
      };
    case 'antigravity-routing':
      return {
        command,
        title: 'Antigravity routing',
        description: 'Toggle routing overrides for Gemini / Antigravity.',
        actions: [{
          key: 'cli_first',
          label: 'Toggle CLI first',
          description: 'Prefer Gemini CLI routing before Antigravity.'
        }, {
          key: 'quota_style_fallback',
          label: 'Toggle quota-style fallback',
          description: 'Fall back to the alternate quota style on exhaustion.'
        }],
        cancelLabel: CANCEL_LABEL,
        payload: {
          command,
          text: 'Antigravity routing',
          knobs: {}
        }
      };
    case 'antigravity-killswitch':
      return {
        command,
        title: 'Antigravity killswitch',
        description: 'Configure the quota killswitch threshold and per-account overrides.',
        actions: [{
          key: 'enable',
          label: 'Enable killswitch',
          description: 'Drop candidates below the floor before dispatch.'
        }, {
          key: 'disable',
          label: 'Disable killswitch',
          description: 'Resume candidate selection regardless of quota.'
        }, {
          key: 'threshold',
          label: 'Set minimum remaining percent',
          description: 'Prompt for a new minimum_remaining_percent (0-100).'
        }],
        cancelLabel: CANCEL_LABEL,
        payload: {
          command,
          text: 'Antigravity killswitch',
          knobs: {}
        }
      };
    case 'antigravity-dump':
      return {
        command,
        title: 'Antigravity wire dump',
        description: 'Show or toggle Gemini/Antigravity wire dump capture for debugging.',
        actions: [{
          key: 'on',
          label: 'Turn dump on',
          description: 'Write request and response bodies to the dump dir.'
        }, {
          key: 'off',
          label: 'Turn dump off',
          description: 'Stop writing new dump files.'
        }, {
          key: 'status',
          label: 'Show dump status',
          description: 'Display whether dumps are enabled and where they go.'
        }],
        cancelLabel: CANCEL_LABEL,
        payload: {
          command,
          text: 'Antigravity wire dump',
          knobs: {
            mode: argumentsText === 'on' ? 'enable' : 'status'
          }
        }
      };
    case 'antigravity-logging':
      return {
        command,
        title: 'Antigravity logging',
        description: 'Adjust the runtime logging level.',
        actions: [{
          key: 'error',
          label: 'Error',
          description: 'Errors only.'
        }, {
          key: 'warn',
          label: 'Warn',
          description: 'Warnings and errors.'
        }, {
          key: 'info',
          label: 'Info',
          description: 'Default. Includes informational events.'
        }, {
          key: 'debug',
          label: 'Debug',
          description: 'Includes debug-level events.'
        }, {
          key: 'trace',
          label: 'Trace',
          description: 'Most verbose — every diagnostic event.'
        }],
        cancelLabel: CANCEL_LABEL,
        payload: {
          command,
          text: 'Antigravity logging',
          knobs: {
            log_level: context.settings.get().log_level
          }
        }
      };
    default:
      {
        const exhaustiveCheck = command;
        throw new Error(`Unknown command ${exhaustiveCheck}`);
      }
  }
}

/**
 * Render the dialog flow as an OpenTUI dialog.
 *
 * The Solid render lives here so the production bundle ships it
 * without `tui.tsx` having to know the per-command action lists. The
 * host's `api.ui.dialog.replace()` is called whenever the flow moves
 * to a sub-step (e.g. account add → OAuth browser prompt → success
 * toast) so the user always sees a single dialog at a time.
 */

export function renderDialogFlow(options) {
  const {
    api,
    flow,
    apply,
    onClose
  } = options;
  const render = () => _$createComponent(api.ui.DialogSelect, {
    get title() {
      return flow.title;
    },
    get options() {
      return flow.actions.map(action => ({
        title: action.label,
        value: action.key,
        description: action.description
      }));
    },
    onSelect: selected => {
      // Close immediately — applyCommand may take seconds; a separate
      // toast/text surface handles the user feedback.
      api.ui.dialog.clear();
      onClose?.();
      // Fire-and-forget: the dialog is gone, the apply path runs in the
      // background and surfaces via toast.
      void apply(flow.command, selected.value).catch(() => {
        // Errors are surfaced by the apply path itself.
      });
    }
  });
  api.ui.dialog.replace(render, onClose);
}