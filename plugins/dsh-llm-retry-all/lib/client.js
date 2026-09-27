/**
 * Retry-all gateway errors - client half.
 *
 * Hand-authored client bundle (the host serves this file as-is through
 * `/plugins`). Registers ONE card in whichever plugin-card seat the running dsh
 * actually renders - the framework's `settings.plugin.item` keyed slot (the same
 * seat dsh-compact-model uses) on the community 0.1.5 line, the Web UI plugin
 * group's `web-ui.plugin.item` list seat (or the plugin manager's
 * `plugins.bundle.config` keyed seat) on 0.1.7, where `settings.plugin.item` was
 * removed and a registration into it activates cleanly but renders NOWHERE.
 * Dispatch rule: a seat renders a card only when the HOST serves a settings
 * namespace / profile entry with the same key, registered by this plugin's host
 * half; both sides share the literal 'dsh-llm-retry-all'.
 *
 * Reads and writes go through the bound settings scope - `ctx.settingsScope` on
 * 0.1.5, the Web UI group's `webUiSettings` binder (or the native config form)
 * on 0.1.7 - never to the host directly. Write verification reads the RAW user
 * layer (`scope.getSnapshot().user`): `SettingsScopeController.mutate` answers a
 * host refusal by silently re-reading the mirror and RESOLVING, so only the
 * presence of the key in the user layer proves the write landed.
 *
 * Only baseline module-table requests are used (react, react/jsx-runtime,
 * @deepseek-ai/dsh-client-ui-primitives for the chevron icon), so no
 * `dsh.client.external` entry is needed.
 *
 * @module dsh-llm-retry-all/client
 */
