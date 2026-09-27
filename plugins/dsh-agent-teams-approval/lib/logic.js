/**
 * AgentTeams approval switch — dependency-free decision logic and wiring.
 *
 * This module owns every rule the plugin applies; `index.js` only supplies the
 * two harness modules (`@deepseek-ai/schemastery` for the settings schema and
 * `@deepseek-ai/dsh-llm` for the pre-step control message) and the plugin
 * metadata the Loader reads. Keeping the rules here is what lets the whole
 * behavior be unit-tested without a DSH runtime.
 *
 * The user-visible contract: while the switch is on, AgentTeams teams run as
 * soon as the captain creates them — AgentTeams' own documented
 * `approval="automatic"` immediate-execution path — so no plan ever stages for
 * the Web "Approve & Run" click. While it is off (the default) the plugin
 * contributes nothing at all: an empty prompt section, a guard that never
 * denies, and a pre-step listener that returns the untouched decision.
 *
 * @module dsh-agent-teams-approval/logic
 */

/** Cordis plugin name (matches the bundle patch row id). */
export const NAME = 'agent-teams-approval';

/** User-settings namespace the switch lives in (`settings.yaml` section key). */
export const SETTINGS_NS = 'agent-teams-approval';

/** Boolean field inside {@link SETTINGS_NS} that carries the switch. */
export const FLAG_FIELD = 'skipApproval';

/**
 * System-prompt section order. AgentTeams registers its captain protocol at 117;
 * this override is placed immediately after it so the model reads the switch's
 * rule as the newer instruction.
 */
export const PROMPT_SECTION_ORDER = 118;

/** The AgentTeams create tool this plugin gates. */
export const CREATE_TOOL = 'agent_teams_create';

/** Source tag of the control message this plugin injects. */
export const PLUGIN_SOURCE = 'agent-teams-approval';

/**
 * Model-facing override, contributed while the switch is on. It names the
 * setting, states that it overrides every earlier AgentTeams instruction
 * (including the `/agent-teams` activation directive), and forbids the staged
 * path that would need a click.
 */
export const OVERRIDE_TEXT = `AgentTeams plan-approval override (agent-teams-approval settings namespace: skipApproval = true): the user
disabled AgentTeams plan approval in Settings → General. This overrides every earlier AgentTeams instruction,
including any /agent-teams activation directive: call agent_teams_create with approval="automatic" (or omit
approval) and let the team run immediately. Do not stage a plan for review, do not wait for a click, and do not
call agent_teams_approve. A create call with approval="required" is rejected while this override is active.
If the user explicitly asks to review a plan before it runs, explain that plan approval is switched off in
Settings → General and offer to turn it off instead of staging one.`;

/**
 * Correction appended after an AgentTeams `/agent-teams` activation directive
 * (that directive asks for the staged path, which this switch disables).
 */
export const CORRECTION_TEXT = `AgentTeams plan-approval override: plan approval is disabled in Settings → General. Ignore the
"approval=required / stop for review" instruction above: call agent_teams_create with approval="automatic" and
let the team run without any Web approval click.`;

/**
 * Denial reason for a create call that would stage a plan while the switch is
 * on. The model reads it as `Error: <reason>`, so it names the exact retry.
 */
export const GUARD_REASON = 'AgentTeams plan approval is disabled by the "AgentTeams 免审批执行" setting in '
    + 'Settings → General: call agent_teams_create again with approval:"automatic" (or omit approval). '
    + 'This rejected call created nothing.';

/**
 * Build the settings schema for the switch.
 * @param z - schemastery module (injected so this file stays dependency-free).
 * @returns the schema registered on {@link SETTINGS_NS}.
 */
/**
 * Mark one schema field as volatile, on both schemastery generations in play.
 *
 * The harness that serves 0.1.7 settings ships schemastery 3.18.4, where `.volatile()`
 * exists; the copy these plugins resolve is 3.18.2, which has no builder for it. Both
 * read the same `schema.meta.volatile` flag (3.18.4's `.volatile()` is literally
 * `extra('volatile', true)`), and the settings provider's `describe()` only serves an
 * entry whose Config carries that flag — so setting it directly is equivalent and works
 * whichever copy is resolved.
 * @param schema - a schemastery field schema.
 * @returns the same schema, marked volatile.
 */
export function volatileField(schema) {
    if (typeof schema.volatile === 'function') return schema.volatile();
    // A stand-in schema (test doubles) may carry no meta bag; there the marker is skipped.
    if (schema.meta !== undefined && schema.meta !== null) schema.meta.volatile = true;
    return schema;
}

