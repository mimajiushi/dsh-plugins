/**
 * Client bundle tests: load the hand-authored browser bundle in Node, assert
 * the registration contract (inject coverage is separately proven by the
 * guard's Tier A/B), and drive the pure view-model helpers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A React stub: enough for the bundle to define components, not to render them. */
const reactStub = {
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useSyncExternalStore: (_subscribe, snap) => snap()
};

const iconNames = [
    'IconBranchOutline16', 'IconRefreshOutline16', 'IconCopyOutline16',
    'IconChevronDownOutline14', 'IconChevronRightOutline14',
    'IconChevronLeftOutline14', 'IconChevronUpOutline14',
    'IconRightUpOutline16', 'IconFolderClose16', 'IconFolderOpen16',
    'IconWarningOutline16', 'IconCloseOutline16'
];

const primitivesStub = {
    Button: function Button() {},
    FileTypeIcon: function FileTypeIcon() {},
    writeClipboard: async () => true,
    ...Object.fromEntries(iconNames.map((name) => [name, function Icon() {}]))
};

function loadBundle() {
    const source = readFileSync(join(packageRoot, 'lib', 'client.js'), 'utf8');
    let record;
    const windowStub = {
        __ModuleLoader__: { load(entry) { record = entry; } },
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        setTimeout: () => 0,
        addEventListener: () => {},
        removeEventListener: () => {}
    };
    const documentStub = {
        querySelector: () => null,
        createElement: () => ({ dataset: {}, textContent: '' }),
        head: { appendChild: () => {} },
        addEventListener: () => {},
        removeEventListener: () => {},
        visibilityState: 'visible'
    };
    const moduleTable = {
        react: reactStub,
        'react/jsx-runtime': {
            jsx: (type, props) => ({ type, props }),
            jsxs: (type, props) => ({ type, props }),
            Fragment: Symbol.for('react.fragment')
        },
        '@deepseek-ai/dsh-client-ui-primitives': primitivesStub
    };
    const run = new Function('window', 'document', 'console', 'require', source);
    run(windowStub, documentStub, console, (id) => {
        if (!Object.hasOwn(moduleTable, id)) throw new Error(`test module table is missing ${JSON.stringify(id)}`);
        return moduleTable[id];
    });
    if (record === undefined) throw new Error('the bundle did not register itself with the module loader');
    return { id: record.id, exports: record.factory((id) => moduleTable[id]) };
}

test('bundle registers under the package name and exports apply/inject', () => {
    const { id, exports } = loadBundle();
    assert.equal(id, 'dsh-workspace-changes');
    assert.equal(typeof exports.apply, 'function');
    // The 2026-09-25 lesson: every ctx service the bundle reads must be declared.
    assert.deepEqual(exports.inject, ['slots', 'sidebarRightTabs', 'locale']);
});

