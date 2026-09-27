/**
 * dsh-workspace-changes — browser half: an IDE-style Changes panel as a
 * right-Sidebar tab.
 *
 * Layout (mirrors the JetBrains commit tool window it is modeled on):
 *  - narrow panel: stacked — the grouped changes tree (更改 / 未跟踪,
 *    冲突 pinned on top, directory sub-grouping with per-folder counts)
 *    collapses into a bar on top of the diff view, with ‹ 3/14 › file
 *    navigation in the diff header;
 *  - wide panel (user-dragged ≥ 760px) or framework fullscreen: tree on the
 *    left, diff on the right, exactly the IDE split.
 *  - diff lines always soft-wrap; long lines are never clipped.
 *
 * The diff viewer renders structured hunks from the host's /changes/diff
 * route (never raw text): dual line-number columns, add/del row tints,
 * collapsible hunks, a unified ⇄ side-by-side switch, copy-diff, and an
 * open-in-IDE split button (editor list from /changes/editors, choice kept in
 * localStorage).
 *
 * Freshness: the host's /changes/events SSE stream (fs/observed bursts plus a
 * slow poll) triggers a silent status refetch; the refresh button, tab
 * visibility regain, and file switches cover the interactive path.
 *
 * Read-only: this bundle sends no mutation verbs — the host half implements
 * none.
 *
 * @module dsh-workspace-changes/client
 */
