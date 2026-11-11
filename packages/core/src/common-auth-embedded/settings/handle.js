import { join, resolve } from 'node:path';
import { FileReadCache } from '../fs/file-read-cache.js';
import { watchSettings } from '../tui-prefs/watcher.js';
import { isJsonObject } from './descriptors.js';
import { SettingsFs } from './fs.js';
import { parseSettings } from './parse.js';
import { resolveSetting } from './resolve.js';
import { buildSettingsSnapshot, } from './snapshot.js';
import { updateSettings } from './update.js';
const reportedKey = Symbol.for('cortexkit.common-auth.settings.reported.v1');
function reportedEntries() {
    let reported = Reflect.get(globalThis, reportedKey);
    if (!reported) {
        reported = new Set();
        Reflect.set(globalThis, reportedKey, reported);
    }
    return reported;
}
/** Internal test hook; not part of the settings package exports. */
export function resetSettingsReportedForTest() {
    reportedEntries().clear();
}
export function openSettings(definition, options) {
    options = { createMissing: false, lockTimeoutMs: 2_000, ...options };
    const userPath = resolve(options.file);
    const cacheOptions = {
        followSymlinks: true,
        // Read SettingsFs at call time so setSettingsFsForTest reaches open handles.
        stat: (path) => SettingsFs.stat(path),
        lstat: (path) => SettingsFs.lstat(path),
    };
    const userCache = new FileReadCache(cacheOptions);
    const projectCache = new FileReadCache(cacheOptions);
    let user;
    const projects = new Map();
    // A project's report and resolution use only the source selected by its read.
    const projectLevels = new Map();
    const projectSequences = new Map();
    let sequence = 0;
    // Keep ordering metadata after eviction so an older in-flight read cannot win.
    const committedSequences = new Map();
    const projectPath = (project) => resolve(join(project, '.cortexkit', `${definition.plugin}.jsonc`));
    // Windows reads every time (below), so remember each file's last bytes to
    // tell a changed file from an unchanged one, as the cache does elsewhere.
    const windows = process.platform === 'win32';
    const windowsSeen = new Map();
    const unreadFile = {
        missing: Symbol('missing'),
        unreadable: Symbol('unreadable'),
    };
    async function load(file, reader) {
        const currentSequence = ++sequence;
        const cache = file.kind === 'user' ? userCache : projectCache;
        let loaded = false;
        const seen = (path, content) => {
            if (!windows) {
                // The cache calls this reader only when the file changed.
                loaded = true;
                return;
            }
            loaded = windowsSeen.get(path) !== content;
            windowsSeen.set(path, content);
        };
        const readFile = async ([path]) => {
            let text;
            try {
                text = await SettingsFs.readFile(path, 'utf8');
            }
            catch (error) {
                const status = error.code === 'ENOENT'
                    ? 'missing'
                    : 'unreadable';
                seen(path, unreadFile[status]);
                return { status };
            }
            seen(path, text);
            let parsed;
            if (reader) {
                let value;
                try {
                    value = reader(text);
                }
                catch {
                    return { status: 'unreadable' };
                }
                if (!isJsonObject(value))
                    return { status: 'unparseable' };
                // Legacy readers return an object keyed by setting name, not JSONC text.
                parsed = {
                    parseable: true,
                    text,
                    hasBom: false,
                    tree: undefined,
                    value,
                    duplicateKeyPaths: [],
                    hasDuplicates: false,
                };
            }
            else {
                parsed = parseSettings(text);
            }
            return parsed.parseable
                ? {
                    status: 'snapshot',
                    snapshot: buildSettingsSnapshot(definition, file, parsed),
                }
                : { status: 'unparseable' };
        };
        // On Windows a quick same-size rewrite can keep the size and timestamps
        // the cache compares, so read the file every time instead of using the cache.
        const outcome = process.platform === 'win32'
            ? await readFile([file.path])
            : await cache.read([file.path], readFile);
        const key = JSON.stringify([file.kind, file.path]);
        if (currentSequence <= (committedSequences.get(key) ?? 0))
            return;
        committedSequences.set(key, currentSequence);
        const previous = file.kind === 'user' ? user : projects.get(file.path);
        const snapshot = outcome.status === 'snapshot'
            ? outcome.snapshot
            : outcome.status === 'missing'
                ? undefined
                : previous?.snapshot;
        const entries = [...(snapshot?.entries ?? [])];
        if (outcome.status === 'unparseable' || outcome.status === 'unreadable') {
            entries.unshift({
                file: { ...file },
                keyPath: [],
                reason: outcome.status,
            });
        }
        const state = { status: outcome.status, snapshot, entries };
        if (file.kind === 'user') {
            user = state;
        }
        else {
            // Cache hits do not refresh insertion order; changed files do.
            if (loaded)
                projects.delete(file.path);
            if (!projects.has(file.path) && projects.size >= 64) {
                const oldest = projects.keys().next().value;
                if (oldest !== undefined) {
                    projects.delete(oldest);
                    windowsSeen.delete(oldest);
                    for (const [project, selected] of projectLevels) {
                        if (selected === oldest)
                            projectLevels.delete(project);
                    }
                }
            }
            projects.set(file.path, state);
        }
        const reported = reportedEntries();
        for (const entry of entries) {
            const identity = JSON.stringify([
                entry.file.path,
                entry.keyPath,
                entry.reason,
            ]);
            if (reported.has(identity))
                continue;
            reported.add(identity);
            options.log.warn(`Settings ${entry.reason}: ${entry.file.path} (${entry.keyPath.join('.') || '<root>'})`, structuredClone(entry));
        }
    }
    async function readProject(project) {
        const path = projectPath(project);
        const currentSequence = ++sequence;
        await load({ kind: 'project', path });
        if (currentSequence <= (projectSequences.get(path) ?? 0))
            return;
        let selected = path;
        if (projects.get(path)?.status === 'missing') {
            const source = options.legacyProject?.(project);
            if (source) {
                selected = resolve(source.path);
                await load({ kind: 'legacy-project', path: selected }, (text) => source.read(text));
            }
        }
        // A slow legacy reader must not replace a newer read's project-file choice.
        if (currentSequence <= (projectSequences.get(path) ?? 0))
            return;
        projectSequences.set(path, currentSequence);
        projectLevels.set(path, selected);
    }
    const handle = {
        async read({ project } = {}) {
            if (options.separateInstall)
                return;
            await Promise.all([
                load({ kind: 'user', path: userPath }),
                ...(project === undefined ? [] : [readProject(project)]),
            ]);
        },
        async get(name, getOptions) {
            if (!Object.hasOwn(definition.settings, name)) {
                throw new TypeError(`Undeclared setting: ${name}`);
            }
            await handle.read({ project: getOptions.project });
            return resolveSetting(definition, name, getOptions, {
                user: user?.snapshot,
                project: getOptions.project === undefined
                    ? undefined
                    : projects.get(projectLevels.get(projectPath(getOptions.project)) ?? '')?.snapshot,
            });
        },
        report() {
            return structuredClone([
                ...(user?.entries ?? []),
                ...Array.from(new Set(projectLevels.values())).flatMap((path) => projects.get(path)?.entries ?? []),
            ]);
        },
        update(edits, context) {
            return updateSettings(definition, { ...options, file: userPath }, edits, context);
        },
        watch(onChange) {
            if (options.separateInstall)
                return () => { };
            return watchSettings(userPath, onChange, {
                fs: {
                    stat: (path) => SettingsFs.stat(path),
                    readFile: (path) => SettingsFs.readFile(path, 'utf8'),
                },
            });
        },
    };
    return handle;
}
