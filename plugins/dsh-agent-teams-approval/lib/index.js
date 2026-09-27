/**
 * AgentTeams approval switch for DeepSeek Harness — host half.
 *
 * A host-plane plugin with no tools of its own: it registers one user-settings
 * namespace (`agent-teams-approval`, surfaced as a Settings → General row by the
 * client half), contributes one system-prompt override, installs one monotonic
 * tool guard, and prepends one `agent/pre-step` correction. While the switch is
 * on, AgentTeams teams run immediately after the captain creates them
 * (`approval="automatic"` — AgentTeams' documented immediate-execution path), so
 * no plan stages for the Web "Approve & Run" click. While it is off (the
 * default) the plugin is inert.
 *
 * Installation (bundle): `dsh plugin --profile <name> add link:<this directory>`
 * (or `node scripts/install.mjs --profile <name>`), then restart DSH.
 *
 * @module dsh-agent-teams-approval
 */
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { NAME, buildSettingsSchema, install } from './logic.js';

export const name = NAME;

/**
 * Required services: the tool registry (guard registration) and the system
 * prompt registry (override section). The settings service is optional and is
 * taken through a lazy `ctx.inject` inside `install`.
 */
export const inject = ['tools', 'systemPrompt'];

/** The settings schema the switch is registered with. */
export const SettingsSchema = buildSettingsSchema(z);

/**
 * Declarative config for the dsh 0.1.7 line.
 *
 * 0.1.7-rc.2 removed `settings.register` and replaced it with this contract: the harness
 * parses a profile entry's `config` against the exported `Config`, fills the schema
 * defaults, and hands the result to `apply(ctx, config)` as the second argument — and a
 * config edit then REMOUNTS the entry, so the apply-time value IS the live value there.
 * The served namespace is the ENTRY id (`agent-teams-approval`), not the settings
 * namespace. Reused verbatim from {@link SettingsSchema}: the same `skipApproval`
 * boolean the General row edits.
 */
export const Config = SettingsSchema;

export {
    FLAG_FIELD,
    PROMPT_SECTION_ORDER,
    SETTINGS_NS,
    buildSettingsSchema,
    guardReason,
    install,
    promptSectionText,
    resolveSkipApproval,
    withApprovalCorrection,
} from './logic.js';

/**
 * Mount the plugin.
 * @param ctx - host plugin context.
 * @param config - composition entry config (unused).
 */
export function apply(ctx, config) {
    install(ctx, config, { z, createUserMessage });
}