export function buildSettingsSchema(z) {
    // `volatileField` is what makes the 0.1.7 settings provider SERVE this entry at all:
    // its `describe()` drops any entry whose Config has no volatile field
    // (`volatileForm(schema) === undefined`), a namespace that is not described is never
    // "served", and the client row's gate then never fires. Where the parsing happens with
    // schemastery 3.18.4 the field arrives as a live reference and an edit does NOT remount
    // the entry (the switch is pulled at every use site); the 3.18.2 copy our plugins
    // resolve ignores the flag while parsing, so there the config is plain and an edit
    // remounts the entry — `install` handles both.
    return z.object({ [FLAG_FIELD]: volatileField(z.boolean().default(false)) });
}

/**
 * Read a config field, whichever shape the running dsh delivered.
 *
 * On 0.1.7 a `.volatile()` field arrives as a live reference — cosmokit's `Volatile` has
 * `get()` and nothing else (no subscribe), so the only way to observe an edit is to pull
 * at USE time. Older lines deliver plain values.
 * @param field - the config field.
 * @param fallback - value to answer when the field is absent or unreadable.
 * @returns the current plain value.
 */
export function liveValue(field, fallback) {
    if (field === undefined || field === null) return fallback;
    if (typeof field === 'object' && typeof field.get === 'function' && typeof field.set !== 'function') {
        try {
            const value = field.get();
            return value === undefined ? fallback : value;
        }
        catch {
            return fallback;
        }
    }
    return field;
}

/**
 * Resolve the switch from a resolved settings section.
 * @param section - resolved namespace value, or anything else when unregistered.
 * @returns whether AgentTeams plan approval is disabled.
 */
export function resolveSkipApproval(section) {
    if (section === null || typeof section !== 'object') return false;
    return section[FLAG_FIELD] === true;
}

/**
 * The model-facing override section text.
 * @param skip - current switch value.
 * @returns the override text, or `''` so the section is dropped while off.
 */
export function promptSectionText(skip) {
    return skip === true ? OVERRIDE_TEXT : '';
}

/**
 * Monotonic tool guard: deny only the create call that would produce a staged
 * plan. `automatic`, an omitted `approval`, and every other tool are left alone.
 * @param skip - current switch value.
 * @param execution - the pending tool call (`{ name, arguments }`).
 * @returns a denial reason, or `undefined` to leave the call allowed.
 */
export function guardReason(skip, execution) {
    if (skip !== true) return undefined;
    if (execution === null || typeof execution !== 'object') return undefined;
    if (execution.name !== CREATE_TOOL) return undefined;
    const args = execution.arguments;
    if (args === null || typeof args !== 'object') return undefined;
    if (args.approval !== 'required') return undefined;
    return GUARD_REASON;
}

/**
 * Append the correction to a pre-step decision that carries an AgentTeams
 * slash-command directive. Never changes the decision kind, never touches a
 * rejection, and stays idempotent inside one decision.
 * @param skip - current switch value.
 * @param decision - the decision produced by the rest of the waterfall.
 * @param createUserMessage - `@deepseek-ai/dsh-llm` message factory.
 * @returns the original decision, or an `enter` decision with one extra message.
 */
