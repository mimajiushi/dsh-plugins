/**
 * Compaction-model override for DeepSeek Harness - client half.
 *
 * Hand-authored client bundle (the host serves this file as-is through
 * `/plugins`). It registers ONE card in whichever plugin-card seat the running
 * dsh actually renders - the framework's `settings.plugin.item` keyed slot on
 * the community 0.1.5 line, the plugin manager's `plugins.bundle.config` keyed
 * seat on 0.1.7, where `settings.plugin.item` was removed and a registration
 * into it renders NOWHERE (the same seat dsh-context's card is served in).
 *
 * Dispatch rule worth knowing when debugging a missing card: a seat renders a
 * card only when the HOST serves a settings namespace / profile entry with the
 * same key. That namespace is registered by this plugin's host half, so the card
 * and the host registration must keep the identical literal.
 *
 * CHROME CONTRACT (learned the hard way - see the layout notes below): the core
 * cards are built by `@deepseek-ai/dsh-client-ui-settings-plugins`' own
 * `PluginCard`, whose class names and design tokens are reproduced here
 * verbatim. This file may NOT import that component - it is not a seed module -
 * so the card shell is re-declared locally with the same shapes.
 *
 * Source of every number below (read from the packaged client bundle):
 *   lib/client.js of dsh-client-ui-settings-plugins, `PluginCard.module.css`
 *   (hashed prefix `YyYd_a_`) and `PluginsSettingsSection.module.css`
 *   (`pbvGtq_`).
 *
 * Reads and writes go through `ctx.settingsScope`, never to the host directly.
 * The only other data source is `ctx.remote.session.modelCatalog()` - the very
 * same catalog the built-in model picker uses, so the choices here are exactly
 * the routes this deployment can actually reach.
 *
 * Only baseline module-table requests are used (react, react/jsx-runtime,
 * @deepseek-ai/dsh-client-ui-primitives), so no `dsh.client.external` entry is
 * needed; `dsh.client.inject` only guarantees the settings UI and remotes are
 * mounted before this bundle runs.
 *
 * @module dsh-compact-model/client
 */