test('apply registers the tab type, the body seat, and the title seat', () => {
    const { exports } = loadBundle();
    const calls = { tabTypes: [], slots: [], injections: [], effects: [] };
    const ctx = {
        effect: (fn) => { calls.effects.push(fn); return () => {}; },
        locale: {
            bind: () => (key) => key,
            register: () => () => {}
        },
        sidebarRightTabs: {
            register: (definition) => { calls.tabTypes.push(definition); return () => {}; }
        },
        slots: {
            inject: (name, factory) => {
                calls.injections.push(name);
                factory();
                return () => {};
            },
            register: (options, component) => { calls.slots.push({ options, component }); return () => {}; }
        }
    };
    exports.apply(ctx);

    assert.equal(calls.tabTypes.length, 1);
    const definition = calls.tabTypes[0];
    assert.equal(definition.kind, 'workspace-changes');
    assert.equal(definition.priority, 'extension');
    // Core calls these — strings would blank the whole guide pane.
    assert.equal(typeof definition.title, 'function');
    assert.equal(typeof definition.guide[0].title, 'function');
    assert.equal(typeof definition.guide[0].description, 'function');
    assert.equal(typeof definition.guide[0].icon, 'function');

    assert.deepEqual(calls.injections, ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']);
    assert.equal(calls.slots.length, 2);
    for (const { options, component } of calls.slots) {
        assert.equal(options.key, 'dsh-workspace-changes');
        assert.equal(typeof component, 'function');
    }
    assert.equal(calls.slots[0].options.locale, 'workspace-changes');
});

test('buildTree nests directories and counts descendants', () => {
    const { internals } = loadBundle().exports;
    const tree = internals.buildTree([
        { path: 'scene/player/player.gd' },
        { path: 'scene/bullet/bullet.gd' },
        { path: 'scene/main.tscn' },
        { path: 'AGENTS.md' }
    ]);
    assert.equal(tree.files.length, 1);
    const scene = tree.dirs.get('scene');
    assert.equal(scene.count, 3);
    assert.ok(scene.dirs.has('player'));
    assert.ok(scene.dirs.has('bullet'));
    assert.equal(scene.files[0].path, 'scene/main.tscn');
});

test('toSplitRows pairs deletion runs with addition runs', () => {
    const { internals } = loadBundle().exports;
    const hunk = {
        oldStart: 10, oldLines: 4, newStart: 10, newLines: 5, section: '',
        lines: [
            { t: ' ', text: 'ctx' },
            { t: '-', text: 'old1' },
            { t: '-', text: 'old2' },
            { t: '+', text: 'new1' },
            { t: ' ', text: 'tail' },
            { t: '+', text: 'pure-add' }
        ]
    };
    const rows = internals.toSplitRows(hunk);
    assert.deepEqual(rows, [
        { left: { no: 10, t: ' ', text: 'ctx' }, right: { no: 10, t: ' ', text: 'ctx' } },
        { left: { no: 11, t: '-', text: 'old1' }, right: { no: 11, t: '+', text: 'new1' } },
        { left: { no: 12, t: '-', text: 'old2' }, right: null },
        { left: { no: 13, t: ' ', text: 'tail' }, right: { no: 12, t: ' ', text: 'tail' } },
        { left: null, right: { no: 13, t: '+', text: 'pure-add' } }
    ]);
});

test('toSplitRows keeps blank context lines paired inside a change block', () => {
    const { internals } = loadBundle().exports;
    // The 2026-09-26 screenshot scenario (subagent-audit.md @@ -1,32 +1,53 @@):
    // a blank line survives unchanged between two change runs, so the block
    // splits — the blank must pair left/right, not pair with an addition.
    const hunk = {
        oldStart: 28, oldLines: 5, newStart: 47, newLines: 5, section: '',
        lines: [
            { t: ' ', text: '' },
            { t: '-', text: '## 4. old heading' },
            { t: '+', text: 'new line one' },
            { t: '+', text: 'new line two' },
            { t: ' ', text: '' },
            { t: '-', text: 'tail old' }
        ]
    };
    const rows = internals.toSplitRows(hunk);
    assert.deepEqual(rows, [
        { left: { no: 28, t: ' ', text: '' }, right: { no: 47, t: ' ', text: '' } },
        { left: { no: 29, t: '-', text: '## 4. old heading' }, right: { no: 48, t: '+', text: 'new line one' } },
        { left: null, right: { no: 49, t: '+', text: 'new line two' } },
        { left: { no: 30, t: ' ', text: '' }, right: { no: 50, t: ' ', text: '' } },
        { left: { no: 31, t: '-', text: 'tail old' }, right: null }
    ]);
    // Invariants over the pairing: no empty row, line numbers gapless per side.
    let left = hunk.oldStart - 1;
    let right = hunk.newStart - 1;
    for (const row of rows) {
        assert.ok(row.left !== null || row.right !== null);
        if (row.left !== null) { assert.equal(row.left.no, left + 1); left = row.left.no; }
        if (row.right !== null) { assert.equal(row.right.no, right + 1); right = row.right.no; }
    }
});

test('copyTextOf rebuilds unified text with the rename header', () => {
    const { internals } = loadBundle().exports;
    const text = internals.copyTextOf({
        file: 'b.txt',
        oldFile: 'a.txt',
        binary: false,
        hunks: [{
            oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, section: 'f()',
            lines: [
                { t: '-', text: 'x' },
                { t: '+', text: 'y' },
                { t: '+', text: 'z' },
                { t: '\\', text: 'No newline at end of file' }
            ]
        }]
    });
    assert.ok(text.startsWith('diff --git a/a.txt b/b.txt'));
    assert.ok(text.includes('@@ -1,1 +1,2 @@ f()'));
    assert.ok(text.includes('\\ No newline at end of file'));
    assert.ok(internals.copyTextOf({ file: 'a.png', binary: true, hunks: [] }).includes('binary'));
});

test('flatFiles orders conflicts, then changes, then unversioned', () => {
    const { internals } = loadBundle().exports;
    const files = internals.flatFiles({
        groups: {
            conflicts: [{ path: 'c.txt', kind: 'conflict' }],
            changes: [{ path: 'a.txt', kind: 'modified' }],
            unversioned: [{ path: 'u.txt', kind: 'untracked' }]
        }
    });
    assert.deepEqual(files.map((entry) => entry.path), ['c.txt', 'a.txt', 'u.txt']);
    assert.equal(files[2].unversioned, true);
    assert.equal(files[0].unversioned, false);
});

// ─── render-drive: the regression net for the 2026-09-25 recursion crash ────

/**
 * A minimal reconciler for the harness's `{type, props}` elements: invokes
 * function components, walks children, and counts every invocation. A render
 * that exceeds the budget is an infinite recursion — the exact failure that
 * froze the renderer and OOM-crashed it on 2026-09-25 (DirRows re-rendering
 * its own parent node because `...props` overrode the child `node`/`depth`).
 */
function walkRender(element, budget = 20000) {
    let count = 0;
    const walk = (el) => {
        if (el === null || el === undefined || el === false || typeof el !== 'object') return;
        count += 1;
        if (count > budget) throw new Error(`render budget (${budget}) exceeded — unbounded recursion`);
        if (typeof el.type === 'function') {
            walk(el.type(el.props ?? {}));
        }
        const children = el.props?.children;
        if (children === undefined) return;
        if (Array.isArray(children)) for (const child of children) walk(child);
        else walk(children);
    };
    walk(element);
    return count;
}

/** Collect rendered rows of one class from an element tree. */
function collectRows(element, className, pick) {
    const found = [];
    const probe = (el) => {
        if (el === null || el === undefined || typeof el !== 'object') return;
        if (el.props?.className === className) found.push(pick(el));
        if (typeof el.type === 'function') probe(el.type(el.props ?? {}));
        const children = el.props?.children;
        if (Array.isArray(children)) children.forEach(probe);
        else probe(children);
    };
    probe(element);
    return found;
}

test('DirRows render terminates on a three-level nested tree', () => {
    const { internals } = loadBundle().exports;
    const tree = internals.buildTree([
        { path: 'scene/player/player.gd', kind: 'modified', added: 5, deleted: 1 },
        { path: 'scene/bullet/bullet.gd', kind: 'modified', added: 2, deleted: 0 },
        { path: 'scene/main.tscn', kind: 'modified', added: 1, deleted: 1 },
        { path: 'resources/animation/enemy_basic_frames.tres', kind: 'added', added: 40, deleted: 0 },
        { path: 'AGENTS.md', kind: 'modified', added: 3, deleted: 0 }
    ]);
    const make = () => internals.DirRows({
        node: tree,
        depth: 1,
        unversioned: false,
        collapsed: new Set(),
        onToggle: () => {},
        selectedPath: undefined,
        selectedUnversioned: undefined,
        t: (key) => key,
        onSelect: () => {},
        onOpenInIde: () => {}
    });
    // With the regression this never terminates (budget throw). Fixed: every
    // row renders exactly once.
    const count = walkRender(make());
    assert.ok(count > 0 && count < 20000);
    // Five directory rows (scene, player, bullet, resources, animation), each once.
    const dirs = collectRows(make(), 'dsh-wc-dir', (el) => el.props.children?.[2]?.props?.children);
    assert.deepEqual([...dirs].sort(), ['animation', 'bullet', 'player', 'resources', 'scene']);
    const files = collectRows(make(), 'dsh-wc-file', (el) => el.props.title);
    assert.equal(files.length, 5);
});

test('GroupView render terminates and shows the combined hidden notice', () => {
    const { internals } = loadBundle().exports;
    const many = [];
    for (let index = 0; index < 520; index += 1) many.push({ path: `d${index % 9}/f${index}.txt`, kind: 'modified', added: 1, deleted: 0 });
    const make = () => internals.GroupView({
        id: 'changes',
        label: '更改',
        entries: many,
        hidden: 4800, // host-side cap survivors
        unversioned: false,
        collapsed: new Set(),
        onToggle: () => {},
        selectedPath: undefined,
        selectedUnversioned: undefined,
        t: (key) => key,
        onSelect: () => {},
        onOpenInIde: () => {}
    });
    // 500 rendered rows (client cap) + notice — never 5320 DOM rows.
    const count = walkRender(make(), 30000);
    assert.ok(count < 30000);
    const notice = collectRows(make(), 'dsh-wc-more', (el) => el.props.children);
    assert.deepEqual(notice, ['state.hiddenFiles']); // t stub echoes keys; fmt leaves it holeless
    const fileRows = collectRows(make(), 'dsh-wc-file', (el) => el.props.title);
    assert.equal(fileRows.length, internals.GROUP_ROW_CAP);
});

test('capHunks trims to the line budget mid-hunk', () => {
    const { internals } = loadBundle().exports;
    const hunks = [
        { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, section: '', lines: [{ t: ' ', text: 'a' }, { t: '-', text: 'b' }, { t: '+', text: 'c' }] },
        { oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, section: '', lines: [{ t: ' ', text: 'x' }, { t: '+', text: 'y' }] }
    ];
    assert.equal(internals.diffLineCount(hunks), 5);
    const capped = internals.capHunks(hunks, 4);
    assert.equal(internals.diffLineCount(capped), 4);
    assert.equal(internals.capHunks(hunks, 99), hunks); // under cap: identity, no copy
});

test('normalizeSelection coerces the missing unversioned field to false', () => {
    const { internals } = loadBundle().exports;
    // Regression: tree rows carry no `unversioned`; the navigation index
    // compares against flatFiles' booleans, and `undefined === false` stranded
    // the ‹ 0/N › counter and the arrows.
    assert.deepEqual(internals.normalizeSelection({ path: 'a.txt', kind: 'modified' }), {
        path: 'a.txt', unversioned: false, kind: 'modified', oldPath: undefined
    });
    assert.equal(internals.normalizeSelection({ path: 'u.txt', kind: 'untracked', unversioned: true }).unversioned, true);
    assert.equal(internals.normalizeSelection(null), undefined);
    // And the normalized record resolves inside flatFiles' ordering.
    const status = { groups: { conflicts: [], changes: [{ path: 'a.txt', kind: 'modified' }], unversioned: [] } };
    const files = internals.flatFiles(status);
    const selected = internals.normalizeSelection({ path: 'a.txt', kind: 'modified' });
    assert.equal(files.findIndex((entry) => entry.path === selected.path && entry.unversioned === selected.unversioned), 0);
});

test('fmt interpolates holes and leaves unknowns intact', () => {
    const { internals } = loadBundle().exports;
    assert.equal(internals.fmt('{n} 个文件', { n: 3 }), '3 个文件');
    assert.equal(internals.fmt('renamed from {old}', {}), 'renamed from {old}');
    assert.equal(internals.fmt('plain'), 'plain');
});

test('diff rows wrap long lines instead of clipping them (2026-09-26)', () => {
    const { internals } = loadBundle().exports;
    const css = internals.CSS;
    // Regression: `.dsh-wc-scell{flex:1 1 0}` reports a zero max-content
    // contribution, so `min-width:max-content` on the row never overflowed —
    // long lines were silently cut at the pane edge with no scrollbar.
    assert.ok(!css.includes('min-width:max-content'), 'rows must not size to max-content');
    const textRule = css.match(/\.dsh-wc-text\{([^}]*)\}/);
    assert.ok(textRule !== null, 'the .dsh-wc-text rule exists');
    assert.ok(textRule[1].includes('white-space:pre-wrap'), 'diff text wraps');
    assert.ok(textRule[1].includes('overflow-wrap:anywhere'), 'unbroken words still wrap');
});

