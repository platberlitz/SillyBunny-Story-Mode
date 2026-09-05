import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/api.js';
import { updateThinkingButton } from '../src/ui.js';
import { CARD_KEY, CHAT_KEY, DEFAULT_SETTINGS, EXTRA_KEY, PROMPT_DIRECTION_KEY, PROMPT_RULES_KEY, SETTINGS_KEY, getCuts, textRevision } from '../src/core.js';

function makeContext({ chat = [], chatId = 'chat-1', characterId = 0, characters = [{ name: 'Ann', data: { extensions: {} } }], groupId = null, chatMetadata = {}, extensionSettings = {} } = {}) {
    const calls = { generate: [], generateOptions: [], prompts: [], updates: [], saveChat: 0, saveChatOptions: [], deleteLast: 0, swipeRight: 0, swipeOptions: [], refresh: 0, added: [], cardWrites: [], raw: null, quiet: null, saveMeta: 0 };
    const context = {
        chat, chatId, characterId, characters, groupId, chatMetadata, extensionSettings,
        onGenerate: null,
        generationSupportsRequestControls: true,
        rawResult: 'raw result',
        swipeAllowed: true,
        saveSettingsDebounced() {},
        async saveMetadata(options) { assert.deepEqual(options, { throwOnError: true }); calls.saveMeta++; return true; },
        setExtensionPrompt(...args) { calls.prompts.push(args); },
        async generate(type, options) { calls.generate.push(type); calls.generateOptions.push(options); api.onGenerationStarted(type, options); await context.onGenerate?.(type, options); },
        async updateMessageBlock(index, message) { calls.updates.push([index, message.mes]); api.clearRedoIfDiverged(); },
        async saveChat(options) { calls.saveChat++; calls.saveChatOptions.push(options); return true; },
        async deleteLastMessage() { calls.deleteLast++; chat.length = Math.max(0, chat.length - 1); api.clearRedoIfDiverged(); },
        addOneMessage(message) { calls.added.push(message); },
        swipe: {
            isAllowed: () => context.swipeAllowed,
            state: () => 'none',
            async right() { calls.swipeRight++; },
            async to(event, direction, options) {
                calls.swipeRight++;
                calls.swipeOptions.push(options);
                assert.equal(direction, 'right');
                const message = options.message;
                message.swipes ??= [message.mes];
                message.swipe_info ??= [{ extra: structuredClone(message.extra ?? {}) }];
                message.swipe_id = options.forceSwipeId;
                message.mes = '...';
                api.clearRedoIfDiverged();
                await context.generate('swipe', options.generationOptions);
                message.mes = message.mes === '...' ? 'New swipe' : message.mes;
                message.swipes[message.swipe_id] = message.mes;
                message.swipe_info[message.swipe_id] = { extra: structuredClone(message.extra ?? {}) };
            },
            refresh() { calls.refresh++; },
        },
        async writeExtensionField(id, key, value, options) { assert.deepEqual(options, { throwOnError: true }); calls.cardWrites.push([id, key, value]); characters[id].data.extensions[key] = value; return true; },
        async generateRaw(args) { calls.raw = args; return context.rawResult; },
        async generateQuietPrompt(args) { calls.quiet = args; return 'quiet result'; },
        eventTypes: { CHAT_COMPLETION_SETTINGS_READY: 'ccsr', TEXT_COMPLETION_SETTINGS_READY: 'tcsr' },
        eventSource: {
            handlers: {},
            on(type, handler) { (this.handlers[type] ??= []).push(handler); },
            removeListener(type, handler) { this.handlers[type] = (this.handlers[type] ?? []).filter((h) => h !== handler); },
        },
    };
    return { context, calls };
}

function withCuts(message, cuts) {
    return {
        ...message,
        extra: { ...message.extra, [EXTRA_KEY]: { cuts, revision: textRevision(message.mes) } },
    };
}

let current = null;
globalThis.SillyTavern = { getContext: () => current };

function use(options) {
    const made = makeContext(options);
    current = made.context;
    api.setHooks({ afterGeneration: null, beforeGeneration: null, busyChanged: null });
    api.setTransformBusy(false);
    api.resetInflight();
    api.clearRedo({ discardFailures: true });
    return made;
}

test('intentional Stop is not an error and keeps accepted partial prose', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    for (const suffix of ['', ' A partial passage']) {
        const { context } = use({ chat: [{ mes: 'Original.', is_user: false }] });
        let completed;
        api.setHooks({ afterGeneration: action => { completed = action; } });
        context.onGenerate = () => {
            context.chat[0].mes += suffix;
            throw new DOMException('Stopped', 'AbortError');
        };
        assert.equal(await api.continueStory({ direction: 'Keep going' }), Boolean(suffix));
        assert.equal(context.chat[0].mes, `Original.${suffix}`);
        assert.equal(completed.error, undefined);
        assert.equal(api.isBusy(), false);
    }
    assert.equal(errors.mock.callCount(), 0);
});

test('settings are normalised on read without being written back, and merged on update', () => {
    const { context } = use({ extensionSettings: { [SETTINGS_KEY]: { shading: true } } });
    assert.equal(api.getSettings().shading, true);
    assert.equal(api.getSettings().rules.length > 10, true);
    assert.deepEqual(context.extensionSettings[SETTINGS_KEY], { shading: true });
    api.updateSettings({ serif: true });
    assert.equal(context.extensionSettings[SETTINGS_KEY].serif, true);
    assert.equal(context.extensionSettings[SETTINGS_KEY].shading, true);
    assert.equal(context.extensionSettings[SETTINGS_KEY].rules.length > 10, true);
});

test('the per-chat flag wins over the card default and is saved immediately', async () => {
    const { context, calls } = use({ chat: [{ mes: 'x' }] });
    assert.equal(api.isEnabled(), false);
    api.updateSettings({ defaultOn: true });
    assert.equal(api.isEnabled(), true);
    context.characters[0].data.extensions[CARD_KEY] = { default: false };
    assert.equal(api.isEnabled(), false);
    assert.equal(await api.setChatFlag(true), true);
    assert.equal(calls.saveMeta, 1);
    assert.deepEqual(context.chatMetadata[CHAT_KEY], { enabled: true });
    assert.equal(api.isEnabled(), true);
    api.updateSettings({ defaultOn: false });
});

test('no chat means Story Mode is off no matter what', () => {
    use({ chat: [], chatId: null });
    api.updateSettings({ defaultOn: true });
    assert.equal(api.isEnabled(), false);
    api.updateSettings({ defaultOn: false });
});

test('rules use the card instruction when present and are injected at depth 1', () => {
    const { context, calls } = use({ chat: [{ mes: 'x' }] });
    api.setRules();
    let [key, text, position, depth, scan, role] = calls.prompts.at(-1);
    assert.equal(key, PROMPT_RULES_KEY);
    assert.ok(text.includes(DEFAULT_SETTINGS.lengthHint));
    assert.deepEqual([position, depth, scan, role], [1, 1, false, 0]);
    context.characters[0].data.extensions[CARD_KEY] = { instruction: 'Card rules: {{length}}.' };
    api.setRules();
    [key, text] = calls.prompts.at(-1);
    assert.equal(text, `Card rules: ${DEFAULT_SETTINGS.lengthHint}.`);
    api.clearRules();
    assert.deepEqual(calls.prompts.at(-1), [PROMPT_RULES_KEY, '', 1, 1, false, 0]);
});

test('direction is injected at depth 0 and cleared with an empty value', () => {
    const { calls } = use({ chat: [{ mes: 'x' }] });
    assert.equal(api.setDirection('go left'), true);
    assert.deepEqual(calls.prompts.at(-1), [PROMPT_DIRECTION_KEY, '[Direction for the next passage only: go left]', 1, 0, false, 0]);
    assert.equal(api.setDirection('   '), false);
    api.clearDirection();
    assert.deepEqual(calls.prompts.at(-1), [PROMPT_DIRECTION_KEY, '', 1, 0, false, 0]);
});

