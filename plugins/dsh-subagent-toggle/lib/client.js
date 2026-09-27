/**
 * Subagent capability toggle for DeepSeek Harness — client half.
 *
 * Hand-authored client bundle (the host serves this file as-is through
 * `/plugins`). It registers ONE card in whichever plugin-card seat the running dsh
 * actually renders — the framework's `settings.plugin.item` keyed slot on the
 * community 0.1.5 line, the plugin manager's `plugins.bundle.config` keyed seat on
 * 0.1.7, where `settings.plugin.item` was removed and a registration into it renders
 * NOWHERE (the seat dsh-context's own card is served in).
 *
 * Dispatch rule worth knowing when debugging a missing card: the Plugins tab
 * renders a card only when the HOST serves a settings namespace with the same
 * key. That namespace is registered by this plugin's host half, so the card
 * and the host registration must keep the identical literal
 * (`dsh-subagent-toggle`).
 *
 * CHROME CONTRACT: the core cards are built by
 * `@deepseek-ai/dsh-client-ui-settings-plugins`' own `PluginCard`, whose class
 * names and design tokens are reproduced here verbatim (hashed prefix
 * `YyYd_a_` in the packaged bundle). This file may NOT import that component —
 * it is not a seed module — so the card shell is re-declared locally.
 *
 * WRITE PATH RULES (learned from a sibling plugin's silent-failure bug):
 *   - `scope.set` NEVER rejects: the scope controller answers a host refusal
 *     with a silent mirror reload and a resolved promise. The only reliable
 *     acceptance test is reading the raw user layer back from
 *     `scope.getSnapshot().user` and comparing.
 *   - Never swallow a write with a bare `.catch` that returns undefined;
 *     failures are shown in the card AND logged.
 *   - Never submit a no-op write: the host treats an unchanged raw section as
 *     completely invisible (no persist, no watcher, no log), which reads as a
 *     dead control.
 *
 * Only baseline module-table requests are used (react, react/jsx-runtime,
 * @deepseek-ai/dsh-client-ui-primitives), so no `dsh.client.external` entry is
 * needed; `dsh.client.inject` guarantees the settings UI is mounted first.
 *
 * @module dsh-subagent-toggle/client
 */
