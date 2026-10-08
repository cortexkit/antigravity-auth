import { type MenuTerminal } from './terminal.js';
/**
 * Ask a yes/no question. "No" is listed first unless `defaultYes`, so a
 * stray Enter declines. Escape, and a terminal that cannot take keys, count
 * as "No": nothing destructive runs without an explicit yes.
 */
export declare function confirm(terminal: MenuTerminal, message: string, defaultYes?: boolean): Promise<boolean>;
