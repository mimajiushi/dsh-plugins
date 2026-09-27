/**
 * AgentTeams limits - client half.
 *
 * Hand-authored client bundle (the host serves this file as-is through
 * `/plugins`). Registers ONE card in whichever plugin-card seat the running dsh
 * actually renders: the framework's `settings.plugin.item` keyed slot on the
 * community 0.1.5 line (the same seat dsh-compact-model / dsh-llm-retry-all use),
 * the plugin manager's `plugins.bundle.config` keyed seat on 0.1.7, where
 * `settings.plugin.item` was removed and a registration into it activates cleanly
 * but renders NOWHERE. Dispatch rule: a seat renders a card only while the HOST
 * serves a settings namespace / profile entry with the same key, registered by
 * this plugin's host half; both sides share the literal 'agent-teams-limits'.
 *
 * Reads and writes go through the bound settings scope - `ctx.settingsScope` on
 * 0.1.5, the Web UI group's `webUiSettings` binder (or the native config form) on
 * 0.1.7 - never to the host directly. Write verification reads the RAW user layer
 * (`scope.getSnapshot().user`): a host refusal answers by silently re-reading the
 * mirror and RESOLVING, so only the presence of the key proves the write landed.
 *
 * Only baseline module-table requests are used (react, react/jsx-runtime,
 * @deepseek-ai/dsh-client-ui-primitives for the chevron icon), so no
 * `dsh.client.external` entry is needed.
 *
 * @module dsh-agent-teams-limits/client
 */
