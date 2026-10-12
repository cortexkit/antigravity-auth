// The command menu: sections of items, each carrying actions with typed
// inputs. Two kinds of type live here. The `Menu*` types and the request and
// result types are plain data: they cross the loopback RPC to a host's TUI
// and are what an in-process renderer walks. The `*Definition` types carry
// the action bodies a plugin or the library supplies; they never leave the
// process and are turned into the plain types only by the seam in `seam.ts`.
/** The section slots, in the one order every renderer shows them. */
export const SECTION_SLOTS = [
    'accounts',
    'quota',
    'routing',
    'limits',
    'cache',
    'diagnostics',
    'extra',
];