window.__ModuleLoader__.load({
    id: 'dsh-workspace-changes',
    factory: (require) => {
        const module = { exports: {} };
        const exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

        const React = require('react');
        const { jsx, jsxs, Fragment } = require('react/jsx-runtime');
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        const {
            Button, FileTypeIcon, writeClipboard,
            IconBranchOutline16, IconRefreshOutline16, IconCopyOutline16,
            IconChevronDownOutline14, IconChevronRightOutline14,
            IconChevronLeftOutline14, IconChevronUpOutline14,
            IconRightUpOutline16, IconFolderClose16, IconFolderOpen16,
            IconWarningOutline16, IconCloseOutline16
        } = primitives;

        const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React;

        // ─── copy (locale dictionaries) ─────────────────────────────────────
        const NS = 'workspace-changes';
        const zh = {
            'tab.title': '变更',
            'guide.title': '变更',
            'guide.description': '像 IDE 一样查看当前工作区的 git 变更与逐行差异',
            'group.changes': '更改',
            'group.unversioned': '未跟踪文件',
            'group.conflicts': '冲突',
            'filesCount': '{n} 个文件',
            'refresh': '刷新',
            'collapseAll': '全部收起',
            'expandAll': '全部展开',
            'back': '返回列表',
            'copyDiff': '复制 diff',
            'copied': '已复制',
            'openInIde': '在 IDE 打开',
            'openInIdeAt': '在 IDE 中打开（当前行）',
            'chooseEditor': '选择编辑器',
            'viewUnified': '统一视图',
            'viewSplit': '双栏对照',
            'state.noWorkspace': '当前会话没有工作区。',
            'state.notRepo': '当前工作区不是 git 仓库。',
            'state.clean': '工作区干净，没有本地变更。',
            'state.loading': '正在读取变更…',
            'state.error': '读取失败',
            'state.retry': '重试',
            'state.pickFile': '从左侧选择一个文件查看差异。',
            'state.binary': '二进制文件，无法显示差异。',
            'state.truncated': '差异过大，仅显示前一部分。',
            'state.rowsCapped': '差异行数过多，仅显示前一部分（复制 diff 仍是完整内容）。',
            'state.hiddenFiles': '…还有 {n} 个文件未显示（超出显示上限）',
            'state.emptyDiff': '没有文本差异（可能仅是文件模式变更）。',
            'state.untrackedDiff': '新文件，全部为新增内容。',
            'hunk.fold': '折叠',
            'hunk.expand': '展开',
            'rename': '重命名自 {old}',
            'ahead': '领先 {n}',
            'behind': '落后 {n}',
            'detached': '游离 HEAD',
            'openFailed': '打开编辑器失败：{message}',
            'noEditor': '未找到可用编辑器，请在插件配置里添加 editors 命令模板。'
        };
        const en = {
            'tab.title': 'Changes',
            'guide.title': 'Changes',
            'guide.description': 'Review the workspace’s git changes with an IDE-style diff viewer',
            'group.changes': 'Changes',
            'group.unversioned': 'Unversioned Files',
            'group.conflicts': 'Conflicts',
            'filesCount': '{n} files',
            'refresh': 'Refresh',
            'collapseAll': 'Collapse all',
            'expandAll': 'Expand all',
            'back': 'Back to list',
            'copyDiff': 'Copy diff',
            'copied': 'Copied',
            'openInIde': 'Open in IDE',
            'openInIdeAt': 'Open in IDE (current line)',
            'chooseEditor': 'Choose editor',
            'viewUnified': 'Unified',
            'viewSplit': 'Side by side',
            'state.noWorkspace': 'This session has no workspace.',
            'state.notRepo': 'This workspace is not a git repository.',
            'state.clean': 'Clean working tree — no local changes.',
            'state.loading': 'Reading changes…',
            'state.error': 'Failed to read changes',
            'state.retry': 'Retry',
            'state.pickFile': 'Pick a file on the left to see its diff.',
            'state.binary': 'Binary file — no diff to show.',
            'state.truncated': 'Large diff — only the first part is shown.',
            'state.rowsCapped': 'Too many diff rows — only the first part is shown (copy diff still gets everything).',
            'state.hiddenFiles': '…and {n} more files not shown (display cap)',
            'state.emptyDiff': 'No textual changes (possibly a mode-only change).',
            'state.untrackedDiff': 'New file — everything is an addition.',
            'hunk.fold': 'Collapse',
            'hunk.expand': 'Expand',
            'rename': 'renamed from {old}',
            'ahead': 'ahead {n}',
            'behind': 'behind {n}',
            'detached': 'detached HEAD',
            'openFailed': 'Failed to open the editor: {message}',
            'noEditor': 'No editor available; add an editors command template in the plugin config.'
        };

        /** Interpolate `{name}` holes in a dictionary string. */
        function fmt(text, holes) {
            if (holes === undefined) return text;
            return text.replace(/\{(\w+)\}/gu, (_, name) => String(holes[name] ?? `{${name}}`));
        }

        // ─── styles ─────────────────────────────────────────────────────────
        const CSS_TAG_ID = 'dsh-workspace-changes/ChangesPanel.module.css';
        const CSS = [
            '.dsh-wc-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);',
            '--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
            '.dsh-wc-root,.dsh-wc-root *{box-sizing:border-box}',
            // toolbar
            '.dsh-wc-toolbar{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex:none}',
            '.dsh-wc-branch{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border:1px solid var(--dsw-alias-border-l2);',
            'border-radius:999px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);max-width:55%;overflow:hidden}',
            '.dsh-wc-branch-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
            '.dsh-wc-ab{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
            '.dsh-wc-spacer{flex:1 1 auto}',
            '.dsh-wc-totals{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
            '.dsh-wc-totals b{font-weight:600}.dsh-wc-totals .up{color:var(--dsw-alias-state-success-primary)}.dsh-wc-totals .dn{color:var(--dsw-alias-state-error-primary)}',
            '.dsh-wc-iconbtn{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:8px;',
            'background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;flex:none}',
            '.dsh-wc-iconbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
            '.dsh-wc-iconbtn:disabled{opacity:.45;cursor:default}',
            '.dsh-wc-iconbtn[data-on]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
            '.dsh-wc-spin svg{animation:dsh-wc-rotate 1s linear infinite}',
            '@keyframes dsh-wc-rotate{to{transform:rotate(360deg)}}',
            // tree
            '.dsh-wc-tree{flex:1 1 auto;min-height:0;overflow-y:auto;padding:4px 6px 10px}',
            '.dsh-wc-group{margin-top:2px}',
            '.dsh-wc-grouphead{display:flex;align-items:center;gap:5px;width:100%;padding:4px 6px;border:none;background:transparent;cursor:pointer;',
            'border-radius:8px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;text-align:left}',
            '.dsh-wc-grouphead:hover{background:var(--dsw-alias-interactive-bg-hover)}',
            '.dsh-wc-count{color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:12px}',
            '.dsh-wc-grouphead[data-tone=conflict]{color:var(--dsw-alias-state-error-primary)}',
            '.dsh-wc-dir{display:flex;align-items:center;gap:5px;width:100%;padding:3px 6px;border:none;background:transparent;cursor:pointer;',
            'border-radius:7px;color:var(--dsw-alias-label-secondary);font-size:12px;text-align:left}',
            '.dsh-wc-dir:hover{background:var(--dsw-alias-interactive-bg-hover)}',
            '.dsh-wc-dirname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dsh-wc-file{display:flex;align-items:center;gap:7px;width:100%;padding:3px 6px;border:none;border-radius:7px;background:transparent;',
            'cursor:pointer;text-align:left;font-size:13px;color:var(--dsw-alias-label-primary)}',
            '.dsh-wc-file:hover{background:var(--dsw-alias-interactive-bg-hover)}',
            '.dsh-wc-file[data-selected]{background:var(--dsw-alias-interactive-bg-hover);box-shadow:inset 2px 0 0 var(--dsw-alias-state-success-primary)}',
            '.dsh-wc-fname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dsh-wc-fdir{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:38%}',
            '.dsh-wc-stat{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}',
            '.dsh-wc-stat .up{color:var(--dsw-alias-state-success-primary)}.dsh-wc-stat .dn{color:var(--dsw-alias-state-error-primary)}',
            '.dsh-wc-kind{flex:none;width:15px;text-align:center;font-size:10px;font-weight:700;border-radius:4px;line-height:14px}',
            '.dsh-wc-kind[data-k=modified]{color:var(--dsw-alias-state-info-primary,#4f8cff)}',
            '.dsh-wc-kind[data-k=added],.dsh-wc-kind[data-k=untracked]{color:var(--dsw-alias-state-success-primary)}',
            '.dsh-wc-kind[data-k=deleted],.dsh-wc-kind[data-k=conflict]{color:var(--dsw-alias-state-error-primary)}',
            '.dsh-wc-kind[data-k=renamed],.dsh-wc-kind[data-k=typechanged]{color:var(--dsw-alias-state-warn-primary,#c8a23c)}',
            '.dsh-wc-file .dsh-wc-open{visibility:hidden}',
            '.dsh-wc-file:hover .dsh-wc-open{visibility:visible}',
            // diff view
            '.dsh-wc-diffhead{display:flex;align-items:center;gap:4px;padding:6px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex:none;min-width:0}',
            '.dsh-wc-diffpath{display:flex;align-items:center;gap:6px;min-width:0;flex:1 1 auto;font-size:12px;color:var(--dsw-alias-label-secondary)}',
            '.dsh-wc-diffname{color:var(--dsw-alias-label-primary);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
            '.dsh-wc-diffdir{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}',
            '.dsh-wc-nav{display:inline-flex;align-items:center;gap:2px;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap}',
            '.dsh-wc-diffbody{flex:1 1 auto;min-height:0;overflow:auto;font:var(--dsw-font-markdown-code-block);font-size:12px;line-height:20px}',
            '.dsh-wc-row{display:flex}',
            '.dsh-wc-no{flex:none;width:44px;padding:0 8px;text-align:right;color:var(--dsw-alias-label-tertiary);user-select:none;opacity:.75}',
            // Long lines WRAP, never clip: flex:1 1 0 cells report a zero
            // max-content contribution, so min-width:max-content on the row
            // never overflowed and overflow:hidden silently cut text at the
            // pane edge with no scrollbar (2026-09-26 report).
            '.dsh-wc-text{flex:1 1 auto;white-space:pre-wrap;overflow-wrap:anywhere;padding-right:16px;color:var(--dsw-alias-label-primary)}',
            '.dsh-wc-row[data-t="+"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 13%,transparent)}',
            '.dsh-wc-row[data-t="+"] .dsh-wc-text{color:var(--dsw-alias-state-success-primary)}',
            '.dsh-wc-row[data-t="-"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}',
            '.dsh-wc-row[data-t="-"] .dsh-wc-text{color:var(--dsw-alias-state-error-primary)}',
            '.dsh-wc-row[data-cursor]{box-shadow:inset 2px 0 0 var(--dsw-alias-label-tertiary)}',
            '.dsh-wc-hunk{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;padding:2px 10px;cursor:pointer;',
            'background:var(--dsw-alias-bg-inset,var(--dsw-specific-input-major));border-bottom:.5px solid var(--dsw-alias-border-l2);',
            'color:var(--dsw-alias-label-tertiary);font-size:11px;user-select:none}',
            '.dsh-wc-hunk:hover{color:var(--dsw-alias-label-secondary)}',
            '.dsh-wc-hunksig{font-family:monospace;white-space:pre;overflow:hidden;text-overflow:ellipsis}',
            '.dsh-wc-nonl{color:var(--dsw-alias-label-tertiary);font-style:italic;padding-left:8px}',
            // split view
            '.dsh-wc-srow{display:flex}',
            '.dsh-wc-scell{flex:1 1 0;min-width:0;display:flex}',
            '.dsh-wc-scell[data-t="+"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 13%,transparent)}',
            '.dsh-wc-scell[data-t="-"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}',
            '.dsh-wc-scell[data-t="+"] .dsh-wc-text{color:var(--dsw-alias-state-success-primary)}',
            '.dsh-wc-scell[data-t="-"] .dsh-wc-text{color:var(--dsw-alias-state-error-primary)}',
            '.dsh-wc-divider{flex:none;width:.5px;background:var(--dsw-alias-border-l2)}',
            // fullscreen split layout
            '.dsh-wc-splitlayout{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:300px minmax(0,1fr)}',
            '.dsh-wc-splitlayout .dsh-wc-tree{border-right:.5px solid var(--dsw-alias-border-l2)}',
            // narrow stacked layout: the list stays on top of the diff
            '.dsh-wc-stack{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}',
            '.dsh-wc-listbar{display:flex;align-items:center;gap:6px;padding:4px 10px;border:none;border-bottom:.5px solid var(--dsw-alias-border-l2);',
            'background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;flex:none;text-align:left}',
            '.dsh-wc-listbar:hover{background:var(--dsw-alias-interactive-bg-hover)}',
            '.dsh-wc-listbar-label{flex:1 1 auto;font-weight:600;color:var(--dsw-alias-label-primary)}',
            '.dsh-wc-treeregion{flex:0 1 auto;min-height:0;max-height:38%;overflow-y:auto;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
            // states
            '.dsh-wc-state{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center}',
            '.dsh-wc-state p{margin:0;font-size:13px;color:var(--dsw-alias-label-tertiary);line-height:20px;max-width:320px}',
            '.dsh-wc-state [data-icon]{color:var(--dsw-alias-label-tertiary)}',
            '.dsh-wc-notice{display:flex;align-items:center;gap:6px;margin:6px 10px 0;padding:6px 10px;border-radius:8px;font-size:12px;',
            'background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}',
            '.dsh-wc-note{display:flex;align-items:center;gap:6px;margin:6px 10px 0;padding:5px 10px;border-radius:8px;font-size:12px;',
            'background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
            '.dsh-wc-more{padding:5px 10px 5px 24px;font-size:12px;color:var(--dsw-alias-label-tertiary);font-style:italic}',
            // editor dropdown
            '.dsh-wc-segment{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;flex:none}',
            '.dsh-wc-segbtn{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:3px 8px;font-size:12px;line-height:16px}',
            '.dsh-wc-segbtn:hover{color:var(--dsw-alias-label-primary)}',
            '.dsh-wc-segbtn[data-on]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
            '.dsh-wc-menuwrap{position:relative;display:inline-flex}',
            '.dsh-wc-menu{position:absolute;top:calc(100% + 4px);right:0;z-index:30;min-width:180px;padding:4px;border-radius:10px;',
            'background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv2)}',
            '.dsh-wc-menuitem{display:flex;align-items:center;gap:8px;width:100%;padding:6px 9px;border:none;border-radius:7px;background:transparent;',
            'cursor:pointer;font-size:12px;color:var(--dsw-alias-label-primary);text-align:left}',
            '.dsh-wc-menuitem:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
            '.dsh-wc-menuitem:disabled{opacity:.45;cursor:default}',
            '.dsh-wc-menuitem[data-current]{color:var(--dsw-alias-state-success-primary)}',
            '.dsh-wc-editoricon{width:14px;height:14px;flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:3px;object-fit:contain}',
        ].join('');

        function initCss() {
            if (typeof document === 'undefined') return;
            if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') !== null) return;
            const tag = document.createElement('style');
            tag.dataset.plugin = 'dsh-workspace-changes';
            tag.dataset.pluginCss = CSS_TAG_ID;
            tag.textContent = CSS;
            document.head.appendChild(tag);
        }

        // ─── transport ──────────────────────────────────────────────────────
        async function post(path, payload) {
            let response;
            try {
                response = await fetch(path, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            } catch {
                return { ok: false, error: { code: 'transport', message: 'route unavailable' } };
            }
            try {
                const envelope = await response.json();
                if (envelope === null || typeof envelope !== 'object') return { ok: false, error: { code: 'transport', message: 'bad envelope' } };
                return envelope;
            } catch {
                return { ok: false, error: { code: 'transport', message: 'bad envelope' } };
            }
        }

        const api = {
            status: (path) => post('/changes/status', { path }),
            diff: (path, file) => post('/changes/diff', { path, file }),
            openInIde: (path, file, line, editor) => post('/changes/open', { path, file, line, editor }),
            async editors() {
                try {
                    const response = await fetch('/changes/editors');
                    const envelope = await response.json();
                    return envelope?.ok === true && Array.isArray(envelope.value) ? envelope.value : [];
                } catch {
                    return [];
                }
            }
        };

        // ─── per-tab store ──────────────────────────────────────────────────
        const tabs = new Map();
        const listeners = new Set();
        let revision = 0;

        function subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
        function snapshot() {
            return revision;
        }
        function notify() {
            revision += 1;
            for (const listener of [...listeners]) {
                try {
                    listener();
                } catch (error) {
                    console.error('[dsh-workspace-changes] listener failed:', error);
                }
            }
        }

        function freshState(cwd) {
            return {
                phase: 'loading', // loading | ready | error | no-workspace | not-repo
                error: undefined,
                cwd,
                status: undefined,
                collapsed: new Set(),
                selected: undefined, // { path, unversioned, kind, oldPath? }
                diffs: new Map(), // path -> { phase, diff?, error? }
                foldedHunks: new Set(), // `${path}#${hunkIndex}`
                viewMode: 'auto', // auto | unified | split
                cursorLine: 1,
                editors: undefined,
                editorChoice: readEditorChoice(),
                notice: undefined,
                sse: undefined,
                ssePath: undefined,
                refreshTimer: undefined
            };
        }

        function stateOf(tabId, cwd) {
            let state = tabs.get(tabId);
            if (state === undefined) {
                state = freshState(cwd);
                tabs.set(tabId, state);
            } else if (cwd !== undefined && state.cwd !== cwd) {
                // The tab switched sessions: drop every workspace-bound piece.
                stopSse(state);
                state = freshState(cwd);
                tabs.set(tabId, state);
            }
            return state;
        }

        function readEditorChoice() {
            try {
                const value = window.localStorage.getItem('dsh-workspace-changes:editor');
                return value === null || value === '' ? undefined : value;
            } catch {
                return undefined;
            }
        }

        function keepEditorChoice(choice) {
            try {
                if (choice === undefined) window.localStorage.removeItem('dsh-workspace-changes:editor');
                else window.localStorage.setItem('dsh-workspace-changes:editor', choice);
            } catch {
                // storage may be unavailable; the choice just won't persist
            }
        }

        /** The flat, display-ordered file list (navigation order). */
        function flatFiles(status) {
            if (status === undefined || status === null) return [];
            const ofGroup = (entries, unversioned) => entries.map((entry) => ({ ...entry, unversioned }));
            return [
                ...ofGroup(status.groups.conflicts, false),
                ...ofGroup(status.groups.changes, false),
                ...ofGroup(status.groups.unversioned, true)
            ];
        }

        /**
         * Whether a keydown belongs to a surface that owns its own ↑/↓/Escape —
         * the composer (`[data-composer-input]`), any input, textarea, select or
         * contenteditable region.
         *
         * Why this guard exists (2026-09-26 bug report: "输入框里光标不能上下移动"):
         * the diff shortcuts below live on a bare `window` listener, so with a
         * diff open they fired for EVERY keydown in the app. A `preventDefault()`
         * there cancels the contenteditable's native caret movement (the browser
         * applies the default action after the whole dispatch), so typing in the
         * composer lost its arrow keys — and its Escape. The shortcuts now stand
         * down for typing surfaces; the panel itself is not focusable, so they
         * still work whenever the user's focus is not in a field.
         * @param target - the event target.
         * @returns true when the event comes from a typing surface.
         */
        function isTypingTarget(target) {
            if (target === null || target === undefined || typeof target !== 'object') return false;
            if (typeof target.closest !== 'function') return false;
            return target.closest('[data-composer-input], input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null;
        }

        /**
         * What one keydown means for the diff shortcuts — the whole decision in
         * one pure function, so the typing guard is testable without a renderer.
         * @param hasSelection - whether a file diff is currently open.
         * @param event - the keydown event (only `key` and `target` are read).
         * @returns `'back'` (Escape), `'next'` (↓), `'prev'` (↑), or null to ignore.
         */
        function diffShortcutAction(hasSelection, event) {
            if (hasSelection !== true) return null;
            if (event === null || event === undefined) return null;
            if (isTypingTarget(event.target)) return null;
            if (event.key === 'Escape') return 'back';
            if (event.key === 'ArrowDown') return 'next';
            if (event.key === 'ArrowUp') return 'prev';
            return null;
        }

        async function refresh(tabId, { silent = false } = {}) {
            const state = tabs.get(tabId);
            if (state === undefined || state.cwd === undefined) return;
            if (state.refreshing === true) return;
            state.refreshing = true;
            if (!silent && state.phase !== 'ready') state.phase = 'loading';
            if (!silent) notify();
            const result = await api.status(state.cwd);
            const current = tabs.get(tabId);
            if (current !== state) return; // workspace switched mid-flight
            state.refreshing = false;
            if (!result.ok) {
                state.phase = 'error';
                state.error = result.error?.message ?? 'unknown';
                notify();
                return;
            }
            if (result.value === null) {
                state.phase = 'not-repo';
                state.status = undefined;
                notify();
                return;
            }
            state.phase = 'ready';
            state.error = undefined;
            state.status = result.value;
            // Keep the selection only while the file still exists in the list.
            if (state.selected !== undefined) {
                const still = flatFiles(result.value).find((entry) => entry.path === state.selected.path && entry.unversioned === state.selected.unversioned);
                if (still === undefined) {
                    state.selected = undefined;
                } else {
                    state.selected = still;
                    // Content may have moved — but poll/SSE refreshes must not
                    // flash the diff back to "loading": keep the old content
                    // on screen until the refetched one lands.
                    void ensureDiff(tabId, { background: state.diffs.has(still.path) });
                }
            }
            notify();
        }

        /**
         * Fetch the selected file's diff. `background` (only honored when a
         * cached record exists) keeps the stale diff on screen while the new
         * one is in flight — used by poll/SSE refreshes.
         */
        async function ensureDiff(tabId, options = {}) {
            const state = tabs.get(tabId);
            if (state === undefined || state.selected === undefined || state.cwd === undefined) return;
            const path = state.selected.path;
            const cached = state.diffs.get(path);
            if (cached !== undefined && cached.phase === 'loading') return;
            if (options.background !== true || cached === undefined) {
                state.diffs.set(path, { phase: 'loading' });
                notify();
            }
            const result = await api.diff(state.cwd, path);
            const current = tabs.get(tabId);
            if (current !== state) return;
            if (!result.ok) state.diffs.set(path, { phase: 'error', error: result.error?.message ?? 'unknown' });
            else state.diffs.set(path, { phase: 'ready', diff: result.value });
            notify();
        }

        /**
         * Normalize a tree entry into a selection record: tree entries carry no
         * `unversioned` field, but the navigation index compares against
         * flatFiles' booleans — an undefined here stranded the counter at 0/N
         * and killed the ‹ › arrows (2026-09-25 report).
         */
        function normalizeSelection(entry) {
            if (entry === null || entry === undefined) return undefined;
            return {
                path: entry.path,
                unversioned: entry.unversioned === true,
                kind: entry.kind,
                oldPath: entry.oldPath
            };
        }

        function select(tabId, entry) {
            const state = tabs.get(tabId);
            if (state === undefined) return;
            state.selected = normalizeSelection(entry);
            state.cursorLine = 1;
            notify();
            if (entry !== null && entry !== undefined) void ensureDiff(tabId);
        }

        function navFile(tabId, delta) {
            const state = tabs.get(tabId);
            if (state === undefined || state.status === undefined || state.selected === undefined) return;
            const files = flatFiles(state.status);
            const index = files.findIndex((entry) => entry.path === state.selected.path && entry.unversioned === state.selected.unversioned);
            if (index === -1) return;
            const next = files[(index + delta + files.length) % files.length];
            if (next !== undefined) select(tabId, next);
        }

        function stopSse(state) {
            if (state.sse !== undefined) {
                state.sse.close();
                state.sse = undefined;
                state.ssePath = undefined;
            }
        }

        function startSse(tabId, state) {
            if (state.cwd === undefined || state.ssePath === state.cwd) return;
            stopSse(state);
            try {
                const source = new EventSource('/changes/events?path=' + encodeURIComponent(state.cwd));
                source.addEventListener('change', () => {
                    // Coalesce bursts: one refetch per quiet window.
                    if (state.refreshTimer !== undefined) return;
                    state.refreshTimer = window.setTimeout(() => {
                        state.refreshTimer = undefined;
                        void refresh(tabId, { silent: true });
                    }, 400);
                });
                state.sse = source;
                state.ssePath = state.cwd;
            } catch (error) {
                console.warn('[dsh-workspace-changes] SSE unavailable:', error);
            }
        }

        /** First mount for one tab: load status, open the stream, wire focus refetch. */
        function start(tabId, cwd, signal) {
            const state = stateOf(tabId, cwd);
            if (state.cwd === undefined) {
                state.cwd = cwd;
            }
            void refresh(tabId);
            startSse(tabId, state);
            const onVisible = () => {
                if (document.visibilityState === 'visible') void refresh(tabId, { silent: true });
            };
            document.addEventListener('visibilitychange', onVisible);
            signal.addEventListener('abort', () => {
                document.removeEventListener('visibilitychange', onVisible);
                stopSse(state);
                if (state.refreshTimer !== undefined) window.clearTimeout(state.refreshTimer);
                tabs.delete(tabId);
            }, { once: true });
        }

        // ─── tree model ─────────────────────────────────────────────────────
        /** Per-group render cap: a node_modules-scale tree must never reach the DOM. */
        const GROUP_ROW_CAP = 500;
        /** Per-diff rendered-line cap (copy still carries the complete diff). */
        const DIFF_ROW_CAP = 5000;
        /** One directory node of the grouped tree. */
        function dirNode(name, fullPath) {
            return { name, path: fullPath, count: 0, dirs: new Map(), files: [] };
        }

        /**
         * Build the nested directory tree of one group's entries. Directory
         * chains are kept level by level (the JetBrains tree the UI mirrors);
         * `count` on a directory is its descendant file total.
         */
        function buildTree(entries) {
            const root = dirNode('', '');
            for (const entry of entries) {
                const segments = entry.path.split('/');
                let node = root;
                for (let index = 0; index < segments.length - 1; index += 1) {
                    const name = segments[index];
                    const fullPath = segments.slice(0, index + 1).join('/');
                    if (!node.dirs.has(name)) node.dirs.set(name, dirNode(name, fullPath));
                    node = node.dirs.get(name);
                    node.count += 1;
                }
                node.files.push(entry);
            }
            const sortNode = (node) => {
                node.dirs = new Map([...node.dirs.entries()].sort((left, right) => left[0].localeCompare(right[0])).map(([key, value]) => [key, sortNode(value)]));
                return node;
            };
            return sortNode(root);
        }

        /** Directory path of a repo-relative file path ('' for root files). */
        function dirOf(path) {
            const cut = path.lastIndexOf('/');
            return cut === -1 ? '' : path.slice(0, cut);
        }
        function baseOf(path) {
            const cut = path.lastIndexOf('/');
            return cut === -1 ? path : path.slice(cut + 1);
        }

        // ─── diff transforms ────────────────────────────────────────────────
        /**
         * Trim a hunk list to at most `cap` content lines (hunk headers free).
         * Returns the same array when under the cap; otherwise a new, shorter
         * one whose last hunk is cut mid-body. Rendering only — `copyTextOf`
         * always serializes the untrimmed original.
         */
        function capHunks(hunks, cap) {
            if (diffLineCount(hunks) <= cap) return hunks; // under cap: identity, no copy
            let budget = cap;
            const out = [];
            for (const hunk of hunks) {
                if (budget <= 0) break;
                if (hunk.lines.length <= budget) {
                    out.push(hunk);
                    budget -= hunk.lines.length;
                    continue;
                }
                out.push({ ...hunk, lines: hunk.lines.slice(0, budget) });
                budget = 0;
            }
            return out;
        }

        /** Total content lines across hunks. */
        function diffLineCount(hunks) {
            let total = 0;
            for (const hunk of hunks) total += hunk.lines.length;
            return total;
        }

        /**
         * Pair a hunk's lines into side-by-side rows: a run of deletions
         * immediately followed by a run of additions pairs line-by-line (the
         * "modified" block); leftover lines of the longer side pair with null.
         * @returns `[{ left: {no,t,text}|null, right: {no,t,text}|null }]`.
         */
        function toSplitRows(hunk) {
            const rows = [];
            let oldNo = hunk.oldStart;
            let newNo = hunk.newStart;
            let index = 0;
            const lines = hunk.lines;
            while (index < lines.length) {
                const line = lines[index];
                if (line.t === ' ') {
                    rows.push({ left: { no: oldNo, t: ' ', text: line.text }, right: { no: newNo, t: ' ', text: line.text } });
                    oldNo += 1;
                    newNo += 1;
                    index += 1;
                    continue;
                }
                if (line.t === '\\') {
                    index += 1;
                    continue;
                }
                // Collect the deletion run and the addition run that follows it.
                const dels = [];
                const adds = [];
                while (index < lines.length && lines[index].t === '-') {
                    dels.push({ no: oldNo, t: '-', text: lines[index].text });
                    oldNo += 1;
                    index += 1;
                }
                while (index < lines.length && lines[index].t === '+') {
                    adds.push({ no: newNo, t: '+', text: lines[index].text });
                    newNo += 1;
                    index += 1;
                }
                const max = Math.max(dels.length, adds.length);
                for (let pair = 0; pair < max; pair += 1) {
                    rows.push({ left: dels[pair] ?? null, right: adds[pair] ?? null });
                }
            }
            return rows;
        }

        /** Rebuild unified diff text (what the copy button puts on the clipboard). */
        function copyTextOf(diff) {
            const out = [`diff --git a/${diff.oldFile ?? diff.file} b/${diff.file}`];
            if (diff.binary) return `${diff.file}: binary file`;
            for (const hunk of diff.hunks) {
                out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.section ? ` ${hunk.section}` : ''}`);
                for (const line of hunk.lines) out.push(line.t === '\\' ? `\\ ${line.text}` : `${line.t}${line.text}`);
            }
            return out.join('\n');
        }

        // ─── tiny view helpers ──────────────────────────────────────────────
        function IconBtn(props) {
            return jsx('button', {
                type: 'button',
                className: 'dsh-wc-iconbtn' + (props.className ? ` ${props.className}` : ''),
                title: props.title,
                'aria-label': props.title,
                disabled: props.disabled === true,
                'data-on': props.on === true ? '' : undefined,
                onClick: props.onClick,
                children: props.children
            });
        }

        function KindBadge(props) {
            const letter = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', typechanged: 'T', conflict: 'U', untracked: 'U' }[props.kind] ?? 'M';
            return jsx('span', { className: 'dsh-wc-kind', 'data-k': props.kind, children: letter });
        }

        function StatText(props) {
            if ((props.added ?? 0) === 0 && (props.deleted ?? 0) === 0) return null;
            return jsxs('span', {
                className: 'dsh-wc-stat',
                children: [
                    props.added > 0 && jsx('span', { className: 'up', children: `+${props.added}` }),
                    props.added > 0 && props.deleted > 0 ? ' ' : null,
                    props.deleted > 0 && jsx('span', { className: 'dn', children: `−${props.deleted}` })
                ]
            });
        }

        // ─── tree components ────────────────────────────────────────────────
        function FileRow(props) {
            const { entry, unversioned, depth, selected, t } = props;
            const onOpen = (event) => {
                event.stopPropagation();
                props.onOpenInIde(entry);
            };
            return jsxs('button', {
                type: 'button',
                className: 'dsh-wc-file',
                style: { paddingLeft: `${6 + depth * 14}px` },
                'data-selected': selected === true ? '' : undefined,
                title: entry.oldPath !== undefined ? fmt(t('rename'), { old: entry.oldPath }) : entry.path,
                onClick: () => props.onSelect({ ...entry, unversioned }),
                children: [
                    jsx(KindBadge, { kind: entry.kind }),
                    jsx(FileTypeIcon, { path: entry.path, size: 14 }),
                    jsx('span', { className: 'dsh-wc-fname', children: baseOf(entry.path) }),
                    depth === 0 && dirOf(entry.path) !== '' && jsx('span', { className: 'dsh-wc-fdir', children: dirOf(entry.path) }),
                    jsx('span', { style: { flex: '1 1 auto' } }),
                    !unversioned && jsx(StatText, { added: entry.added, deleted: entry.deleted }),
                    jsx('span', {
                        className: 'dsh-wc-iconbtn dsh-wc-open',
                        role: 'button',
                        title: t('openInIde'),
                        onClick: onOpen,
                        children: jsx(IconRightUpOutline16, { size: 13 })
                    })
                ]
            });
        }

        function DirRows(props) {
            const { node, depth } = props;
            const rows = [];
            for (const [name, child] of node.dirs) {
                const key = `dir:${child.path}`;
                const collapsed = props.collapsed.has(key);
                rows.push(jsxs('button', {
                    key,
                    type: 'button',
                    className: 'dsh-wc-dir',
                    style: { paddingLeft: `${6 + depth * 14}px` },
                    onClick: () => props.onToggle(key),
                    children: [
                        jsx(collapsed ? IconChevronRightOutline14 : IconChevronDownOutline14, { size: 12 }),
                        jsx(collapsed ? IconFolderClose16 : IconFolderOpen16, { size: 14 }),
                        jsx('span', { className: 'dsh-wc-dirname', children: name }),
                        jsx('span', { className: 'dsh-wc-count', children: fmt(props.t('filesCount'), { n: child.count }) })
                    ]
                }));
                if (!collapsed) rows.push(jsx(DirRows, { ...props, key: `${key}/rows`, node: child, depth: depth + 1 }));
            }
            for (const entry of node.files) {
                rows.push(jsx(FileRow, {
                    key: `file:${entry.path}`,
                    entry,
                    depth,
                    unversioned: props.unversioned,
                    selected: props.selectedPath === entry.path && props.selectedUnversioned === props.unversioned,
                    t: props.t,
                    onSelect: props.onSelect,
                    onOpenInIde: props.onOpenInIde
                }));
            }
            return jsx(Fragment, { children: rows });
        }

        function GroupView(props) {
            const { id, label, entries, unversioned, tone } = props;
            const key = `group:${id}`;
            const collapsed = props.collapsed.has(key);
            // Client render cap on top of the host's group cap: the DOM never
            // sees more than GROUP_ROW_CAP rows from one group.
            const shown = entries.length > GROUP_ROW_CAP ? entries.slice(0, GROUP_ROW_CAP) : entries;
            const hiddenHere = (entries.length - shown.length) + (props.hidden ?? 0);
            const tree = useMemo(() => buildTree(shown), [shown]);
            if (entries.length === 0 && hiddenHere === 0) return null;
            const headerCount = entries.length + (props.hidden ?? 0);
            return jsxs('section', {
                className: 'dsh-wc-group',
                children: [
                    jsxs('button', {
                        type: 'button',
                        className: 'dsh-wc-grouphead',
                        'data-tone': tone,
                        onClick: () => props.onToggle(key),
                        children: [
                            jsx(collapsed ? IconChevronRightOutline14 : IconChevronDownOutline14, { size: 12 }),
                            jsx('span', { children: label }),
                            jsx('span', { className: 'dsh-wc-count', children: fmt(props.t('filesCount'), { n: headerCount }) })
                        ]
                    }),
                    !collapsed && jsx(DirRows, {
                        node: tree,
                        depth: 1,
                        unversioned,
                        collapsed: props.collapsed,
                        onToggle: props.onToggle,
                        selectedPath: props.selectedPath,
                        selectedUnversioned: props.selectedUnversioned,
                        t: props.t,
                        onSelect: props.onSelect,
                        onOpenInIde: props.onOpenInIde
                    }),
                    !collapsed && hiddenHere > 0 && jsx('div', {
                        className: 'dsh-wc-more',
                        children: fmt(props.t('state.hiddenFiles'), { n: hiddenHere })
                    })
                ]
            });
        }

        // ─── diff components ────────────────────────────────────────────────
        function UnifiedRows(props) {
            const { diff, tabId, foldedHunks, onFold } = props;
            const blocks = [];
            diff.hunks.forEach((hunk, hunkIndex) => {
                const key = `${diff.file}#${hunkIndex}`;
                const folded = foldedHunks.has(key);
                blocks.push(jsxs('div', {
                    key: `h${hunkIndex}`,
                    className: 'dsh-wc-hunk',
                    title: folded ? props.t('hunk.expand') : props.t('hunk.fold'),
                    onClick: () => onFold(tabId, key),
                    children: [
                        jsx(folded ? IconChevronRightOutline14 : IconChevronDownOutline14, { size: 12 }),
                        jsxs('span', {
                            className: 'dsh-wc-hunksig',
                            children: [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, hunk.section !== '' ? ` ${hunk.section}` : '']
                        }),
                        jsx('span', { className: 'dsh-wc-count', children: `+${hunk.lines.filter((line) => line.t === '+').length} −${hunk.lines.filter((line) => line.t === '-').length}` })
                    ]
                }));
                if (folded) return;
                let oldNo = hunk.oldStart;
                let newNo = hunk.newStart;
                hunk.lines.forEach((line, lineIndex) => {
                    if (line.t === '\\') {
                        blocks.push(jsx('div', { key: `${hunkIndex}:${lineIndex}`, className: 'dsh-wc-nonl', children: `\\ ${line.text}` }));
                        return;
                    }
                    let oldText = '';
                    let newText = '';
                    let lineNo;
                    if (line.t === ' ') {
                        oldText = String(oldNo);
                        newText = String(newNo);
                        lineNo = newNo;
                        oldNo += 1;
                        newNo += 1;
                    } else if (line.t === '-') {
                        oldText = String(oldNo);
                        lineNo = oldNo;
                        oldNo += 1;
                    } else {
                        newText = String(newNo);
                        lineNo = newNo;
                        newNo += 1;
                    }
                    blocks.push(jsxs('div', {
                        key: `${hunkIndex}:${lineIndex}`,
                        className: 'dsh-wc-row',
                        'data-t': line.t === ' ' ? undefined : line.t,
                        'data-cursor': lineNo === props.cursorLine ? '' : undefined,
                        onClick: () => props.onCursor(tabId, lineNo),
                        children: [
                            jsx('span', { className: 'dsh-wc-no', children: oldText }),
                            jsx('span', { className: 'dsh-wc-no', children: newText }),
                            jsx('span', { className: 'dsh-wc-text', children: line.text === '' ? ' ' : line.text })
                        ]
                    }));
                });
            });
            return jsx(Fragment, { children: blocks });
        }

        function SplitRows(props) {
            const { diff, tabId, foldedHunks, onFold } = props;
            const blocks = [];
            diff.hunks.forEach((hunk, hunkIndex) => {
                const key = `${diff.file}#${hunkIndex}`;
                const folded = foldedHunks.has(key);
                blocks.push(jsxs('div', {
                    key: `h${hunkIndex}`,
                    className: 'dsh-wc-hunk',
                    onClick: () => onFold(tabId, key),
                    children: [
                        jsx(folded ? IconChevronRightOutline14 : IconChevronDownOutline14, { size: 12 }),
                        jsxs('span', {
                            className: 'dsh-wc-hunksig',
                            children: [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, hunk.section !== '' ? ` ${hunk.section}` : '']
                        })
                    ]
                }));
                if (folded) return;
                const rows = toSplitRows(hunk);
                rows.forEach((row, rowIndex) => {
                    const cell = (side) => jsxs('div', {
                        className: 'dsh-wc-scell',
                        'data-t': side === null || side.t === ' ' ? undefined : side.t,
                        children: [
                            jsx('span', { className: 'dsh-wc-no', children: side === null ? '' : String(side.no) }),
                            jsx('span', { className: 'dsh-wc-text', children: side === null || side.text === '' ? ' ' : side.text })
                        ]
                    });
                    blocks.push(jsxs('div', {
                        key: `${hunkIndex}:${rowIndex}`,
                        className: 'dsh-wc-srow',
                        children: [cell(row.left), jsx('span', { className: 'dsh-wc-divider' }), cell(row.right)]
                    }));
                });
            });
            return jsx(Fragment, { children: blocks });
        }

        function DiffBody(props) {
            const { state, tabId, t } = props;
            const selected = state.selected;
            const record = selected === undefined ? undefined : state.diffs.get(selected.path);
            if (selected === undefined) {
                return jsx('div', { className: 'dsh-wc-state', children: jsx('p', { children: t('state.pickFile') }) });
            }
            if (record === undefined || record.phase === 'loading') {
                return jsx('div', { className: 'dsh-wc-state', children: jsx('p', { children: t('state.loading') }) });
            }
            if (record.phase === 'error') {
                return jsxs('div', {
                    className: 'dsh-wc-state',
                    children: [
                        jsxs('p', { children: [t('state.error'), `: ${record.error}`] }),
                        jsx(Button, { variant: 'outline', onClick: () => { state.diffs.delete(selected.path); void ensureDiff(tabId); }, children: t('state.retry') })
                    ]
                });
            }
            const diff = record.diff;
            const notes = [];
            if (diff.binary) notes.push(t('state.binary'));
            else if (diff.hunks.length === 0) notes.push(t('state.emptyDiff'));
            if (diff.truncated) notes.push(t('state.truncated'));
            if (diff.untracked) notes.push(t('state.untrackedDiff'));
            const mode = state.viewMode === 'auto' ? (props.fullscreen ? 'split' : 'unified') : state.viewMode;
            const overCap = diffLineCount(diff.hunks) > DIFF_ROW_CAP;
            const shown = overCap ? { ...diff, hunks: capHunks(diff.hunks, DIFF_ROW_CAP) } : diff;
            return jsxs(Fragment, {
                children: [
                    notes.length > 0 && jsx('div', { className: 'dsh-wc-note', children: notes.join(' · ') }),
                    overCap && jsx('div', { className: 'dsh-wc-note', children: t('state.rowsCapped') }),
                    jsx('div', {
                        className: 'dsh-wc-diffbody',
                        children: diff.binary || diff.hunks.length === 0
                            ? null
                            : mode === 'split'
                                ? jsx(SplitRows, { diff: shown, tabId, foldedHunks: state.foldedHunks, onFold: foldHunk, t })
                                : jsx(UnifiedRows, { diff: shown, tabId, foldedHunks: state.foldedHunks, onFold: foldHunk, cursorLine: state.cursorLine, onCursor: setCursor, t })
                    })
                ]
            });
        }

        function foldHunk(tabId, key) {
            const state = tabs.get(tabId);
            if (state === undefined) return;
            if (state.foldedHunks.has(key)) state.foldedHunks.delete(key);
            else state.foldedHunks.add(key);
            notify();
        }

        function setCursor(tabId, line) {
            const state = tabs.get(tabId);
            if (state === undefined || typeof line !== 'number') return;
            state.cursorLine = line;
            notify();
        }

        // ─── editor dropdown ────────────────────────────────────────────────
        /** One editor row's icon: the first-party open-in-app PNG, hidden when absent. */
        function EditorIcon(props) {
            const [missing, setMissing] = useState(false);
            if (missing) return jsx('span', { className: 'dsh-wc-editoricon', children: jsx(IconRightUpOutline16, { size: 13 }) });
            return jsx('img', {
                className: 'dsh-wc-editoricon',
                src: `/open-in-app/icon/${props.id}`,
                width: 14,
                height: 14,
                alt: '',
                onError: () => setMissing(true)
            });
        }

        function EditorMenu(props) {
            const { state, tabId, t } = props;
            const [open, setOpen] = useState(false);
            const wrapRef = useRef(null);
            useEffect(() => {
                if (state.editors === undefined) {
                    void api.editors().then((list) => {
                        const current = tabs.get(tabId);
                        if (current !== state) return;
                        state.editors = list;
                        notify();
                    });
                }
            }, [tabId, state]);
            useEffect(() => {
                if (!open) return undefined;
                const onDown = (event) => {
                    if (wrapRef.current !== null && !wrapRef.current.contains(event.target)) setOpen(false);
                };
                document.addEventListener('mousedown', onDown);
                return () => document.removeEventListener('mousedown', onDown);
            }, [open]);
            const choice = state.editorChoice;
            return jsxs('span', {
                className: 'dsh-wc-menuwrap',
                ref: wrapRef,
                children: [
                    jsxs('span', {
                        children: [
                            jsxs(Button, {
                                variant: 'outline',
                                icon: jsx(IconRightUpOutline16, { size: 13 }),
                                title: t('openInIdeAt'),
                                onClick: () => props.onOpenInIde(state.selected),
                                children: t('openInIde')
                            }),
                            jsx(IconBtn, { title: t('chooseEditor'), onClick: () => setOpen((value) => !value), children: jsx(IconChevronDownOutline14, { size: 12 }) })
                        ]
                    }),
                    open && jsx('span', {
                        className: 'dsh-wc-menu',
                        children: state.editors === undefined
                            // Still probing the registry — never flash an empty menu.
                            ? [jsx('span', { key: 'loading', className: 'dsh-wc-menuitem', 'aria-disabled': 'true', children: jsx('span', { children: t('state.loading') }) })]
                            : state.editors.length === 0
                                ? [jsx('span', { key: 'empty', className: 'dsh-wc-menuitem', 'aria-disabled': 'true', children: jsx('span', { children: t('noEditor') }) })]
                                : state.editors.map((editor) => jsxs('button', {
                            key: editor.id,
                            type: 'button',
                            className: 'dsh-wc-menuitem',
                            'data-current': choice === editor.id ? '' : undefined,
                            disabled: editor.available !== true,
                            onClick: () => {
                                state.editorChoice = editor.id;
                                keepEditorChoice(editor.id);
                                setOpen(false);
                                notify();
                            },
                            children: [
                                jsx(EditorIcon, { id: editor.id }),
                                jsx('span', { children: editor.label })
                            ]
                        }))
                    })
                ]
            });
        }

        // ─── main body ──────────────────────────────────────────────────────
        /** Width at which the diff view switches to the tree|diff split even without framework fullscreen. */
        const WIDE_PX = 760;

        function ChangesTabBody(props) {
            const { sessionId, useSessions, useTabInfo, t } = props;
            const info = useTabInfo();
            const tabId = info.tab.id;
            const signal = info.tab.signal;
            const fullscreen = info.sidebar?.fullscreen === true;
            const cwd = useSessions((sessions) => sessions.byId[sessionId]?.cwd);
            useSyncExternalStore(subscribe, snapshot);
            const state = stateOf(tabId, cwd);
            const rootRef = useRef(null);

            useEffect(() => {
                if (cwd === undefined || signal.aborted) return;
                if (state.phase === 'loading' && state.status === undefined && state.started !== true) {
                    state.started = true;
                    start(tabId, cwd, signal);
                }
            }, [cwd, tabId, signal, state]);

            // Track the panel's own width: a wide track (user-dragged) deserves
            // the tree|diff split just as much as the framework's fullscreen.
            useEffect(() => {
                const element = rootRef.current;
                if (element === null || typeof ResizeObserver === 'undefined') return undefined;
                const observer = new ResizeObserver((entries) => {
                    const width = entries[0]?.contentRect.width ?? 0;
                    const wide = width >= WIDE_PX;
                    const current = tabs.get(tabId);
                    if (current === undefined || current.wide === wide) return;
                    current.wide = wide;
                    notify();
                });
                observer.observe(element);
                return () => observer.disconnect();
            }, [tabId]);

            const horizontal = fullscreen || state.wide === true;

            const toggle = useCallback((key) => {
                const current = tabs.get(tabId);
                if (current === undefined) return;
                if (current.collapsed.has(key)) current.collapsed.delete(key);
                else current.collapsed.add(key);
                notify();
            }, [tabId]);

            const openInIde = useCallback((entry) => {
                const current = tabs.get(tabId);
                if (current === undefined || current.cwd === undefined || entry === undefined || entry === null) return;
                void api.openInIde(current.cwd, entry.path, current.cursorLine, current.editorChoice).then((result) => {
                    if (result.ok) return;
                    current.notice = fmt(t('openFailed'), { message: result.error?.message ?? 'unknown' });
                    notify();
                });
            }, [tabId, t]);

            const copyDiff = useCallback(() => {
                const current = tabs.get(tabId);
                const record = current?.selected === undefined ? undefined : current.diffs.get(current.selected.path);
                if (record?.phase !== 'ready') return;
                void writeClipboard(copyTextOf(record.diff)).then((ok) => {
                    if (!ok) return;
                    current.notice = undefined;
                    current.copiedAt = Date.now();
                    notify();
                    window.setTimeout(() => {
                        const live = tabs.get(tabId);
                        if (live === undefined) return;
                        live.copiedAt = undefined;
                        notify();
                    }, 1200);
                });
            }, [tabId]);

            // Keyboard: ↑/↓ previous/next file, Esc back to the list.
            useEffect(() => {
                const onKey = (event) => {
                    const current = tabs.get(tabId);
                    // One pure decision (see diffShortcutAction): no open diff, or
                    // an event from a typing surface, means core keeps the key.
                    const action = diffShortcutAction(current?.selected !== undefined, event);
                    if (action === null) return;
                    if (action === 'back') select(tabId, null);
                    else navFile(tabId, action === 'next' ? 1 : -1);
                    event.preventDefault();
                };
                window.addEventListener('keydown', onKey);
                return () => window.removeEventListener('keydown', onKey);
            }, [tabId]);

            const status = state.status;
            const files = status === undefined || status === null ? [] : flatFiles(status);
            const index = state.selected === undefined ? -1 : files.findIndex((entry) => entry.path === state.selected.path && entry.unversioned === state.selected.unversioned);

            const toolbar = jsxs('div', {
                className: 'dsh-wc-toolbar',
                children: [
                    status && jsxs('span', {
                        className: 'dsh-wc-branch',
                        title: status.upstream || status.branch || t('detached'),
                        children: [
                            jsx(IconBranchOutline16, { size: 13 }),
                            jsx('span', { className: 'dsh-wc-branch-name', children: status.detached ? `${t('detached')} ${status.head}` : status.branch }),
                            (status.ahead > 0 || status.behind > 0) && jsxs('span', {
                                className: 'dsh-wc-ab',
                                children: [status.ahead > 0 ? `↑${status.ahead}` : '', status.behind > 0 ? `↓${status.behind}` : '']
                            })
                        ]
                    }),
                    status && jsxs('span', {
                        className: 'dsh-wc-totals',
                        children: [
                            fmt(t('filesCount'), { n: status.totals.files }),
                            ' ',
                            jsx('b', { className: 'up', children: `+${status.totals.added}` }),
                            ' ',
                            jsx('b', { className: 'dn', children: `−${status.totals.deleted}` })
                        ]
                    }),
                    jsx('span', { className: 'dsh-wc-spacer' }),
                    jsx(IconBtn, {
                        title: t('refresh'),
                        className: state.refreshing === true ? 'dsh-wc-spin' : undefined,
                        onClick: () => void refresh(tabId),
                        children: jsx(IconRefreshOutline16, { size: 14 })
                    })
                ]
            });

            let body;
            if (cwd === undefined) {
                body = jsx('div', { className: 'dsh-wc-state', children: jsx('p', { children: t('state.noWorkspace') }) });
            } else if (state.phase === 'loading' && status === undefined) {
                body = jsx('div', { className: 'dsh-wc-state', children: jsx('p', { children: t('state.loading') }) });
            } else if (state.phase === 'error') {
                body = jsxs('div', {
                    className: 'dsh-wc-state',
                    children: [
                        jsx(IconWarningOutline16, { size: 22, 'data-icon': true }),
                        jsxs('p', { children: [t('state.error'), state.error === undefined ? '' : `: ${state.error}`] }),
                        jsx(Button, { variant: 'outline', onClick: () => void refresh(tabId), children: t('state.retry') })
                    ]
                });
            } else if (state.phase === 'not-repo') {
                body = jsxs('div', {
                    className: 'dsh-wc-state',
                    children: [jsx('p', { children: t('state.notRepo') }), jsx('p', { children: cwd })]
                });
            } else if (status !== undefined && files.length === 0) {
                body = jsx('div', { className: 'dsh-wc-state', children: jsx('p', { children: t('state.clean') }) });
            } else if (status !== undefined) {
                const treeProps = {
                    collapsed: state.collapsed,
                    onToggle: toggle,
                    t,
                    selectedPath: state.selected?.path,
                    selectedUnversioned: state.selected?.unversioned,
                    onSelect: (entry) => select(tabId, entry),
                    onOpenInIde: openInIde
                };
                const tree = jsxs('div', {
                    className: 'dsh-wc-tree',
                    children: [
                        jsx(GroupView, { id: 'conflicts', label: t('group.conflicts'), entries: status.groups.conflicts, hidden: status.groups.hidden?.conflicts ?? 0, unversioned: false, tone: 'conflict', ...treeProps }),
                        jsx(GroupView, { id: 'changes', label: t('group.changes'), entries: status.groups.changes, hidden: status.groups.hidden?.changes ?? 0, unversioned: false, ...treeProps }),
                        jsx(GroupView, { id: 'unversioned', label: t('group.unversioned'), entries: status.groups.unversioned, hidden: status.groups.hidden?.unversioned ?? 0, unversioned: true, ...treeProps })
                    ]
                });
                const diffHead = state.selected === undefined ? null : jsxs('div', {
                    className: 'dsh-wc-diffhead',
                    children: [
                        jsx(IconBtn, { title: t('back'), onClick: () => select(tabId, null), children: jsx(IconChevronLeftOutline14, { size: 14 }) }),
                        jsx(FileTypeIcon, { path: state.selected.path, size: 14 }),
                        jsxs('span', {
                            className: 'dsh-wc-diffpath',
                            title: state.selected.path,
                            children: [
                                jsx('span', { className: 'dsh-wc-diffname', children: baseOf(state.selected.path) }),
                                dirOf(state.selected.path) !== '' && jsx('span', { className: 'dsh-wc-diffdir', children: dirOf(state.selected.path) })
                            ]
                        }),
                        jsxs('span', {
                            className: 'dsh-wc-nav',
                            children: [
                                jsx(IconBtn, { title: '↑', onClick: () => navFile(tabId, -1), children: jsx(IconChevronUpOutline14, { size: 13 }) }),
                                `${index === -1 ? '–' : index + 1}/${files.length}`,
                                jsx(IconBtn, { title: '↓', onClick: () => navFile(tabId, 1), children: jsx(IconChevronDownOutline14, { size: 13 }) })
                            ]
                        }),
                        jsx(IconBtn, {
                            title: state.copiedAt === undefined ? t('copyDiff') : t('copied'),
                            onClick: copyDiff,
                            children: jsx(IconCopyOutline16, { size: 14 })
                        }),
                        (() => {
                            const active = state.viewMode === 'auto' ? (horizontal ? 'split' : 'unified') : state.viewMode;
                            const setMode = (mode) => {
                                const current = tabs.get(tabId);
                                if (current === undefined) return;
                                current.viewMode = mode;
                                notify();
                            };
                            return jsxs('span', {
                                className: 'dsh-wc-segment',
                                children: [
                                    jsx('button', {
                                        type: 'button',
                                        className: 'dsh-wc-segbtn',
                                        'data-on': active === 'unified' ? '' : undefined,
                                        title: t('viewUnified'),
                                        onClick: () => setMode('unified'),
                                        children: '≡'
                                    }),
                                    jsx('button', {
                                        type: 'button',
                                        className: 'dsh-wc-segbtn',
                                        'data-on': active === 'split' ? '' : undefined,
                                        title: t('viewSplit'),
                                        onClick: () => setMode('split'),
                                        children: '⇄'
                                    })
                                ]
                            });
                        })(),
                        jsx(EditorMenu, { state, tabId, t, onOpenInIde: () => openInIde(state.selected) })
                    ]
                });
                if (horizontal) {
                    // Wide panel or framework fullscreen: the IDE split — tree
                    // left, diff right (the screenshot's layout).
                    body = jsxs('div', {
                        className: 'dsh-wc-splitlayout',
                        children: [tree, jsxs('div', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }, children: [diffHead, jsx(DiffBody, { state, tabId, t, fullscreen: horizontal })] })]
                    });
                } else if (state.selected === undefined) {
                    body = tree;
                } else {
                    // Narrow panel: the file list stays on top (collapsible),
                    // the diff below — the list never disappears.
                    const listCollapsed = state.collapsed.has('region:list');
                    body = jsxs('div', {
                        className: 'dsh-wc-stack',
                        children: [
                            jsxs('button', {
                                type: 'button',
                                className: 'dsh-wc-listbar',
                                onClick: () => toggle('region:list'),
                                title: listCollapsed ? t('expandAll') : t('collapseAll'),
                                children: [
                                    jsx(listCollapsed ? IconChevronRightOutline14 : IconChevronDownOutline14, { size: 12 }),
                                    jsx('span', { className: 'dsh-wc-listbar-label', children: fmt(t('filesCount'), { n: status.totals.files }) }),
                                    jsx('span', { className: 'dsh-wc-count', children: `${index === -1 ? '–' : index + 1}/${files.length}` })
                                ]
                            }),
                            !listCollapsed && jsx('div', { className: 'dsh-wc-treeregion', children: tree }),
                            diffHead,
                            jsx(DiffBody, { state, tabId, t, fullscreen: false })
                        ]
                    });
                }
            }

            return jsxs('div', {
                className: 'dsh-wc-root',
                ref: rootRef,
                'data-fullscreen': horizontal ? '' : undefined,
                children: [
                    toolbar,
                    state.notice !== undefined && jsxs('div', {
                        className: 'dsh-wc-notice',
                        children: [
                            jsx('span', { style: { flex: '1 1 auto' }, children: state.notice }),
                            jsx(IconBtn, {
                                title: '×',
                                onClick: () => {
                                    const current = tabs.get(tabId);
                                    if (current !== undefined) {
                                        current.notice = undefined;
                                        notify();
                                    }
                                },
                                children: jsx(IconCloseOutline16, { size: 12 })
                            })
                        ]
                    }),
                    body
                ]
            });
        }

        function ChangesTabTitle() {
            return jsx(Fragment, { children: '变更' });
        }

        // ─── plugin body ────────────────────────────────────────────────────

        /** Required services: slot registry, the sidebar tab-type registry, and copy. */
        const inject = ['slots', 'sidebarRightTabs', 'locale'];

        const TAB_ID = 'dsh-workspace-changes';
        const TAB_KIND = 'workspace-changes';

        function apply(ctx) {
            initCss();
            const t = ctx.locale.bind(NS);
            const disposers = [];
            ctx.effect(() => () => {
                for (const dispose of disposers.splice(0)) {
                    try {
                        dispose();
                    } catch (error) {
                        console.error('[dsh-workspace-changes] dispose failed:', error);
                    }
                }
            }, 'dsh-workspace-changes: registrations');

            ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-workspace-changes: dictionaries');

            disposers.push(ctx.sidebarRightTabs.register({
                id: TAB_ID,
                kind: TAB_KIND,
                priority: 'extension',
                title: () => t('tab.title'),
                guide: [{
                    kind: TAB_KIND,
                    title: () => t('guide.title'),
                    description: () => t('guide.description'),
                    icon: IconBranchOutline16,
                    order: 30
                }]
            }));

            disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
                name: 'sidebar.right.pane.tab',
                key: TAB_ID,
                locale: NS
            }, ChangesTabBody)));

            disposers.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
                name: 'sidebar.right.pane.tab.title',
                key: TAB_ID
            }, ChangesTabTitle)));
        }

        exports.apply = apply;
        exports.inject = inject;
        // Pure helpers exported for the plugin's own tests (the guard does not mind).
        exports.internals = { buildTree, toSplitRows, copyTextOf, flatFiles, dirOf, baseOf, fmt, capHunks, diffLineCount, normalizeSelection, isTypingTarget, diffShortcutAction, DirRows, GroupView, GROUP_ROW_CAP, DIFF_ROW_CAP, CSS };
        return module.exports;
    }
});
