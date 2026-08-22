import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/api.js';
import { CARD_KEY, CHAT_KEY, EXTRA_KEY, PROMPT_DIRECTION_KEY, PROMPT_RULES_KEY, SETTINGS_KEY, getCuts, textRevision } from '../src/core.js';

function makeContext({ chat = [], chatId = 'chat-1', characterId = 0, characters = [{ name: 'Ann', data: { extensions: {} } }], groupId = null, chatMetadata = {}, extensionSettings = {} } = {}) {
    const calls = { generate: [], prompts: [], updates: [], saveChat: 0, saveChatOptions: [], deleteLast: 0, swipeRight: 0, refresh: 0, added: [], cardWrites: [], raw: null, quiet: null, saveMeta: 0 };
    const context = {
        chat, chatId, characterId, characters, groupId, chatMetadata, extensionSettings,
        onGenerate: null,
        rawResult: 'raw result',
        swipeAllowed: true,
        saveSettingsDebounced() {},
        async saveMetadata() { calls.saveMeta++; },
        setExtensionPrompt(...args) { calls.prompts.push(args); },
        async generate(type) { calls.generate.push(type); await context.onGenerate?.(type); },
        async updateMessageBlock(index, message) { calls.updates.push([index, message.mes]); },
        async saveChat(options) { calls.saveChat++; calls.saveChatOptions.push(options); },
        async deleteLastMessage() { calls.deleteLast++; chat.length = Math.max(0, chat.length - 1); },
        addOneMessage(message) { calls.added.push(message); },
        swipe: {
            isAllowed: () => context.swipeAllowed,
            async right() { calls.swipeRight++; },
            refresh() { calls.refresh++; },
        },
        async writeExtensionField(id, key, value) { calls.cardWrites.push([id, key, value]); characters[id].data.extensions[key] = value; },
        async generateRaw(args) { calls.raw = args; return context.rawResult; },
        async generateQuietPrompt(args) { calls.quiet = args; return 'quiet result'; },
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
    api.resetInflight();
    api.clearRedo();
    return made;
}

test('settings are normalised, written back and merged on update', () => {
    const { context } = use({ extensionSettings: { [SETTINGS_KEY]: { tint: false } } });
    assert.equal(api.getSettings().tint, false);
    assert.equal(context.extensionSettings[SETTINGS_KEY].rules.length > 10, true);
    api.updateSettings({ serif: true });
    assert.equal(context.extensionSettings[SETTINGS_KEY].serif, true);
    assert.equal(context.extensionSettings[SETTINGS_KEY].tint, false);
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
    assert.ok(text.includes('two to four paragraphs'));
    assert.deepEqual([position, depth, scan, role], [1, 1, false, 0]);
    context.characters[0].data.extensions[CARD_KEY] = { instruction: 'Card rules: {{length}}.' };
    api.setRules();
    [key, text] = calls.prompts.at(-1);
    assert.equal(text, 'Card rules: two to four paragraphs.');
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
    assert.deepEqual(calls.prompts.at(-1), [PROMPT_DIRECTION_KEY, '', 1, 0, false, 0]);
});

test('Story continuation pauses host Auto-continue and restores it afterwards', async () => {
    const { context } = use({ chat: [{ is_user: false, mes: 'Start', extra: {} }] });
    context.powerUserSettings = { auto_continue: { enabled: true } };
    context.onGenerate = async () => {
        assert.equal(context.powerUserSettings.auto_continue.enabled, false);
        context.chat[0].mes += ' once';
    };
    assert.equal(await api.continueStory(), true);
    assert.equal(context.powerUserSettings.auto_continue.enabled, true);
    assert.deepEqual(getCuts(context.chat[0]), [5]);
});

test('host generation state blocks Story actions and ignores nested quiet terminals', async () => {
    const { calls } = use({ chat: [{ is_user: false, mes: 'Start' }] });
    api.onGenerationStarted('normal');
    api.onGenerationStarted('quiet');
    api.onGenerationFinished();
    assert.equal(api.isBusy(), true);
    assert.equal(await api.continueStory(), false);
    assert.equal(calls.generate.length, 0);
    api.onGenerationFinished();
    assert.equal(api.isBusy(), false);
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
    assert.deepEqual(calls.saveChatOptions[0], { allowShrink: true });
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

test('an empty Retry keeps the removed tail available to Redo', async () => {
    const { context } = use({ chat: [withCuts({ is_user: false, mes: 'Start, old tail' }, [5])] });
    assert.equal(await api.retry(), true);
    assert.equal(context.chat[0].mes, 'Start');
    assert.equal(api.canRedo(), true);
    assert.equal(await api.redo(), true);
    assert.equal(context.chat[0].mes, 'Start, old tail');
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
    assert.equal(calls.quiet, null);
    api.updateSettings({ transformsUseFullContext: true });
    const viaQuiet = await api.runTransform({ kind: 'expand', value, start, end: start + 4, signal: null });
    assert.equal(viaQuiet, 'quiet result');
    assert.equal(calls.quiet.skipWIAN, true);
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
