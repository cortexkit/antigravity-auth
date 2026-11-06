import { writeJsonAtomic } from '../fs/atomic-write.js';
import { assertLimitsWriteAllowed, runInsideHook } from './hooks.js';
import { notReadyError, readPool, runOperation } from './mutate.js';
/** A namespace merge and its check of current row bindings share one locked config snapshot. */
export async function updatePoolLimitsNamespace(rt, mutator, options = {}) {
    assertLimitsWriteAllowed();
    const { ctx } = rt;
    await runOperation(ctx, 'updateLimitsNamespace', undefined, undefined, async (locks, progress) => {
        for (const spec of ctx.storeLocks)
            await locks.acquire(spec);
        const result = await readPool(ctx);
        if (result.status !== 'ready')
            throw notReadyError(result, 'updateLimitsNamespace', undefined);
        const rows = result.rows.map(({ id, credentialEpoch, identity }) => ({
            id,
            credentialEpoch,
            identity,
        }));
        const envelope = await runInsideHook('updateLimitsNamespace', () => mutator(structuredClone(result.config.commonAuthLimits), rows));
        const config = { ...result.config, commonAuthLimits: envelope };
        const info = {
            operation: 'updateLimitsNamespace',
            rowId: undefined,
        };
        try {
            await writeJsonAtomic(ctx.configPath, config, {
                beforeRename: async () => {
                    await ctx.onStep?.('before-config-write', info);
                    await locks.assertAll();
                    options.beforePublish?.();
                },
            });
        }
        catch (error) {
            if (error &&
                typeof error === 'object' &&
                'published' in error &&
                error.published === true)
                options.onPublished?.();
            throw error;
        }
        progress.writes++;
        options.onPublished?.();
        await ctx.onStep?.('after-config-write', info);
    });
}
