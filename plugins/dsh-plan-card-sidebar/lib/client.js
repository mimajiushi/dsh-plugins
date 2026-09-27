/**
 * dsh-plan-card-sidebar — browser half.
 *
 * The plan-review card ("计划待审", the takeover `exit_plan_mode` presents
 * through the user-questions channel) normally occupies the conversation
 * composer seat at a fixed size. This plugin gives that same card a second
 * home — the right Sidebar, as a tab — and adds a per-card switch that moves it
 * between the two homes. The decision buttons travel with the card, so the
 * sidebar tab is a complete review surface, not a mirror.
 *
 * How it works, and why nothing else has to change:
 *
 * - `conversation.composer` is a **chain** slot. The chain walks its entries in
 *   ascending priority and renders the first entry whose `select` returns
 *   non-null; core's `ui-user-questions` entry sits at the default priority 0.
 *   This plugin registers at priority -1, so it is asked first and claims
 *   **only** plan-review requests — every other question (and every other
 *   composer takeover) returns null and stays with core, untouched.
 * - Because this entry is the elected occupant for a plan review, it renders
 *   the card in the conversation when the card is inline (core's own layout,
 *   plus one sidebar button) and a one-line status bar with "切回主对话" when the
 *   card is docked. The composer seat is therefore never blank and the way back
 *   is always visible.
 * - The sidebar home is an ordinary sidebar tab type
 *   (`ctx.sidebarRightTabs.register` + a `sidebar.right.pane.tab` body), so it
 *   sits next to Files/Browser, works in a floating panel, and is opened and
 *   closed through `ctx.sidebarRight.openTab` / `close`.
 * - Both homes drive the *same* pending-question carrier: the buttons call
 *   `pending.answer({...})` / `pending.cancel()` exactly like core's panel, so
 *   approving, refusing, and "去聊天里说" behave identically wherever the card
 *   is drawn.
 *
 * Known maintenance coupling: the inline card mirrors core's PlanReviewPanel
 * markup and reuses that panel's compiled class names (`.gtAFBG_*`, shipped by
 * `dsh-client-ui-user-questions`) so the two look identical. The markup is
 * defined once, in `PlanReviewCard`.
 *
 * @module dsh-plan-card-sidebar/client
 */