test('continue with an empty box records a cut, extends the last block and clears the direction', async () => {
    const { context, calls } = use({ chat: [{ is_user: false, mes: 'Once upon a time', extra: {} }] });
    context.onGenerate = async () => {
        context.chat[0].mes += ', there was a fox.';
    };
    assert.equal(await api.continueStory({ hasText: false, direction: 'Introduce a fox' }), true);
    assert.deepEqual(calls.generate, ['continue']);
    assert.deepEqual(getCuts(context.chat[0]), ['Once upon a time'.length]);
    assert.deepEqual(calls.prompts.at(-1), [PROMPT_DIRECTION_KEY, '', 1, 0, false, 0]);
    assert.equal(api.isInflight(), false);
});

test('continue with text records the cut on the block the host just sent', async () => {
    const { context, calls } = use({ chat: [{ is_user: false, mes: 'Prior.', extra: {} }] });
    context.onGenerate = async () => {
        context.chat.push({ is_user: true, mes: 'She opened the door and', extra: {} });
        api.onMessageSent(context.chat.length - 1);
        context.chat[1].mes += ' saw nothing.';
    };
    await api.continueStory({ hasText: true });
    assert.deepEqual(getCuts(context.chat[1]), ['She opened the door and'.length]);
    assert.deepEqual(getCuts(context.chat[0]), []);
    assert.equal(calls.generate.length, 1);
});

test('a continuation that produced nothing leaves no cut behind', async () => {
    const { context, calls } = use({ chat: [{ is_user: false, mes: 'Stays the same', extra: {} }] });
    await api.continueStory({ hasText: false });
    assert.deepEqual(getCuts(context.chat[0]), []);
    assert.equal(context.chat[0].extra[EXTRA_KEY], undefined);
    assert.equal(calls.saveChat, 1);
});

test('direction remains active until the owned generation promise settles', async () => {
    const { calls } = use({ chat: [{ mes: 'x' }] });
    let release;
    current.onGenerate = () => new Promise((resolve) => { release = resolve; });
    const generation = api.continueStory({ direction: 'keep me' });
    await Promise.resolve();
    assert.equal(api.isInflight(), true);
    assert.ok(calls.prompts.at(-1)[1].includes('keep me'));
    release();
    await generation;
    assert.equal(api.isInflight(), false);
    assert.ok(calls.prompts.at(-1)[1].includes('keep me'));
});

test('continuations pass request-owned limits, including zero, without installing event interceptors', async () => {
    const { context, calls } = use({ chat: [{ is_user: false, mes: 'Start' }], extensionSettings: { [SETTINGS_KEY]: { maxTokens: 120 } } });
    context.onGenerate = async () => { context.chat[0].mes += ' tail'; };
    assert.equal(await api.continueStory({ hasText: false }), true);
    assert.deepEqual(calls.generateOptions[0], { suppressAutoContinue: true, suppressUserMessage: false, maxOutputTokens: 120 });
    assert.deepEqual(context.eventSource.handlers, {});
    api.updateSettings({ maxTokens: 0 });
    await api.continueStory({ hasText: false });
    assert.equal(calls.generateOptions.at(-1).maxOutputTokens, 0);
});

test('the agents gate filters current runtime choices without mutating stored preferences', async () => {
    const { context } = use({ chat: [{ is_user: false, mes: 'Start' }], chatMetadata: { [CHAT_KEY]: { enabled: true } }, extensionSettings: { [SETTINGS_KEY]: { agentGate: true, allowedAgents: ['keep'] } } });
    const agents = [{ id: 'keep', name: 'Keep', enabled: true }, { id: 'drop', name: 'Drop', enabled: true }, { id: 'off', name: 'Off', enabled: false }];
    const store = {
        filters: new Map(),
        getAgents: () => [...agents],
        getEnabledAgents: () => agents.filter((agent) => agent.enabled && store.isAgentRuntimeAllowed(agent)),
        setRuntimeAgentFilter(owner, predicate) { if (predicate) this.filters.set(owner, predicate); else this.filters.delete(owner); },
        isAgentRuntimeAllowed: (agent) => [...store.filters.values()].every(predicate => predicate(agents.find(current => current.id === agent.id))),
    };
    assert.deepEqual(api.listAgents(store).map((agent) => `${agent.name}:${agent.enabled}`), ['Keep:true', 'Drop:true', 'Off:false']);
    assert.deepEqual(api.applyAgentGate(store), ['drop']);
    assert.deepEqual(agents.map((agent) => agent.enabled), [true, true, false]);
    assert.deepEqual(store.getEnabledAgents().map(agent => agent.id), ['keep']);
    assert.deepEqual(api.applyAgentGate(store), ['drop'], 'applying again keeps the same hold');
    api.updateSettings({ allowedAgents: ['keep', 'drop'] });
    assert.deepEqual(api.applyAgentGate(store), [], 'a newly allowed agent is released');
    assert.deepEqual(agents.map((agent) => agent.enabled), [true, true, false]);
    api.updateSettings({ allowedAgents: ['keep'] });
    assert.deepEqual(api.applyAgentGate(store), ['drop']);

    context.chatMetadata[CHAT_KEY].enabled = false;
    assert.deepEqual(api.applyAgentGate(store), [], 'Story Mode off in the chat releases the hold');
    assert.deepEqual(agents.map((agent) => agent.enabled), [true, true, false], 'only what the gate switched off comes back');
    context.chatMetadata[CHAT_KEY].enabled = true;
    assert.deepEqual(api.applyAgentGate(store), ['drop']);
    api.updateSettings({ agentGate: false });
    assert.deepEqual(api.applyAgentGate(store), [], 'the setting off releases the hold');
    api.updateSettings({ agentGate: true });
    api.applyAgentGate(store);
    api.releaseAgentGate(store);
    assert.deepEqual(agents.map((agent) => agent.enabled), [true, true, false]);
    api.releaseAgentGate(store);
    assert.equal(store.filters.size, 0);
    assert.equal(api.listAgents(null), null);
});

test('Story continuation leaves global Auto-continue untouched', async () => {
    const { context } = use({ chat: [{ is_user: false, mes: 'Start', extra: {} }] });
    context.powerUserSettings = { auto_continue: { enabled: true } };
    context.onGenerate = async () => {
        assert.equal(context.powerUserSettings.auto_continue.enabled, true);
        context.chat[0].mes += ' once';
    };
    assert.equal(await api.continueStory(), true);
    assert.equal(context.powerUserSettings.auto_continue.enabled, true);
    assert.deepEqual(getCuts(context.chat[0]), [5]);
});

test('the host generating markers block Story actions until they clear, with or without GENERATION_ENDED', async () => {
    const { calls } = use({ chat: [{ is_user: false, mes: 'Start' }] });
    globalThis.document = { body: { dataset: { generating: 'true' } }, getElementById: () => null };
    try {
        api.onGenerationStarted('normal');
        assert.equal(api.isBusy(), true);
        assert.equal(await api.continueStory(), false);
        assert.equal(calls.generate.length, 0);
        delete document.body.dataset.generating;
        api.refreshBusy();
        assert.equal(api.isBusy(), false);
    } finally {
        delete globalThis.document;
    }
});

test('continue refuses while a continuation is running or when there is nothing to continue', async () => {
    const { context, calls } = use({ chat: [] });
    assert.equal(await api.continueStory({ hasText: false }), false);
    assert.equal(calls.generate.length, 0);
    context.chat.push({ is_user: false, mes: 'x', extra: {} });
    let release;
    context.onGenerate = () => new Promise((resolve) => { release = resolve; });
    const first = api.continueStory({ hasText: false });
    assert.equal(await api.continueStory({ hasText: false }), false);
    release();
    await first;
    assert.equal(calls.generate.length, 1);
});