window.__ModuleLoader__.load({
    id: 'dsh-compact-model',
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
        const React = require('react');
        const { jsx, jsxs, Fragment } = require('react/jsx-runtime');
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        const Menu = primitives.Menu;
        const Button = primitives.Button;
        const IconChevronDownOutline14 = primitives.IconChevronDownOutline14;

        /** Settings namespace owned by this plugin's host half (= the card's slot key). */
        const NS = 'dsh-compact-model';
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
         * visible there). The Web UI plugin group's own `web-ui.plugin.item` list is
         * NOT used: on the official desktop that section renders no third-party card at
         * all, so a registration there is invisible.
         */
        const SEAT_BUNDLE = 'plugins.bundle.config';
        /** The bundle package name the plugin manager keys this plugin's page by. */
        const BUNDLE_KEY = 'dsh-compact-model';
        /**
         * Profile entry ids the 0.1.7 host may serve this plugin's config under. On that
         * line the served namespace IS the entry id, and the bundle's patch layer
         * declares `- id: compact-model / name: dsh-compact-model`; both shapes are fed to
         * `whileServed` so a deployment that serves either one still gets the card.
         */
        const ENTRY_IDS = ['compact-model', 'dsh-compact-model'];
        const PROVIDER_FIELD = 'provider';
        const MODEL_FIELD = 'model';
        const EFFORT_FIELD = 'reasoningEffort';
        const CSS_TAG_ID = 'dsh-compact-model/Card.css';

        /** Sentinel menu row id meaning "leave the field empty / follow the session". */
        const FOLLOW = '\u0000follow';

        /**
         * Card chrome + field styles.
         *
         * The `dsh-pcm-card`..`dsh-pcm-chevronOpen` block is a faithful copy of
         * the framework's `PluginCard.module.css` so this card is visually
         * identical to the `dsh-context` / `终端` / `Agent 循环` cards beside it.
         * The `dsh-pcm-field`..`dsh-pcm-hint` block mirrors `Field`/`ValueField`
         * from the same package.
         *
         * THE ONE RULE THAT MATTERS: `Menu` renders its own wrapper
         * (`<span class="root">`, `display:inline-flex`) around the anchor. An
         * inline-flex wrapper is shrink-to-fit, so a `flex:none` button dropped
         * inside it collapses to a few pixels and its label is clipped away by
         * `overflow:hidden`. `.dsh-pcm-fieldValue` therefore forces the wrapper
         * to be a *growing* flex item (`flex:1 1 auto; min-width:0`) and
         * `.dsh-pcm-select` fills it (`width:100%`) instead of sizing to
         * content. Never re-add `flex:none` to `.dsh-pcm-select`, and never
         * move the width cap back onto the button.
         */
        const css = ''
            // --- card shell (mirrors PluginCard.module.css) ---
            + '.dsh-pcm-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);'
            + 'border-radius:16px;list-style:none;transition:border-color .16s,background .16s}'
            + '.dsh-pcm-card:hover{border-color:var(--dsw-alias-label-dimmed)}'
            + '.dsh-pcm-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}'
            + '.dsh-pcm-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;'
            + 'background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}'
            + '.dsh-pcm-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}'
            + '.dsh-pcm-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}'
            + '.dsh-pcm-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}'
            + '.dsh-pcm-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}'
            + '.dsh-pcm-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}'
            + '.dsh-pcm-chevronOpen{transform:rotate(180deg)}'
            + '.dsh-pcm-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}'
            // --- fields (mirrors Field/ValueField in the same package) ---
            + '.dsh-pcm-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}'
            + '.dsh-pcm-field+.dsh-pcm-field{border-top:.5px solid var(--dsw-alias-border-l2)}'
            + '.dsh-pcm-fieldHead{align-items:center;gap:8px;display:flex}'
            + '.dsh-pcm-fieldLabel{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;'
            + 'font-weight:500;line-height:1.5}'
            + '.dsh-pcm-fieldValue{display:flex;align-items:center;width:100%;min-width:0}'
            + '.dsh-pcm-select{appearance:none;width:100%;min-width:0;font:inherit;font-size:13px;line-height:1.5;'
            + 'color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;height:34px;'
            + 'border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);'
            + 'border-radius:8px;padding:0 12px;align-items:center;gap:8px;display:flex}'
            + '.dsh-pcm-select:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}'
            + '.dsh-pcm-select:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}'
            + '.dsh-pcm-select:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;opacity:.6}'
            + '.dsh-pcm-selectText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
            + '.dsh-pcm-selectTextEmpty{color:var(--dsw-alias-label-tertiary)}'
            + '.dsh-pcm-selectIcon{flex:none;color:var(--dsw-alias-label-tertiary)}'
            + '.dsh-pcm-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}'
            + '.dsh-pcm-warn{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5;padding-top:4px}';
        if (typeof document !== 'undefined'
            && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') === null) {
            const tag = document.createElement('style');
            tag.dataset.plugin = 'dsh-compact-model';
            tag.dataset.pluginCss = CSS_TAG_ID;
            tag.textContent = css;
            document.head.appendChild(tag);
        }

        /** Effort choices; ids match the DeepSeek adapter's accepted set. */
        const EFFORT_CHOICES = [
            { id: '', label: '\u8ddf\u968f\u6a21\u578b\u9ed8\u8ba4' },
            { id: 'off', label: 'off\uff08\u5173\u95ed\u601d\u8003\uff09' },
            { id: 'low', label: 'low' },
            { id: 'high', label: 'high' },
            { id: 'max', label: 'max' },
        ];
        const FOLLOW_ITEM = { id: FOLLOW, label: '\u8ddf\u968f\u4f1a\u8bdd\u6a21\u578b\uff08\u4e0d\u5e72\u9884\uff09' };

        /**
         * Trimmed string read of one section field.
         * @param section - the settings section value.
         * @param field - field name.
         * @returns the trimmed string, or '' for anything else.
         */
        function fieldOf(section, field) {
            if (section === null || typeof section !== 'object') return '';
            const value = section[field];
            return typeof value === 'string' ? value.trim() : '';
        }

        /**
         * The catalog shape `remote.session.modelCatalog()` answers with:
         * `{ routableProviders, groups: [{ id, name, models: [{ id, name, reasoning }] }], failures }`.
         * Flattened into selectable options plus a lookup for labels.
         *
         * `loaded` and `loading` are kept apart on purpose: a catalog that has
         * not answered yet must not be reported to the user as a failure to
         * read one. `loaded` itself means "at least one usable provider was
         * parsed", which is the only signal that decides whether the dropdowns
         * have anything to offer.
         *
         * @param response - the remote's reply envelope.
         * @returns `{ providers, models, routable, failures, loaded }`.
         */
        function readCatalog(response) {
            const value = response !== null && typeof response === 'object' && response.ok === true ? response.value : undefined;
            const groups = value !== null && typeof value === 'object' && Array.isArray(value.groups) ? value.groups : [];
            const providers = [];
            const models = new Map();
            for (const group of groups) {
                if (group === null || typeof group !== 'object') continue;
                const providerId = typeof group.id === 'string' ? group.id : '';
                if (providerId === '') continue;
                const list = Array.isArray(group.models) ? group.models : [];
                providers.push({
                    id: providerId,
                    name: typeof group.name === 'string' && group.name !== '' ? group.name : providerId,
                });
                models.set(providerId, list
                    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
                    .map((entry) => ({
                        id: entry.id,
                        name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id,
                        efforts: entry.reasoning !== null && typeof entry.reasoning === 'object'
                            && Array.isArray(entry.reasoning.efforts)
                            ? entry.reasoning.efforts
                                .filter((effort) => effort !== null && typeof effort === 'object' && typeof effort.id === 'string')
                                .map((effort) => effort.id)
                            : [],
                    })));
            }
            const routable = value !== null && typeof value === 'object' && Array.isArray(value.routableProviders)
                ? value.routableProviders.filter((id) => typeof id === 'string')
                : [];
            const failures = value !== null && typeof value === 'object' && Array.isArray(value.failures)
                ? value.failures.length
                : 0;
            // `loaded` means "this catalog has at least one usable provider", NOT
            // "the reply happened to carry a non-empty groups array": a group whose
            // rows were all malformed carries no choices, and reporting that as a
            // loaded catalog would quietly hide every option from the dropdowns.
            return { providers, models, routable, failures, loaded: providers.length > 0 };
        }

        /**
         * Load the model catalog once per mount. Failure is not fatal: the card
         * still shows the stored route and simply cannot offer new choices.
         *
         * @param remote - the `remote.session` client, when the shell has one.
         * @returns `{ catalog, loading }` where catalog is null until first answer.
         */
        function useCatalog(remote) {
            const [state, setState] = React.useState({ catalog: null, loading: true });
            React.useEffect(() => {
                let live = true;
                if (remote === undefined || remote === null || typeof remote.modelCatalog !== 'function') {
                    setState({ catalog: readCatalog(null), loading: false });
                    return () => {
                        live = false;
                    };
                }
                Promise.resolve()
                    .then(() => remote.modelCatalog())
                    .then((response) => {
                        if (live) setState({ catalog: readCatalog(response), loading: false });
                    })
                    .catch(() => {
                        if (live) setState({ catalog: readCatalog(null), loading: false });
                    });
                return () => {
                    live = false;
                };
            }, [remote]);
            return state;
        }

        /**
         * One labelled setting whose control is a dropdown.
         *
         * The `Menu` wrapper is handed the field-value class so it can grow; its
         * anchor is a plain element (not a `Button`) because `Button` wraps its
         * children in an extra layout box that fights the height rule here.
         *
         * @param props - `{ id, label, hint, value, items, emptyLabel, disabled, onPick }`.
         * @returns the field.
         */
        function SelectField(props) {
            const [open, setOpen] = React.useState(false);
            const items = props.items.length > 0
                ? props.items
                : [{ id: FOLLOW, label: props.emptyLabel, disabled: true }];
            const active = props.items.find((item) => item.id === props.value);
            const label = active !== undefined ? active.label : (props.emptyLabel);
            const empty = active === undefined;
            return jsxs('div', {
                className: 'dsh-pcm-field',
                children: [
                    jsxs('div', {
                        className: 'dsh-pcm-fieldHead',
                        children: [
                            jsx('label', {
                                className: 'dsh-pcm-fieldLabel',
                                htmlFor: props.id,
                                children: props.label,
                            }),
                        ],
                    }),
                    jsx('div', {
                        className: 'dsh-pcm-fieldValue',
                        children: jsx(Menu, {
                            open,
                            onClose: () => setOpen(false),
                            items,
                            selectedId: props.value,
                            onSelect: (id) => {
                                setOpen(false);
                                props.onPick(id);
                            },
                            align: 'end',
                            portal: true,
                            anchor: jsx('button', {
                                type: 'button',
                                id: props.id,
                                className: 'dsh-pcm-select',
                                disabled: props.disabled === true,
                                'aria-haspopup': 'menu',
                                'aria-expanded': open,
                                'aria-label': props.label,
                                onClick: () => setOpen((value) => !value),
                                children: [
                                    jsx('span', {
                                        className: empty ? 'dsh-pcm-selectText dsh-pcm-selectTextEmpty' : 'dsh-pcm-selectText',
                                        children: label,
                                    }),
                                    IconChevronDownOutline14 !== undefined
                                        ? jsx(IconChevronDownOutline14, { className: 'dsh-pcm-selectIcon' })
                                        : null,
                                ],
                            }),
                        }),
                    }),
                    props.hint !== undefined
                        ? jsx('p', { className: 'dsh-pcm-hint', children: props.hint })
                        : null,
                ],
            });
        }

        /**
         * The settings card.
         *
         * `useCompactModel` is the renderer-bound selector over the settings scope
         * (`hooks: { compactModel: scope }` becomes the `useCompactModel` prop).
         * Every hook runs unconditionally, before any early return.
         *
         * @param props - the slot's injected face plus the renderer-bound hooks.
         * @returns the card, or nothing when the host serves no such namespace.
         */
        function CompactModelCard(props) {
            const useCompactModel = props.useCompactModel;
            const snapshot = typeof useCompactModel === 'function' ? useCompactModel((value) => value) : undefined;
            const { catalog, loading } = useCatalog(props.remoteSession);
            const [open, setOpen] = React.useState(false);
            const [pending, setPending] = React.useState(false);
            const [failure, setFailure] = React.useState('');

            if (snapshot !== undefined && snapshot !== null && snapshot.status === 'unavailable') return null;

            const ready = snapshot !== undefined && snapshot !== null && snapshot.status === 'ready';
            const writable = ready && snapshot.writable === true;
            const section = ready && snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {};
            const provider = fieldOf(section, PROVIDER_FIELD);
            const model = fieldOf(section, MODEL_FIELD);
            const effort = fieldOf(section, EFFORT_FIELD);
            const pinned = provider !== '' && model !== '';
            const disabled = pending || !writable;

            const providers = catalog === null ? [] : catalog.providers;
            const providerName = (id) => {
                const found = providers.find((entry) => entry.id === id);
                return found !== undefined ? found.name : id;
            };
            const modelEntries = catalog !== null && catalog.models.has(provider) ? catalog.models.get(provider) : [];
            const modelsOf = (id) => (catalog !== null && catalog.models.has(id) ? catalog.models.get(id) : []);
            /**
             * Providers that reported no models at all.
             *
             * These must not be silently selectable: choosing one leaves the route
             * incomplete (a provider with no model pins nothing), and the card would
             * snap straight back to the placeholder -- the exact "my click did
             * nothing" experience this control is being fixed for. They stay visible
             * but disabled, so the reason is on screen instead of in a guess.
             */
            const barrenProviders = providers.filter((entry) => modelsOf(entry.id).length === 0);
            const providerItems = [
                FOLLOW_ITEM,
                ...providers.map((entry) => {
                    const barren = modelsOf(entry.id).length === 0;
                    const name = catalog.routable.includes(entry.id)
                        ? entry.name
                        : entry.name + '\uff08\u672a\u8def\u7531\uff09';
                    return barren
                        ? { id: entry.id, label: name + '\uff08\u672a\u4e0a\u62a5\u6a21\u578b\uff09', disabled: true }
                        : { id: entry.id, label: name };
                }),
            ];
            const modelItems = [
                FOLLOW_ITEM,
                ...modelEntries.map((entry) => ({ id: entry.id, label: entry.name })),
                // A stored route whose model left the catalog stays selectable so the
                // card never silently misrepresents what is configured.
                ...(model !== '' && !modelEntries.some((entry) => entry.id === model)
                    ? [{ id: model, label: model + '\uff08\u4e0d\u5728\u76ee\u5f55\u4e2d\uff09' }]
                    : []),
            ];
            const effortItems = EFFORT_CHOICES.map((choice) => ({
                id: choice.id === '' ? FOLLOW : choice.id,
                label: choice.label,
            }));
            const effortIds = modelEntries.find((entry) => entry.id === model)?.efforts ?? [];
            const unsupportedEffort = effort !== '' && effortIds.length > 0 && !effortIds.includes(effort);

            const run = (operations) => {
                setPending(true);
                setFailure('');
                Promise.resolve()
                    .then(operations)
                    .catch((error) => {
                        // Never swallow a failed write: silence here is exactly what
                        // made an earlier "selection did nothing" report impossible to
                        // diagnose from the outside. The message is surfaced in the
                        // card AND logged for a console that may already be open.
                        const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
                            ? error.message
                            : String(error);
                        setFailure(message);
                        try {
                            console.error('[dsh-compact-model] settings write failed:', error);
                        }
                        catch {
                            /* a shell without console still gets the inline message */
                        }
                    })
                    .then(() => {
                        setPending(false);
                    });
            };
            /**
             * Report a write that could not even be attempted.
             *
             * `writeRoute`/`pickEffort` used to `return` silently when the injected
             * writer was missing, which presented to the user as "the selection did
             * nothing" with zero evidence anywhere. A missing seat is a wiring bug,
             * so it is reported like any other failed write.
             *
             * @param seat - the injected prop that was expected.
             * @param detail - what the value actually was.
             */
            const reportMissingSeat = (seat, detail) => {
                setFailure('\u7f3a\u5c11\u6ce8\u5165\u7684\u5199\u5165\u51fd\u6570 ' + seat + '\uff08\u5b9e\u9645\u4e3a ' + detail + '\uff09');
                try {
                    console.error('[dsh-compact-model] missing injected seat:', seat, detail);
                }
                catch {
                    /* the inline message is the durable channel */
                }
            };
            /** Describe a value for the missing-seat message. */
            const describe = (value) => {
                if (value === null) return 'null';
                if (value === undefined) return 'undefined';
                return typeof value;
            };
            /**
             * TEMPORARY diagnostic readout (remove with the line that renders it).
             *
             * The revision matters most: the scope fences every write with the revision
             * it last saw, and the host answers a fence mismatch with a conflict that
             * the scope handles by silently re-reading. Seeing this number move after a
             * click is the cheapest proof that the write reached the host at all.
             */
            const status = snapshot === undefined || snapshot === null ? 'none' : String(snapshot.status);
            const revision = snapshot === undefined || snapshot === null ? 'n/a' : String(snapshot.revision);
            const userLayer = snapshot !== undefined && snapshot !== null && snapshot.user !== null
                && typeof snapshot.user === 'object'
                ? Object.keys(snapshot.user).join(',')
                : '';
            const diet = '\u3010\u8bca\u65ad\u3011status=' + status
                + ' rev=' + revision
                + ' writable=' + String(writable)
                + ' mode=' + (snapshot === undefined || snapshot === null ? 'n/a' : String(snapshot.mode))
                + ' | provider="' + provider + '" model="' + model + '" effort="' + effort + '"'
                + ' | user=[' + userLayer + ']'
                + ' | setRoute=' + describe(props.setRoute)
                + ' setEffort=' + describe(props.setEffort)
                + ' | catalog=' + (catalog === null ? 'null' : String(catalog.providers.length) + '\u5bb6/'
                    + String(catalog.routable.length) + '\u53ef\u8def\u7531/' + String(catalog.failures) + '\u5931\u8d25');
            /**
             * Whether the card already IS the proposed route.
             *
             * Two effects: it drops a no-op write (the host skips an unchanged
             * section silently, so submitting one would look like a dead control),
             * and it kills the `<select>`/Menu `onSelect` re-fire that a controlled
             * list can produce.
             *
             * @param nextProvider - proposed provider.
             * @param nextModel - proposed model.
             * @returns `true` when nothing would change.
             */
            const sameRoute = (nextProvider, nextModel) => nextProvider === provider && nextModel === model;
            /**
             * The model to carry into `nextProvider`.
             *
             * ONLY when that provider actually lists it. Keying this off the STORED
             * provider's entries -- which is what this did first -- carries A's model
             * into B, and the result is a perfectly "legal" pair (both halves
             * non-empty) that persists silently and then makes the compaction backend
             * ask provider B for a model id that belongs to A. It must be judged
             * against the provider being switched TO.
             *
             * @param nextProvider - the provider being selected.
             * @returns the model id to keep, or '' to require a fresh choice.
             */
            const carriedModel = (nextProvider) => {
                const entries = catalog !== null && catalog.models.has(nextProvider)
                    ? catalog.models.get(nextProvider)
                    : [];
                return entries.some((entry) => entry.id === model) ? model : '';
            };
            /** Write the route as a batch: the pair must never be half-written. */
            const writeRoute = (nextProvider, nextModel) => {
                if (sameRoute(nextProvider, nextModel)) return;
                if (typeof props.setRoute !== 'function') {
                    reportMissingSeat('setRoute', describe(props.setRoute));
                    return;
                }
                run(() => props.setRoute({ provider: nextProvider, model: nextModel }));
            };
            const pickProvider = (id) => {
                const nextProvider = id === FOLLOW ? '' : id;
                // Switching provider invalidates the model unless the new provider
                // lists the same one; clearing keeps the pair meaningful.
                writeRoute(nextProvider, nextProvider === '' ? '' : carriedModel(nextProvider));
            };
            const pickModel = (id) => writeRoute(provider, id === FOLLOW ? '' : id);
            const pickEffort = (id) => {
                if ((id === FOLLOW ? '' : id) === effort) return;
                if (typeof props.setEffort !== 'function') {
                    reportMissingSeat('setEffort', describe(props.setEffort));
                    return;
                }
                run(() => props.setEffort(id === FOLLOW ? '' : id));
            };

            const subtitle = !ready                ? '\u5f53\u524d\u8fde\u63a5\u65e0\u6cd5\u8bfb\u53d6\u8be5\u8bbe\u7f6e\u3002'
                : pinned
                    ? '\u538b\u7f29\u4f7f\u7528 ' + providerName(provider) + ' / ' + model
                    : '\u538b\u7f29\u8ddf\u968f\u5f53\u524d\u4f1a\u8bdd\u7684\u6a21\u578b\uff08\u9ed8\u8ba4\uff09\u3002';

            const header = jsxs('button', {
                type: 'button',
                className: 'dsh-pcm-header',
                'aria-expanded': open,
                onClick: () => setOpen((value) => !value),
                children: [
                    jsxs('span', {
                        className: 'dsh-pcm-headText',
                        children: [
                            jsx('span', {
                                className: 'dsh-pcm-name',
                                children: '\u538b\u7f29\u6a21\u578b\uff08compact\uff09',
                            }),
                            jsx('span', { className: 'dsh-pcm-description', children: subtitle }),
                        ],
                    }),
                    IconChevronDownOutline14 !== undefined
                        ? jsx(IconChevronDownOutline14, {
                            className: open ? 'dsh-pcm-chevron dsh-pcm-chevronOpen' : 'dsh-pcm-chevron',
                        })
                        : null,
                ],
            });

            const body = !open ? null : jsxs('div', {
                className: 'dsh-pcm-body',
                children: [
                    jsx(SelectField, {
                        id: 'dsh-compact-model-provider',
                        label: '\u63d0\u4f9b\u65b9',
                        hint: '\u538b\u7f29\u8bf7\u6c42\u4f7f\u7528\u7684\u670d\u52a1\u63d0\u4f9b\u65b9\u3002',
                        value: provider,
                        emptyLabel: '\u672a\u9009\u62e9',
                        items: providerItems,
                        disabled,
                        onPick: pickProvider,
                    }),
                    jsx(SelectField, {
                        id: 'dsh-compact-model-model',
                        label: '\u6a21\u578b',
                        hint: '\u538b\u7f29\u8bf7\u6c42\u4f7f\u7528\u7684\u6a21\u578b\uff1b\u4e0e\u63d0\u4f9b\u65b9\u5fc5\u987b\u6210\u5bf9\u8bbe\u7f6e\u3002',
                        value: model,
                        emptyLabel: provider === ''
                            ? '\u5148\u9009\u63d0\u4f9b\u65b9'
                            : '\u672a\u9009\u62e9',
                        items: modelItems,
                        disabled: disabled || provider === '',
                        onPick: pickModel,
                    }),
                    jsx(SelectField, {
                        id: 'dsh-compact-model-effort',
                        label: '\u601d\u8003\u5f3a\u5ea6',
                        hint: '\u538b\u7f29\u8bf7\u6c42\u7684 reasoning effort\uff1b\u9ed8\u8ba4\u8ddf\u968f\u6a21\u578b\u7684\u8fde\u63a5\u9ed8\u8ba4\u503c\u3002',
                        value: effort === '' ? FOLLOW : effort,
                        emptyLabel: '\u8ddf\u968f\u6a21\u578b\u9ed8\u8ba4',
                        items: effortItems,
                        disabled,
                        onPick: pickEffort,
                    }),
                    catalog !== null && !catalog.loaded
                        ? jsx('p', {
                            className: 'dsh-pcm-warn',
                            role: 'status',
                            children: loading
                                ? '\u6b63\u5728\u8bfb\u53d6\u6a21\u578b\u76ee\u5f55\u2026'
                                : '\u65e0\u6cd5\u8bfb\u53d6\u6a21\u578b\u76ee\u5f55\uff0c\u6682\u65f6\u53ea\u80fd\u6cbf\u7528\u5df2\u4fdd\u5b58\u7684\u6a21\u578b\u3002',
                        })
                        : null,
                    catalog !== null && catalog.failures > 0
                        ? jsx('p', {
                            className: 'dsh-pcm-warn',
                            role: 'status',
                            children: '\u6709 ' + catalog.failures + ' \u4e2a\u63d0\u4f9b\u65b9\u672a\u80fd\u4e0a\u62a5\u6a21\u578b\u6e05\u5355\uff0c\u5176\u6a21\u578b\u53ef\u80fd\u7f3a\u5931\u3002',
                        })
                        : null,
                    barrenProviders.length > 0
                        ? jsx('p', {
                            className: 'dsh-pcm-warn',
                            role: 'status',
                            children: '\u4e0b\u5217\u63d0\u4f9b\u65b9\u672a\u4e0a\u62a5\u6a21\u578b\uff0c\u6682\u4e0d\u53ef\u9009\uff08\u9009\u4e86\u4e5f\u9489\u4e0d\u4f4f\u8def\u7ebf\uff09\uff1a'
                                + barrenProviders.map((entry) => entry.name).join('\u3001'),
                        })
                        : null,
                    unsupportedEffort
                        ? jsx('p', {
                            className: 'dsh-pcm-warn',
                            role: 'status',
                            children: '\u6240\u9009\u6a21\u578b\u7684\u76ee\u5f55\u672a\u58f0\u660e\u300c\u601d\u8003\u5f3a\u5ea6 ' + effort
                                + '\u300d\uff0c\u82e5\u88ab\u9002\u914d\u5668\u62d2\u7edd\uff0c\u538b\u7f29\u4f1a\u81ea\u52a8\u6539\u7528\u8be5\u6a21\u578b\u9ed8\u8ba4\u5f3a\u5ea6\u3002',
                        })
                        : null,
                    jsx('p', {
                        className: 'dsh-pcm-hint',
                        children: '\u6362\u6210\u522b\u7684\u6a21\u578b\u4f1a\u8ba9\u538b\u7f29\u8bf7\u6c42\u7528\u4e0d\u4e0a\u70ed\u524d\u7f00\u7f13\u5b58\uff08KV cache \u590d\u7528\u4f1a\u5931\u6548\uff09\uff0c'
                            + '\u8fd9\u662f\u5206\u5f00\u7ed1\u5b9a\u6a21\u578b\u7684\u56fa\u6709\u4ee3\u4ef7\u3002\u6e05\u7a7a\u4e24\u9879\u5373\u56de\u5230\u300c\u8ddf\u968f\u4f1a\u8bdd\u6a21\u578b\u300d\u3002',
                    }),
                    pending
                        ? jsx('p', { className: 'dsh-pcm-hint', children: '\u6b63\u5728\u5199\u5165\u2026' })
                        : null,
                    failure !== ''
                        ? jsx('p', {
                            className: 'dsh-pcm-warn',
                            role: 'alert',
                            children: '\u5199\u5165\u5931\u8d25\uff1a' + failure,
                        })
                        : null,
                    jsx('p', { className: 'dsh-pcm-hint', children: diet }),
                ],
            });

            return jsxs('li', {
                className: open ? 'dsh-pcm-card dsh-pcm-cardOpen' : 'dsh-pcm-card',
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
         * writes `- id: compact-model / name: dsh-compact-model`), so every candidate is
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
            /** The catalog client, captured whenever `remote.session` shows up. */
            let remoteSession;

            /**
             * Read one field back from the RAW user layer.
             *
             * This is the only honest way to learn whether a write was accepted, and
             * it is what the framework's own cards do (`PluginCard.store()` returns
             * `userLayer()?.[field] === value`). The reason a `.catch()` is useless
             * here: `SettingsScopeController.mutate` answers a host refusal by calling
             * its private `recover()` -- it SILENTLY re-reads the mirror and RESOLVES.
             * The promise therefore fulfils whether the value was persisted or
             * rejected, so a write that never happened looks exactly like a successful
             * one. Reading the user layer back turns that into a real signal.
             *
             * `snapshot.user` is the raw stored layer, and an absent key means "not
             * overridden" -- which is what an unset has to leave behind.
             *
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
             *
             * @param scope - the bound settings scope.
             * @param field - field that was written.
             * @param wanted - the value the caller asked to store ('' means "unset").
             * @param read - reads one field back.
             */
            const assertStored = (scope, field, wanted, read) => {
                const actual = read(scope, field);
                const settled = wanted === '' ? actual === undefined || actual === '' : actual === wanted;
                if (settled) return;
                throw new Error(
                    `${field} \u6ca1\u6709\u88ab\u63a5\u53d7\uff1a\u671f\u671b `
                    + `${wanted === '' ? '\u6e05\u7a7a' : JSON.stringify(wanted)}\uff0c`
                    + `\u5b9e\u9645 ${actual === undefined ? '\u672a\u8bbe\u7f6e' : JSON.stringify(actual)}`
                    + '\uff08\u5bbf\u4e3b\u62d2\u7edd\u4e86\u8fd9\u6b21\u5199\u5165\uff09',
                );
            };

            /**
             * Register the card in the seat the RUNNING dsh actually renders.
             *
             * The line is told apart by `configForms` - 0.1.7's value service, which
             * replaced the settings store and appears in no 0.1.5 package. On 0.1.5
             * nothing changes: same seat, same key. On 0.1.7 the card follows
             * web-all 0.4.2's own rule for the same decision (its comment: "The signal
             * that actually distinguishes the two deployments is whether dsh-web-settings
             * is loaded"): with the Web UI plugin group loaded the card goes to the
             * group's list seat, otherwise to the plugin manager's keyed seat, whose key
             * is the BUNDLE package name (dshmarket's note: "The package name the host
             * keys a bundle's own configuration by ... not the same string as the locale
             * namespace"). The keyed seat is gated by `whileServed` so a deployment that
             * serves no config form for this plugin shows no dead card.
             *
             * @param scope - the bound settings scope.
             */
            const registerCard = (scope) => {
                const forms = serviceOf(ctx, 'configForms');
                const face = () => ({
                    hooks: { compactModel: scope },
                    // Read when the renderer asks for the face, not now: the catalog
                    // client may register after the card does.
                    remoteSession,
                    setRoute: (route) => {
                        const write = route.provider === '' && route.model === ''
                            // Unpinning clears the pair. Provider first: an empty provider
                            // with a model still set is a half-pair, and the card must
                            // never leave one behind.
                            ? scope.unset(PROVIDER_FIELD).then(() => scope.unset(MODEL_FIELD))
                            // Per-field writes through `set`, NOT one batched `mutate`.
                            // `set` is the same call the reasoning-effort control uses,
                            // and it keeps a plain single-field request on the wire. The
                            // host no longer rejects a half-pair, so either order is
                            // storable; model first keeps the provider meaningful at
                            // every step.
                            : scope.set(MODEL_FIELD, route.model).then(() => scope.set(PROVIDER_FIELD, route.provider));
                        return write.then(() => {
                            assertStored(scope, PROVIDER_FIELD, route.provider, storedField);
                            assertStored(scope, MODEL_FIELD, route.model, storedField);
                        });
                    },
                    setEffort: (value) => {
                        const write = value === ''
                            ? scope.unset(EFFORT_FIELD)
                            : scope.set(EFFORT_FIELD, value);
                        return write.then(() => {
                            assertStored(scope, EFFORT_FIELD, value, storedField);
                        });
                    },
                });
                if (forms === undefined || forms === null) {
                    // 0.1.5: the framework's own keyed plugin seat.
                    ctx.slots.inject(SEAT_LEGACY, () => ctx.slots.register({
                        name: SEAT_LEGACY,
                        key: NS,
                        inject: face,
                    }, CompactModelCard));
                    return;
                }
                // 0.1.7: the plugin manager's keyed seat, keyed by the BUNDLE package
                // name, gated by `whileServed` so a deployment that serves no form for
                // this entry shows no dead card.
                const mountSeat = () => ctx.slots.inject(SEAT_BUNDLE, () => ctx.slots.register({
                    name: SEAT_BUNDLE,
                    key: BUNDLE_KEY,
                    inject: face,
                }, CompactModelCard));
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
            // `remote.session` carries the model catalog, and it may register after the
            // card does; the face reads it lazily so either order works. A shell without
            // remotes still gets the card.
            ctx.inject(['remote.session'], (remoteCtx) => {
                remoteSession = remoteCtx['remote.session'];
            });
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
             * SOURCE - it resolves the namespace through the profile entry and hands back
             * the same snapshot shape. The seat does not depend on it (`plugins.bundle.config`
             * either way); the line is told apart by `configForms`, which no 0.1.5 package
             * mentions, because the group is loaded on 0.1.5 + web-all 0.3.x as well.
             */
            ctx.inject(['webUiSettings'], (scoped) => {
                if (serviceOf(ctx, 'configForms') === undefined) return;
                const family = serviceOf(scoped, 'webUiSettings');
                if (family === undefined || family === null || typeof family.bind !== 'function') return;
                mount(family.bind({ namespace: NS }));
            });
            /**
             * ③ 0.1.7 without the group: bind the native shared form, resolved by ENTRY
             * ID (on that line the served namespace IS the entry id). If the group turns
             * out to be present after all, its binder wins instead.
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
        exports.CompactModelCard = CompactModelCard;
        exports.SelectField = SelectField;
        exports.readCatalog = readCatalog;
        exports.CSS_TAG_ID = CSS_TAG_ID;
        exports.SETTINGS_NS = NS;
        exports.FOLLOW = FOLLOW;
        exports.EFFORT_CHOICES = EFFORT_CHOICES;
        exports.Fragment = Fragment;
        return module.exports;
    },
});