/** A fake event target whose `closest` answers the given selector substrings. */
function fakeTarget(...matches) {
    return {
        closest(selector) {
            return matches.some((match) => selector.includes(match)) ? {} : null;
        }
    };
}

test('the diff shortcuts never steal keys from a typing surface (2026-09-26)', () => {
    const { internals } = loadBundle().exports;
    // Regression: the ↑/↓/Esc shortcuts sit on a bare `window` keydown listener
    // and call `preventDefault()`. With a diff open they therefore fired for
    // every keydown in the app, and a `preventDefault()` from a bubble-phase
    // listener still cancels the contenteditable's native caret movement — the
    // composer lost ↑/↓ (and Escape) while the user was typing.
    assert.equal(internals.isTypingTarget(fakeTarget('[data-composer-input]')), true, 'composer');
    assert.equal(internals.isTypingTarget(fakeTarget('input')), true, 'input');
    assert.equal(internals.isTypingTarget(fakeTarget('textarea')), true, 'textarea');
    assert.equal(internals.isTypingTarget(fakeTarget('select')), true, 'select');
    assert.equal(internals.isTypingTarget(fakeTarget('[contenteditable="true"]')), true, 'contenteditable=true');
    assert.equal(internals.isTypingTarget(fakeTarget('[contenteditable=""]')), true, 'contenteditable=""');
    // Everywhere else the shortcuts must keep working: the panel is not
    // focusable, so a click on a file row leaves `body` (or a plain div) as the
    // event target.
    assert.equal(internals.isTypingTarget(fakeTarget()), false, 'plain element');
    assert.equal(internals.isTypingTarget(null), false, 'null target');
    assert.equal(internals.isTypingTarget(undefined), false, 'undefined target');
    assert.equal(internals.isTypingTarget({}), false, 'object without closest');
});

