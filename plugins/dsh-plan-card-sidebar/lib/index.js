/**
 * dsh-plan-card-sidebar — host half.
 *
 * Pure UI plugin: the empty `apply` exists so the package appears in the host
 * Loader roster, exactly like the first-party client plugins
 * (`@deepseek-ai/dsh-client-ui-plan` and friends). The browser half ships via
 * `exports["./client"]`, discovered through the `dsh.client` declaration in
 * package.json and served at `/plugins/dsh-plan-card-sidebar/client.js`.
 *
 * All behavior — the sidebar tab type, the composer seat that renders the plan
 * card, and the switch between the two homes — lives in the browser half.
 *
 * @module dsh-plan-card-sidebar
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
function apply() {}

export { apply };
