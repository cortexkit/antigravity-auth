import { isAbsolute } from 'node:path';
export async function loadTui({ rawEntry, runtimeEntry, importModule = (entry) => import(entry), }) {
    for (const [option, entry] of Object.entries({ rawEntry, runtimeEntry })) {
        if (!isAbsolute(entry) &&
            !(entry.startsWith('file:') && new URL(entry).pathname.startsWith('/'))) {
            throw new Error(`${option} must be an absolute path or file URL: ${entry}`);
        }
    }
    let entry = runtimeEntry;
    try {
        await importModule(`opentui:runtime-module:${encodeURIComponent('@opentui/solid')}`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/Cannot find|Could not resolve|Module not found|Unable to resolve/.test(message) ||
            !message.includes('opentui:runtime-module:'))
            throw error;
        entry = rawEntry;
    }
    return (await importModule(entry)).default;
}
