/**
 * Behavioral checks for the plan-card-sidebar client bundle.
 *
 * The bundle is loaded exactly as the browser module table loads it, and its
 * registrations are driven through a fake client context. What is asserted here
 * is the part that fails quietly in the GUI when it is wrong: which slot entry
 * wins the composer chain, which requests it claims, and what the switch does
 * to the sidebar.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { composerSeat, loadBundle, manifest, mountPlugin, planReviewRequest, requiredModules } from './harness.mjs';

const PLUGIN_INJECT = ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions'];
/** Modules the shell seeds statically; everything else must be declared. */
const BASELINE_MODULES = ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'];

test('the bundle registers itself and exports the plugin face', () => {
    const { id, exports } = loadBundle();
    assert.equal(id, 'dsh-plan-card-sidebar');
    assert.equal(typeof exports.apply, 'function');
    assert.deepEqual(exports.inject, PLUGIN_INJECT);
});

test('every module the bundle requires is either seeded or declared', () => {
    const declared = [...BASELINE_MODULES, ...(manifest().dsh?.client?.inject ?? [])];
    for (const id of requiredModules()) {
        assert.ok(declared.includes(id), `${id} is required by the bundle but neither seeded nor injected`);
    }
    // The sidebar package is the one dynamic row this plugin needs; the rest of
    // the module graph is the frozen seed table every web bundle shares.
    assert.deepEqual(manifest().dsh?.client?.inject, ['@deepseek-ai/dsh-client-ui-sidebar-right']);
});

test('the sidebar tab type is registered as an extension page kind', () => {
    const { calls } = mountPlugin();
    assert.equal(calls.tabTypes.length, 1);
    const [type] = calls.tabTypes;
    assert.equal(type.id, 'dsh-plan-card-sidebar');
    assert.equal(type.kind, 'plan-review-card');
    assert.equal(type.priority, 'extension');
    assert.equal(typeof type.title, 'function');
    assert.equal(type.title('anything'), '计划待审');
    assert.equal(type.guide.length, 1);
    assert.equal(type.guide[0].kind, 'plan-review-card');
    // Core's guide page ("开始") renders each capsule through EntryBox, which
    // calls entry.title() and entry.description?.() as functions. Strings here
    // throw "entry.title is not a function" and blank the whole guide pane, so
    // pin the callable contract — this is exactly what slipped through before.
    assert.equal(typeof type.guide[0].title, 'function');
    assert.equal(type.guide[0].title(), '计划待审');
    assert.equal(typeof type.guide[0].description, 'function');
    assert.equal(type.guide[0].description(), '审阅待批的计划');
});

test('the tab body and its title register under the type id', () => {
    const { calls } = mountPlugin();
    const body = calls.slots.find((slot) => slot.options.name === 'sidebar.right.pane.tab');
    const title = calls.slots.find((slot) => slot.options.name === 'sidebar.right.pane.tab.title');
    assert.equal(body?.options.key, 'dsh-plan-card-sidebar');
    assert.equal(title?.options.key, 'dsh-plan-card-sidebar');
    assert.deepEqual(calls.injections.sort(), [
        'conversation.composer',
        'sidebar.right.pane.tab',
        'sidebar.right.pane.tab.title'
    ]);
});

test('the composer seat is asked before core, and only for plan reviews', () => {
    const { calls } = mountPlugin();
    const { options } = composerSeat(calls);
    // Chain entries are walked in ascending priority and core's
    // ui-user-questions entry sits at the default 0.
    assert.equal(options.priority, -1);
    assert.equal(typeof options.select, 'function');

    const review = planReviewRequest();
    assert.equal(options.select({ pendingInteraction: review }), review);

    const question = planReviewRequest({
        kind: 'question',
        questions: [{
            id: 'q1',
            header: 'Pick one',
            question: 'Which?',
            options: [{ label: 'A' }, { label: 'B' }]
        }]
    });
    assert.equal(options.select({ pendingInteraction: question }), null);

    // A shape core would have delegated to its generic flow stays core's.
    const threeWay = planReviewRequest({
        questions: [{
            id: 'plan-review',
            question: 'Approve?',
            detail: '# Plan',
            options: [{ label: 'Approve' }, { label: 'Maybe' }, { label: 'Keep planning' }],
            intent: { kind: 'plan-review', approve: 'Approve' }
        }]
    });
    assert.equal(options.select({ pendingInteraction: threeWay }), null);

    assert.equal(options.select({ pendingInteraction: null }), null);
    assert.equal(options.select({}), null);
});

test('both seats render through the same card: inline, then the status bar', () => {
    const { calls, service } = mountPlugin();
    const { options, component } = composerSeat(calls);
    const review = planReviewRequest();

    assert.equal(options.select({ pendingInteraction: review }), review);
    const inline = component({ matched: review });
    assert.equal(typeof inline, 'object');
    assert.notEqual(inline, null);

    // Docked by the card's own switch: the same seat now renders the stub, and
    // the request is still the one the chain elects.
    service.dock(review);
    const docked = component({ matched: review });
    assert.equal(typeof docked, 'object');
    assert.notEqual(docked, null);
    assert.equal(options.select({ pendingInteraction: review }), review);
});