window.__ModuleLoader__.load({
    id: 'dsh-agent-teams-limits',
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
        const React = require('react');
        const { jsx, jsxs } = require('react/jsx-runtime');
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        const IconChevronDownOutline14 = primitives.IconChevronDownOutline14;

        /** Settings namespace owned by this plugin's host half (= the card's slot key). */
        const NS = 'agent-teams-limits';
        /** 0.1.5 seat: Settings -> Plugins -> Plugin configuration. */
        const SEAT_LEGACY = 'settings.plugin.item';
        /** 0.1.7 seat: the plugin manager's keyed seat, keyed by the BUNDLE package name. */
        const SEAT_BUNDLE = 'plugins.bundle.config';
        /** The bundle package name the plugin manager keys this plugin's page by. */
        const BUNDLE_KEY = 'dsh-agent-teams-limits';
        /** Profile entry ids the 0.1.7 host may serve this plugin's config under. */
        const ENTRY_IDS = ['agent-teams-limits', 'dsh-agent-teams-limits'];
        const CSS_TAG_ID = 'dsh-agent-teams-limits/Card.css';

        /**
         * The two limits the card edits.
         *
         * `placeholder` is what "leave it empty" means, and it is exactly
         * AgentTeams' own default - the host injects nothing while the field is
         * unset, so an unconfigured install behaves like one without this plugin.
         */
        const FIELDS = [
            {
                field: 'maxMembers',
                id: 'dsh-agent-teams-limits-max-members',
                label: '成员上限',
                min: 1,
                max: 64,
                placeholder: '8',
                hint: '单个团队花名册最多几人。留空 = 用 AgentTeams 自己的默认（8）。超过上限的建队 / 加人请求会被拒绝。',
            },
            {
                field: 'maxConcurrentMembers',
                id: 'dsh-agent-teams-limits-max-concurrent',
                label: '并发上限',
                min: 0,
                max: 32,
                placeholder: '不限',
                hint: '单个团队最多几名成员同时干活；到上限时新任务留在待办、唤醒消息留在邮箱，有空位自动补位。留空或 0 = 不限。',
            },
        ];

        /**
         * Card chrome + field styles: a faithful copy of the framework's
         * `PluginCard.module.css` / Field shapes (same source as
         * dsh-compact-model's and dsh-llm-retry-all's cards), plus one rule for the
         * number inputs which reuses the select's visual box.
         */
        const css = ''
            // --- card shell (mirrors PluginCard.module.css) ---
            + '.dsh-atl-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);'
            + 'border-radius:16px;list-style:none;transition:border-color .16s,background .16s}'
            + '.dsh-atl-card:hover{border-color:var(--dsw-alias-label-dimmed)}'
            + '.dsh-atl-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}'
            + '.dsh-atl-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;'
            + 'background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}'
            + '.dsh-atl-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}'
            + '.dsh-atl-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}'
            + '.dsh-atl-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}'
            + '.dsh-atl-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}'
            + '.dsh-atl-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}'
            + '.dsh-atl-chevronOpen{transform:rotate(180deg)}'
            + '.dsh-atl-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}'
            // --- field (mirrors Field/ValueField in the same package) ---
            + '.dsh-atl-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}'
            + '.dsh-atl-fieldHead{align-items:center;gap:8px;display:flex}'
            + '.dsh-atl-fieldLabel{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;'
            + 'font-weight:500;line-height:1.5}'
            + '.dsh-atl-fieldValue{display:flex;align-items:center;width:100%;min-width:0}'
            + '.dsh-atl-input{appearance:textfield;width:100%;min-width:0;font:inherit;font-size:13px;line-height:1.5;'
            + 'color:var(--dsw-alias-label-primary);height:34px;'
            + 'border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);'
            + 'border-radius:8px;padding:0 12px}'
            + '.dsh-atl-input::-webkit-outer-spin-button,.dsh-atl-input::-webkit-inner-spin-button{appearance:none;margin:0}'
            + '.dsh-atl-input:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}'
            + '.dsh-atl-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}'
            + '.dsh-atl-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;opacity:.6}'
            + '.dsh-atl-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}'
            + '.dsh-atl-warn{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5;padding-top:4px}';
        if (typeof document !== 'undefined'
            && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') === null) {
            const tag = document.createElement('style');
            tag.dataset.plugin = 'dsh-agent-teams-limits';
            tag.dataset.pluginCss = CSS_TAG_ID;
            tag.textContent = css;
            document.head.appendChild(tag);
        }

        /**
         * Look up one field descriptor.
         * @param field - field name.
         * @returns the descriptor, or undefined for an unknown name.
         */
        function fieldOf(field) {
            return FIELDS.find((candidate) => candidate.field === field);
        }

        /**
         * Parse one input value into a write intent.
         * @param text - raw input text.
         * @param field - field name (its range decides validity).
         * @returns `{ kind: 'unset' }` (empty = back to the AgentTeams default),
         *   `{ kind: 'set', value }`, or `{ kind: 'invalid' }`.
         */
        function parseLimitInput(text, field) {
            const descriptor = fieldOf(field);
            if (descriptor === undefined) return { kind: 'invalid' };
            const trimmed = String(text === undefined || text === null ? '' : text).trim();
            if (trimmed === '') return { kind: 'unset' };
            if (!/^\d+$/.test(trimmed)) return { kind: 'invalid' };
            const value = Number.parseInt(trimmed, 10);
            if (!Number.isSafeInteger(value) || value < descriptor.min || value > descriptor.max) return { kind: 'invalid' };
            return { kind: 'set', value };
        }

        /**
         * Resolve the raw stored value of one field.
         * @param snapshot - the scope snapshot.
         * @param field - field name.
         * @returns the number stored in the RAW user layer, or undefined.
         */
        function storedValue(snapshot, field) {
            const user = snapshot !== undefined && snapshot !== null && typeof snapshot === 'object' ? snapshot.user : undefined;
            const value = user !== null && typeof user === 'object' ? user[field] : undefined;
            if (typeof value === 'number' && Number.isFinite(value)) return value;
            if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
            return undefined;
        }

        /**
         * Resolved display state of both limits.
         * @param snapshot - the scope snapshot.
         * @returns `{ maxMembers, maxConcurrentMembers, configured }` where the
         *   numbers are what the HOST will enforce (defaults filled in).
         */
        function resolvedLimits(snapshot) {
            const members = storedValue(snapshot, 'maxMembers');
            const concurrent = storedValue(snapshot, 'maxConcurrentMembers');
            return {
                maxMembers: members === undefined ? 8 : members,
                maxConcurrentMembers: concurrent === undefined ? 0 : concurrent,
                configured: members !== undefined || concurrent !== undefined,
            };
        }

        /**
         * The settings card.
         *
         * `useAgentTeamsLimits` is the renderer-bound selector over the settings
         * scope (`hooks: { agentTeamsLimits: scope }` becomes this prop). Every
         * hook runs unconditionally, before any early return.
         *
         * @param props - the slot's injected face plus the renderer-bound hooks.
         */
        function LimitsCard(props) {
            const useAgentTeamsLimits = props.useAgentTeamsLimits;
            const snapshot = typeof useAgentTeamsLimits === 'function' ? useAgentTeamsLimits((value) => value) : undefined;
            const [open, setOpen] = React.useState(false);
            const [pending, setPending] = React.useState(false);
            const [failure, setFailure] = React.useState('');
            // Draft text per field; null means "follow the snapshot".
            const [drafts, setDrafts] = React.useState({});

            if (snapshot !== undefined && snapshot !== null && snapshot.status === 'unavailable') return null;

            const ready = snapshot !== undefined && snapshot !== null && snapshot.status === 'ready';
            const writable = ready && snapshot.writable === true;
            const limits = resolvedLimits(snapshot);
            const disabled = pending || !writable;

            const subtitle = !ready
                ? '当前连接无法读取该设置。'
                : limits.configured
                    ? '成员上限 ' + limits.maxMembers + '；并发上限 ' + (limits.maxConcurrentMembers === 0 ? '不限' : limits.maxConcurrentMembers) + '。'
                    : '未设置：AgentTeams 默认（8 名成员；并发不限）。';

            const report = (message) => {
                setFailure(message);
                try {
                    console.error('[dsh-agent-teams-limits] settings write failed:', message);
                }
                catch {
                    /* the inline message is the durable channel */
                }
            };

            /**
             * Write one field, then prove the write landed in the raw user layer.
             * @param field - field name.
             * @param raw - the input's current text.
             */
            const commit = (field, raw) => {
                const descriptor = fieldOf(field);
                const intent = parseLimitInput(raw, field);
                if (intent.kind === 'invalid') {
                    report('「' + (descriptor === undefined ? field : descriptor.label) + '」需要 '
                        + descriptor.min + '–' + descriptor.max + ' 的整数，或留空恢复默认。');
                    setDrafts((current) => ({ ...current, [field]: null }));
                    return;
                }
                if (typeof props.setLimit !== 'function') {
                    report('缺少注入的写入函数 setLimit（实际为 ' + typeof props.setLimit + '）');
                    return;
                }
                const stored = storedValue(snapshot, field);
                // No-op guard, keyed on the RAW user layer: a host that ignores an
                // unchanged section would look exactly like a dead control.
                if ((intent.kind === 'unset' && stored === undefined) || (intent.kind === 'set' && stored === intent.value)) {
                    setDrafts((current) => ({ ...current, [field]: null }));
                    setFailure('');
                    return;
                }
                setPending(true);
                setFailure('');
                Promise.resolve()
                    .then(() => props.setLimit(field, intent))
                    .then(() => setDrafts((current) => ({ ...current, [field]: null })))
                    .catch((error) => {
                        report(error !== null && typeof error === 'object' && typeof error.message === 'string'
                            ? error.message
                            : String(error));
                    })
                    .then(() => setPending(false));
            };

            const header = jsxs('button', {
                type: 'button',
                className: 'dsh-atl-header',
                'aria-expanded': open,
                onClick: () => setOpen((value) => !value),
                children: [
                    jsxs('span', {
                        className: 'dsh-atl-headText',
                        children: [
                            jsx('span', { className: 'dsh-atl-name', children: 'Agent Teams 限制' }),
                            jsx('span', { className: 'dsh-atl-description', children: subtitle }),
                        ],
                    }),
                    IconChevronDownOutline14 !== undefined
                        ? jsx(IconChevronDownOutline14, {
                            className: open ? 'dsh-atl-chevron dsh-atl-chevronOpen' : 'dsh-atl-chevron',
                        })
                        : null,
                ],
            });

            const fields = FIELDS.map((descriptor) => {
                const stored = storedValue(snapshot, descriptor.field);
                const draft = drafts[descriptor.field];
                const inputValue = draft !== undefined && draft !== null ? draft : (stored === undefined ? '' : String(stored));
                return jsxs('div', {
                    className: 'dsh-atl-field',
                    key: descriptor.field,
                    children: [
                        jsxs('div', {
                            className: 'dsh-atl-fieldHead',
                            children: jsx('label', {
                                className: 'dsh-atl-fieldLabel',
                                htmlFor: descriptor.id,
                                children: descriptor.label,
                            }),
                        }),
                        jsx('div', {
                            className: 'dsh-atl-fieldValue',
                            children: jsx('input', {
                                id: descriptor.id,
                                className: 'dsh-atl-input',
                                type: 'number',
                                min: descriptor.min,
                                max: descriptor.max,
                                step: 1,
                                inputMode: 'numeric',
                                disabled,
                                value: inputValue,
                                placeholder: descriptor.placeholder,
                                onChange: (event) => {
                                    const next = String(event.target.value);
                                    setDrafts((current) => ({ ...current, [descriptor.field]: next }));
                                },
                                onBlur: () => commit(descriptor.field, inputValue),
                                onKeyDown: (event) => {
                                    if (event.key === 'Enter') {
                                        event.preventDefault();
                                        commit(descriptor.field, inputValue);
                                    }
                                },
                            }),
                        }),
                        jsx('p', { className: 'dsh-atl-hint', children: descriptor.hint }),
                    ],
                });
            });

            const body = !open ? null : jsxs('div', {
                className: 'dsh-atl-body',
                children: [
                    ...fields,
                    jsx('p', {
                        className: 'dsh-atl-hint',
                        children: '两项都在改完后立即生效（不需要重启）：成员上限由 AgentTeams 自己的判定执行，'
                            + '并发上限由本地补丁 patch-agent-teams-limits.mjs 加进它的调度器执行。',
                    }),
                    pending
                        ? jsx('p', { className: 'dsh-atl-hint', children: '正在写入…' })
                        : null,
                    failure !== ''
                        ? jsx('p', { className: 'dsh-atl-warn', role: 'alert', children: '写入失败：' + failure })
                        : null,
                ],
            });

            return jsxs('li', {
                className: open ? 'dsh-atl-card dsh-atl-cardOpen' : 'dsh-atl-card',
                children: [header, body],
            });
        }

        /**
         * Required client services: the slot ledger.
         *
         * `settingsScope` is deliberately NOT declared here: declaring a service the
         * runtime does not provide makes the whole client boot fail with
         * "N entry did not activate / pending (waiting for service: ...)". The
         * settings transports are attached with `ctx.inject([...], cb)` inside
         * `apply` instead, because plugins boot in parallel and a synchronous
         * lookup at mount time finds nothing.
         */
        const inject = ['slots'];

        /**
         * Resolve one service that may not be registered yet.
         * @param ctx - a client context.
         * @param name - service name.
         * @returns the service, or undefined.
         */
        function serviceOf(ctx, name) {
            if (ctx === undefined || ctx === null || typeof ctx.get !== 'function') return undefined;
            try {
                return ctx.get(name);
            }
            catch {
                return undefined;
            }
        }

        /**
         * First candidate profile entry whose native shared form is usable.
         * @param forms - the `configForms` service.
         * @param ids - candidate profile entry ids.
         * @returns the form, or undefined.
         */
        function firstUsableForm(forms, ids) {
            if (forms === undefined || forms === null || typeof forms.get !== 'function') return undefined;
            for (const id of ids) {
                let form;
                try {
                    form = forms.get(id);
                }
                catch {
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
         * @param ctx - client plugin context.
         */
        function apply(ctx) {
            /**
             * Refuse to let a write fail silently.
             * @param scope - the bound settings scope.
             * @param field - field name.
             * @param intent - the write intent that was submitted.
             */
            const assertStored = (scope, field, intent) => {
                const actual = storedValue(scope.getSnapshot(), field);
                const settled = intent.kind === 'unset' ? actual === undefined : actual === intent.value;
                if (settled) return;
                throw new Error(
                    '该项没有被接受：期望 ' + (intent.kind === 'unset' ? '清空' : JSON.stringify(intent.value))
                    + '，实际 ' + (actual === undefined ? '未设置' : JSON.stringify(actual))
                    + '（宿主拒绝了这次写入）',
                );
            };

            /**
             * Register the card in the seat the RUNNING dsh actually renders.
             *
             * The line is told apart by `configForms` - 0.1.7's value service, which
             * replaced the settings store and appears in no 0.1.5 package. On 0.1.5
             * nothing changes: same seat, same key. On 0.1.7 the card goes to the
             * plugin manager's keyed seat, whose key is the BUNDLE package name, gated
             * by `whileServed` so a deployment that serves no config form for this
             * entry shows no dead card.
             *
             * @param scope - the bound settings scope.
             */
            const registerCard = (scope) => {
                const forms = serviceOf(ctx, 'configForms');
                const face = () => ({
                    hooks: { agentTeamsLimits: scope },
                    setLimit: (field, intent) => {
                        const write = intent.kind === 'unset' ? scope.unset(field) : scope.set(field, intent.value);
                        return write.then(() => assertStored(scope, field, intent));
                    },
                });
                if (forms === undefined || forms === null) {
                    ctx.slots.inject(SEAT_LEGACY, () => ctx.slots.register({
                        name: SEAT_LEGACY,
                        key: NS,
                        inject: face,
                    }, LimitsCard));
                    return;
                }
                const mountSeat = () => ctx.slots.inject(SEAT_BUNDLE, () => ctx.slots.register({
                    name: SEAT_BUNDLE,
                    key: BUNDLE_KEY,
                    inject: face,
                }, LimitsCard));
                const gated = () => (typeof forms.whileServed === 'function'
                    ? forms.whileServed(ENTRY_IDS, mountSeat)
                    : mountSeat());
                if (typeof ctx.effect === 'function') ctx.effect(gated, NS + ': plugins-page card');
                else gated();
            };

            /**
             * The single latch: whichever transport arrives first registers exactly
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

            // ① 0.1.5: the host-served `settingsScope` - the community shell's own transport.
            ctx.inject(['settingsScope'], (scoped) => {
                const legacy = serviceOf(scoped, 'settingsScope');
                if (legacy === undefined || legacy === null || typeof legacy.bind !== 'function') return;
                mount(legacy.bind({ namespace: NS }));
            });
            // ② 0.1.7 with the Web UI plugin group: prefer the group's binder.
            ctx.inject(['webUiSettings'], (scoped) => {
                if (serviceOf(ctx, 'configForms') === undefined) return;
                const family = serviceOf(scoped, 'webUiSettings');
                if (family === undefined || family === null || typeof family.bind !== 'function') return;
                mount(family.bind({ namespace: NS }));
            });
            // ③ 0.1.7 without the group: the native shared form, resolved by ENTRY ID.
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
        exports.LimitsCard = LimitsCard;
        exports.parseLimitInput = parseLimitInput;
        exports.resolvedLimits = resolvedLimits;
        exports.storedValue = storedValue;
        exports.FIELDS = FIELDS;
        exports.NS = NS;
        exports.CSS_TAG_ID = CSS_TAG_ID;
        return module.exports;
    },
});
