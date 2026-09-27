/**
 * dsh-workspace-changes — host half: the workspace-gated, loopback-only
 * /changes/* JSON routes (status / per-file diff / open-in-IDE) and the
 * /changes/events SSE stream on the shared webserver. The browser half
 * (exports "./client") registers the right-Sidebar "变更" tab.
 *
 * Read-only contract: the only spawned processes are `git status` /
 * `git diff` / `git rev-parse` reads and a detached editor launch. Nothing
 * here stages, discards, commits, or writes a file.
 *
 * @module dsh-workspace-changes
 */

import z from '@deepseek-ai/schemastery';
import { subprocessRunner } from './host/git.js';
import { registerChangesRoutes } from './host/routes.js';

/** Required services: the route registry, the managed spawn seam, the workspace registry. */
export const inject = ['webServer', 'subprocess', 'workspaceRegistry'];

/** The settings-card namespace of this plugin. */
export const SETTINGS = 'workspace-changes';

/** Plugin config schema (settings-editable; patch supplies the defaults). */
export const Config = z.object({
    editor: z.string().default('auto'),
    editors: z.array(z.object({
        id: z.string(),
        label: z.string(),
        command: z.string()
    })).default([]),
    maxDiffBytes: z.number().default(1024 * 1024),
    maxUntrackedBytes: z.number().default(256 * 1024),
    pollIntervalMs: z.number().default(30_000)
});

/** Resolve the effective config with schema defaults applied. */
function effectiveConfig(config) {
    return {
        editor: typeof config?.editor === 'string' ? config.editor : 'auto',
        editors: Array.isArray(config?.editors) ? config.editors : [],
        maxDiffBytes: typeof config?.maxDiffBytes === 'number' && config.maxDiffBytes > 0 ? config.maxDiffBytes : 1024 * 1024,
        maxUntrackedBytes: typeof config?.maxUntrackedBytes === 'number' && config.maxUntrackedBytes > 0 ? config.maxUntrackedBytes : 256 * 1024,
        pollIntervalMs: typeof config?.pollIntervalMs === 'number' && config.pollIntervalMs >= 10_000 ? config.pollIntervalMs : 30_000
    };
}

/**
 * Mount-once guard: live patch reload can re-run apply; the previous
 * registration set is disposed first so routes never double-register.
 */
let activeDispose;

/**
 * Host plugin body: register the routes and SSE stream.
 * @param ctx - host context carrying webServer, subprocess, workspaceRegistry.
 * @param config - profile patch values.
 */
export function apply(ctx, config) {
    if (activeDispose !== undefined) {
        activeDispose();
        activeDispose = undefined;
    }
    const runner = subprocessRunner(ctx);
    const current = () => effectiveConfig(config);
    const dispose = registerChangesRoutes(ctx, runner, current);
    ctx.effect(() => {
        activeDispose = undefined;
        return dispose;
    }, 'dsh-workspace-changes: /changes routes');
    activeDispose = dispose;
}
