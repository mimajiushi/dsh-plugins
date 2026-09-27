/**
 * AgentTeams approval switch for DeepSeek Harness — client half.
 *
 * Hand-authored client bundle (the host serves this file as-is through
 * `/plugins`): it registers one `settings.general.item` row into the General
 * section, so the switch appears in Settings → 通用设置. The row is backed by the
 * settings namespace the host half registers; this half never talks to the host
 * directly — it reads and writes through the bound settings scope
 * (`settingsScope` on dsh 0.1.5, the Web UI group's `webUiSettings` binder — or
 * the native config form — on 0.1.7, which removed `settingsScope`).
 *
 * Only baseline module-table requests are used (react, react/jsx-runtime,
 * @deepseek-ai/dsh-client-ui-primitives), so no `dsh.client.external` entry is
 * needed.
 *
 * @module dsh-agent-teams-approval/client
 */
window.__ModuleLoader__.load({
    id: 'dsh-agent-teams-approval',
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
        const React = require('react');
        const { jsx, jsxs } = require('react/jsx-runtime');
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        const Switch = primitives.Switch;

        /** Settings namespace owned by this plugin's host half. */
        const NS = 'agent-teams-approval';
        /**
         * Profile entry ids the 0.1.7 host may serve this plugin's config under: the id
         * the bundle's patch layer declares (`- id: agent-teams-approval`) plus the
         * package name it resolves to (`dsh-agent-teams-approval`). Only the binder's
         * `configForms` fallback uses them, in order.
         */
        const ENTRY_IDS = ['agent-teams-approval', 'dsh-agent-teams-approval'];
        /** Boolean field inside the namespace section. */
        const FLAG_FIELD = 'skipApproval';
        /** Row identity inside the `settings.general.item` ledger. */
        const ROW_ID = 'agent-teams-approval';
        /** Row position: after ui-theme's Appearance (10) and Font size (11). */
        const ROW_ORDER = 12;
        const CSS_TAG_ID = 'dsh-agent-teams-approval/ApprovalRow.module.css';

        const css = '.dsh-ata-row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}'
            + '.dsh-ata-row-text{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}'
            + '.dsh-ata-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}'
            + '.dsh-ata-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}'
            + '.dsh-ata-switch{flex:none}';
        if (typeof document !== 'undefined'
            && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') === null) {
            const tag = document.createElement('style');
            tag.dataset.plugin = 'dsh-agent-teams-approval';
            tag.dataset.pluginCss = CSS_TAG_ID;
            tag.textContent = css;
            document.head.appendChild(tag);
        }

        const zh = {
            'row.title': 'AgentTeams 免审批执行',
            'row.description': '开启后，队长创建团队即直接开始执行，不再需要点击「确认并启动团队」；关闭则恢复先审阅计划、再启动的流程。',
            'row.unavailable': '当前连接不支持修改该设置。',
        };
        const en = {
            'row.title': 'AgentTeams auto-run (no plan approval)',
            'row.description': 'When on, a new AgentTeams team runs as soon as the captain creates it — no “Approve & Run” '
                + 'click. When off, plans are staged for review as before.',
            'row.unavailable': 'This connection cannot change this setting.',
        };
        const DICTIONARIES = { zh, en };

        /** Locale lookup that never throws when the seat is missing. */
        function translate(t, key) {
            if (typeof t === 'function') {
                try {
                    const text = t(key);
                    if (typeof text === 'string' && text !== '') return text;
                }
                catch {
                    /* fall through to the key itself */
                }
            }
            return key;
        }

        /** Fallback control for a shell whose primitive library omits Switch. */
        function FallbackToggle({ checked, disabled, label, onChange }) {
            return jsx('input', {
                type: 'checkbox',
                role: 'switch',
                className: 'dsh-ata-switch',
                'aria-label': label,
                checked,
                disabled,
                onChange: (event) => onChange(event.target.checked),
            });
        }

        /**
         * One preference row: title + description on the left, switch on the right.
         * `useApproval` is the renderer-bound selector over the settings scope.
         */
        function ApprovalRow(props) {
            const t = props.t;
            const useApproval = props.useApproval;
            const snapshot = typeof useApproval === 'function' ? useApproval((value) => value) : undefined;
            const [pending, setPending] = React.useState(false);
            const ready = snapshot !== undefined && snapshot !== null && snapshot.status === 'ready';
            const writable = ready && snapshot.writable === true;
            const enabled = ready && snapshot.value !== undefined && snapshot.value !== null
                && snapshot.value[FLAG_FIELD] === true;
            const disabled = pending || !writable;
            const blocked = snapshot !== undefined && snapshot !== null
                && (snapshot.status === 'unavailable' || (ready && snapshot.writable !== true));
            const toggle = (next) => {
                setPending(true);
                Promise.resolve()
                    .then(() => props.setSkipApproval(next))
                    .catch(() => undefined)
                    .then(() => {
                        setPending(false);
                    });
            };
            const Control = typeof Switch === 'function' ? Switch : FallbackToggle;
            return jsxs('div', {
                className: 'dsh-ata-row',
                children: [
                    jsxs('div', {
                        className: 'dsh-ata-row-text',
                        children: [
                            jsx('div', { className: 'dsh-ata-title', children: translate(t, 'row.title') }),
                            jsx('div', { className: 'dsh-ata-desc', children: translate(t, 'row.description') }),
                            blocked
                                ? jsx('div', { className: 'dsh-ata-desc', children: translate(t, 'row.unavailable') })
                                : null,
                        ],
                    }),
                    jsx(Control, {
                        checked: enabled,
                        onChange: toggle,
                        disabled,
                        label: translate(t, 'row.title'),
                        className: 'dsh-ata-switch',
                    }),
                ],
            });
        }

        /**
         * Required client services: slot ledger and dictionaries.
         *
         * `settingsScope` is deliberately NOT declared here. It exists in dsh 0.1.5-rc.1
         * but was removed in 0.1.7-rc.2 (settings moved into the profile plugin config),
         * and declaring a service the runtime does not provide makes the whole client
         * boot fail with "N entry did not activate / pending (waiting for service: ...)".
         * The settings transports are attached with `ctx.inject([...], cb)` inside
         * `apply` instead (dshmarket's own pattern), so the row mounts the moment one of
         * them registers: on the real page our `apply` runs BEFORE them (plugins boot in
         * parallel), where a synchronous lookup finds nothing at all.
         */
        const inject = ['slots', 'locale'];

        /**
         * How long the Web UI plugin group gets to appear before the row binds the native
         * shared form instead of the group's binder.
         *
         * The group's `webUiSettings` service is registered by a DIFFERENT plugin and the
         * two bundles boot in parallel, so "this deployment has no group" and "the group
         * is not here YET" look identical for a moment. This window tells them apart.
         */
        const FAMILY_GRACE_MS = 2000;

        /**
         * Resolve one service that may not be registered yet.
         *
         * Never throws: the runtime's service proxy rejects an undeclared access, and a
         * missing service is a supported state here (the other dsh line's service is
         * absent by design).
         * @param ctx - a client context (the plugin's own or an injected child).
         * @param name - service name.
         * @returns the service, or undefined.
         */
        function serviceOf(ctx, name) {
            if (ctx === undefined || ctx === null || typeof ctx.get !== 'function') return undefined;
            try {
                return ctx.get(name);
            } catch {
                return undefined;
            }
        }

        /**
         * First candidate profile entry whose native shared form is usable.
         *
         * The entry id and the package name need not be the same string (the patch layer
         * writes `- id: agent-teams-approval / name: dsh-agent-teams-approval`), so every
         * candidate is tried in order.
         * @param forms - the `configForms` service.
         * @param ids - candidate profile entry ids.
         * @returns the form (a snapshot source), or undefined.
         */
        function firstUsableForm(forms, ids) {
            if (forms === undefined || forms === null || typeof forms.get !== 'function') return undefined;
            for (const id of ids) {
                let form;
                try {
                    form = forms.get(id);
                } catch {
                    continue;
                }
                if (form !== undefined && form !== null
                    && typeof form.getSnapshot === 'function' && typeof form.set === 'function') {
                    return form;
                }
            }
            return undefined;
        }

        /**
         * Mount the row.
         *
         * Every settings transport this build can use is attached with `ctx.inject`, and
         * the FIRST one to arrive wins. That ordering IS the fix for the real-page bug:
         * plugins boot in parallel, `slots` is up long before the settings services are,
         * and the previous synchronous lookup ran at exactly that moment - found
         * `settingsScope`, `webUiSettings` and `configForms` all absent - and returned,
         * leaving the entry active with no row anywhere.
         *
         * Binding is the ONLY half that moves between the lines: unlike
         * `settings.plugin.item` (removed in 0.1.7, which is why the plugin-card halves
         * must switch seats), the `settings.general.item` row seat still exists on 0.1.7,
         * so the seat and its registration options stay exactly the same everywhere; what
         * was missing on the official desktop was the scope bind, nothing else.
         *
         * @param ctx - client plugin context.
         */
        function apply(ctx) {
            ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'agent-teams-approval: row dictionaries');
            /**
             * Register the General row against one bound scope.
             * @param scope - the bound settings scope.
             */
            const registerRow = (scope) => {
                ctx.slots.inject('settings.general.item', () => ctx.slots.register({
                    name: 'settings.general.item',
                    id: ROW_ID,
                    order: ROW_ORDER,
                    locale: NS,
                    inject: () => ({
                        hooks: { approval: scope },
                        setSkipApproval: (next) => scope.set(FLAG_FIELD, next === true),
                    }),
                }, ApprovalRow));
            };
            /**
             * The single latch. Whichever transport arrives first registers exactly once;
             * every later arrival - and the grace timer - is a no-op. A value without
             * `getSnapshot` is not a settings scope and never latches.
             * @param scope - the candidate snapshot source.
             */
            let mounted = false;
            const mount = (scope) => {
                if (mounted) return;
                if (scope === undefined || scope === null || typeof scope.getSnapshot !== 'function') return;
                mounted = true;
                registerRow(scope);
            };
            /**
             * ① 0.1.5: the host-served `settingsScope`, the community shell's own
             * transport - preferred whenever it exists.
             */
            ctx.inject(['settingsScope'], (scoped) => {
                const legacy = serviceOf(scoped, 'settingsScope');
                if (legacy === undefined || legacy === null || typeof legacy.bind !== 'function') return;
                mount(legacy.bind({ namespace: NS }));
            });
            /**
             * ② 0.1.7 with the Web UI plugin group: the group's binder. The 0.1.7 line is
             * told apart by `configForms` - the group is loaded on 0.1.5 + web-all 0.3.x
             * as well, and binding on THAT signal would be wrong on the community end.
             */
            ctx.inject(['webUiSettings'], (scoped) => {
                if (serviceOf(ctx, 'configForms') === undefined) return;
                const family = serviceOf(scoped, 'webUiSettings');
                if (family === undefined || family === null || typeof family.bind !== 'function') return;
                mount(family.bind({ namespace: NS }));
            });
            /**
             * ③ 0.1.7 without the group: after the grace window, bind the native shared
             * form directly. No `whileServed` gate is needed here: the row seat is
             * declared by the harness itself, and an entry the host does not serve answers
             * with no form at all, so the row is then simply not registered.
             */
            ctx.inject(['configForms'], (scoped) => {
                const forms = serviceOf(scoped, 'configForms');
                const decide = () => {
                    if (mounted) return;
                    const family = serviceOf(ctx, 'webUiSettings');
                    if (family !== undefined && family !== null && typeof family.bind === 'function') {
                        mount(family.bind({ namespace: NS }));
                        return;
                    }
                    mount(firstUsableForm(forms, ENTRY_IDS));
                };
                const family = serviceOf(ctx, 'webUiSettings');
                if (family !== undefined && family !== null && typeof family.bind === 'function') {
                    // The group is already here: do not sit out the grace window.
                    decide();
                    return undefined;
                }
                if (typeof setTimeout !== 'function') {
                    decide();
                    return undefined;
                }
                const timer = setTimeout(decide, FAMILY_GRACE_MS);
                return () => clearTimeout(timer);
            });
        }

        exports.apply = apply;
        exports.inject = inject;
        exports.ApprovalRow = ApprovalRow;
        exports.FLAG_FIELD = FLAG_FIELD;
        exports.ROW_ID = ROW_ID;
        exports.ROW_ORDER = ROW_ORDER;
        exports.SETTINGS_NS = NS;
        exports.dictionaries = DICTIONARIES;
        return module.exports;
    },
});