test('failed and unsupported group continuations do not inject direction', async () => {
    let made = use({ chat: [] });
    assert.equal(await api.continueStory({ hasText: false, direction: 'do not leak' }), false);
    assert.equal(made.calls.prompts.length, 0);
    made = use({ chat: [{ is_user: false, mes: 'Group text' }], groupId: 'group-1' });
    assert.equal(await api.continueStory({ hasText: true, direction: 'also do not leak' }), false);
    assert.equal(made.calls.generate.length, 0);
    assert.equal(made.calls.prompts.length, 0);
});

test('a continuation that finishes after a chat switch cannot seal or save the old chat', async () => {
    const old = use({ chat: [{ is_user: false, mes: 'Old chat' }] });
    let release;
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    old.context.onGenerate = () => {
        markStarted();
        return new Promise((resolve) => { release = resolve; });
    };
    const pending = api.continueStory({ direction: 'old direction' });
    await started;
    const next = makeContext({ chat: [{ is_user: false, mes: 'New chat' }], chatId: 'chat-2' });
    current = next.context;
    old.context.chat[0].mes += ' generated tail';
    release();
    await pending;
    assert.deepEqual(getCuts(old.context.chat[0]), []);
    assert.equal(old.calls.saveChat, 0);
    assert.equal(next.calls.saveChat, 0);
});

test('a chat switch during save cannot report success or clear the new chat direction', async () => {
    const old = use({ chat: [{ is_user: false, mes: 'Old' }] });
    const next = makeContext({ chatId: 'chat-2', chat: [{ mes: 'New' }] });
    let finished;
    api.setHooks({ afterGeneration: action => { finished = action; } });
    old.context.onGenerate = async () => { old.context.chat[0].mes += ' tail'; };
    old.context.saveChat = async () => { current = next.context; return true; };
    assert.equal(await api.continueStory({ direction: 'old' }), false);
    assert.equal(finished.success, false);
    assert.equal(next.calls.prompts.length, 0);
});

test('actions abort after closing an editor switches chats', async () => {
    const old = use({ chat: [{ is_user: false, mes: 'Do not delete' }] });
    const next = makeContext({ chat: [{ is_user: false, mes: 'Other chat' }], chatId: 'chat-2' });
    let editorOpen = true;
    const textarea = {
        closest: () => ({
            querySelector: () => ({
                click() {
                    current = next.context;
                    editorOpen = false;
                },
            }),
        }),
    };
    globalThis.document = { getElementById: (id) => id === 'curEditTextarea' && editorOpen ? textarea : null };
    try {
        assert.equal(await api.undo(), false);
    } finally {
        delete globalThis.document;
    }
    assert.equal(old.context.chat.length, 1);
    assert.equal(next.context.chat.length, 1);
    assert.equal(old.calls.deleteLast, 0);
    assert.equal(next.calls.deleteLast, 0);
});

test('actions abort if the open editor does not close', async () => {
    const made = use({ chat: [{ is_user: false, mes: 'Do not delete' }] });
    const textarea = { closest: () => ({ querySelector: () => ({ click() {} }) }) };
    const originalNow = Date.now;
    const originalTimeout = globalThis.setTimeout;
    let now = 0;
    Date.now = () => (now += 1000);
    globalThis.setTimeout = (resolve) => { resolve(); };
    globalThis.document = { getElementById: (id) => id === 'curEditTextarea' ? textarea : null };
    try {
        assert.equal(await api.undo(), false);
    } finally {
        Date.now = originalNow;
        globalThis.setTimeout = originalTimeout;
        delete globalThis.document;
    }
    assert.equal(made.calls.deleteLast, 0);
});

test('Continue reads the composer again after closing an editor', async () => {
    const { context } = use({ chat: [{ is_user: false, mes: 'Prior' }] });
    let editorOpen = true;
    const composer = { value: '' };
    const textarea = {
        closest: () => ({
            querySelector: () => ({ click() { editorOpen = false; composer.value = 'My line'; } }),
        }),
    };
    globalThis.document = {
        getElementById(id) {
            if (id === 'curEditTextarea') return editorOpen ? textarea : null;
            if (id === 'send_textarea') return composer;
            return null;
        },
    };
    context.onGenerate = async () => {
        context.chat.push({ is_user: true, mes: composer.value, extra: {} });
        api.onMessageSent(1);
        context.chat[1].mes += ' continued';
    };
    try {
        assert.equal(await api.continueStory({ hasText: false }), true);
    } finally {
        delete globalThis.document;
    }
    assert.deepEqual(getCuts(context.chat[1]), ['My line'.length]);
});

test('undo truncates to the last cut, keeps swipes in sync and redo restores it', async () => {
    const { context, calls } = use({ chat: [withCuts({ is_user: true, mes: 'Mine and theirs', swipe_id: 0, swipes: ['Mine and theirs'] }, [4])] });
    context.chat[0].swipe_info = [{ extra: structuredClone(context.chat[0].extra) }];
    assert.equal(await api.undo(), true);
    assert.equal(context.chat[0].mes, 'Mine');
    assert.equal(context.chat[0].swipes[0], 'Mine');
    assert.deepEqual(getCuts(context.chat[0]), []);
    assert.equal(context.chat[0].swipe_info[0].extra[EXTRA_KEY], undefined);
    assert.deepEqual(calls.updates, [[0, 'Mine']]);
    assert.equal(calls.saveChat, 1);
    assert.equal(api.canRedo(), true);
    assert.equal(await api.redo(), true);
    assert.equal(context.chat[0].mes, 'Mine and theirs');
    assert.deepEqual(getCuts(context.chat[0]), [4]);
    assert.deepEqual(context.chat[0].swipe_info[0].extra[EXTRA_KEY], context.chat[0].extra[EXTRA_KEY]);
    assert.equal(context.chat[0].swipes[0], 'Mine and theirs');
    assert.equal(calls.saveChat, 2);
    assert.equal(api.canRedo(), false);
});

test('undo on a model block without cuts deletes it, saves, and redo puts it back', async () => {
    const { context, calls } = use({ chat: [{ is_user: true, mes: 'Mine' }, { is_user: false, mes: 'Theirs', extra: {} }] });
    assert.equal(await api.undo(), true);
    assert.equal(context.chat.length, 1);
    assert.equal(calls.deleteLast, 1);
    assert.equal(calls.saveChat, 1);
    assert.deepEqual(calls.saveChatOptions[0], { throwOnError: true, allowShrink: true });
    assert.equal(calls.refresh, 1);
    assert.equal(await api.redo(), true);
    assert.equal(context.chat.length, 2);
    assert.equal(context.chat[1].mes, 'Theirs');
    assert.equal(calls.added.length, 1);
    assert.equal(calls.saveChat, 2);
});

test('message redo refuses a divergent branch', async () => {
    const { context } = use({ chat: [{ is_user: true, mes: 'Mine' }, { is_user: false, mes: 'Old model' }] });
    assert.equal(await api.undo(), true);
    context.chat.push({ is_user: true, mes: 'New branch' });
    assert.equal(await api.redo(), false);
    assert.deepEqual(context.chat.map((message) => message.mes), ['Mine', 'New branch']);
});

test('undo does nothing on a block the user wrote', async () => {
    const { context, calls } = use({ chat: [{ is_user: true, mes: 'Mine' }] });
    assert.equal(await api.undo(), false);
    assert.equal(context.chat.length, 1);
    assert.equal(calls.deleteLast, 0);
});

test('redo refuses when the block changed since the undo', async () => {
    const { context } = use({ chat: [withCuts({ is_user: false, mes: 'abcdef' }, [3])] });
    await api.undo();
    context.chat[0].mes = 'abcX';
    assert.equal(await api.redo(), false);
    assert.equal(context.chat[0].mes, 'abcX');
});

test('redo validates the exact prefix, not only its length', async () => {
    const { context } = use({ chat: [withCuts({ is_user: true, mes: 'abc tail' }, [3])] });
    assert.equal(await api.undo(), true);
    context.chat[0].mes = 'xyz';
    assert.equal(await api.redo(), false);
    assert.equal(context.chat[0].mes, 'xyz');
});