test('the diff shortcut decision keeps typing surfaces and closed panels out', () => {
    const { internals } = loadBundle().exports;
    const key = (name, target) => ({ key: name, target: target ?? fakeTarget(), preventDefault: () => {} });
    const composer = fakeTarget('[data-composer-input]');

    // No diff open → the shortcuts are inert no matter what.
    for (const name of ['ArrowUp', 'ArrowDown', 'Escape', 'a']) {
        assert.equal(internals.diffShortcutAction(false, key(name)), null, `closed panel, ${name}`);
    }
    // A diff open, but the user is typing → core keeps every key.
    for (const name of ['ArrowUp', 'ArrowDown', 'Escape']) {
        assert.equal(internals.diffShortcutAction(true, key(name, composer)), null, `composer, ${name}`);
    }
    // A diff open and no typing surface → the shortcuts work.
    assert.equal(internals.diffShortcutAction(true, key('ArrowUp')), 'prev');
    assert.equal(internals.diffShortcutAction(true, key('ArrowDown')), 'next');
    assert.equal(internals.diffShortcutAction(true, key('Escape')), 'back');
    // Unrelated keys are never claimed (they must not be preventDefaulted).
    assert.equal(internals.diffShortcutAction(true, key('Enter')), null);
    assert.equal(internals.diffShortcutAction(true, null), null, 'missing event');
});