window.__ModuleLoader__.load({
    id: 'dsh-subagent-toggle',
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
        const React = require('react');
        const { jsx, jsxs } = require('react/jsx-runtime');
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        const Switch = primitives.Switch;
        const IconChevronDownOutline14 = primitives.IconChevronDownOutline14;

        /** Settings namespace owned by this plugin's host half (= the card's slot key). */
        const NS = 'dsh-subagent-toggle';
        /**
         * The seats a plugin settings card can live in, per dsh line.
         *
         * `settings.plugin.item` is the 0.1.5 seat (Settings → Plugins → Plugin
         * configuration). 0.1.7-rc.2 REMOVED it — web-all 0.4.2's own seat helper
         * records the consequence: "alpha.2 removed the `settings.plugin.item` keyed
         * seat of the `ui-settings-plugins` tab that this helper used before, so a
         * card keyed by its settings namespace has no seat to land in any more." A
         * registration into a seat nobody declares still activates cleanly and
         * renders NOWHERE, which is exactly the "card vanished on the official
         * desktop" report.
         */
        const SEAT_LEGACY = 'settings.plugin.item';
        /**
         * The plugin manager's keyed seat, keyed by the BUNDLE package name — the seat
         * 0.1.7 actually renders third-party cards in (dsh-context's card is served and
         * visible there). The Web UI plugin group's own `web-ui.plugin.item` list is NOT
         * used: on the official desktop that section renders no third-party card at all,
         * so a registration there is invisible.
         */
        const SEAT_BUNDLE = 'plugins.bundle.config';
        /** The bundle package name the plugin manager keys this plugin's page by. */
        const BUNDLE_KEY = 'dsh-subagent-toggle';
        /**
         * Profile entry ids the 0.1.7 host may serve this plugin's config under. On that
         * line the served namespace IS the entry id (the patch layer declares
         * `- id: subagent-toggle / name: dsh-subagent-toggle`), so the entry id comes
         * first and the settings namespace stays as the second candidate.
         */
        const ENTRY_IDS = ['subagent-toggle', 'dsh-subagent-toggle'];
        const ENABLED_FIELD = 'enabled';
        const CSS_TAG_ID = 'dsh-subagent-toggle/Card.css';

        /**
         * Card chrome + toggle row styles.
         *
         * The `dsh-sat-card`..`dsh-sat-chevronOpen` block is a faithful copy of
         * the framework's `PluginCard.module.css`; `dsh-sat-toggleRow` /
         * `dsh-sat-toggleLabel` mirror `SubagentModelSelectionCard.module.css`
         * from the same package. Keep the class shapes in sync with that file
         * when the framework's card chrome changes.
         */
        const css = ''
            // --- card shell (mirrors PluginCard.module.css) ---
            + '.dsh-sat-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);'
            + 'border-radius:16px;list-style:none;transition:border-color .16s,background .16s}'
            + '.dsh-sat-card:hover{border-color:var(--dsw-alias-label-dimmed)}'
            + '.dsh-sat-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}'
            + '.dsh-sat-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;'
            + 'background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}'
            + '.dsh-sat-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}'
            + '.dsh-sat-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}'
            + '.dsh-sat-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}'
            + '.dsh-sat-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}'
            + '.dsh-sat-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}'
            + '.dsh-sat-chevronOpen{transform:rotate(180deg)}'
            + '.dsh-sat-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}'
            // --- toggle row (mirrors SubagentModelSelectionCard.module.css) ---
            + '.dsh-sat-permission{gap:6px;padding:12px 0;display:grid}'
            + '.dsh-sat-toggleRow{color:var(--dsw-alias-label-primary);justify-content:space-between;'
            + 'align-items:flex-start;gap:16px;font-size:13px;line-height:1.5;display:flex}'
            + '.dsh-sat-toggleLabel{flex:1;min-width:0}'
            + '.dsh-sat-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}'
            + '.dsh-sat-warn{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5;padding-top:4px}';
        if (typeof document !== 'undefined'
            && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') === null) {
            const tag = document.createElement('style');
            tag.dataset.plugin = 'dsh-subagent-toggle';
            tag.dataset.pluginCss = CSS_TAG_ID;
            tag.textContent = css;
            document.head.appendChild(tag);
        }

        /**
         * Read the effective on/off state from a scope snapshot.
         *
         * The RESOLVED value (`snapshot.value`) is the display source: it
         * already folds the base default in, so a section nobody ever wrote
         * still reads as ON. Only an explicit `enabled: false` is OFF — the
         * same rule the host guard enforces in `parsePolicy`.
         * @param snapshot - the settings scope snapshot.
         * @returns whether the subagent capability is on.
         */
        function readEnabled(snapshot) {
            if (snapshot === undefined || snapshot === null) return true;
            const section = snapshot.value;
            if (section === null || typeof section !== 'object') return true;
            return section[ENABLED_FIELD] !== false;
        }

        /**
         * The settings card.
         *
         * `useSubagentToggle` is the renderer-bound selector over the settings
         * scope (`hooks: { subagentToggle: scope }` becomes the
         * `useSubagentToggle` prop). Every hook runs unconditionally, before
         * any early return.
         *
         * @param props - the slot's injected face plus the renderer-bound hooks.
         * @returns the card, or nothing when the host serves no such namespace.
         */
        function SubagentToggleCard(props) {
            const useSubagentToggle = props.useSubagentToggle;
            const snapshot = typeof useSubagentToggle === 'function' ? useSubagentToggle((value) => value) : undefined;
            const [open, setOpen] = React.useState(false);
            const [pending, setPending] = React.useState(false);
            const [failure, setFailure] = React.useState('');

            if (snapshot !== undefined && snapshot !== null && snapshot.status === 'unavailable') return null;

            const ready = snapshot !== undefined && snapshot !== null && snapshot.status === 'ready';
            const writable = ready && snapshot.writable === true;
            const enabled = readEnabled(snapshot);
            const disabled = pending || !writable || Switch === undefined;

            /** Describe a value for the missing-seat message. */
            const describe = (value) => {
                if (value === null) return 'null';
                if (value === undefined) return 'undefined';
                return typeof value;
            };
            /**
             * Report a write that could not even be attempted: a missing
             * injected seat is a wiring bug, and silence here is what once made
             * a sibling plugin's "the click did nothing" report undiagnosable.
             * @param seat - the injected prop that was expected.
             * @param detail - what the value actually was.
             */
            const reportMissingSeat = (seat, detail) => {
                setFailure('缺少注入的写入函数 ' + seat + '（实际为 ' + detail + '）');
                try {
                    console.error('[dsh-subagent-toggle] missing injected seat:', seat, detail);
                }
                catch {
                    /* the inline message is the durable channel */
                }
            };
            /**
             * Run one write, surfacing any failure in the card and the console.
             * @param operations - the write thunk.
             */
            const run = (operations) => {
                setPending(true);
                setFailure('');
                Promise.resolve()
                    .then(operations)
                    .catch((error) => {
                        const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
                            ? error.message
                            : String(error);
                        setFailure(message);
                        try {
                            console.error('[dsh-subagent-toggle] settings write failed:', error);
                        }
                        catch {
                            /* a shell without console still gets the inline message */
                        }
                    })
                    .then(() => {
                        setPending(false);
                    });
            };
            const toggle = (next) => {
                if (next === enabled) return;
                if (typeof props.setEnabled !== 'function') {
                    reportMissingSeat('setEnabled', describe(props.setEnabled));
                    return;
                }
                run(() => props.setEnabled(next));
            };

            const subtitle = !ready
                ? '当前连接无法读取该设置。'
                : enabled
                    ? 'subagent 能力已开启（默认）。'
                    : 'subagent 能力已关闭：模型调用 subagent 类工具会被提示改用 Agent Teams。';

            const header = jsxs('button', {
                type: 'button',
                className: 'dsh-sat-header',
                'aria-expanded': open,
                onClick: () => setOpen((value) => !value),
                children: [
                    jsxs('span', {
                        className: 'dsh-sat-headText',
                        children: [
                            jsx('span', { className: 'dsh-sat-name', children: 'Subagent 开关' }),
                            jsx('span', { className: 'dsh-sat-description', children: subtitle }),
                        ],
                    }),
                    IconChevronDownOutline14 !== undefined
                        ? jsx(IconChevronDownOutline14, {
                            className: open ? 'dsh-sat-chevron dsh-sat-chevronOpen' : 'dsh-sat-chevron',
                        })
                        : null,
                ],
            });

            const body = !open ? null : jsxs('div', {
                className: 'dsh-sat-body',
                children: [
                    jsxs('div', {
                        className: 'dsh-sat-permission',
                        children: [
                            jsxs('div', {
                                className: 'dsh-sat-toggleRow',
                                children: [
                                    jsx('span', {
                                        className: 'dsh-sat-toggleLabel',
                                        children: '启用 subagent 能力',
                                    }),
                                    Switch !== undefined
                                        ? jsx(Switch, {
                                            checked: enabled,
                                            label: '启用 subagent 能力',
                                            disabled,
                                            onChange: toggle,
                                        })
                                        : null,
                                ],
                            }),
                            jsx('p', {
                                className: 'dsh-sat-hint',
                                children: enabled
                                    ? '关闭后，subagent / subagent_fork / workflow / ralph / list_subagent_models / send_message 的调用会被拦截，'
                                        + '模型会收到改用 Agent Teams 的提示。'
                                    : '已拦截：subagent / subagent_fork / workflow / ralph / list_subagent_models / send_message。'
                                        + 'Agent Teams（agent_teams_*）、list_agents、interrupt_agent 不受影响。',
                            }),
                        ],
                    }),
                    jsx('p', {
                        className: 'dsh-sat-hint',
                        children: '开关立即生效，无需重启或新建会话。宿主内部的记忆整理、goal 续跑与任务看板不属于 subagent 能力，不受影响。',
                    }),
                    pending
                        ? jsx('p', { className: 'dsh-sat-hint', children: '正在写入…' })
                        : null,
                    failure !== ''
                        ? jsx('p', {
                            className: 'dsh-sat-warn',
                            role: 'alert',
                            children: '写入失败：' + failure,
                        })
                        : null,
                ],
            });

            return jsxs('li', {
                className: open ? 'dsh-sat-card dsh-sat-cardOpen' : 'dsh-sat-card',
                children: [header, body],
            });
        }

        /**
         * Required client services: the slot ledger.
         *
         * `settingsScope` is deliberately NOT declared here. It exists in dsh 0.1.5-rc.1
         * but was removed in 0.1.7-rc.2 (settings moved into the profile plugin config),
         * and declaring a service the runtime does not provide makes the whole client
         * boot fail with "N entry did not activate / pending (waiting for service: ...)".
         * The settings transports are attached with `ctx.inject([...], cb)` inside
         * `apply` instead (dshmarket's own pattern), so the card mounts the moment one of
         * them registers: on the real page our `apply` runs BEFORE them (plugins boot in
         * parallel), where a synchronous lookup finds nothing at all.
         */
        const inject = ['slots'];

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
         * writes `- id: subagent-toggle / name: dsh-subagent-toggle`), so every candidate
         * is tried in order.
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
         * Mount the card.
         *
         * Every settings transport this build can use is attached with `ctx.inject`, and
         * the FIRST one to arrive wins. That ordering IS the fix for the real-page bug:
         * plugins boot in parallel, `slots` is up long before the settings services are,
         * and the previous synchronous lookup ran at exactly that moment — found
         * `settingsScope`, `webUiSettings` and `configForms` all absent — and returned,
         * leaving the entry active with no card anywhere (the stylesheet is injected at
         * module load time, which is why the page had our CSS but no card). the local gate harness
         * cannot reproduce it because there every service is provided up front.
         *
         * @param ctx - client plugin context.
         */
        function apply(ctx) {
            /**
             * Read one field from the RAW user layer. Scope writes never
             * reject, so presence in `user` is the only reliable evidence that
             * the host accepted a write.
             * @param scope - the bound settings scope.
             * @param field - field name.
             * @returns the stored value, or undefined when the key is absent.
             */
            const storedField = (scope, field) => {
                const snapshot = scope.getSnapshot();
                const user = snapshot !== null && typeof snapshot === 'object' ? snapshot.user : undefined;
                if (user === null || typeof user !== 'object') return undefined;
                return user[field];
            };
            /**
             * Refuse to let a write fail silently.
             * @param scope - the bound settings scope.
             * @param wanted - the boolean the caller asked to store.
             */
            const assertStored = (scope, wanted) => {
                const actual = storedField(scope, ENABLED_FIELD);
                if (actual === wanted) return;
                throw new Error(
                    'enabled 没有被接受：期望 ' + JSON.stringify(wanted) + '，'
                    + '实际 ' + (actual === undefined ? '未设置' : JSON.stringify(actual))
                    + '（宿主拒绝了这次写入）',
                );
            };
            /**
             * Register the card in the seat the RUNNING dsh actually renders.
             *
             * The line is told apart by `configForms` — 0.1.7's value service, which
             * replaced the settings store and appears in no 0.1.5 package. On 0.1.5
             * nothing changes: same seat, same key. On 0.1.7 the card goes to the plugin
             * manager's keyed seat, whose key is the BUNDLE package name (dshmarket's
             * note: "The package name the host keys a bundle's own configuration by … not
             * the same string as the locale namespace") — the seat dsh-context's own card
             * is served in. It is gated by `whileServed` so a deployment that serves no
             * config form for this entry shows no dead card.
             *
             * @param scope - the bound settings scope.
             */
            const registerCard = (scope) => {
                const forms = serviceOf(ctx, 'configForms');
                const face = () => ({
                    hooks: { subagentToggle: scope },
                    setEnabled: (next) => {
                        // No-op guard: the host treats an unchanged raw section
                        // as completely invisible, so submitting one would read
                        // as a dead control.
                        if (readEnabled(scope.getSnapshot()) === next) return Promise.resolve();
                        return scope.set(ENABLED_FIELD, next).then(() => {
                            assertStored(scope, next);
                        });
                    },
                });
                if (forms === undefined || forms === null) {
                    ctx.slots.inject(SEAT_LEGACY, () => ctx.slots.register({
                        name: SEAT_LEGACY,
                        key: NS,
                        inject: face,
                    }, SubagentToggleCard));
                    return;
                }
                const mountSeat = () => ctx.slots.inject(SEAT_BUNDLE, () => ctx.slots.register({
                    name: SEAT_BUNDLE,
                    key: BUNDLE_KEY,
                    inject: face,
                }, SubagentToggleCard));
                const gated = () => (typeof forms.whileServed === 'function'
                    ? forms.whileServed(ENTRY_IDS, mountSeat)
                    : mountSeat());
                if (typeof ctx.effect === 'function') ctx.effect(gated, NS + ': plugins-page card');
                else gated();
            };
            /**
             * The single latch. Whichever transport arrives first registers exactly
             * once; every later arrival is a no-op. A value without `getSnapshot` is
             * not a settings scope and never latches.
             * @param scope - the candidate snapshot source.
             */
            let mounted = false;
            const mount = (scope) => {
                if (mounted) return;
                if (scope === undefined || scope === null || typeof scope.getSnapshot !== 'function') return;
                mounted = true;
                registerCard(scope);
            };
            /**
             * ① 0.1.5: the host-served `settingsScope`, the community shell's own
             * transport — preferred whenever it exists.
             */
            ctx.inject(['settingsScope'], (scoped) => {
                const legacy = serviceOf(scoped, 'settingsScope');
                if (legacy === undefined || legacy === null || typeof legacy.bind !== 'function') return;
                mount(legacy.bind({ namespace: NS }));
            });
            /**
             * ② 0.1.7 with the Web UI plugin group: prefer the group's binder as the scope
             * SOURCE — it resolves the namespace through the profile entry and answers with
             * the same snapshot shape. The seat does not depend on it
             * (`plugins.bundle.config` either way); the line is told apart by
             * `configForms`, which no 0.1.5 package mentions, because the group is loaded
             * on 0.1.5 + web-all 0.3.x as well.
             */
            ctx.inject(['webUiSettings'], (scoped) => {
                if (serviceOf(ctx, 'configForms') === undefined) return;
                const family = serviceOf(scoped, 'webUiSettings');
                if (family === undefined || family === null || typeof family.bind !== 'function') return;
                mount(family.bind({ namespace: NS }));
            });
            /**
             * ③ 0.1.7 without the group: bind the native shared form, resolved by ENTRY ID
             * (on that line the served namespace IS the entry id). If the group turns out
             * to be present after all, its binder wins instead.
             */
            ctx.inject(['configForms'], (scoped) => {
                const forms = serviceOf(scoped, 'configForms');
                const family = serviceOf(ctx, 'webUiSettings');
                if (family !== undefined && family !== null && typeof family.bind === 'function') {
                    mount(family.bind({ namespace: NS }));
                    return;
                }
                mount(firstUsableForm(forms, ENTRY_IDS));
            });
        }

        exports.apply = apply;
        exports.inject = inject;
        exports.SubagentToggleCard = SubagentToggleCard;
        exports.readEnabled = readEnabled;
        exports.CSS_TAG_ID = CSS_TAG_ID;
        exports.SETTINGS_NS = NS;
        exports.ENABLED_FIELD = ENABLED_FIELD;
        return module.exports;
    },
});