test('retry truncates the last continuation and continues again', async () => {
    const { context, calls } = use({ chat: [withCuts({ is_user: false, mes: 'Start, old tail' }, [5])] });
    context.onGenerate = async () => {
        context.chat[0].mes += ' new tail';
    };
    assert.equal(await api.retry(), true);
    assert.equal(context.chat[0].mes, 'Start new tail');
    assert.deepEqual(getCuts(context.chat[0]), [5]);
    assert.deepEqual(calls.generate, ['continue']);
});

test('an empty Retry restores the removed tail automatically', async () => {
    const { context } = use({ chat: [withCuts({ is_user: false, mes: 'Start, old tail' }, [5])] });
    assert.equal(await api.retry(), false);
    assert.equal(context.chat[0].mes, 'Start, old tail');
});

test('retry never changes the composer and explicitly suppresses its consumption', async () => {
    const { context, calls } = use({ chat: [withCuts({ is_user: false, mes: 'Start, old tail' }, [5])] });
    const composer = { value: 'my draft', events: 0, dispatchEvent() { this.events++; } };
    globalThis.document = { getElementById: (id) => id === 'send_textarea' ? composer : null };
    context.onGenerate = async (_type, options) => {
        assert.equal(options.suppressUserMessage, true);
        assert.equal(composer.value, 'my draft');
        context.chat[0].mes += ' new tail';
    };
    try {
        assert.equal(await api.retry(), true);
    } finally {
        delete globalThis.document;
    }
    assert.equal(context.chat[0].mes, 'Start new tail');
    assert.equal(context.chat.length, 1, 'the draft was not posted as a block');
    assert.deepEqual(getCuts(context.chat[0]), [5]);
    assert.equal(composer.value, 'my draft');
    assert.equal(composer.events, 0, 'the composer was never touched');
    assert.deepEqual(calls.generate, ['continue']);
});

test('retry on a host-made model block swipes, and respects the swipe gate', async () => {
    const { context, calls } = use({ chat: [{ is_user: false, mes: 'Theirs', extra: {} }] });
    assert.equal(await api.retry(), true);
    assert.equal(calls.swipeRight, 1);
    context.swipeAllowed = false;
    assert.equal(await api.retry(), false);
    assert.equal(calls.swipeRight, 1);
    context.chat[0].is_user = true;
    assert.equal(await api.retry(), false);
});

test('stale or malformed cuts and system messages are never destructive fallbacks', async () => {
    let made = use({ chat: [{ is_user: false, mes: 'abcdef', extra: { [EXTRA_KEY]: { cuts: [3] } } }] });
    assert.equal(await api.undo(), false);
    assert.equal(await api.retry(), false);
    assert.equal(made.calls.deleteLast, 0);
    assert.equal(made.calls.swipeRight, 0);
    made = use({ chat: [{ is_user: false, mes: 'abcdef', extra: { [EXTRA_KEY]: { cuts: 'bad' } } }] });
    assert.equal(await api.undo(), false);
    assert.equal(await api.retry(), false);
    assert.equal(made.calls.deleteLast, 0);
    assert.equal(made.calls.swipeRight, 0);
    made = use({ chat: [{ is_user: false, is_system: true, mes: 'hidden' }] });
    assert.equal(await api.undo(), false);
    assert.equal(await api.retry(), false);
    assert.equal(made.calls.deleteLast, 0);
    assert.equal(made.calls.swipeRight, 0);
});

test('an edit keeps the cuts only when the text did not change', () => {
    const { context } = use({ chat: [withCuts({ is_user: true, mes: 'Mine and theirs' }, [4])] });
    api.noteEditOpened(0);
    api.onMessageEdited(0);
    assert.deepEqual(getCuts(context.chat[0]), [4]);
    api.noteEditOpened(0);
    context.chat[0].mes = 'Mine and theirs!';
    api.onMessageEdited(0);
    assert.deepEqual(getCuts(context.chat[0]), []);
    context.chat[0].extra[EXTRA_KEY] = { cuts: [2], revision: textRevision(context.chat[0].mes) };
    api.onMessageEdited(0);
    assert.deepEqual(getCuts(context.chat[0]), []);
});

test('runTransform uses the cheap raw call by default and the full pipeline when asked', async () => {
    const { context, calls } = use({ chat: [] });
    context.rawResult = '"Hello there."';
    const value = 'Para one.\n\nSelect THIS please.\n\nPara three.';
    const start = value.indexOf('THIS');
    const result = await api.runTransform({ kind: 'rewrite', value, start, end: start + 4, signal: null });
    assert.equal(result, 'Hello there.');
    assert.ok(calls.raw.prompt.includes('Passage to change:\nTHIS'));
    assert.ok(calls.raw.prompt.includes('Text before the passage:\nPara one.\n\nSelect'));
    assert.equal(calls.raw.responseLength, 64);
    assert.equal(calls.raw.preserveReasoningBudget, true);
    assert.equal(calls.quiet, null);
    api.updateSettings({ transformsUseFullContext: true });
    const viaQuiet = await api.runTransform({ kind: 'expand', value, start, end: start + 4, signal: null });
    assert.equal(viaQuiet, 'quiet result');
    assert.equal(calls.quiet.skipWIAN, true);
    assert.equal(calls.quiet.preserveReasoningBudget, true);
    assert.ok(calls.quiet.quietPrompt.includes('Expand the passage'));
    api.updateSettings({ transformsUseFullContext: false });
    assert.equal(await api.runTransform({ kind: 'rewrite', value, start: 2, end: 2, signal: null }), '');
    context.rawResult = 'better phrase';
    const spaced = 'One bad phrase two';
    assert.equal(await api.runTransform({ kind: 'rewrite', value: spaced, start: 3, end: 15, signal: null }), ' better phrase ');
});

test('card config is written into the card and cleared with explicit empty values', async () => {
    const { context, calls } = use({ chat: [{ mes: 'x' }] });
    assert.deepEqual(api.getCardConfig(), { default: undefined, instruction: '' });
    assert.equal(await api.setCardConfig({ default: true, instruction: '  ' }), true);
    assert.deepEqual(calls.cardWrites.at(-1), [0, CARD_KEY, { default: true, instruction: '' }]);
    assert.deepEqual(api.getCardConfig(), { default: true, instruction: '' });
    await api.setCardConfig({ instruction: 'Rules' });
    assert.deepEqual(context.characters[0].data.extensions[CARD_KEY], { default: true, instruction: 'Rules' });
    await api.setCardConfig({ default: false });
    assert.deepEqual(context.characters[0].data.extensions[CARD_KEY], { default: false, instruction: 'Rules' });
    await api.setCardConfig({ instruction: 'New rules' });
    assert.deepEqual(context.characters[0].data.extensions[CARD_KEY], { default: false, instruction: 'New rules' });
    await api.setCardConfig({ default: undefined });
    assert.deepEqual(context.characters[0].data.extensions[CARD_KEY], { default: null, instruction: 'New rules' });
    assert.deepEqual(api.getCardConfig(), { default: undefined, instruction: 'New rules' });
    context.groupId = 'g1';
    assert.equal(api.getCardConfig(), null);
    assert.equal(await api.setCardConfig({ default: true }), false);
});

test('concurrent card updates are serialized and merge the latest card value', async () => {
    const { context, calls } = use({ chat: [{ mes: 'x' }] });
    let release;
    let started;
    const firstStarted = new Promise((resolve) => { started = resolve; });
    context.writeExtensionField = async (id, key, value) => {
        calls.cardWrites.push([id, key, value]);
        if (calls.cardWrites.length === 1) {
            started();
            await new Promise((resolve) => { release = resolve; });
        }
        context.characters[id].data.extensions[key] = value;
        return true;
    };
    const first = api.setCardConfig({ default: true });
    const second = api.setCardConfig({ instruction: 'Rules' });
    await firstStarted;
    release();
    await Promise.all([first, second]);
    assert.deepEqual(context.characters[0].data.extensions[CARD_KEY], { default: true, instruction: 'Rules' });
});

