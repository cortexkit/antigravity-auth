import type { CommandMenu } from './menu.js';
import type { NotifyKind } from './model.js';
/**
 * The part of Pi's `ExtensionUIContext` the renderer uses. `select` and
 * `input` resolve undefined when the user backs out.
 */
export interface PiMenuUi {
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    notify(message: string, type?: NotifyKind): void;
}
export interface PiMenuOptions {
    sessionId?: string;
}
/**
 * Runs one invocation of the slash command on Pi: sections, then an item or
 * a section action, then the action's inputs and confirmation; after each
 * apply the user is back in the same section with the refreshed menu. Backing
 * out of the section list ends the invocation.
 */
export declare function runPiCommandMenu(menu: CommandMenu, ui: PiMenuUi, options?: PiMenuOptions): Promise<void>;