test('the switch records the dock, opens the sidebar tab, and undock reverses it', () => {
    const opened = [];
    const closed = [];
    const { calls, service } = mountPlugin({
        sidebarRight: {
            openTab: (kind, options) => {
                opened.push({ kind, options });
            },
            close: (tabId) => {
                closed.push(tabId);
            },
            active: () => ({ id: 'tab-1', kind: 'plan-review-card' }),
            isExpanded: () => true,
            toggleExpanded: () => {}
        }
    });
    assert.equal(typeof service?.dock, 'function');

    const review = planReviewRequest();
    assert.equal(service.isDocked(review.key), false);

    // What the card's switch button does.
    assert.equal(service.dock(review), true);
    assert.equal(service.isDocked(review.key), true);
    assert.deepEqual(opened, [{
        kind: 'plan-review-card',
        options: { revealIfOpened: true, params: { reviewKey: 'question:1' } }
    }]);

    // Docked: the composer seat elects the same request, and the dock record is
    // what the sidebar tab body resolves its review from. The real tab body
    // reports the id the framework minted; the fake one is told directly.
    const { options } = composerSeat(calls);
    assert.equal(options.select({ pendingInteraction: review }), review);
    assert.equal(service.soleDock().pending, review);
    service.soleDock().tabId = 'tab-1';

    service.undock(review.key);
    assert.equal(service.isDocked(review.key), false);
    assert.deepEqual(closed, ['tab-1']);
    assert.equal(service.soleDock(), undefined);
});

test('a card whose session is off screen is not docked into the sidebar', () => {
    const opened = [];
    const { service } = mountPlugin({
        sessions: { list: { getSnapshot: () => ({ current: 'session-b' }) } },
        sidebarRight: {
            openTab: () => opened.push('open'),
            close: () => {},
            active: () => undefined,
            isExpanded: () => false,
            toggleExpanded: () => {}
        }
    });
    const review = planReviewRequest({ sessionId: 'session-a' });
    assert.equal(service.dock(review), false);
    assert.equal(service.isDocked(review.key), false);
    assert.deepEqual(opened, []);
});

test('a settle releases the composer seat without closing the column', () => {
    const closed = [];
    const { service } = mountPlugin({
        sidebarRight: {
            openTab: () => {},
            close: (tabId) => {
                closed.push(tabId);
            },
            active: () => ({ id: 'tab-9', kind: 'plan-review-card' }),
            isExpanded: () => true,
            toggleExpanded: () => {}
        }
    });
    const review = planReviewRequest();
    service.dock(review);
    // The tab body registers the id the framework minted for it.
    service.soleDock().tabId = 'tab-9';
    // What the card's own decision handlers do once the answer is delivered.
    service.undock(review.key);
    assert.equal(service.isDocked(review.key), false);
    assert.deepEqual(closed, ['tab-9']);
});

test('a hidden column is left alone when the card moves back', () => {
    const closed = [];
    const { service } = mountPlugin({
        sidebarRight: {
            openTab: () => {},
            close: (tabId) => {
                closed.push(tabId);
            },
            active: () => ({ id: 'tab-2', kind: 'sidebar-guide' }),
            isExpanded: () => false,
            toggleExpanded: () => {}
        }
    });
    const review = planReviewRequest();
    service.dock(review);
    service.soleDock().tabId = 'tab-7';
    service.undock(review.key);
    assert.equal(service.isDocked(review.key), false);
    // Closing the sole docked tab would collapse the whole column.
    assert.deepEqual(closed, []);
});

/**
 * Drive the real sidebar tab body (recorded in `calls.slots`) with the harness
 * React stub. What matters is which dock record its props resolve to, and the
 * stub's `useTabInfo` hands it a tab whose navigation is exactly what the
 * framework would commit.
 * @param calls - `mountPlugin()` registrations.
 * @param navigation - the tab's navigation record.
 * @returns the element the body produced.
 */
function renderBody(calls, navigation) {
    const body = calls.slots.find((slot) => slot.options.name === 'sidebar.right.pane.tab')?.component;
    if (typeof body !== 'function') throw new Error('the plugin registered no sidebar tab body');
    return body({
        useTabInfo: () => ({
            sidebar: { fullscreen: false },
            tab: { id: 'tab-1', kind: 'plan-review-card', title: '计划待审', navigation }
        })
    });
}

test('the sidebar body resolves the docked card without navigation params (the guide-opened tab)', () => {
    const { calls, service } = mountPlugin();
    const review = planReviewRequest();

    // Nothing docked: the idle face.
    let element = renderBody(calls, { address: 'dsh-page://plan-review-card', params: undefined, revision: 0 });
    assert.equal(element.props['data-plan-card'], 'idle');

    // Docked, then a tab that carries no params — how the sidebar's own guide
    // opens it — must still resolve the card. This is the blank-sidebar fix.
    service.dock(review);
    element = renderBody(calls, { address: 'dsh-page://plan-review-card', params: undefined, revision: 0 });
    assert.equal(element.props.variant, 'sidebar');
    assert.equal(element.props.review.id, review.questions[0].id);
    assert.equal(element.props.pending, review);
});

test('the sidebar body prefers the reviewKey navigation param when present', () => {
    const { calls, service } = mountPlugin();
    const review = planReviewRequest();
    service.dock(review);

    const element = renderBody(calls, {
        address: 'dsh-page://plan-review-card',
        params: { reviewKey: 'question:1' },
        revision: 1
    });
    assert.equal(element.props.variant, 'sidebar');
    assert.equal(element.props.review.id, review.questions[0].id);
});

test('a stale reviewKey param resolves nothing once the record has settled', () => {
    const { calls, service } = mountPlugin();
    const review = planReviewRequest();
    service.dock(review);
    service.undock(review.key);

    const element = renderBody(calls, {
        address: 'dsh-page://plan-review-card',
        params: { reviewKey: 'question:1' },
        revision: 1
    });
    assert.equal(element.props['data-plan-card'], 'idle');
});