test('the /story command registers once with on/off/toggle', async () => {
    const registered = [];
    const { context } = use({ chat: [{ mes: 'x' }] });
    context.SlashCommandParser = { addCommandObject: (command) => registered.push(command) };
    context.SlashCommand = { fromProps: (props) => props };
    context.SlashCommandArgument = { fromProps: (props) => props };
    context.ARGUMENT_TYPE = { STRING: 'string' };
    const seen = [];
    assert.equal(api.registerCommands({ onToggle: (arg) => { seen.push(arg); return 'ok'; } }), true);
    assert.equal(api.registerCommands({ onToggle: () => 'again' }), true);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, 'story');
    assert.deepEqual(registered[0].unnamedArgumentList[0].enumList, ['on', 'off', 'toggle']);
    assert.equal(await registered[0].callback({}, 'on'), 'ok');
    assert.deepEqual(seen, ['on']);
});

test('continuation records and preserves reasoning traces across continuations, undo, and redo', async () => {
    const initialMessage = {
        is_user: false,
        mes: 'It was a dark and stormy night.',
        extra: {
            reasoning: 'Setting the atmosphere.',
            reasoning_duration: 3,
        },
    };
    const { context } = use({
        chat: [initialMessage],
        extensionSettings: { [SETTINGS_KEY]: { maxTokens: 160 } },
    });

    // Simulate continuation producing text and reasoning
    context.onGenerate = async () => {
        const msg = context.chat[0];
        msg.mes += ' Lightning flashed across the sky.';
        msg.extra.reasoning = 'Adding dramatic weather element.';
        msg.extra.reasoning_duration = 2;
    };

    assert.equal(await api.continueStory({ hasText: false }), true);

    // Message should now have preserved both reasoning traces
    const msg = context.chat[0];
    const reasonings = api.getMessageReasonings(msg);
    assert.equal(reasonings.length, 2);
    assert.deepEqual(reasonings[0], {
        cut: 0,
        text: 'Setting the atmosphere.',
        duration: 3,
    });
    assert.deepEqual(reasonings[1], {
        cut: 31,
        text: 'Adding dramatic weather element.',
        duration: 2,
    });

    // Undo continuation
    assert.equal(await api.undo(), true);
    assert.equal(msg.mes, 'It was a dark and stormy night.');
    const undoneReasonings = api.getMessageReasonings(msg);
    assert.equal(undoneReasonings.length, 1);
    assert.equal(undoneReasonings[0].text, 'Setting the atmosphere.');

    // Redo continuation
    assert.equal(await api.redo(), true);
    assert.equal(msg.mes, 'It was a dark and stormy night. Lightning flashed across the sky.');
    const redoneReasonings = api.getMessageReasonings(msg);
    assert.equal(redoneReasonings.length, 2);
    assert.equal(redoneReasonings[1].text, 'Adding dramatic weather element.');
});

test('updateThinkingButton manages the brain action button based on message reasoning', () => {
    let buttonAdded = null;
    let buttonRemoved = false;
    const mockBtn = {
        title: '',
        tabIndex: -1,
        className: '',
        setAttribute(k, v) { this[k] = v; },
        addEventListener() {},
        remove() { buttonRemoved = true; },
    };
    const mockButtons = {
        querySelector(selector) {
            if (selector === '.sbstory-thinking-btn') return buttonAdded;
            return null;
        },
        appendChild(child) { buttonAdded = child; },
    };
    const mockMesEl = {
        getAttribute() { return '0'; },
        querySelector(selector) {
            if (selector === '.mes_buttons') return mockButtons;
            return null;
        },
    };

    globalThis.document = {
        createElement(tag) {
            if (tag === 'button') return { ...mockBtn };
            return {};
        },
    };

    // 1. Message with no reasoning: no button
    updateThinkingButton(mockMesEl, { extra: {} });
    assert.equal(buttonAdded, null);

    // 2. Message with 1 reasoning: button added with title
    updateThinkingButton(mockMesEl, {
        extra: { reasoning: 'Reflecting on the scene', reasoning_duration: 6000 },
    });
    assert.notEqual(buttonAdded, null);
    assert.equal(buttonAdded.title, 'View reasoning trace (6s)');
    assert.equal(buttonAdded['aria-label'], buttonAdded.title);

    // 3. Message with multiple reasonings across continuations
    updateThinkingButton(mockMesEl, {
        extra: {
            story_mode: {
                reasonings: [
                    { cut: 0, text: 'Part 1', duration: 4000 },
                    { cut: 50, text: 'Part 2', duration: 8000 },
                ],
            },
        },
    });
    assert.equal(buttonAdded.title, 'View 2 reasoning thoughts (12s)');

    // 4. Message reasoning cleared: button removed
    updateThinkingButton(mockMesEl, { extra: {} });
    assert.equal(buttonRemoved, true);
    delete globalThis.document;
});

test('host deletion notifications preserve consecutive Undo C,B and Redo B,C', async () => {
    const { context } = use({ chat: ['A', 'B', 'C'].map(mes => ({ mes, is_user: false })) });
    assert.equal(await api.undo(), true);
    assert.equal(await api.undo(), true);
    assert.deepEqual(context.chat.map(message => message.mes), ['A']);
    assert.equal(await api.redo(), true);
    assert.equal(await api.redo(), true);
    assert.deepEqual(context.chat.map(message => message.mes), ['A', 'B', 'C']);
});

test('Redo restores a continuation after its whole model block was also undone', async () => {
    const { context } = use({ chat: [{ mes: 'A', is_user: true }, { mes: 'B', is_user: false }] });
    context.onGenerate = async () => { context.chat[1].mes += ' C'; };
    await api.continueStory();
    const original = structuredClone(context.chat);
    assert.equal(await api.undo(), true);
    assert.equal(await api.undo(), true);
    assert.equal(await api.redo(), true);
    assert.equal(await api.redo(), true);
    assert.deepEqual(context.chat, original);
});

test('new continuation snapshots round-trip all host metadata and active swipe reasoning twice', async () => {
    const original = {
        mes: 'A', is_user: false, gen_started: 10, gen_finished: 20,
        extra: { reasoning: 'A thought', reasoning_duration: 2500, reasoning_signature: 'A signature', other_extension: { value: 1 } },
        swipe_id: 0, swipes: ['A', 'Alternative'],
        swipe_info: [{ extra: { reasoning: 'A thought', reasoning_duration: 2500 } }, { extra: { reasoning: 'Alternative thought' } }],
    };
    const { context } = use({ chat: [structuredClone(original)] });
    const message = context.chat[0];
    const snapshots = [original];
    for (const suffix of ['B', 'C']) {
        context.onGenerate = async () => {
            message.mes += suffix;
            message.extra.reasoning = `${suffix} thought`;
            message.extra.reasoning_duration = 3500;
            message.extra.reasoning_signature = suffix;
            message.extra.other_extension.value++;
            message.gen_finished++;
        };
        assert.equal(await api.continueStory(), true);
        snapshots.push(structuredClone(message));
    }
    assert.equal(await api.undo(), true);
    assert.deepEqual(message, snapshots[1]);
    assert.equal(await api.undo(), true);
    assert.deepEqual(message, original);
    assert.equal(await api.redo(), true);
    assert.deepEqual(message, snapshots[1]);
    assert.equal(await api.redo(), true);
    assert.deepEqual(message, snapshots[2]);
    assert.equal(message.swipe_info[0].extra.reasoning, 'C thought');
});

test('accumulated nonstream reasoning records only the new suffix', () => {
    use();
    const message = { mes: 'A B', extra: { reasoning: 'Old thought.\nNew thought.', reasoning_duration: 2400 } };
    api.recordContinuationReasoning(message, { cut: 1, prevReasoning: 'Old thought.', prevDuration: 1400 });
    assert.deepEqual(api.getMessageReasonings(message).map(reasoning => reasoning.text), ['Old thought.', 'New thought.']);
    const repeated = { extra: { reasoning: 'Same.Same.' } };
    api.recordContinuationReasoning(repeated, { cut: 1, prevReasoning: 'Same.' });
    assert.deepEqual(api.getMessageReasonings(repeated).map(reasoning => reasoning.text), ['Same.', 'Same.']);
});

