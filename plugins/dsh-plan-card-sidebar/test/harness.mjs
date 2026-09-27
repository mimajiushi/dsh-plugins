/**
 * Load the hand-authored browser bundle in Node and drive its registration
 * surface with a fake client context.
 *
 * The bundle is a plain script that calls `window.__ModuleLoader__.load`, so a
 * test only needs those three globals (`window`, `document`, `console`) plus the
 * module table it requires. Nothing here needs a DOM: only `apply` and the
 * component functions are exercised, and the components are called through the
 * chain selector, never rendered.
 *
 * @module dsh-plan-card-sidebar/test/harness
 */
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
    useSyncExternalStore: (_subscribe, snapshot) => snapshot()
};

/**
 * Every module id the bundle asks for, in source order.
 *
 * The host resolves each of these against the client module table before the
 * bundle runs, so a missing answer is a boot failure — worth checking without a
 * browser.
 * @returns The distinct module ids.
 */
export function requiredModules() {
    const source = readFileSync(join(packageRoot, 'lib', 'client.js'), 'utf8');
    const ids = new Set();
    for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) ids.add(match[1]);
    return [...ids];
}

/** The package's own manifest, as the loader reads it. */
export function manifest() {
    return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
}

/** The module table the bundle requires; anything else is a test bug. */
const moduleTable = {
    react: reactStub,
    'react/jsx-runtime': {
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }),
        Fragment: Symbol.for('react.fragment')
    },
    '@deepseek-ai/dsh-client-ui-primitives': {
        Button: function Button() {},
        MarkdownText: function MarkdownText() {},
        IconEditOutline16: function IconEditOutline16() {},
        IconPanelLeftOutline16: function IconPanelLeftOutline16() {}
    }
};

/**
 * Load the bundle and return its exports plus the load record.
 * @returns `{ exports, id }` as the module loader would see them.
 */
export function loadBundle() {
    const source = readFileSync(join(packageRoot, 'lib', 'client.js'), 'utf8');
    let record;
    const windowStub = {
        __ModuleLoader__: {
            load(entry) {
                record = entry;
            }
        },
        setTimeout: () => 0,
        requestAnimationFrame: (fn) => {
            fn();
            return 0;
        }
    };
    const documentStub = {
        querySelector: () => null,
        createElement: () => ({ dataset: {}, textContent: '' }),
        head: { appendChild: () => {} }
    };

    const run = new Function('window', 'document', 'console', 'require', source);
    run(windowStub, documentStub, console, (id) => {
        if (!Object.hasOwn(moduleTable, id)) throw new Error(`test module table is missing ${JSON.stringify(id)}`);
        return moduleTable[id];
    });
    if (record === undefined) throw new Error('the bundle did not register itself with the module loader');
    if (!record.id?.startsWith('dsh-plan-card-sidebar')) throw new Error(`unexpected bundle id ${record.id}`);

    return { id: record.id, exports: record.factory((id) => moduleTable[id]) };
}

/**
 * Build a fake client context that records every registration, and mount the
 * plugin on it.
 * @returns The recorded registrations and the provided service face.
 */
export function mountPlugin(overrides = {}) {
    const calls = {
        tabTypes: [],
        slots: [],
        injections: [],
        provided: new Map()
    };
    const sidebarRight = overrides.sidebarRight ?? {
        openTab: () => {},
        close: () => {},
        active: () => undefined,
        isExpanded: () => true,
        toggleExpanded: () => {}
    };
    const ctx = {
        effect: (fn) => {
            fn();
            return () => {};
        },
        slots: {
            inject: (name, factory) => {
                calls.injections.push(name);
                const disposer = factory();
                return typeof disposer === 'function' ? disposer : () => {};
            },
            register: (options, component) => {
                calls.slots.push({ options, component });
                return () => {};
            }
        },
        sidebarRightTabs: {
            register: (definition) => {
                calls.tabTypes.push(definition);
                return () => {};
            }
        },
        sidebarRight,
        sessions: overrides.sessions ?? { list: { getSnapshot: () => ({ current: 'session-a' }) } },
        provide: (name, face) => {
            calls.provided.set(name, face);
        }
    };

    const { exports } = loadBundle();
    exports.apply(ctx);
    return { calls, service: calls.provided.get('planCardSidebar'), ctx };
}

/** The composer seat's registration, as `apply` registered it. */
export function composerSeat(calls) {
    const entry = calls.slots.find((slot) => slot.options.name === 'conversation.composer');
    if (entry === undefined) throw new Error('the plugin registered no conversation.composer seat');
    return entry;
}

/** A plan-review request shaped exactly as `dsh-plan-mode` asks it. */
export function planReviewRequest(overrides = {}) {
    const questions = overrides.questions ?? [{
        id: 'plan-review',
        header: 'Plan review',
        question: 'Approve this plan and leave plan mode?',
        detail: '# Ship the sidebar card\n\nMove the plan card.',
        options: [
            { label: 'Approve', description: 'Leave plan mode.' },
            { label: 'Keep planning', description: 'Stay in plan mode.' }
        ],
        intent: { kind: 'plan-review', approve: 'Approve' }
    }];
    return {
        key: overrides.key ?? 'question:1',
        sessionId: overrides.sessionId ?? 'session-a',
        kind: overrides.kind ?? 'plan-review',
        questions,
        answer: () => Promise.resolve(),
        cancel: () => Promise.resolve()
    };
}

export { packageRoot };