window.__ModuleLoader__.load({
    id: 'dsh-llm-retry-all',
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
        const React = require('react');
        const { jsx, jsxs } = require('react/jsx-runtime');
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        const IconChevronDownOutline14 = primitives.IconChevronDownOutline14;

        /** Settings namespace owned by this plugin's host half (= the card's slot key). */
        const NS = 'dsh-llm-retry-all';
        /**
         * The seats a plugin settings card can live in, per dsh line.
         *
         * `settings.plugin.item` is the 0.1.5 seat (Settings -> Plugins -> Plugin
         * configuration). 0.1.7-rc.2 REMOVED it - web-all 0.4.2's own seat helper
         * records the consequence: "alpha.2 removed the `settings.plugin.item` keyed
         * seat of the `ui-settings-plugins` tab that this helper used before, so a
         * card keyed by its settings namespace has no seat to land in any more." A
         * registration into a seat nobody declares still activates cleanly and
         * renders NOWHERE, which is exactly the "card vanished on the official
         * desktop" report.
         */
        const SEAT_LEGACY = 'settings.plugin.item';
        /**
         * The plugin manager's keyed seat, keyed by the BUNDLE package name - the seat
         * 0.1.7 actually renders third-party cards in (dsh-context's card is served and
         * visible there). The Web UI plugin group's own `web-ui.plugin.item` list is NOT
         * used: on the official desktop that section renders no third-party card at all,
         * so a registration there is invisible.
         */
        const SEAT_BUNDLE = 'plugins.bundle.config';
        /** The bundle package name the plugin manager keys this plugin's page by. */
        const BUNDLE_KEY = 'dsh-llm-retry-all';
        /**
         * Profile entry ids the 0.1.7 host may serve this plugin's config under. On that
         * line the served namespace IS the entry id, and the bundle's patch layer declares
         * `- id: llm-retry-all / name: dsh-llm-retry-all`; the entry id comes first and
         * the settings namespace stays as the second candidate.
         */
        const ENTRY_IDS = ['llm-retry-all', 'dsh-llm-retry-all'];
        const MAX_RETRIES_FIELD = 'maxRetries';
        const DEFAULT_MAX_RETRIES = 10000;
        const CSS_TAG_ID = 'dsh-llm-retry-all/Card.css';

        /**
         * Card chrome + field styles: a faithful copy of the framework's
         * `PluginCard.module.css` / Field shapes (same source as
         * dsh-compact-model's card), plus one rule for the number input which
         * reuses the select's visual box.
         */
        const css = ''
            // --- card shell (mirrors PluginCard.module.css) ---
            + '.dsh-lra-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);'
            + 'border-radius:16px;list-style:none;transition:border-color .16s,background .16s}'
            + '.dsh-lra-card:hover{border-color:var(--dsw-alias-label-dimmed)}'
            + '.dsh-lra-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}'
            + '.dsh-lra-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;'
            + 'background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}'
            + '.dsh-lra-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}'
            + '.dsh-lra-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}'
            + '.dsh-lra-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}'
            + '.dsh-lra-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}'
            + '.dsh-lra-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}'
            + '.dsh-lra-chevronOpen{transform:rotate(180deg)}'
            + '.dsh-lra-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}'
            // --- field (mirrors Field/ValueField in the same package) ---
            + '.dsh-lra-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}'
            + '.dsh-lra-fieldHead{align-items:center;gap:8px;display:flex}'
            + '.dsh-lra-fieldLabel{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;'
            + 'font-weight:500;line-height:1.5}'
            + '.dsh-lra-fieldValue{display:flex;align-items:center;width:100%;min-width:0}'
            + '.dsh-lra-input{appearance:textfield;width:100%;min-width:0;font:inherit;font-size:13px;line-height:1.5;'
            + 'color:var(--dsw-alias-label-primary);height:34px;'
            + 'border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);'
            + 'border-radius:8px;padding:0 12px}'
            + '.dsh-lra-input::-webkit-outer-spin-button,.dsh-lra-input::-webkit-inner-spin-button{appearance:none;margin:0}'
            + '.dsh-lra-input:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}'
            + '.dsh-lra-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}'
            + '.dsh-lra-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;opacity:.6}'
            + '.dsh-lra-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}'
            + '.dsh-lra-warn{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5;padding-top:4px}';
        if (typeof document !== 'undefined'
            && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') === null) {
            const tag = document.createElement('style');
            tag.dataset.plugin = 'dsh-llm-retry-all';
            tag.dataset.pluginCss = CSS_TAG_ID;
            tag.textContent = css;
            document.head.appendChild(tag);
        }

        /**
         * Parse one input value into a write intent.
         * @param text - raw input text.
         * @returns `{ kind: 'unset' }` (empty = back to default),
         *   `{ kind: 'set', value }`, or `{ kind: 'invalid' }`.
         */
        function parseMaxRetriesInput(text) {
            const trimmed = String(text).trim();
            if (trimmed === '') return { kind: 'unset' };
            if (!/^\d+$/.test(trimmed)) return { kind: 'invalid' };
            const value = Number.parseInt(trimmed, 10);
            if (!Number.isSafeInteger(value)) return { kind: 'invalid' };
            return { kind: 'set', value };
        }

        /** Resolved display value of the section, always a non-negative integer. */
        function resolvedMaxRetries(section) {
            const value = section !== null && typeof section === 'object' ? section[MAX_RETRIES_FIELD] : undefined;
            if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_RETRIES;
            const n = Math.floor(value);
            return n < 0 ? 0 : n;
        }

        /**
         * The settings card.
         *
         * `useLlmRetryAll` is the renderer-bound selector over the settings
         * scope (`hooks: { llmRetryAll: scope }` becomes this prop). Every
         * hook runs unconditionally, before any early return.
         *
         * @param props - the slot's injected face plus the renderer-bound hooks.
         */
        function RetryAllCard(props) {
            const useLlmRetryAll = props.useLlmRetryAll;
            const snapshot = typeof useLlmRetryAll === 'function' ? useLlmRetryAll((value) => value) : undefined;
            const [open, setOpen] = React.useState(false);
            const [pending, setPending] = React.useState(false);
            const [failure, setFailure] = React.useState('');
            // Draft text of the input; null means "follow the snapshot".
            const [draft, setDraft] = React.useState(null);

            if (snapshot !== undefined && snapshot !== null && snapshot.status === 'unavailable') return null;

            const ready = snapshot !== undefined && snapshot !== null && snapshot.status === 'ready';
            const writable = ready && snapshot.writable === true;
            const section = ready && snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {};
            const maxRetries = resolvedMaxRetries(section);
            const disabled = pending || !writable;
            const inputValue = draft !== null ? draft : String(maxRetries);

            const subtitle = !ready
                ? '当前连接无法读取该设置。'
                : maxRetries === 0
                    ? '已关闭（保留内置默认重试：每提供方最多 5 次）。'
                    : '所有网关错误最多重试 ' + maxRetries + ' 次。';

            const report = (message) => {
                setFailure(message);
                try {
                    console.error('[dsh-llm-retry-all] settings write failed:', message);
                }
                catch {
                    /* the inline message is the durable channel */
                }
            };

            const commit = () => {
                const intent = parseMaxRetriesInput(inputValue);
                if (intent.kind === 'invalid') {
                    report('请输入不小于 0 的整数（0 = 关闭本插件），或留空恢复默认 ' + DEFAULT_MAX_RETRIES + '。');
                    setDraft(null);
                    return;
                }
                if (typeof props.setMaxRetries !== 'function') {
                    report('缺少注入的写入函数 setMaxRetries（实际为 ' + typeof props.setMaxRetries + '）');
                    return;
                }
                // No-op guard, keyed on the RAW user layer: the host silently
                // ignores an unchanged section, which would look exactly like
                // a dead control. Empty input when nothing is stored is also
                // a no-op (the default already applies).
                const stored = snapshot.user !== null && typeof snapshot.user === 'object'
                    ? snapshot.user[MAX_RETRIES_FIELD]
                    : undefined;
                if ((intent.kind === 'unset' && stored === undefined)
                    || (intent.kind === 'set' && stored === intent.value)) {
                    setDraft(null);
                    setFailure('');
                    return;
                }
                setPending(true);
                setFailure('');
                Promise.resolve()
                    .then(() => props.setMaxRetries(intent))
                    .then(() => setDraft(null))
                    .catch((error) => {
                        report(error !== null && typeof error === 'object' && typeof error.message === 'string'
                            ? error.message
                            : String(error));
                    })
                    .then(() => setPending(false));
            };

            const header = jsxs('button', {
                type: 'button',
                className: 'dsh-lra-header',
                'aria-expanded': open,
                onClick: () => setOpen((value) => !value),
                children: [
                    jsxs('span', {
                        className: 'dsh-lra-headText',
                        children: [
                            jsx('span', { className: 'dsh-lra-name', children: '模型重试（网关全错误）' }),
                            jsx('span', { className: 'dsh-lra-description', children: subtitle }),
                        ],
                    }),
                    IconChevronDownOutline14 !== undefined
                        ? jsx(IconChevronDownOutline14, {
                            className: open ? 'dsh-lra-chevron dsh-lra-chevronOpen' : 'dsh-lra-chevron',
                        })
                        : null,
                ],
            });

            const body = !open ? null : jsxs('div', {
                className: 'dsh-lra-body',
                children: [
                    jsxs('div', {
                        className: 'dsh-lra-field',
                        children: [
                            jsx('div', {
                                className: 'dsh-lra-fieldHead',
                                children: jsx('label', {
                                    className: 'dsh-lra-fieldLabel',
                                    htmlFor: 'dsh-llm-retry-all-max-retries',
                                    children: '最大重试次数',
                                }),
                            }),
                            jsx('div', {
                                className: 'dsh-lra-fieldValue',
                                children: jsx('input', {
                                    id: 'dsh-llm-retry-all-max-retries',
                                    className: 'dsh-lra-input',
                                    type: 'number',
                                    min: 0,
                                    step: 1,
                                    inputMode: 'numeric',
                                    disabled,
                                    value: inputValue,
                                    placeholder: String(DEFAULT_MAX_RETRIES),
                                    onChange: (event) => setDraft(String(event.target.value)),
                                    onBlur: commit,
                                    onKeyDown: (event) => {
                                        if (event.key === 'Enter') {
                                            event.preventDefault();
                                            commit();
                                        }
                                    },
                                }),
                            }),
                            jsx('p', {
                                className: 'dsh-lra-hint',
                                children: '第 1 次重试等 5s，之后每次多等 5s（5s、10s、15s…），单次等待封顶 5 分钟。'
                                    + '429、没额度、鉴权失败、断网等所有网关错误都会重试，压缩（compact）内部出错同样重试；'
                                    + '手动取消不重试。0 = 关闭本插件（保留内置默认重试），留空 = 恢复默认 ' + DEFAULT_MAX_RETRIES + '。',
                            }),
                        ],
                    }),
                    pending
                        ? jsx('p', { className: 'dsh-lra-hint', children: '正在写入…' })
                        : null,
                    failure !== ''
                        ? jsx('p', { className: 'dsh-lra-warn', role: 'alert', children: '写入失败：' + failure })
                        : null,
                ],
            });

            return jsxs('li', {
                className: open ? 'dsh-lra-card dsh-lra-cardOpen' : 'dsh-lra-card',
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
         * writes `- id: llm-retry-all / name: dsh-llm-retry-all`), so every candidate is
         * tried in order.
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
         * and the previous synchronous lookup ran at exactly that moment - found
         * `settingsScope`, `webUiSettings` and `configForms` all absent - and returned,
         * leaving the entry active with no card anywhere (the stylesheet is injected at
         * module load time, which is why the page had our CSS but no card).
         *
         * @param ctx - client plugin context.
         */
        function apply(ctx) {
            /**
             * Read one field back from the RAW user layer (see module header).
             * @param scope - the bound settings scope.
             * @param field - field name.
             * @returns the stored value, or undefined when the key is absent.
             */
            const storedField = (scope, field) => {
                const user = scope.getSnapshot().user;
                if (user === null || typeof user !== 'object') return undefined;
                return user[field];
            };

            /**
             * Refuse to let a write fail silently.
             * @param scope - the bound settings scope.
             * @param intent - the write intent that was submitted.
             */
            const assertStored = (scope, intent) => {
                const actual = storedField(scope, MAX_RETRIES_FIELD);
                const settled = intent.kind === 'unset'
                    ? actual === undefined
                    : actual === intent.value;
                if (settled) return;
                throw new Error(
                    'maxRetries 没有被接受：期望 '
                    + (intent.kind === 'unset' ? '清空' : JSON.stringify(intent.value))
                    + '，实际 ' + (actual === undefined ? '未设置' : JSON.stringify(actual))
                    + '（宿主拒绝了这次写入）',
                );
            };

            /**
             * Register the card in the seat the RUNNING dsh actually renders.
             *
             * The line is told apart by `configForms` - 0.1.7's value service, which
             * replaced the settings store and appears in no 0.1.5 package. On 0.1.5
             * nothing changes: same seat, same key. On 0.1.7 the card goes to the plugin
             * manager's keyed seat, whose key is the BUNDLE package name (dshmarket's
             * note: "The package name the host keys a bundle's own configuration by ...
             * not the same string as the locale namespace") - the seat dsh-context's own
             * card is served in. It is gated by `whileServed` so a deployment that serves
             * no config form for this entry shows no dead card.
             *
             * The card slot itself is declared by another package (on 0.1.5
             * dsh-client-ui-settings-plugins, on 0.1.7 the plugin manager), which
             * dsh.client.inject does NOT name: a bare register can throw "slot not
             * declared" and the card would silently never render. Both branches register
             * through the declaration barrier (`ctx.slots.inject`).
             *
             * @param scope - the bound settings scope.
             */
            const registerCard = (scope) => {
                const forms = serviceOf(ctx, 'configForms');
                const face = () => ({
                    hooks: { llmRetryAll: scope },
                    setMaxRetries: (intent) => {
                        const write = intent.kind === 'unset'
                            ? scope.unset(MAX_RETRIES_FIELD)
                            : scope.set(MAX_RETRIES_FIELD, intent.value);
                        return write.then(() => assertStored(scope, intent));
                    },
                });
                if (forms === undefined || forms === null) {
                    ctx.slots.inject(SEAT_LEGACY, () => ctx.slots.register({
                        name: SEAT_LEGACY,
                        key: NS,
                        inject: face,
                    }, RetryAllCard));
                    return;
                }
                const mountSeat = () => ctx.slots.inject(SEAT_BUNDLE, () => ctx.slots.register({
                    name: SEAT_BUNDLE,
                    key: BUNDLE_KEY,
                    inject: face,
                }, RetryAllCard));
                const gated = () => (typeof forms.whileServed === 'function'
                    ? forms.whileServed(ENTRY_IDS, mountSeat)
                    : mountSeat());
                if (typeof ctx.effect === 'function') ctx.effect(gated, NS + ': plugins-page card');
                else gated();
            };
            /**
             * The single latch. Whichever transport arrives first registers exactly
             * once; every later arrival is a no-op. A value without `getSnapshot` is not
             * a settings scope and never latches.
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
             * transport - preferred whenever it exists.
             */
            ctx.inject(['settingsScope'], (scoped) => {
                const legacy = serviceOf(scoped, 'settingsScope');
                if (legacy === undefined || legacy === null || typeof legacy.bind !== 'function') return;
                mount(legacy.bind({ namespace: NS }));
            });
            /**
             * ② 0.1.7 with the Web UI plugin group: prefer the group's binder as the scope
             * SOURCE - it resolves the namespace through the profile entry and answers with
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
        exports.RetryAllCard = RetryAllCard;
        exports.parseMaxRetriesInput = parseMaxRetriesInput;
        exports.resolvedMaxRetries = resolvedMaxRetries;
        exports.CSS_TAG_ID = CSS_TAG_ID;
        return module.exports;
    },
});