test('host prefix whitespace changes restore exact original text instead of sealing a wrong cut', async () => {
    const original = { mes: '  Original \n', is_user: true, extra: { reasoning: 'Prior', reasoning_duration: 1000 } };
    const { context, calls } = use({ chat: [structuredClone(original)] });
    let finished;
    api.setHooks({ afterGeneration: action => { finished = action; } });
    context.onGenerate = async () => { context.chat[0].mes = 'Original new passage'; };
    assert.equal(await api.continueStory({ direction: 'keep this' }), false);
    assert.deepEqual(context.chat[0], original);
    assert.equal(finished.success, false);
    assert.match(finished.error.message, /original text/);
    assert.ok(calls.prompts.at(-1)[1].includes('keep this'));
});

test('reasoning-only output is not a successful continuation and leaves no stale cuts', async () => {
    const original = { mes: 'Original', is_user: false, extra: { story_mode: { reasonings: [{ cut: 0, text: 'Old', duration: 1000 }] } } };
    const { context, calls } = use({ chat: [structuredClone(original)] });
    let finished;
    api.setHooks({ afterGeneration: action => { finished = action; } });
    context.onGenerate = async () => { context.chat[0].extra.reasoning = 'No prose, only thinking'; };
    assert.equal(await api.continueStory({ direction: 'keep direction' }), false);
    assert.deepEqual(context.chat[0], original);
    assert.equal(finished.success, false);
    assert.ok(calls.prompts.at(-1)[1].includes('keep direction'));
    assert.equal(api.canUndo(), true);
    assert.equal(await api.undo(), true);
});

test('Retry ignores text typed while the truncation save is pending', async () => {
    const { context, calls } = use({ chat: [withCuts({ mes: 'A old', is_user: false }, [1])] });
    const composer = { value: '' };
    globalThis.document = { getElementById: id => id === 'send_textarea' ? composer : null };
    const save = context.saveChat;
    context.saveChat = async options => {
        if (calls.saveChat === 0) composer.value = 'typed during save';
        return save(options);
    };
    context.onGenerate = async (_type, options) => {
        assert.equal(options.suppressUserMessage, true);
        assert.equal(composer.value, 'typed during save');
        context.chat[0].mes += ' replacement';
    };
    try {
        assert.equal(await api.retry(), true);
        assert.equal(context.chat[0].mes, 'A replacement');
        assert.equal(composer.value, 'typed during save');
        assert.equal(context.chat.length, 1);
    } finally {
        delete globalThis.document;
    }
});

test('Retry failure restores its removed tail including original reasoning', async () => {
    const original = withCuts({ mes: 'A old', is_user: false, extra: { reasoning: 'old thought', reasoning_duration: 1234 } }, [1]);
    const { context } = use({ chat: [structuredClone(original)] });
    context.onGenerate = async () => { throw new Error('request failed'); };
    assert.equal(await api.retry(), false);
    assert.deepEqual(context.chat[0], original);
});

test('Retry refuses a target changed during its save without consuming the composer or changing a new block', async () => {
    const { context, calls } = use({ chat: [withCuts({ mes: 'A old', is_user: false }, [1])] });
    const save = context.saveChat;
    context.saveChat = async options => {
        const result = await save(options);
        context.chat.push({ mes: 'Unrelated new block', is_user: true });
        return result;
    };
    assert.equal(await api.retry(), false);
    assert.equal(calls.generate.length, 0);
    assert.equal(context.chat[1].mes, 'Unrelated new block');
});

test('strict mutation saves roll back and retain recovery on rejection or refusal', async t => {
    for (const operation of ['undo tail', 'undo message', 'redo tail', 'redo message', 'continue', 'retry truncate', 'retry replace', 'retry restore', 'swipe']) {
        await t.test(operation, async () => {
            const plain = operation.includes('message') || operation === 'swipe';
            const { context } = use({ chat: [plain ? { mes: 'A old', is_user: false } : withCuts({ mes: 'A old', is_user: false }, [1])] });
            if (operation.startsWith('redo')) await api.undo();
            const before = structuredClone(context.chat);
            let attempts = 0;
            const failAt = ['retry replace', 'retry restore'].includes(operation) ? 2 : 1;
            context.saveChat = async options => {
                assert.equal(options.throwOnError, true);
                attempts++;
                if (attempts === failAt) {
                    assert.equal(api.canRedo(), true, 'recovery exists before the save yields');
                    if (operation === 'continue') return false;
                    throw new Error(`save rejected: ${operation}`);
                }
                return true;
            };
            if (operation !== 'retry restore') context.onGenerate = async () => { context.chat.at(-1).mes += ' new'; };
            const result = operation.startsWith('undo') ? await api.undo()
                : operation.startsWith('redo') ? await api.redo()
                    : operation === 'continue' ? await api.continueStory({ direction: 'keep' }) : await api.retry();
            assert.equal(result, false);
            assert.deepEqual(context.chat, before);
            assert.equal(api.canRedo(), true);
            assert.equal(api.isBusy(), false);
            assert.equal(await api.redo(), true, 'recovery remains usable after the save service recovers');
        });
    }
});

test('Undo rolls back even when the host deletion notification rejects', async () => {
    const original = { mes: 'B', is_user: false };
    const { context } = use({ chat: [{ mes: 'A' }, original] });
    context.deleteLastMessage = async () => {
        context.chat.pop();
        api.clearRedoIfDiverged();
        throw new Error('notification failed');
    };
    assert.equal(await api.undo(), false);
    assert.equal(context.chat[1], original);
    assert.equal(api.canRedo(), true);
});

test('whole-block Retry requests a fresh controlled swipe and preserves every prior swipe', async () => {
    const { context, calls } = use({ chat: [{ mes: 'A', is_user: false, swipe_id: 0, swipes: ['A', 'B'], swipe_info: [{ extra: { reasoning: 'A thought' } }, { extra: { reasoning: 'B thought' } }] }] });
    assert.equal(await api.retry(), true);
    assert.deepEqual(context.chat[0].swipes, ['A', 'B', 'New swipe']);
    assert.equal(calls.swipeOptions[0].forceSwipeId, 2);
    assert.deepEqual(calls.generateOptions[0], { suppressAutoContinue: true, suppressUserMessage: true, maxOutputTokens: DEFAULT_SETTINGS.maxTokens });
});

test('whole-block Retry restores no-output swipes and replaces rather than inherits old reasoning traces', async () => {
    const original = { mes: 'A', is_user: false, extra: { story_mode: { reasonings: [{ cut: 0, text: 'Old thought' }] } } };
    const { context } = use({ chat: [structuredClone(original)] });
    const swipe = context.swipe.to;
    context.swipe.to = async (_event, _direction, options) => {
        options.message.swipe_id = 1;
        options.message.mes = '...';
    };
    assert.equal(await api.retry(), false);
    assert.deepEqual(context.chat[0], original);
    context.swipe.to = swipe;
    context.onGenerate = async () => { context.chat[0].extra.reasoning = 'New thought'; };
    assert.equal(await api.retry(), true);
    assert.deepEqual(api.getMessageReasonings(context.chat[0]).map(reasoning => reasoning.text), ['New thought']);
});

test('persistent save failure keeps original text and a recoverable generated snapshot', async () => {
    const { context } = use({ chat: [{ mes: 'A', is_user: false }] });
    context.onGenerate = async () => { context.chat[0].mes += ' B'; };
    context.saveChat = async () => { throw new Error('offline'); };
    assert.equal(await api.continueStory({ direction: 'keep' }), false);
    assert.equal(context.chat[0].mes, 'A');
    assert.equal(api.canRedo(), true);
    assert.equal(await api.redo(), false);
    assert.equal(context.chat[0].mes, 'A');
    assert.equal(api.canRedo(), true);
    context.saveChat = async () => true;
    assert.equal(await api.redo(), true);
    assert.equal(context.chat[0].mes, 'A B');
});