export function withApprovalCorrection(skip, decision, createUserMessage) {
    if (skip !== true) return decision;
    if (typeof createUserMessage !== 'function') return decision;
    if (decision === null || typeof decision !== 'object') return decision;
    if (decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
    const fromCommand = decision.messages.some((message) => message?.source?.kind === 'agent-teams-command');
    if (!fromCommand) return decision;
    const already = decision.messages.some((message) => message?.source?.kind === 'plugin'
        && message.source.plugin === PLUGIN_SOURCE);
    if (already) return decision;
    return {
        ...decision,
        messages: [...decision.messages, createUserMessage({
            content: [{ type: 'text', text: CORRECTION_TEXT }],
            source: { kind: 'plugin', plugin: PLUGIN_SOURCE },
        })],
    };
}

/**
 * Wire the plugin onto a host context.
 * @param ctx - host plugin context (`tools`, `systemPrompt`, optional `settings`).
 * @param config - composition entry config; on dsh 0.1.7 this IS the live settings
 *   section (the parsed `Config`), on 0.1.5 it is only the entry config.
 * @param deps - harness modules: `{ z, createUserMessage }`.
 * @returns the live switch reader (used by tests and diagnostics).
 */
export function install(ctx, config, deps) {
    if (ctx === null || typeof ctx !== 'object') throw new TypeError('agent-teams-approval: a plugin context is required');
    const z = deps?.z;
    const createUserMessage = deps?.createUserMessage;
    let skip = false;

    const commit = (next, reason) => {
        const value = next === true;
        if (value === skip && reason !== 'initial') return;
        skip = value;
        ctx.logger?.info?.(`agent-teams-approval: AgentTeams plan approval ${value
            ? 'disabled — teams run immediately after create'
            : 'required — plans stage for review'} (${reason})`);
    };

    // 1. User settings: the durable switch.
    //
    // The two dsh lines deliver it differently. 0.1.5 serves `settings.register` plus a
    // watcher that keeps `skip` current. 0.1.7-rc.2 removed that method and hands the
    // PARSED ENTRY CONFIG to `apply(ctx, config)` instead, where the field is a
    // `.volatile()` REFERENCE: an edit updates it in place (no remount) and the reference
    // exposes only `get()`, so the switch is pulled at every use site — never cached.
    const configFlag = config?.[FLAG_FIELD];
    const configIsLive = configFlag !== undefined && configFlag !== null
        && typeof configFlag === 'object' && typeof configFlag.get === 'function';
    commit(resolveSkipApproval({ [FLAG_FIELD]: liveValue(configFlag, false) }), 'initial');
    /**
     * The switch as of this call.
     * @returns whether AgentTeams plan approval is disabled right now.
     */
    const readSkip = () => {
        if (configIsLive) return resolveSkipApproval({ [FLAG_FIELD]: liveValue(configFlag, false) });
        return skip;
    };
    if (typeof ctx.inject === 'function' && z !== undefined) {
        ctx.inject(['settings'], (sctx) => {
            const service = sctx.settings;
            // 0.1.5 only: no `register` means this is the 0.1.7 line, where the volatile
            // config reference above already carries the value. Calling it anyway is what
            // used to log "registration failed" (or throw into the fiber executor) and
            // leave the switch stuck at its default on the official desktop.
            if (service === undefined || service === null || typeof service.register !== 'function') return;
            try {
                const scope = service.register(SETTINGS_NS, buildSettingsSchema(z));
                commit(resolveSkipApproval(scope.get()), 'initial');
                const dispose = scope.watch((next) => {
                    commit(resolveSkipApproval(next), 'settings update');
                });
                if (typeof dispose === 'function') ctx.effect(() => dispose, 'agent-teams-approval: settings watcher');
            }
            catch (error) {
                ctx.logger?.warn?.(`agent-teams-approval: settings namespace "${SETTINGS_NS}" registration failed: ${String(error)}`);
            }
        });
    }
    else {
        ctx.logger?.warn?.('agent-teams-approval: the settings service (or @deepseek-ai/schemastery) is unavailable; '
            + 'the switch stays at its default (approval required)');
    }

    // 2. Prompt override: empty while the switch is off, so the composed prompt is
    // byte-identical to a composition without this plugin.
    if (typeof ctx.systemPrompt?.section === 'function') {
        ctx.effect(() => ctx.systemPrompt.section({
            name: 'agent-teams-approval:gate',
            order: PROMPT_SECTION_ORDER,
            text: () => promptSectionText(readSkip()),
        }), 'agent-teams-approval: prompt section');
    }

    // 3. Hard gate: the staged path — the only path that needs a click — cannot
    // start while the switch is on.
    if (typeof ctx.tools?.guard === 'function') {
        ctx.effect(() => ctx.tools.guard((execution) => guardReason(readSkip(), execution)), 'agent-teams-approval: create gate');
    }
    else if (typeof ctx.tools?.register === 'function') {
        ctx.logger?.warn?.('agent-teams-approval: ctx.tools.guard is unavailable on this host; '
            + 'only the prompt override enforces the switch');
    }

    // 4. `/agent-teams` correction. Prepended so it wraps the AgentTeams gesture
    // boundary and therefore sees the directive that listener appends.
    if (typeof ctx.on === 'function') {
        ctx.on('agent/pre-step', async (_payload, next) => {
            const decision = await next();
            try {
                return withApprovalCorrection(readSkip(), decision, createUserMessage);
            }
            catch (error) {
                ctx.logger?.warn?.(`agent-teams-approval: pre-step override failed: ${String(error)}`);
                return decision;
            }
        }, { prepend: true });
    }

    return { isSkipApproval: readSkip };
}
