import * as fs from 'node:fs/promises';
const defaults = {
    readFile: fs.readFile,
    stat: fs.stat,
    lstat: fs.lstat,
    realpath: fs.realpath,
    open: fs.open,
    rename: fs.rename,
    link: fs.link,
    unlink: fs.unlink,
    mkdir: fs.mkdir,
    readdir: fs.readdir,
};
// Keep one object so readers, writers and directory sync use the same filesystem.
export const SettingsFs = { ...defaults };
/** Internal test hook; omitted methods always use the native implementation. */
export function setSettingsFsForTest(overrides) {
    Object.assign(SettingsFs, defaults, overrides);
}