test('malformed saved continuation snapshots cannot delete or truncate a block', async () => {
    const message = withCuts({ mes: 'A tail', is_user: false }, [1]);
    message.extra[EXTRA_KEY].continuations = [{ cut: 1, before: null }];
    const { context, calls } = use({ chat: [message] });
    const before = structuredClone(message);
    assert.equal(await api.undo(), false);
    assert.equal(await api.retry(), false);
    assert.deepEqual(context.chat[0], before);
    assert.equal(calls.saveChat, 0);
});

test('the exact host swipe state blocks destructive actions and selection rewrites', async () => {
    const { context, calls } = use({ chat: [withCuts({ mes: 'A tail', is_user: false }, [1])] });
    context.swipe.state = () => 'swiping';
    assert.equal(api.isBusy(), true);
    for (const action of [api.undo, api.redo, api.retry, api.continueStory]) assert.equal(await action(), false);
    assert.equal(await api.runTransform({ kind: 'rewrite', value: 'A', start: 0, end: 1 }), '');
    assert.equal(calls.saveChat, 0);
    assert.equal(calls.generate.length, 0);
    context.swipe.state = () => 'editing';
    assert.equal(api.isBusy(), false, 'the editor must still be closable by Story actions');
});

test('transform reservation blocks Story actions, accepts its own request, and late callbacks cannot unlock a newer request', async () => {
    const { context } = use({ chat: [{ mes: 'A' }] });
    const states = [];
    api.setHooks({ busyChanged: value => states.push(value) });
    const pending = [];
    context.generateRaw = () => new Promise(resolve => pending.push(resolve));
    const controller = new AbortController();
    api.setTransformBusy(true);
    assert.equal(await api.undo(), false);
    const first = api.runTransform({ kind: 'rewrite', value: 'A', start: 0, end: 1, signal: controller.signal });
    assert.equal(pending.length, 1);
    controller.abort();
    api.setTransformBusy(false);
    api.setTransformBusy(true);
    const second = api.runTransform({ kind: 'rewrite', value: 'B', start: 0, end: 1 });
    pending[0]('late');
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal(api.isBusy(), true);
    assert.equal(states.at(-1), true);
    pending[1]('replacement');
    assert.equal(await second, 'replacement');
    assert.equal(api.isBusy(), true, 'only the UI releases its pending reservation');
    api.setTransformBusy(false);
    assert.equal(api.isBusy(), false);
});

test('strict metadata failures restore the exact prior preference', async () => {
    const { context } = use({ chatMetadata: { [CHAT_KEY]: { enabled: false, other: 1 } } });
    const previous = context.chatMetadata[CHAT_KEY];
    context.saveMetadata = async options => { assert.equal(options.throwOnError, true); throw new Error('metadata refused'); };
    await assert.rejects(api.setChatFlag(true), /metadata refused/);
    assert.equal(context.chatMetadata[CHAT_KEY], previous);
    delete context.chatMetadata[CHAT_KEY];
    context.saveMetadata = async () => false;
    await assert.rejects(api.setChatFlag(true), /not saved/);
    assert.equal(Object.hasOwn(context.chatMetadata, CHAT_KEY), false);
});

test('card writes reject stale displayed and queued identities, and strict failures do not change local rules', async () => {
    const { context, calls } = use({ characters: [{ avatar: 'A.png', data: { extensions: {} } }, { avatar: 'B.png', data: { extensions: {} } }] });
    const original = api.currentCharacter();
    context.characterId = 1;
    await assert.rejects(api.setCardConfig({ instruction: 'draft A' }, original), /selected character changed/);
    assert.equal(calls.cardWrites.length, 0);
    context.characterId = 0;
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    context.writeExtensionField = async (id, key, value, options) => {
        assert.equal(options.throwOnError, true);
        calls.cardWrites.push([id, key, value]);
        started();
        await new Promise(resolve => { release = resolve; });
        context.characters[id].data.extensions[key] = value;
        return true;
    };
    const first = api.setCardConfig({ default: true }, original);
    const queued = api.setCardConfig({ instruction: 'queued draft A' }, original);
    const rejected = assert.rejects(queued, /selected character changed/);
    await ready;
    context.characterId = 1;
    release();
    await first;
    await rejected;
    assert.equal(calls.cardWrites.length, 1);
    assert.deepEqual(context.characters[1].data.extensions, {});
    context.writeExtensionField = async () => { throw new Error('card refused'); };
    await assert.rejects(api.setCardConfig({ instruction: 'draft B' }), /card refused/);
    assert.deepEqual(context.characters[1].data.extensions, {});
});

test('runtime agent predicates re-read settings and scope after queuing without any flag writes', () => {
    const { context } = use({ chat: [{ mes: 'A' }], chatMetadata: { [CHAT_KEY]: { enabled: true } }, extensionSettings: { [SETTINGS_KEY]: { agentGate: true, allowedAgents: [] } } });
    let predicate;
    const agents = [{ id: 'one', enabled: true, enabledChatIds: ['saved-scope'] }];
    const original = structuredClone(agents);
    const store = {
        getAgents: () => agents,
        setRuntimeAgentFilter(owner, fn) { assert.equal(owner, SETTINGS_KEY); predicate = fn; },
    };
    api.applyAgentGate(store);
    assert.equal(predicate(agents[0]), false);
    assert.deepEqual(api.listAgents(store).map(agent => [agent.enabled, agent.paused]), [[true, true]]);
    api.updateSettings({ allowedAgents: ['one'] });
    assert.equal(predicate(agents[0]), true);
    api.updateSettings({ allowedAgents: [] });
    context.chatMetadata = { [CHAT_KEY]: { enabled: false } };
    assert.equal(predicate(agents[0]), true);
    assert.deepEqual(agents, original);
    api.releaseAgentGate(store);
    assert.equal(predicate, null);
});

test('persisted cuts stay metadata-only and linear across many continuations and inactive swipe histories', async () => {
    const prose = 'MANUSCRIPT_TEXT_'.repeat(100);
    const unchanged = 'UNRELATED_EXTENSION_DATA_'.repeat(500);
    const { context } = use({ chat: [{
        mes: prose, is_user: false, swipe_id: 0,
        swipes: [prose, `${prose}alternative one`, `${prose}alternative two`],
        extra: { reasoning: 'Initial', reasoning_duration: 1000, unchanged },
        swipe_info: Array.from({ length: 3 }, () => ({ extra: { reasoning: 'Initial', reasoning_duration: 1000, unchanged } })),
    }] });
    for (let swipeId = 0; swipeId < 3; swipeId++) {
        let message = context.chat[0];
        message.swipe_id = swipeId;
        message.mes = message.swipes[swipeId];
        message.extra = structuredClone(message.swipe_info[swipeId].extra);
        const original = structuredClone(message);
        let halfSize;
        for (let i = 0; i < 30; i++) {
            context.onGenerate = async () => {
                message.mes += ` MANUSCRIPT_PASSAGE_${i} ${'prose '.repeat(40)}`;
                message.extra.reasoning += ` Thought ${i}`;
                message.extra.reasoning_duration = 2000 + i;
                message.gen_finished = 100 + i;
            };
            assert.equal(await api.continueStory(), true);
            if (i === 14) halfSize = JSON.stringify(message.extra[EXTRA_KEY].continuations).length;
        }
        const history = message.extra[EXTRA_KEY].continuations;
        const serialised = JSON.stringify(history);
        assert.equal(history.length, 30);
        assert.ok(serialised.length < halfSize * 2.2, 'doubling cuts must not quadruple metadata');
        assert.ok(!serialised.includes('MANUSCRIPT_'), 'no prefix, passage or inactive swipe prose is copied');
        assert.ok(!serialised.includes('UNRELATED_EXTENSION_DATA_'), 'unchanged extension data is not copied');
        const inspect = value => {
            if (!value || typeof value !== 'object') return;
            assert.equal(Array.isArray(value.continuations), false, 'no nested continuation arrays');
            for (const key of ['mes', 'swipes', 'swipe_info']) assert.equal(Object.hasOwn(value, key), false);
            for (const child of Object.values(value)) inspect(child);
        };
        history.forEach(inspect);
        // Exercise loaded JSON, not an in-memory pre-generation snapshot.
        const completed = JSON.parse(JSON.stringify(message));
        context.chat[0] = message = structuredClone(completed);
        api.clearRedo();
        for (let i = 0; i < 30; i++) assert.equal(await api.undo(), true);
        assert.deepEqual(message, original);
        for (let i = 0; i < 30; i++) assert.equal(await api.redo(), true);
        assert.deepEqual(message, completed);
    }
});