window.__ModuleLoader__.load({
    id: 'dsh-plan-card-sidebar',
    factory: (require) => {
        const module = { exports: {} };
        const exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

        const React = require('react');
        const { jsx, jsxs, Fragment } = require('react/jsx-runtime');
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        const { Button, IconEditOutline16, IconPanelLeftOutline16, MarkdownText } = primitives;

        const { useCallback, useEffect, useMemo, useState, useSyncExternalStore } = React;

        // ─── copy ───────────────────────────────────────────────────────────
        /** This plugin's own strings; button labels reuse the asker's, as core does. */
        const TEXT = {
            header: '计划待审',
            dock: '侧边栏',
            dockTitle: '把计划卡片放到右侧栏显示',
            undock: '切回主对话',
            undockTitle: '把计划卡片收回主对话显示',
            stubDesc: '计划卡片已在右侧栏打开，按钮也在那边',
            stubError: '打开侧边栏失败，仍显示在主对话里',
            retry: '重试',
            tabTitle: '计划待审',
            guideDescription: '审阅待批的计划',
            busy: '处理中…',
            idle: '当前没有待审的计划。',
            done: '这张计划卡片已经处理完毕。'
        };

        // ─── styles ─────────────────────────────────────────────────────────
        /** Only the pieces core's panel does not already style. */
        const CSS_TAG_ID = 'dsh-plan-card-sidebar/PlanCardSidebar.module.css';
        const CSS = [
            '.dsh-pcs-toggle{flex-shrink:0;display:inline-flex;align-items:center;gap:4px;padding:2px 8px;',
            'border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:none;cursor:pointer;',
            'font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);',
            'transition:color var(--ds-transition-duration) var(--ds-ease-in-out),border-color var(--ds-transition-duration) var(--ds-ease-in-out)}',
            '.dsh-pcs-toggle:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}',
            '.dsh-pcs-toggle:disabled{opacity:.6;cursor:default}',
            '.dsh-pcs-sidebar-card{background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-state-warn-secondary);',
            'border-radius:16px;display:flex;flex-direction:column;min-height:0;height:100%;overflow:hidden;',
            'color:var(--dsw-alias-label-primary);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);',
            '--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
            '.dsh-pcs-sidebar-card,.dsh-pcs-sidebar-card *{box-sizing:border-box}',
            '.dsh-pcs-composer-stub{padding:6px calc(var(--dsh-composer-side-clearance) + 16px) 10px;display:flex;justify-content:center}',
            '.dsh-pcs-stub-card{width:100%;max-width:var(--dsh-composer-card-max-width);display:flex;align-items:center;gap:10px;',
            'padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-specific-input-major);',
            'box-shadow:var(--dsw-shadow-lv2);box-sizing:border-box}',
            '.dsh-pcs-stub-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
            '.dsh-pcs-stub-title{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;',
            'text-overflow:ellipsis;white-space:nowrap}',
            '.dsh-pcs-stub-desc{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
            '.dsh-pcs-stub-error{font-size:12px;line-height:16px;color:var(--dsw-alias-state-error-primary)}',
            '.dsh-pcs-empty{padding:16px;margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}'
        ].join('');

        /** Inject the stylesheet once per page (idempotent across plugin reloads). */
        function initCss() {
            if (typeof document === 'undefined') return;
            if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') !== null) return;
            const tag = document.createElement('style');
            tag.dataset.plugin = 'dsh-plan-card-sidebar';
            tag.dataset.pluginCss = CSS_TAG_ID;
            tag.textContent = CSS;
            document.head.appendChild(tag);
        }

        // ─── plan-review narrowing (the rule core itself applies) ───────────

        /**
         * Narrow a request to a renderable plan review, or return undefined to
         * leave it entirely to core.
         * @param questions - the request's whole question batch.
         * @returns The narrowed review, or undefined.
         */
        function planReviewOf(questions) {
            if (!Array.isArray(questions) || questions.length !== 1) return undefined;
            const question = questions[0];
            const intent = question === null || typeof question !== 'object' ? undefined : question.intent;
            if (intent?.kind !== 'plan-review' || question.detail === undefined) return undefined;
            if (question.multiSelect === true) return undefined;
            const options = question.options ?? [];
            if (options.length > 2) return undefined;
            const approve = options.find((option) => option.label === intent.approve);
            if (approve === undefined) return undefined;
            const decline = options.find((option) => option.label !== intent.approve);
            return {
                id: question.id,
                question: question.question,
                plan: question.detail,
                approve,
                ...(decline === undefined ? {} : { decline })
            };
        }

        /** The plan's first markdown heading, or undefined when it has none. */
        function firstHeading(plan) {
            for (const line of String(plan).split('\n')) {
                const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
                if (match !== null) return match[1];
            }
            return undefined;
        }

        /** Markdown stripped down to one readable line, for the status bar. */
        function plainLine(value) {
            return String(value ?? '').replace(/[#*`>_~[\]]/g, ' ').replace(/\s+/g, ' ').trim();
        }

        /** The one-line plan summary the status bar shows. */
        function planSummary(plan) {
            const heading = firstHeading(plan);
            if (heading !== undefined) return plainLine(heading) || TEXT.header;
            const line = String(plan).split('\n').map(plainLine).find((candidate) => candidate !== '');
            return line ?? TEXT.header;
        }

        // ─── dock state ─────────────────────────────────────────────────────
        // Which request currently lives in the sidebar. Keyed by the pending
        // carrier's opaque render key; nothing is persisted, because the
        // sidebar's own tab state is per-page memory too.

        /** Key → `{ key, sessionId, tabId, pending }`. */
        const docked = new Map();
        /** Requests with a retry chain in flight, so two chains never race. */
        const docking = new Set();
        const dockListeners = new Set();
        let dockRevision = 0;

        /** Subscribe to dock changes; both homes are rendered from this bundle. */
        function subscribeDock(listener) {
            dockListeners.add(listener);
            return () => {
                dockListeners.delete(listener);
            };
        }

        function dockSnapshot() {
            return dockRevision;
        }

        function notifyDock() {
            dockRevision += 1;
            for (const listener of [...dockListeners]) {
                try {
                    listener();
                } catch (error) {
                    console.error('[dsh-plan-card-sidebar] dock listener failed:', error);
                }
            }
        }

        /** The dock record of the request the sidebar is showing, if any. */
        function soleDock() {
            for (const record of docked.values()) return record;
            return undefined;
        }

        /**
         * The key of the sole docked request, if any. The tab body's fallback
         * resolver: a tab opened from the sidebar's own guide carries no
         * navigation params, so it cannot name its record directly.
         */
        function soleDockKey() {
            for (const [key] of docked) return key;
            return undefined;
        }

        /** Whether this request currently lives in the sidebar. */
        function isDocked(key) {
            return docked.has(key);
        }

        /** Drop the dock record; the composer seat falls back to the inline card. */
        function clearDock(key) {
            if (docked.delete(key)) notifyDock();
        }

        // ─── host ties ──────────────────────────────────────────────────────

        /** The client plugin context, captured for the module-level helpers. */
        let host;

        /** Report which session the browser is looking at, when the roster exists. */
        function activeSessionId() {
            try {
                return host?.sessions?.list?.getSnapshot?.()?.current;
            } catch {
                return undefined;
            }
        }

        /** Whether the sidebar is still showing the tab this request opened. */
        function tabIsActive(record) {
            if (record === undefined || record.tabId === undefined) return false;
            try {
                return host?.sidebarRight?.active?.()?.id === record.tabId;
            } catch {
                return false;
            }
        }

        /**
         * Close this request's tab, but only while the panel is showing it:
         * closing the sole docked tab also collapses the whole column, and a
         * settle that happens while the user is reading Files must not slam the
         * column shut. Everything else just drops the record, which is the only
         * thing that makes the card "docked".
         */
        function closeDockTab(record) {
            const sidebar = host?.sidebarRight;
            if (sidebar === undefined || record.tabId === undefined) return;
            try {
                if (sidebar.isExpanded() === true && tabIsActive(record)) sidebar.close(record.tabId);
            } catch (error) {
                console.warn('[dsh-plan-card-sidebar] sidebar close failed:', error);
            }
        }

        /**
         * Bring the sidebar back to this request's tab, creating it when needed.
         * Never called during another seat's render: the controller's session
         * binding appears only once its panel is mounted, so early attempts can
         * legitimately fail and the callers retry.
         * @param record - the dock record to show.
         * @returns Whether the tab is showing now.
         */
        function ensureDocked(record) {
            const sidebar = host?.sidebarRight;
            if (sidebar === undefined) return false;
            try {
                if (tabIsActive(record)) {
                    if (sidebar.isExpanded() === false) sidebar.toggleExpanded();
                    return true;
                }
                // Name the record in the tab's navigation params; the body
                // resolves by param first. `openContent` settles even on an
                // already-open page tab, so a re-open refreshes the params.
                sidebar.openTab(TAB_KIND, {
                    revealIfOpened: true,
                    ...(typeof record.key === 'string' ? { params: { reviewKey: record.key } } : {})
                });
                return true;
            } catch (error) {
                console.warn('[dsh-plan-card-sidebar] sidebar open failed:', error);
                return false;
            }
        }

        /** Retry `ensureDocked` across a few frames while the panel seat mounts. */
        function ensureDockedSoon(key, attempts = 12) {
            if (docking.has(key)) return;
            docking.add(key);
            const step = (left) => {
                const record = docked.get(key);
                if (record === undefined || ensureDocked(record) || left <= 0) {
                    docking.delete(key);
                    return;
                }
                window.setTimeout(() => step(left - 1), 60);
            };
            step(attempts);
        }

        /**
         * Close this request's sidebar tab and drop its dock record — the
         * explicit "切回主对话" path.
         */
        function releaseDock(key) {
            const record = docked.get(key);
            if (record === undefined) return;
            closeDockTab(record);
            clearDock(key);
        }

        /** Hand the keyboard back to the composer after "去聊天里说". */
        function focusComposer() {
            if (typeof document === 'undefined') return;
            window.requestAnimationFrame(() => {
                const seat = document.querySelector('[data-composer-seat]');
                const field = seat?.querySelector('textarea, [contenteditable="true"]');
                if (field instanceof HTMLElement) field.focus();
            });
        }

        // ─── sidebar tab type ───────────────────────────────────────────────

        /** Tab type id, also the key this plugin's body registers under. */
        const TAB_ID = 'dsh-plan-card-sidebar';
        /** Tab kind this plugin owns. */
        const TAB_KIND = 'plan-review-card';

        /** The markdown labels core's panel passes; MarkdownText requires them. */
        const MARKDOWN_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' };

        /**
         * The plan-review card itself — one definition, rendered in the
         * conversation and in the sidebar. Layout and class names mirror core's
         * `PlanReviewPanel`; the extra button in the strip is this plugin's
         * switch.
         *
         * @param props.pending - the pending-question carrier carrying `answer`/`cancel`.
         * @param props.review - the narrowed plan review.
         * @param props.mode - `'inline'` or `'sidebar'`; picks the switch's meaning.
         * @param props.onSwitch - the switch button's handler.
         * @param props.onSettled - called once a decision was delivered.
         * @param props.variant - card chrome: core's composer card or the column card.
         * @returns The card element.
         */
        function PlanReviewCard(props) {
            const { pending, review, mode, onSwitch, onSettled, variant } = props;
            const [busy, setBusy] = useState(undefined);
            const [error, setError] = useState(null);

            const run = useCallback((label, send) => {
                setBusy(label);
                setError(null);
                const started = (() => {
                    try {
                        return Promise.resolve(send());
                    } catch (cause) {
                        return Promise.reject(cause);
                    }
                })();
                started.then(() => {
                    onSettled();
                }, (cause) => {
                    setBusy(undefined);
                    setError(cause instanceof Error ? cause.message : String(cause));
                });
            }, [onSettled]);

            const decide = (label) => {
                run(label, () => pending.answer({ answers: [{ id: review.id, selected: [label] }] }));
            };

            const discuss = () => {
                run('discuss', () => pending.cancel());
                // The seat is handed back to the InputBar as soon as the
                // request settles; focus lands on the next frame.
                focusComposer();
            };
            const cardClass = variant === 'sidebar' ? 'dsh-pcs-sidebar-card' : 'gtAFBG_card';
            const frameClass = variant === 'sidebar' ? undefined : 'gtAFBG_frame';
            const decline = review.decline;

            const card = jsxs('section', {
                className: cardClass,
                'aria-label': review.question ?? TEXT.header,
                'data-plan-card': variant,
                children: [
                    jsxs('div', {
                        className: 'gtAFBG_strip',
                        children: [
                            jsx('span', { className: 'gtAFBG_dot' }),
                            jsx('span', { children: TEXT.header }),
                            jsx('span', { style: { flex: '1 1 auto' } }),
                            jsx('button', {
                                type: 'button',
                                className: 'dsh-pcs-toggle',
                                title: mode === 'sidebar' ? TEXT.undockTitle : TEXT.dockTitle,
                                disabled: busy !== undefined,
                                onClick: onSwitch,
                                'data-plan-card-switch': mode,
                                children: mode === 'sidebar'
                                    ? [jsx(IconPanelLeftOutline16, { size: 13 }), TEXT.undock]
                                    : [jsx(IconPanelLeftOutline16, { size: 13 }), TEXT.dock]
                            })
                        ]
                    }),
                    jsx('div', {
                        className: 'gtAFBG_body',
                        'data-plan-review-scroll': true,
                        children: jsx(MarkdownText, { text: review.plan, labels: MARKDOWN_LABELS })
                    }),
                    jsxs('div', {
                        className: 'gtAFBG_footer',
                        children: [
                            jsx('div', {
                                className: 'gtAFBG_feedback',
                                role: 'status',
                                children: error ?? (busy === undefined ? null : TEXT.busy)
                            }),
                            jsxs('div', {
                                className: 'gtAFBG_actions',
                                children: [
                                    jsx(Button, {
                                        variant: 'ghost',
                                        className: 'gtAFBG_discuss',
                                        icon: jsx(IconEditOutline16, { size: 14 }),
                                        disabled: busy !== undefined,
                                        onClick: discuss,
                                        children: '去聊天里说'
                                    }),
                                    decline !== undefined && jsx(Button, {
                                        variant: 'outline',
                                        ...(decline.description === undefined ? {} : { title: decline.description }),
                                        disabled: busy !== undefined,
                                        onClick: () => {
                                            decide(decline.label);
                                        },
                                        children: '拒绝'
                                    }),
                                    jsx(Button, {
                                        variant: 'primary',
                                        ...(review.approve.description === undefined ? {} : { title: review.approve.description }),
                                        disabled: busy !== undefined,
                                        onClick: () => {
                                            decide(review.approve.label);
                                        },
                                        children: '确认执行'
                                    })
                                ]
                            })
                        ]
                    })
                ]
            });

            return frameClass === undefined ? card : jsx('div', { className: frameClass, children: card });
        }

        /**
         * The sidebar tab body. Resolves the request it reviews from the dock
         * record: the opener names the record in the tab's navigation params,
         * and when those are absent (a tab opened from the sidebar's own
         * guide) the sole docked record answers instead. Reports back the tab
         * id the framework minted, and drops a record whose tab was closed by
         * hand so the composer seat returns to the inline card.
         */
        function PlanCardSidebarBody(props) {
            const tab = props.useTabInfo();
            // Params win when present; a stale param key (record already
            // settled) deliberately resolves nothing rather than some other
            // card, which keeps the done/idle faces honest.
            const paramKey = typeof tab?.navigation?.params?.reviewKey === 'string' ? tab.navigation.params.reviewKey : undefined;
            const key = paramKey ?? soleDockKey();
            const revision = useSyncExternalStore(subscribeDock, dockSnapshot);
            const record = key === undefined ? undefined : docked.get(key);
            const pending = record?.pending;
            const review = useMemo(() => (pending === undefined ? undefined : planReviewOf(pending.questions)), [pending, revision]);

            useEffect(() => {
                if (key === undefined || record === undefined) return;
                if (record.tabId === tab.tab.id) return;
                record.tabId = tab.tab.id;
                notifyDock();
            }, [key, record, tab.tab.id]);

            // The tab body is the tab's lifetime. When it unmounts while this
            // record is still the docked one, the user closed the tab by hand
            // (core never unmounts a tab body for any other reason), and the
            // composer seat goes back to the inline card. A move *out* of the
            // dock clears the record before unmounting, so the identity check
            // below tells the two apart.
            useEffect(() => () => {
                if (key !== undefined && docked.get(key) === record) clearDock(key);
            }, [key, record]);

            // Switch back: the tab goes away, the card returns to the composer
            // seat, and this component unmounts with its record.
            const onSwitch = useCallback(() => {
                releaseDock(key);
            }, [key]);

            // Settled: the composer seat is released — the dock record is what
            // "the card is in the sidebar" means — but the tab stays put and
            // turns into its done face. Closing it here would close the column
            // under a click that was about the plan, not about the layout.
            const onSettled = useCallback(() => {
                clearDock(key);
            }, [key]);

            if (pending === undefined || review === undefined) {
                return jsx('div', {
                    className: 'dsh-pcs-sidebar-card',
                    'data-plan-card': 'idle',
                    children: jsx('p', { className: 'dsh-pcs-empty', children: record === undefined ? TEXT.idle : TEXT.done })
                });
            }

            return jsx(PlanReviewCard, {
                pending,
                review,
                mode: 'sidebar',
                onSwitch,
                onSettled,
                variant: 'sidebar'
            });
        }

        /** The sidebar tab's chip title: the record's captured title is already this name. */
        function PlanCardSidebarTitle() {
            return jsx(Fragment, { children: TEXT.tabTitle });
        }

        // ─── composer seat ──────────────────────────────────────────────────

        /**
         * The composer seat while the card is docked: one status line and the
         * way back. `ensureDocked` re-opens the tab on mount, so a refresh that
         * kept the record (or a collapsed panel) never leaves the card in
         * neither home.
         */
        function PlanCardStub(props) {
            const pending = props.matched;
            const sessionId = pending.sessionId;
            const revision = useSyncExternalStore(subscribeDock, dockSnapshot);
            const [notice, setNotice] = useState(null);
            const [attempt, setAttempt] = useState(0);

            const review = useMemo(() => planReviewOf(pending.questions), [pending, revision]);
            const summary = review === undefined ? TEXT.header : planSummary(review.plan);
            const record = docked.get(pending.key);

            useEffect(() => {
                if (ensureDocked(record)) {
                    setNotice(null);
                    return;
                }
                setNotice(TEXT.stubError);
                ensureDockedSoon(pending.key);
            }, [pending.key, attempt, revision, record]);

            const back = useCallback(() => {
                // Confirmed synchronously before the seat changes hands: a
                // rejected confirmation is reported instead of silently
                // replacing the card with nothing.
                releaseDock(pending.key);
            }, [pending.key]);

            const retry = useCallback(() => {
                if (!docked.has(pending.key)) docked.set(pending.key, { key: pending.key, sessionId, tabId: undefined, pending });
                notifyDock();
                setAttempt((value) => value + 1);
            }, [pending.key, sessionId, pending]);

            return jsx('div', {
                className: 'dsh-pcs-composer-stub',
                'data-plan-card-stub': pending.key,
                children: jsxs('div', {
                    className: 'dsh-pcs-stub-card',
                    children: [
                        jsxs('div', {
                            className: 'dsh-pcs-stub-text',
                            children: [
                                jsx('span', { className: 'dsh-pcs-stub-title', title: summary, children: summary }),
                                jsx('span', {
                                    className: notice === null ? 'dsh-pcs-stub-desc' : 'dsh-pcs-stub-error',
                                    role: 'status',
                                    children: notice ?? TEXT.stubDesc
                                })
                            ]
                        }),
                        notice !== null && jsx(Button, { variant: 'outline', onClick: retry, children: TEXT.retry }),
                        jsx(Button, {
                            variant: 'outline',
                            icon: jsx(IconPanelLeftOutline16, { size: 14 }),
                            onClick: back,
                            children: TEXT.undock
                        })
                    ]
                })
            });
        }

        /**
         * The composer seat while the card is inline: core's card plus the
         * switch. Registering `dock` on the component keeps the seat
         * self-contained — the button's handler lives next to the state it
         * changes.
         */
        function PlanCardInline(props) {
            const pending = props.matched;
            const sessionId = pending.sessionId;
            const review = useMemo(() => planReviewOf(pending.questions), [pending]);
            const [refused, setRefused] = useState(false);

            const onSwitch = useCallback(() => {
                const sidebar = host?.sidebarRight;
                if (sidebar === undefined) {
                    setRefused(true);
                    return;
                }
                const active = activeSessionId();
                if (active !== undefined && active !== sessionId) {
                    setRefused(true);
                    return;
                }
                // Record before opening: the tab body resolves its review from
                // the record, so it must exist before the tab mounts.
                docked.set(pending.key, { key: pending.key, sessionId, tabId: undefined, pending });
                notifyDock();
                setRefused(false);
                const record = docked.get(pending.key);
                if (!ensureDocked(record)) ensureDockedSoon(pending.key);
            }, [pending, sessionId]);

            const onSettled = useCallback(() => undefined, []);

            if (review === undefined) return null;

            return jsxs(Fragment, {
                children: [
                    jsx(PlanReviewCard, {
                        pending,
                        review,
                        mode: 'inline',
                        onSwitch,
                        onSettled,
                        variant: 'composer'
                    }),
                    refused && jsx('div', {
                        className: 'dsh-pcs-composer-stub',
                        children: jsx('div', {
                            className: 'dsh-pcs-stub-card',
                            children: jsx('span', { className: 'dsh-pcs-stub-error', role: 'status', children: TEXT.stubError })
                        })
                    })
                ]
            });
        }

        // ─── plugin body ────────────────────────────────────────────────────

        /**
         * Required services: the slot registry, the sidebar's tab-type registry
         * and navigation controller, and the session roster (used to keep the
         * card and the sidebar on the same session).
         */
        const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions'];

        /**
         * Client plugin body: register the sidebar tab type with its two seats,
         * and take the composer seat ahead of core for plan reviews only.
         * @param ctx - client root context.
         */
        function apply(ctx) {
            host = ctx;
            initCss();

            const disposers = [];
            ctx.effect(() => () => {
                for (const dispose of disposers.splice(0)) {
                    try {
                        dispose();
                    } catch (error) {
                        console.error('[dsh-plan-card-sidebar] dispose failed:', error);
                    }
                }
            }, 'dsh-plan-card-sidebar: registrations');

            // The tab type: a page kind, so it opens by kind and needs no glob.
            disposers.push(ctx.sidebarRightTabs.register({
                id: TAB_ID,
                kind: TAB_KIND,
                priority: 'extension',
                title: () => TEXT.tabTitle,
                guide: [{
                    kind: TAB_KIND,
                    // Core's guide page ("开始") renders each capsule through
                    // EntryBox, which CALLS these fields: entry.title() and
                    // entry.description?.(). Plain strings throw
                    // "entry.title is not a function" and blank the whole guide
                    // pane, so both stay thunks — as core's own entries are.
                    title: () => TEXT.tabTitle,
                    description: () => TEXT.guideDescription,
                    order: 40
                }]
            }));

            disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
                name: 'sidebar.right.pane.tab',
                key: TAB_ID,
                inject: () => ({
                    hooks: {
                        tabInfo: (_standard, context) => {
                            const { tabId, title, fullscreen, signal, actions, useStore, useTabNavigation } = context;
                            return function useTabInfo() {
                                const navigation = useTabNavigation(tabId);
                                return useMemo(() => ({
                                    sidebar: { fullscreen },
                                    tab: {
                                        id: tabId,
                                        kind: TAB_KIND,
                                        title,
                                        navigation,
                                        signal,
                                        actions,
                                        useStore
                                    }
                                }), [navigation, signal, actions, fullscreen, title, useStore]);
                            };
                        }
                    }
                })
            }, PlanCardSidebarBody)));

            disposers.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
                name: 'sidebar.right.pane.tab.title',
                key: TAB_ID
            }, PlanCardSidebarTitle)));

            // The composer seat. Priority -1 is asked before core's entry at 0,
            // and the selector claims one request shape only; everything else
            // (including every non-plan question) returns null and stays core's.
            disposers.push(ctx.slots.inject('conversation.composer', () => ctx.slots.register({
                name: 'conversation.composer',
                priority: -1,
                select: ({ pendingInteraction }) => {
                    if (pendingInteraction === null || typeof pendingInteraction !== 'object') return null;
                    if (pendingInteraction.kind !== 'plan-review') return null;
                    if (planReviewOf(pendingInteraction.questions) === undefined) return null;
                    return pendingInteraction;
                }
            }, (props) => (isDocked(props.matched.key) ? jsx(PlanCardStub, props) : jsx(PlanCardInline, props)))));

            // A small service face for scripted checks and future callers; the
            // user-facing path is the card's own switch.
            ctx.provide('planCardSidebar', {
                isDocked,
                dock(pending) {
                    if (typeof pending?.key !== 'string' || typeof pending?.sessionId !== 'string') return false;
                    const active = activeSessionId();
                    if (active !== undefined && active !== pending.sessionId) return false;
                    docked.set(pending.key, { key: pending.key, sessionId: pending.sessionId, tabId: undefined, pending });
                    notifyDock();
                    return ensureDocked(docked.get(pending.key));
                },
                undock: releaseDock,
                soleDock
            });
        }

        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    }
});