test('failed continuation save rolls back only owned values and Redo preserves concurrent metadata and messages', async () => {
    const { context } = use({ chat: [{
        mes: 'A', is_user: false, swipe_id: 0, swipes: ['A', 'Alternative'],
        extra: { reasoning: 'Before', reasoning_duration: 1000, other: { value: 1 } },
        swipe_info: [{ extra: { reasoning: 'Before' } }, { extra: { reasoning: 'Other' } }],
    }] });
    const message = context.chat[0];
    context.onGenerate = async () => {
        message.mes += ' B';
        message.extra.reasoning = 'After';
        message.extra.other.value = 2;
    };
    let saves = 0;
    context.saveChat = async () => {
        if (++saves === 1) {
            message.extra.note = 'written during save';
            message.extra.other.concurrent = true;
            message.swipes[1] = 'Edited alternative';
            message.swipe_info[1].extra.note = 'keep';
            context.chat.push({ mes: 'Unrelated next block', is_user: true });
            throw new Error('save refused');
        }
        return true;
    };
    assert.equal(await api.continueStory(), false);
    assert.equal(message.mes, 'A');
    assert.equal(message.extra.reasoning, 'Before');
    assert.deepEqual(message.extra.other, { value: 1, concurrent: true });
    assert.equal(message.extra.note, 'written during save');
    assert.equal(message.swipes[1], 'Edited alternative');
    assert.equal(message.swipe_info[1].extra.note, 'keep');
    api.clearRedoIfDiverged();
    assert.equal(api.canRedo(), true);
    assert.equal(await api.redo(), true);
    assert.equal(message.mes, 'A B');
    assert.equal(message.extra.reasoning, 'After');
    assert.deepEqual(message.extra.other, { value: 2, concurrent: true });
    assert.equal(message.extra.note, 'written during save');
    assert.equal(message.swipes[1], 'Edited alternative');
    assert.equal(context.chat[1].mes, 'Unrelated next block');
});

test('failed Undo preserves a concurrent edit outside the removed tail and keeps recovery usable', async () => {
    const { context } = use({ chat: [withCuts({ mes: 'A tail', is_user: false }, [1])] });
    const message = context.chat[0];
    let saves = 0;
    context.saveChat = async () => {
        if (++saves === 1) {
            message.extra.concurrent = 'keep';
            throw new Error('save refused');
        }
        return true;
    };
    assert.equal(await api.undo(), false);
    assert.equal(message.mes, 'A tail');
    assert.equal(message.extra.concurrent, 'keep');
    assert.equal(await api.redo(), true);
    assert.equal(message.extra.concurrent, 'keep');
    assert.deepEqual(getCuts(message), [1]);
});

test('failed whole-message Redo never removes a concurrently edited message', async () => {
    const { context } = use({ chat: [{ mes: 'A', is_user: true }, { mes: 'B', is_user: false }] });
    await api.undo();
    context.saveChat = async () => {
        context.chat[1].mes = 'B edited during save';
        throw new Error('save refused');
    };
    assert.equal(await api.redo(), false);
    assert.equal(context.chat[1].mes, 'B edited during save');
    api.clearRedoIfDiverged();
    context.saveChat = async () => true;
    assert.equal(await api.redo(), true);
    assert.equal(context.chat[1].mes, 'B edited during save');
});

test('failed-save recovery survives chat-change cleanup and a freshly loaded attempted save', async () => {
    const old = use({ chat: [withCuts({ mes: 'A tail', is_user: false }, [1])] });
    const next = makeContext({ chatId: 'other', chat: [{ mes: 'Other story' }] });
    let savedAttempt;
    old.context.saveChat = async () => {
        savedAttempt = structuredClone(old.context.chat);
        current = next.context;
        api.clearRedo();
        throw new Error('save response failed after changing chats');
    };
    assert.equal(await api.undo(), false);
    assert.equal(old.context.chat[0].mes, 'A tail');
    assert.equal(next.calls.saveChat, 0);
    assert.equal(next.context.chat[0].mes, 'Other story');
    const reloaded = makeContext({ chat: savedAttempt });
    current = reloaded.context;
    api.clearRedo();
    assert.equal(api.canRedo(), true);
    assert.equal(await api.redo(), true);
    assert.equal(reloaded.context.chat[0].mes, 'A tail');
    assert.equal(reloaded.calls.saveChat, 1);
});

test('rollback removes newly created generation metadata but retains a concurrent extension field', async () => {
    const { context } = use({ chat: [{ mes: 'A', is_user: false }] });
    const message = context.chat[0];
    context.onGenerate = async () => { message.mes += ' B'; message.extra.reasoning = 'New thought'; };
    let calls = 0;
    context.saveChat = async () => {
        if (++calls === 1) { message.extra.note = 'keep'; throw new Error('offline'); }
        return true;
    };
    assert.equal(await api.continueStory(), false);
    assert.deepEqual(message, { mes: 'A', is_user: false, extra: { note: 'keep' } });
    assert.equal(await api.redo(), true);
    assert.equal(message.mes, 'A B');
    assert.equal(message.extra.note, 'keep');
});

test('a concurrent text edit is never rolled back or overwritten by failed-save recovery', async () => {
    const { context } = use({ chat: [{ mes: 'A', is_user: false }] });
    context.onGenerate = async () => { context.chat[0].mes += ' B'; };
    let calls = 0;
    context.saveChat = async () => {
        if (++calls === 1) { context.chat[0].mes = 'User replacement'; throw new Error('offline'); }
        return true;
    };
    assert.equal(await api.continueStory(), false);
    assert.equal(context.chat[0].mes, 'User replacement');
    api.clearRedoIfDiverged();
    assert.equal(api.canRedo(), true, 'conflicting recovery is retained, not applied blindly');
    assert.equal(await api.redo(), false);
    assert.equal(context.chat[0].mes, 'User replacement');
});

test('successful recovery is removed even when chat-change cleanup replaces the pending stack', async () => {
    const old = use({ chat: [withCuts({ mes: 'A tail', is_user: false }, [1])] });
    old.context.saveChat = async () => { throw new Error('offline'); };
    assert.equal(await api.undo(), false);
    old.context.saveChat = async () => {
        current = makeContext({ chatId: 'other', chat: [{ mes: 'Other' }] }).context;
        api.clearRedo();
        return true;
    };
    assert.equal(await api.redo(), true);
    current = old.context;
    assert.equal(api.canRedo(), false);
});

test('corrupt compact metadata cannot replace prose or install nested history through a metadata field', async () => {
    const { context, calls } = use({ chat: [{ mes: 'A', is_user: false }] });
    context.onGenerate = async () => { context.chat[0].mes += ' B'; };
    await api.continueStory();
    const message = context.chat[0];
    message.extra[EXTRA_KEY].continuations[0].message.fields.push(['mes', 'Wrong text']);
    const original = structuredClone(message);
    const saves = calls.saveChat;
    assert.equal(await api.undo(), false);
    assert.deepEqual(message, original);
    assert.equal(calls.saveChat, saves);
});
