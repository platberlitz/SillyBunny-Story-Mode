import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS, extractReasonings, formatDuration } from '../src/core.js';

const uiSource = readFileSync(new URL('../src/ui.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

// Only the DOM operations used by these UI tests. Layout and native modal behaviour need a browser.
class UIEvent {
    constructor(type, options = {}) { Object.assign(this, { type, bubbles: false, cancelable: false, defaultPrevented: false, eventPhase: 0, currentTarget: null }, options); }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
    stopPropagation() { this.stopped = true; }
    stopImmediatePropagation() { this.stopped = this.immediate = true; }
}

class UIElement {
    constructor(tag, document) {
        this.tagName = tag.toUpperCase();
        this.ownerDocument = document;
        this.children = [];
        this.attributes = new Map();
        this.dataset = {};
        this.listeners = new Map();
        this.value = '';
        this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } };
        this.classList = {
            contains: (name) => this.className.split(/\s+/u).includes(name),
            add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/u).filter(Boolean), ...names])].join(' '); },
            remove: (...names) => { this.className = this.className.split(/\s+/u).filter((name) => !names.includes(name)).join(' '); },
            toggle: (name, force = !this.classList.contains(name)) => { this.classList[force ? 'add' : 'remove'](name); return force; },
        };
    }
    get className() { return this.getAttribute('class') ?? ''; }
    set className(value) { this.setAttribute('class', value); }
    get id() { return this.getAttribute('id') ?? ''; }
    set id(value) { this.setAttribute('id', value); }
    get type() { return this.getAttribute('type') ?? ''; }
    set type(value) { this.setAttribute('type', value); }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(value) { this.toggleAttribute('hidden', value); }
    get open() { return this.hasAttribute('open'); }
    set open(value) { this.toggleAttribute('open', value); }
    get tabIndex() { return Number(this.getAttribute('tabindex') ?? (this.tagName === 'BUTTON' ? 0 : -1)); }
    set tabIndex(value) { this.setAttribute('tabindex', value); }
    get textContent() { return (this.text ?? '') + this.children.map((child) => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this.text = String(value); }
    get isConnected() { return this === this.ownerDocument || Boolean(this.parentElement?.isConnected); }
    get nextElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] ?? null; }
    get nextSibling() { return this.nextElementSibling; }
    get previousElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) - 1] ?? null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    toggleAttribute(name, force = !this.hasAttribute(name)) { if (force) this.setAttribute(name, ''); else this.removeAttribute(name); }
    append(...children) { for (const child of children) this.insertBefore(child, null); }
    appendChild(child) { this.append(child); return child; }
    prepend(child) { this.insertBefore(child, this.children[0]); }
    insertBefore(child, next) {
        child.remove();
        this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, child);
        child.parentElement = this;
        return child;
    }
    remove() {
        if (this.parentElement) {
            if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
            this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
            this.parentElement = null;
        }
    }
    removeChild(child) { child.remove(); }
    replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.text = ''; this.append(...children); }
    contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
    matches(selector) {
        return selector.split(',').some((part) => {
            const chain = part.trim().split(/\s+(?![^\[]*\])/u);
            const simple = chain.pop();
            let excluded = false;
            let rest = simple.replace(/:not\(([^()]*)\)/gu, (_match, inner) => { excluded ||= this.matches(inner); return ''; });
            if (excluded) return false;
            let attributesMatch = true;
            rest = rest.replace(/\[([\w-]+)(?:=["']([^"']*)["'])?\]/gu, (_match, key, value) => {
                attributesMatch &&= value === undefined ? this.hasAttribute(key) : this.getAttribute(key) === value;
                return '';
            });
            if (!attributesMatch) return false;
            const tag = rest.match(/^[\w-]+/u)?.[0];
            const id = rest.match(/#([\w-]+)/u)?.[1];
            const classes = [...rest.matchAll(/\.([\w-]+)/gu)].map((match) => match[1]);
            if ((tag && tag.toUpperCase() !== this.tagName) || (id && id !== this.id) || classes.some((name) => !this.classList.contains(name))) return false;
            return !chain.length || Boolean(this.parentElement?.closest(chain.join(' ')));
        });
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
    querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    addEventListener(type, listener, options = {}) {
        const entries = this.listeners.get(type) ?? [];
        entries.push({ listener, capture: options === true || options.capture === true, once: options.once, signal: options.signal });
        this.listeners.set(type, entries);
    }
    removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry.listener !== listener)); }
    dispatchEvent(event) {
        event.target = this;
        const path = [];
        for (let node = this; node; node = node.parentElement) path.push(node);
        const run = (node, capture) => {
            event.currentTarget = node;
            event.eventPhase = node === this ? 2 : capture ? 1 : 3;
            for (const entry of [...(node.listeners.get(event.type) ?? [])]) {
                if (event.immediate) break;
                if (entry.capture !== capture || entry.signal?.aborted) continue;
                if (entry.once) node.removeEventListener(event.type, entry.listener);
                entry.listener.call(node, event);
            }
        };
        for (const node of path.toReversed()) { run(node, true); if (event.stopped) break; }
        if (!event.stopped) {
            for (const node of path) { run(node, false); if (event.stopped || !event.bubbles) break; }
        }
        event.currentTarget = null;
        event.eventPhase = 0;
        return !event.defaultPrevented;
    }
    click() { if (!this.disabled) fire(this, 'click'); }
    focus() {
        if (this.disabled || !this.isConnected) return;
        const previous = this.ownerDocument.activeElement;
        this.ownerDocument.activeElement = this;
        if (previous !== this) { fire(previous, 'blur'); fire(previous, 'focusout'); }
    }
    setSelectionRange(start, end, direction = 'none') { Object.assign(this, { selectionStart: start, selectionEnd: end, selectionDirection: direction }); }
    setRangeText(text, start, end) { this.value = this.value.slice(0, start) + text + this.value.slice(end); this.setSelectionRange(start, start + text.length); }
    select() { this.setSelectionRange(0, this.value.length); }
    getBoundingClientRect() { return { height: this.height ?? 40, top: 0, left: 0, bottom: 400, right: 600 }; }
    scrollIntoView() { this.scrolls = (this.scrolls ?? 0) + 1; }
}

function fire(node, type, options = {}) {
    const event = new UIEvent(type, { bubbles: true, cancelable: true, ...options });
    node?.dispatchEvent(event);
    return event;
}

let instance = 0;
async function setup(t) {
    const globals = new Map();
    const setGlobal = (name, value) => {
        globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };
    const document = new UIElement('document');
    document.ownerDocument = document;
    document.createElement = (tag) => new UIElement(tag, document);
    document.getElementById = (id) => document.querySelector(`#${id}`);
    document.documentElement = document.createElement('html');
    document.body = document.createElement('body');
    document.append(document.documentElement);
    document.documentElement.append(document.body);
    document.activeElement = document.body;
    const make = (tag, id, parent = document.body, className = '') => {
        const node = document.createElement(tag);
        if (id) node.id = id;
        node.className = className;
        parent.append(node);
        return node;
    };
    const chat = make('div', 'chat');
    const form = make('form', 'send_form');
    const anchor = make('div', 'nonQRFormItems', form);
    const composer = make('textarea', 'send_textarea', anchor);
    make('div', 'send_but', anchor);
    make('div', 'option_continue');
    make('div', 'extensions_settings2');
    const frames = new Map(), timers = new Map(), resizes = [];
    let scheduled = 0;
    class Observer {
        constructor(callback) { this.callback = callback; resizes.push(this); }
        observe(target) { this.target = target; }
        disconnect() { this.disconnected = true; }
        trigger() { if (!this.disconnected) this.callback(); }
    }
    for (const [name, value] of Object.entries({
        document, Element: UIElement, HTMLElement: UIElement, Event: UIEvent, navigator: {},
        ResizeObserver: Observer, MutationObserver: Observer,
        requestAnimationFrame: (callback) => { frames.set(++scheduled, callback); return scheduled; },
        cancelAnimationFrame: (id) => frames.delete(id),
        setTimeout: (callback) => { timers.set(++scheduled, callback); return scheduled; },
        clearTimeout: (id) => timers.delete(id),
    })) setGlobal(name, value);

    // Mirror Popup's registration, Enter handler and native cancel path, not its visual implementation.
    class Popup {
        static util = { popups: [], isPopupOpen: () => Popup.util.popups.some((popup) => popup.dlg.open) };
        static closeDelay = null;
        static sendOnEnter = true;
        constructor(content, type, value) {
            this.type = type;
            this.dlg = document.createElement('dialog');
            this.dlg.className = 'popup';
            this.dlg.append(content);
            this.mainInput = make('textarea', '', this.dlg, 'popup-input result-control');
            this.mainInput.value = value;
            this.mainInput.hidden = type !== 3;
            this.mainInput.rows = 1;
            this.okButton = make('div', '', this.dlg, 'menu_button result-control');
            this.cancelButton = make('div', '', this.dlg, 'menu_button result-control');
            for (const [button, result] of [[this.okButton, 1], [this.cancelButton, 0]]) {
                button.setAttribute('data-result', result);
                button.addEventListener('click', () => this.complete(result));
            }
            this.closeButton = make('div', '', this.dlg);
            Popup.util.popups.push(this);
            this.dlg.addEventListener('keydown', (event) => {
                const focused = document.activeElement;
                if (event.key === 'Enter' && !event.altKey && !event.shiftKey
                    && focused.closest('.popup') === this.dlg && focused.closest('.result-control')
                    && (focused.tagName !== 'TEXTAREA' || (Popup.sendOnEnter && (event.ctrlKey || this.mainInput.rows <= 1)))) {
                    event.preventDefault();
                    event.stopPropagation();
                    this.complete(Number(focused.getAttribute('data-result') ?? 1));
                }
            });
            this.dlg.addEventListener('cancel', (event) => { event.preventDefault(); this.completeCancelled(); });
        }
        show() {
            document.body.append(this.dlg);
            this.dlg.open = true;
            (this.type === 3 ? this.mainInput : this.dlg.querySelector('[autofocus]')).focus();
            return new Promise((resolve) => { this.resolve = resolve; });
        }
        async complete(result) {
            const value = this.type === 3 ? (result === 1 ? this.mainInput.value : result === 0 ? false : null) : result;
            if (Popup.closeDelay) await Popup.closeDelay;
            this.dlg.open = false;
            this.dlg.remove();
            Popup.util.popups = Popup.util.popups.filter((popup) => popup !== this);
            this.resolve(value);
        }
        completeCancelled() { return this.complete(null); }
    }
    const characters = ['A', 'B'].map((name) => ({ name, avatar: `${name}.png`, data: { extensions: {} } }));
    const context = { chat: [{ mes: 'Original passage' }], chatId: 'chat-a', characterId: 0, groupId: null, characters, Popup, POPUP_TYPE: { INPUT: 3, DISPLAY: 4 }, powerUserSettings: { auto_save_msg_edits: false } };
    const settings = { ...DEFAULT_SETTINGS, allowedAgents: [] };
    const calls = { busy: [], transforms: [], writes: [], notices: [], edits: [], continued: 0, changed: 0 };
    const state = { busy: false, generating: false, agents: [], transform: async () => 'Replacement', write: async () => true };
    let ui, integration;
    let cardWrite = Promise.resolve();
    const api = {
        ctx: () => ({ ...context }),
        currentCharacter: () => context.groupId ? null : characters[context.characterId],
        getSettings: () => ({ ...settings }),
        updateSettings: (patch) => Object.assign(settings, patch),
        getCardConfig: () => api.currentCharacter()?.data.extensions.story_mode ?? { default: undefined, instruction: '' },
        hasChat: () => Boolean(context.chatId),
        isEnabled: () => api.hasChat() && (context.enabled ?? api.getCardConfig()?.default ?? settings.defaultOn),
        isBusy: () => state.busy || state.generating || document.body.dataset.generating === 'true' || form.classList.contains('sb-generating-controls'),
        setTransformBusy: (busy) => { state.busy = busy; calls.busy.push(busy); ui.setBusy(api.isBusy()); },
        runTransform: (args) => { calls.transforms.push(args); return state.transform(args); },
        setCardConfig: async (patch, character) => {
            calls.writes.push({ patch, character });
            const avatar = character.avatar;
            const write = cardWrite.catch(() => {}).then(async () => {
                if (character !== api.currentCharacter() || character.avatar !== avatar) throw new Error('The selected character changed. Your draft was not saved.');
                if (await state.write(patch, character) !== true) throw new Error('Character preference was not saved');
                // Strict host writes merge into the latest object for the captured avatar, even after a chat switch.
                const savedCharacter = characters.find((candidate) => candidate.avatar === avatar);
                savedCharacter.data.extensions.story_mode = { ...savedCharacter.data.extensions.story_mode, ...patch };
                return true;
            });
            cardWrite = write;
            return write;
        },
        listAgents: () => state.agents,
        applyAgentGate: () => { for (const agent of state.agents) agent.paused = Boolean(settings.agentGate && api.isEnabled() && !settings.allowedAgents.includes(agent.id)); },
        canUndo: () => true, canRedo: () => true,
        manuscript: () => ({ words: 12, text: 'Original passage', fileName: 'story.txt' }),
        noteEditOpened: (index) => calls.edits.push(index),
        getMessageReasonings: extractReasonings,
        toast: (kind, text) => calls.notices.push({ kind, text }),
        continueStory: async () => { calls.continued++; return true; },
        retry: async () => true, undo: async () => true, redo: async () => true,
    };
    setGlobal('__storyUiApi', api);
    const source = uiSource.replace("import * as api from './api.js';", 'const api = globalThis.__storyUiApi;')
        .replace("'./core.js'", JSON.stringify(new URL('../src/core.js', import.meta.url).href));
    ui = await import(`data:text/javascript;base64,${Buffer.from(`${source}\n//# sourceURL=sbstory-ui-test-${++instance}.js`).toString('base64')}`);
    t.after(async () => {
        await integration?.disable();
        ui.unmountAll();
        for (const [name, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    });
    const passage = (index = 0) => {
        context.chat[index] ??= { mes: `Passage ${index + 1}` };
        const mes = make('div', '', chat, 'mes');
        mes.setAttribute('mesid', index);
        const buttons = make('div', '', mes, 'mes_buttons');
        const edit = make('div', '', buttons, 'mes_button mes_edit');
        edit.tabIndex = 0; // The host's keyboard.js registers every .mes_button.
        const done = make('div', '', mes, 'mes_edit_done menu_button');
        const text = make('div', '', mes, 'mes_text');
        const textarea = make('textarea', 'curEditTextarea', text);
        textarea.value = context.chat[index].mes;
        textarea.setSelectionRange(0, 8, 'backward');
        return { mes, edit, done, textarea, text };
    };
    const press = (node, key, options) => {
        const event = fire(node, 'keydown', { key, ...options });
        if (!event.defaultPrevented) {
            if (key === 'Escape') fire(Popup.util.popups.at(-1)?.dlg, 'cancel');
            if ((key === 'Enter' || key === ' ') && node.tagName === 'BUTTON') node.click();
        }
        return event;
    };
    ui.mountBar();
    ui.mountTransformRow();
    document.body.classList.add('sbstory');
    ui.bindClickToEdit();
    ui.bindEscapeSave();
    const row = ui.mountTransformRow();
    const mountDrawer = () => ui.ensureDrawer({ onChange: () => {
        calls.changed++;
        calls.rules = api.getCardConfig()?.instruction || settings.rules;
        api.applyAgentGate();
        ui.applyState(api.isEnabled());
        ui.renderDrawer();
    }, onChatToggle: (enabled) => { context.enabled = enabled; return true; } });
    const mountIntegration = async () => {
        ui.unmountAll();
        const events = new Map();
        Object.assign(context, {
            extensionSettings: {}, generationSupportsRequestControls: true,
            saveSettingsDebounced() {}, saveMetadata() {}, generate() {}, generateRaw() {}, generateQuietPrompt() {},
            setExtensionPrompt() {}, updateMessageBlock() {}, deleteLastMessage() {}, addOneMessage() {}, saveChat() {},
            writeExtensionField() {}, messageFormatting() {}, swipe: { to() {} },
            eventTypes: Object.fromEntries(['APP_READY', 'CHAT_CHANGED', 'MESSAGE_SENT', 'MESSAGE_EDITED', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED'].map((name) => [name, name])),
            eventSource: {
                on(type, handler) {
                    const handlers = events.get(type) ?? new Set();
                    handlers.add(handler);
                    events.set(type, handlers);
                    if (type === 'APP_READY') handler(); // The real host replays this to late subscribers.
                },
                removeListener: (type, handler) => events.get(type)?.delete(handler),
                emit: async (type, ...args) => { for (const handler of events.get(type) ?? []) await handler(...args); },
            },
        });
        let hooks;
        Object.assign(api, {
            setHooks: (next) => { hooks = next; },
            refreshBusy: () => hooks?.busyChanged?.(api.isBusy()),
            setRules: () => { calls.rules = api.getCardConfig()?.instruction || settings.rules; },
            clearRules: () => { calls.rules = ''; },
            clearDirection() {}, clearRedo() {}, releaseAgentGate() {},
            isInflight: () => false,
            registerCommands: ({ onToggle }) => { calls.command = onToggle; },
            loadAgentStore: async () => null,
            setChatFlag: async (enabled) => { context.enabled = enabled; return true; },
        });
        setGlobal('SillyTavern', { getContext: api.ctx });
        setGlobal('__storyUiModule', ui);
        const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
            .replace("import * as api from './src/api.js';", 'const api = globalThis.__storyUiApi;')
            .replace("import * as ui from './src/ui.js';", 'const ui = globalThis.__storyUiModule;')
            .replace("'./src/core.js'", JSON.stringify(new URL('../src/core.js', import.meta.url).href));
        integration = await import(`data:text/javascript;base64,${Buffer.from(`${source}\n//# sourceURL=sbstory-index-test-${++instance}.js`).toString('base64')}`);
        integration.activate();
        return integration;
    };
    return { ui, api, context, settings, characters, state, calls, document, make, passage, press, row, timers, frames, resizes, composer, Popup, mountDrawer, mountIntegration };
}

test('Custom isolates Escape, Cancel and empty submission without losing an unsaved host edit', async (t) => {
    const h = await setup(t);
    const { textarea } = h.passage();
    textarea.value = 'Unsaved original passage';
    textarea.focus();
    h.ui.refreshTransformRow();
    let discarded = 0;
    h.document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { discarded++; textarea.remove(); } });
    for (const end of ['escape', 'cancel', 'empty']) {
        h.row.querySelectorAll('.sbstory-tbtn')[3].click();
        const popup = h.Popup.util.popups.at(-1);
        assert.equal(h.api.isBusy(), true);
        assert.equal(h.document.getElementById('sbstory-bar').getAttribute('aria-busy'), 'true');
        assert.equal(h.document.getElementById('sbstory-continue').disabled, true);
        assert.equal(h.row.querySelector('.sbstory-stop').hidden, false);
        assert.equal(popup.dlg.getAttribute('aria-labelledby'), 'sbstory-custom-title');
        if (end === 'escape') assert.equal(h.press(popup.mainInput, 'Escape').defaultPrevented, false);
        if (end === 'cancel') popup.complete(0);
        if (end === 'empty') { popup.mainInput.value = ' '; h.press(popup.mainInput, 'Enter'); }
        await tick();
        assert.equal(discarded, 0);
        assert.equal(h.document.getElementById('curEditTextarea'), textarea);
        assert.equal(textarea.value, 'Unsaved original passage');
        assert.deepEqual([textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection], [0, 8, 'backward']);
        assert.equal(h.document.activeElement, textarea);
        assert.equal(h.api.isBusy(), false);
    }
    assert.equal(h.calls.transforms.length, 0);
});

test('Custom retains native key defaults and the host result controls across event phases', async (t) => {
    const h = await setup(t);
    const { textarea } = h.passage();
    textarea.focus();
    h.ui.refreshTransformRow();
    h.row.querySelectorAll('.sbstory-tbtn')[3].click();
    const popup = h.Popup.util.popups[0];
    let background = 0;
    const phases = [];
    h.document.addEventListener('keydown', (event) => phases.push(event.eventPhase), true);
    popup.dlg.addEventListener('keydown', (event) => phases.push(event.eventPhase), true);
    popup.mainInput.addEventListener('keydown', (event) => phases.push(event.eventPhase));
    popup.dlg.addEventListener('keydown', (event) => phases.push(event.eventPhase));
    h.document.addEventListener('keydown', () => background++);
    const arrow = h.press(popup.mainInput, 'ArrowLeft');
    assert.deepEqual(phases, [1, 1, 2, 3]);
    assert.equal(arrow.defaultPrevented, false, 'caret movement must retain its native default');
    assert.equal(arrow.eventPhase, 0, 'dispatch resets the event phase');
    for (const options of [{ altKey: true }, { shiftKey: true }]) {
        assert.equal(h.press(popup.mainInput, 'Enter', options).defaultPrevented, false);
        assert.equal(popup.dlg.open, true);
    }
    h.Popup.sendOnEnter = false;
    assert.equal(h.press(popup.mainInput, 'Enter').defaultPrevented, false);
    popup.cancelButton.focus();
    assert.equal(h.press(popup.cancelButton, 'Enter').defaultPrevented, true);
    await tick();
    assert.equal(background, 0);
    assert.equal(h.calls.transforms.length, 0);
    assert.equal(h.document.activeElement, textarea);
    assert.equal(h.api.isBusy(), false);
});

test('native Escape leaves the Custom request reserved until the host close animation completes', async (t) => {
    const h = await setup(t);
    const { textarea } = h.passage();
    textarea.focus();
    h.ui.refreshTransformRow();
    h.row.querySelectorAll('.sbstory-tbtn')[3].click();
    const popup = h.Popup.util.popups[0];
    const closing = deferred();
    h.Popup.closeDelay = closing.promise;
    assert.equal(h.press(popup.mainInput, 'Escape').defaultPrevented, false);
    assert.equal(h.api.isBusy(), true);
    assert.equal(popup.dlg.open, true);
    closing.resolve();
    await tick();
    assert.equal(h.api.isBusy(), false);
    assert.equal(h.document.activeElement, textarea);
    assert.equal(h.calls.transforms.length, 0);
});

test('Custom rechecks selection, editor and chat identity after the dialog', async (t) => {
    for (const change of ['selection', 'text', 'editor', 'chat', 'character']) {
        await t.test(change, async (t) => {
            const h = await setup(t);
            const { textarea } = h.passage();
            h.ui.refreshTransformRow();
            h.row.querySelectorAll('.sbstory-tbtn')[3].click();
            const popup = h.Popup.util.popups.at(-1);
            if (change === 'selection') textarea.setSelectionRange(2, 8);
            if (change === 'text') textarea.value = 'Changed text';
            if (change === 'editor') { textarea.remove(); h.passage(1); }
            if (change === 'chat') h.context.chatId = 'chat-b';
            if (change === 'character') h.context.characterId = 1;
            popup.mainInput.value = 'Make it shorter';
            popup.complete(1);
            await tick();
            assert.equal(h.calls.transforms.length, 0);
            assert.equal(h.api.isBusy(), false);
        });
    }
});

test('Custom instructions survive Stop and late failures cannot unlock a newer rewrite', async (t) => {
    const h = await setup(t);
    const { textarea } = h.passage();
    h.ui.refreshTransformRow();
    const old = deferred(), next = deferred();
    h.state.transform = () => old.promise;
    const custom = h.row.querySelectorAll('.sbstory-tbtn')[3];
    custom.click();
    h.Popup.util.popups.at(-1).mainInput.value = 'Keep my instruction';
    h.Popup.util.popups.at(-1).complete(1);
    await tick();
    h.row.querySelector('.sbstory-stop').click();
    assert.equal(h.calls.transforms[0].signal.aborted, true);
    assert.equal(h.api.isBusy(), false);
    h.state.transform = () => next.promise;
    custom.click();
    const retry = h.Popup.util.popups.at(-1);
    assert.equal(retry.mainInput.value, 'Keep my instruction');
    retry.complete(1);
    await tick();
    const status = h.row.querySelector('.sbstory-tstatus');
    assert.equal(status.textContent, 'Working...');
    old.reject(new Error('Late failure'));
    await tick();
    assert.equal(status.textContent, 'Working...');
    assert.equal(h.api.isBusy(), true);
    assert.deepEqual(h.calls.busy, [true, false, true]);
    next.resolve('New text');
    await tick();
    assert.equal(textarea.value, 'New text passage');
    assert.equal(h.api.isBusy(), false);
    assert.match(status.textContent, /^Replaced\./u);
});

test('failed Custom requests retain their instruction and a collapsed selection still gets a result announcement', async (t) => {
    t.mock.method(console, 'error', () => {});
    const h = await setup(t);
    const { textarea } = h.passage();
    h.ui.applyState(true);
    h.state.transform = async () => { throw new Error('Offline'); };
    const custom = h.row.querySelectorAll('.sbstory-tbtn')[3];
    custom.click();
    h.Popup.util.popups.at(-1).mainInput.value = 'Keep the voice';
    h.Popup.util.popups.at(-1).complete(1);
    await tick();
    assert.equal(textarea.value, 'Original passage');
    assert.match(h.document.querySelector('.sbstory-status').textContent, /Rewrite failed/u);
    custom.click();
    assert.equal(h.Popup.util.popups.at(-1).mainInput.value, 'Keep the voice');
    h.Popup.util.popups.at(-1).completeCancelled();
    await tick();
    const pending = deferred();
    h.state.transform = () => pending.promise;
    h.row.querySelector('.sbstory-tbtn').click();
    textarea.setSelectionRange(2, 2);
    pending.resolve('Unused replacement');
    await tick();
    assert.equal(h.row.hidden, true);
    assert.match(h.document.querySelector('.sbstory-status').textContent, /nothing was replaced/u);
});

test('host controls cancel before committing and host hotkeys cannot conflict with a pending rewrite', async (t) => {
    const h = await setup(t);
    const { textarea, done } = h.passage();
    const pending = deferred();
    h.state.transform = () => pending.promise;
    h.ui.refreshTransformRow();
    h.row.querySelector('.sbstory-tbtn').click();
    let hostActions = 0;
    h.document.addEventListener('keydown', () => hostActions++);
    h.document.getElementById('option_continue').addEventListener('click', () => hostActions++);
    h.press(textarea, 'Enter', { ctrlKey: true });
    h.press(h.composer, 'Enter', { altKey: true });
    h.document.getElementById('option_continue').click();
    assert.equal(hostActions, 0);
    done.addEventListener('click', () => {
        assert.equal(h.api.isBusy(), false);
        assert.equal(h.calls.transforms[0].signal.aborted, true);
        textarea.remove();
    });
    done.click();
    pending.resolve('Too late');
    await tick();
    assert.equal(textarea.value, 'Original passage');
});

test('main generation disables the visible rewrite row and mode changes cancel requests', async (t) => {
    const h = await setup(t);
    const { textarea } = h.passage();
    h.ui.refreshTransformRow();
    h.state.generating = true;
    h.ui.setBusy(true);
    assert.ok(h.row.querySelectorAll('.sbstory-tbtn:not(.sbstory-stop)').every((button) => button.disabled));
    assert.equal(h.row.querySelector('.sbstory-stop').hidden, true);
    h.state.generating = false;
    h.ui.setBusy(false);
    const pending = deferred();
    h.state.transform = () => pending.promise;
    h.row.querySelector('.sbstory-tbtn').click();
    h.ui.applyState(false);
    assert.equal(h.calls.transforms[0].signal.aborted, true);
    pending.resolve('Too late');
    await tick();
    assert.equal(textarea.value, 'Original passage');
    assert.equal(h.api.isBusy(), false);
});

test('reasoning uses a labelled host popup, isolates keys and restores focus with one native activation', async (t) => {
    const h = await setup(t);
    const { mes, textarea } = h.passage();
    const message = { mes: 'Text', extra: { reasoning: 'Thought', reasoning_duration: 6000 } };
    h.context.chat[0] = message;
    h.ui.updateThinkingButton(mes, message);
    const brain = mes.querySelector('.sbstory-thinking-btn');
    assert.equal(brain.tagName, 'BUTTON');
    assert.equal(brain.type, 'button');
    assert.equal(brain.getAttribute('aria-label'), `View reasoning trace (${formatDuration(6000)})`);
    let clicks = 0, backgroundKeys = 0;
    brain.addEventListener('click', () => clicks++);
    h.document.addEventListener('keydown', (event) => {
        backgroundKeys++;
        if (event.key === 'Enter' && !event.ctrlKey && !event.altKey) event.target.closest('.mes_button, .menu_button')?.click();
        if (event.key === 'Escape') textarea.remove();
    });
    brain.focus();
    h.press(brain, 'Enter');
    assert.equal(clicks, 1);
    assert.equal(h.Popup.util.isPopupOpen(), true);
    const popup = h.Popup.util.popups[0];
    assert.equal(popup.dlg.getAttribute('aria-labelledby'), 'sbstory-thinking-title');
    const body = popup.dlg.querySelector('.sbstory-dialog-body');
    body.focus();
    h.press(body, 'Enter', { altKey: true });
    h.press(body, 'Enter', { ctrlKey: true });
    h.press(body, 'ArrowLeft');
    h.press(body, 'ArrowRight');
    assert.equal(backgroundKeys, 0);
    assert.equal(h.press(body, 'Escape').defaultPrevented, false);
    await tick();
    assert.equal(h.Popup.util.isPopupOpen(), false);
    assert.equal(h.document.activeElement, brain);
    assert.equal(textarea.isConnected, true);
});

test('reasoning copy uses the host fallback and checks its otherwise discarded result', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const h = await setup(t);
    let copySucceeded = false, copied = 0;
    const execCommand = (command) => { assert.equal(command, 'copy'); return copySucceeded; };
    h.document.execCommand = execCommand;
    h.context.copyText = (text) => {
        copied++;
        assert.equal(text, 'Thought');
        const temp = h.make('textarea', '', h.Popup.util.popups[0].dlg);
        temp.value = text;
        temp.focus();
        h.document.execCommand('copy');
        temp.remove();
    };
    const opening = h.ui.openThinkingDialog({ extra: { reasoning: 'Thought' } });
    const popup = h.Popup.util.popups[0];
    const button = popup.dlg.querySelector('.sbstory-dialog-btn.fa-copy');
    button.focus();
    button.click();
    await tick();
    assert.equal(h.calls.notices.at(-1).kind, 'error');
    assert.equal(h.document.execCommand, execCommand);
    assert.equal(h.document.activeElement, button);
    copySucceeded = true;
    button.click();
    await tick();
    assert.equal(h.calls.notices.at(-1).kind, 'success');
    assert.equal(copied, 2);
    assert.equal(h.document.execCommand, execCommand);
    globalThis.navigator.clipboard = { writeText: async () => { throw new Error('Clipboard permission denied'); } };
    h.context.copyText = (text) => navigator.clipboard.writeText(text);
    button.click();
    await tick();
    assert.equal(h.calls.notices.at(-1).kind, 'error');
    globalThis.navigator.clipboard.writeText = async () => {};
    button.click();
    await tick();
    assert.equal(h.calls.notices.at(-1).kind, 'success');
    assert.equal(h.document.execCommand, execCommand);
    popup.completeCancelled();
    await opening;
});

test('settings retain a focused draft, await its save and immediately refresh dependent labels', async (t) => {
    const h = await setup(t);
    h.mountDrawer();
    const instruction = h.document.getElementById('sbstory-opt-card-rules');
    instruction.focus();
    instruction.value = 'My new rules';
    instruction.setSelectionRange(3, 6);
    fire(instruction, 'input');
    h.ui.renderDrawer();
    assert.equal(h.document.getElementById(instruction.id), instruction);
    assert.deepEqual([instruction.selectionStart, instruction.selectionEnd], [3, 6]);
    const save = deferred();
    h.state.write = () => save.promise;
    fire(instruction, 'change');
    h.composer.focus();
    await tick();
    assert.equal(h.document.getElementById(instruction.id), instruction, 'blur must not rebuild before the save finishes');
    assert.equal(h.calls.writes[0].character, h.characters[0]);
    instruction.focus();
    save.resolve(true);
    await tick();
    assert.equal(h.document.getElementById(instruction.id), instruction);
    assert.equal(instruction.value, 'My new rules');
    assert.match(h.document.querySelector('label[for="sbstory-opt-rules"]').textContent, /not used/u);
    assert.deepEqual([instruction.selectionStart, instruction.selectionEnd], [3, 6]);
    for (const input of h.document.querySelectorAll('.sbstory-field textarea, .sbstory-field input, .sbstory-field select')) {
        for (const id of input.getAttribute('aria-describedby').split(' ')) assert.ok(h.document.getElementById(id));
    }
});

test('failed rules stay unsaved and can be saved again without retyping', async (t) => {
    t.mock.method(console, 'error', () => {});
    const h = await setup(t);
    h.mountDrawer();
    const input = h.document.getElementById('sbstory-opt-card-rules');
    input.value = 'Keep this draft';
    fire(input, 'input');
    h.state.write = async () => { throw new Error('Save rejected'); };
    fire(input, 'change');
    await tick();
    const retained = h.document.getElementById(input.id);
    assert.equal(retained.value, 'Keep this draft');
    assert.equal(retained.getAttribute('aria-invalid'), 'true');
    assert.match(h.document.getElementById('sbstory-card-rules-status').textContent, /Not saved/u);
    const retry = h.document.getElementById('sbstory-save-card-rules');
    assert.equal(retry.hidden, false);
    h.state.write = async () => true;
    retry.click();
    await tick();
    assert.equal(h.characters[0].data.extensions.story_mode.instruction, 'Keep this draft');
    assert.equal(h.document.getElementById('sbstory-save-card-rules').hidden, true);
});

test('stale card fields pass their displayed character and never overwrite the newly selected card', async (t) => {
    t.mock.method(console, 'error', () => {});
    const h = await setup(t);
    h.mountDrawer();
    const oldRules = h.document.getElementById('sbstory-opt-card-rules');
    const oldDefault = h.document.getElementById('sbstory-opt-card-default');
    oldRules.focus();
    oldRules.value = 'Rules for A';
    fire(oldRules, 'input');
    h.context.characterId = 1;
    h.ui.renderDrawer();
    assert.notEqual(h.document.getElementById(oldRules.id), oldRules);
    fire(oldRules, 'change');
    oldDefault.value = 'true';
    fire(oldDefault, 'change');
    await tick();
    assert.ok(h.calls.writes.every((write) => write.character === h.characters[0]));
    assert.deepEqual(h.characters[1].data.extensions, {});
    assert.equal(h.document.getElementById(oldRules.id).value, '');
    h.context.characterId = 0;
    h.ui.renderDrawer();
    assert.equal(h.document.getElementById(oldRules.id).value, 'Rules for A');
    assert.match(h.document.getElementById('sbstory-card-rules-status').textContent, /Not saved/u);
});

test('an in-flight card save cannot reset a newer card field or lose the original draft', async (t) => {
    t.mock.method(console, 'error', () => {});
    const h = await setup(t);
    h.mountDrawer();
    const input = h.document.getElementById('sbstory-opt-card-rules');
    input.focus();
    input.value = 'Waiting rules for A';
    fire(input, 'input');
    const saving = deferred();
    h.state.write = () => saving.promise;
    fire(input, 'change');
    await tick();
    h.context.characterId = 1;
    h.ui.renderDrawer();
    const next = h.document.getElementById(input.id);
    next.focus();
    next.value = 'Unsaved rules for B';
    next.setSelectionRange(4, 7);
    fire(next, 'input');
    saving.resolve(false);
    await tick();
    assert.equal(h.document.getElementById(input.id), next);
    assert.equal(h.document.activeElement, next);
    assert.equal(next.value, 'Unsaved rules for B');
    assert.deepEqual([next.selectionStart, next.selectionEnd], [4, 7]);
    assert.deepEqual(h.characters[1].data.extensions, {});
    h.context.characterId = 0;
    h.ui.renderDrawer();
    assert.equal(h.document.getElementById(input.id).value, 'Waiting rules for A');
});

test('a completed card save applies settings when the host refreshed the same card object', async (t) => {
    for (const kind of ['rules', 'default']) {
        await t.test(kind, async (t) => {
            const h = await setup(t);
            h.mountDrawer();
            const saving = deferred();
            h.state.write = () => saving.promise;
            const input = h.document.getElementById(`sbstory-opt-card-${kind}`);
            input.value = kind === 'rules' ? 'Saved rules for the refreshed card' : 'true';
            if (kind === 'rules') fire(input, 'input');
            fire(input, 'change');
            await tick();
            h.characters[0] = structuredClone(h.characters[0]);
            saving.resolve(true);
            await tick();
            assert.equal(h.calls.changed, 1, 'acknowledged saves must reapply the active card, not only rebuild the drawer');
            if (kind === 'rules') assert.equal(h.calls.rules, input.value);
            else assert.equal(h.document.body.classList.contains('sbstory'), true);
            assert.equal(h.calls.writes.length, 1, 'onChange/renderDrawer must not start another save');
        });
    }
});

test('an acknowledged save to a departed card does not apply its rules to the new card', async (t) => {
    const h = await setup(t);
    h.mountDrawer();
    const input = h.document.getElementById('sbstory-opt-card-rules');
    input.value = 'Rules saved only to A';
    fire(input, 'input');
    const saving = deferred();
    h.state.write = () => saving.promise;
    fire(input, 'change');
    await tick();
    h.context.characterId = 1;
    h.ui.renderDrawer();
    saving.resolve(true);
    await tick();
    assert.equal(h.characters[0].data.extensions.story_mode.instruction, input.value);
    assert.deepEqual(h.characters[1].data.extensions, {});
    assert.equal(h.calls.changed, 0);
    assert.equal(h.document.getElementById(input.id).value, '');
});

test('card defaults support inheritance and agent labels distinguish runtime pause from stored preference', async (t) => {
    const h = await setup(t);
    h.state.agents = [{ id: 'one', name: 'One', enabled: true, paused: true }, { id: 'two', name: 'Two', enabled: false, paused: false }];
    h.mountDrawer();
    const select = h.document.getElementById('sbstory-opt-card-default');
    assert.equal(select.tagName, 'SELECT');
    assert.deepEqual(select.children.map((option) => option.getAttribute('value')), ['', 'true', 'false']);
    assert.match(h.document.getElementById('sbstory-opt-agent-one').closest('label').textContent, /paused by Story Mode/u);
    assert.match(h.document.getElementById('sbstory-opt-agent-two').closest('label').textContent, /switched off in Agents/u);
    select.value = 'true';
    fire(select, 'change');
    await tick();
    assert.equal(h.document.getElementById('sbstory-opt-chat').checked, true);
    const inherit = h.document.getElementById(select.id);
    inherit.value = '';
    fire(inherit, 'change');
    await tick();
    assert.equal(h.calls.writes.at(-1).patch.default, undefined);
    assert.equal(h.document.getElementById('sbstory-opt-chat').checked, false);
    const rules = h.document.getElementById('sbstory-opt-rules');
    rules.focus();
    h.state.agents[0].paused = false;
    h.ui.renderDrawer();
    assert.equal(h.document.getElementById('sbstory-opt-agent-one').closest('label').textContent, 'One');
    assert.equal(h.document.activeElement, rules);
});

test('keyboard edit entry, Escape focus return, idle buttons and delayed scroll keep host caret intent', async (t) => {
    const h = await setup(t);
    const { textarea, edit, done } = h.passage(2);
    h.ui.stampBlocks();
    assert.equal(edit.tabIndex, 0);
    let opened = 0;
    edit.addEventListener('click', () => opened++);
    h.press(edit, ' ');
    assert.equal(opened, 1);
    h.ui.checkEditor();
    const delayed = [...h.timers.values()][0];
    assert.equal(textarea.getAttribute('aria-label'), 'Edit passage 3');
    textarea.focus();
    textarea.setSelectionRange(3, 3);
    h.ui.checkEditor();
    assert.equal(textarea.selectionStart, 3);
    done.addEventListener('click', () => { textarea.remove(); h.ui.checkEditor(); });
    h.press(textarea, 'Escape');
    assert.equal(h.document.activeElement, edit);
    const other = h.passage(0).textarea;
    h.context.chatId = 'another-chat';
    delayed();
    assert.equal(other.scrolls, undefined);
    const button = h.document.getElementById('sbstory-export');
    button.focus();
    let arrows = 0;
    h.document.addEventListener('keydown', () => arrows++);
    h.press(button, 'ArrowRight');
    assert.equal(arrows, 0);
    other.focus();
    h.press(other, 'ArrowRight');
    assert.equal(arrows, 1);
});

test('first activation teaches editing and rewrites; the row reserves its measured wrapped height', async (t) => {
    const h = await setup(t);
    const { textarea } = h.passage();
    h.ui.applyState(true);
    h.ui.applyState(true);
    assert.equal(h.calls.notices.length, 1);
    assert.match(h.calls.notices[0].text, /Select text to rewrite.*Escape saves/u);
    h.row.height = 132;
    h.resizes.find((observer) => observer.target === h.row).trigger();
    assert.equal(h.document.body.style['--sbstory-row-slot'], '152px');
    textarea.setSelectionRange(0, 0);
    h.ui.refreshTransformRow();
    assert.equal(h.document.body.style['--sbstory-row-slot'], undefined);
    const details = h.make('details', '', h.document.getElementById('chat'), 'mes_reasoning_details');
    const reasoning = h.make('textarea', '', details, 'reasoning_edit_textarea');
    h.ui.checkEditor();
    assert.equal(details.open, true);
    assert.equal(reasoning.getAttribute('aria-label'), 'Edit reasoning');
});

test('first-use help respects saved acknowledgement and still works when account storage throws', async (t) => {
    for (const acknowledged of [true, false]) {
        await t.test(String(acknowledged), async (t) => {
            const h = await setup(t);
            h.context.accountStorage = { getItem() { if (acknowledged) return '1'; throw new Error('Storage unavailable'); } };
            h.ui.applyState(true);
            h.ui.applyState(false);
            h.ui.applyState(true);
            assert.equal(h.calls.notices.length, acknowledged ? 0 : 1);
            const count = h.document.getElementById('sbstory-words');
            assert.equal(count.textContent, '12 words');
            assert.equal(count.hasAttribute('aria-live'), false);
        });
    }
});

test('real index activation, delayed onChange and per-chat disable respect host busy markers', async (t) => {
    const h = await setup(t);
    h.context.enabled = true;
    const { textarea } = h.passage();
    h.document.body.dataset.generating = 'true';
    const integration = await h.mountIntegration();
    const bar = h.document.getElementById('sbstory-bar');
    const row = h.document.getElementById('sbstory-transforms');
    assert.equal(bar.hidden, false);
    assert.equal(bar.getAttribute('aria-busy'), 'true');
    assert.equal(h.document.getElementById('sbstory-continue').disabled, true);
    integration.enable();
    assert.equal(h.document.querySelectorAll('#sbstory-bar').length, 1);
    assert.equal(h.calls.notices.length, 1);

    const rules = h.document.getElementById('sbstory-opt-card-rules');
    rules.focus();
    rules.value = 'Rules from a delayed save';
    fire(rules, 'input');
    const saving = deferred();
    h.state.write = () => saving.promise;
    fire(rules, 'change');
    h.composer.focus();
    await tick();
    assert.equal(h.document.getElementById(rules.id), rules);
    saving.resolve(true);
    await tick();
    assert.equal(h.calls.rules, rules.value, 'index onChange must apply prompt rules as well as render the drawer');
    assert.equal(h.calls.writes.length, 1);
    assert.equal(h.document.getElementById(rules.id).value, rules.value);

    delete h.document.body.dataset.generating;
    h.api.refreshBusy();
    textarea.focus();
    h.ui.refreshTransformRow();
    row.querySelectorAll('.sbstory-tbtn')[3].click();
    const popup = h.Popup.util.popups[0];
    h.document.getElementById('send_form').classList.add('sb-generating-controls');
    await h.calls.command('off');
    await tick();
    assert.equal(popup.dlg.isConnected, false);
    assert.equal(h.state.busy, false, 'mode-off releases the rewrite reservation');
    assert.equal(h.api.isBusy(), true, 'host generation must remain busy');
    assert.equal(bar.hidden, true);
    assert.equal(row.hidden, true);
    assert.equal(h.document.body.classList.contains('sbstory'), false);
    assert.equal(h.calls.rules, '');
    assert.equal(h.timers.size, 0, 'mode-off cancels the delayed editor reveal');
    await integration.disable();
    assert.equal(h.document.getElementById('sbstory-bar'), null);
    assert.equal(h.frames.size, 0);
    assert.ok(h.resizes.every((observer) => observer.disconnected));
    assert.equal(h.press(textarea, 'Escape').stopped, undefined, 'teardown removes our keyboard capture listener');
});

test('action status only announces current successful completions, never word-count refreshes', async (t) => {
    const h = await setup(t);
    h.ui.applyState(true);
    const status = h.document.querySelector('.sbstory-status');
    const context = h.api.ctx();
    h.ui.reportGenerationResult({ context, success: false });
    assert.equal(status.textContent, '');
    h.ui.reportGenerationResult({ context, success: true });
    assert.equal(status.textContent, 'Continuation added.');
    h.document.getElementById('sbstory-undo').click();
    await tick();
    assert.equal(status.textContent, 'Undo complete.');
    h.ui.refreshBar();
    assert.equal(status.textContent, 'Undo complete.');
    h.context.chatId = 'other-chat';
    h.ui.reportGenerationResult({ context, success: true });
    assert.equal(status.textContent, 'Undo complete.');
});

test('CSS keeps the narrow count cascade, accessible unit, touch sizing and host editing affordances', () => {
    for (const width of [44, 28, 22, 18]) assert.ok(css.includes(`@container (width < ${width}em)`));
    assert.match(css, /@container \(width < 18em\)\s*\{\s*#sbstory-bar #sbstory-words\s*\{\s*display: none;/u, 'the two-ID hide rule outranks the later one-ID base display');
    assert.match(css, /@container \(width < 22em\)[\s\S]*?clip-path: inset\(50%\);/u);
    assert.doesNotMatch(css, /\.sbstory-words-unit\s*\{[^}]*display: none/u);
    assert.match(css, /@media \(pointer: coarse\)[\s\S]*?--sbstory-action-size: max\(44px,/u);
    assert.match(css, /@media \(pointer: coarse\)\s*\{\s*#sbstory-bar\s*\{[^}]*gap: 4px;[^}]*padding-inline: 0;/u);
    assert.match(css, /@media \(pointer: coarse\)[\s\S]*?@container \(width < 28em\)\s*\{\s*#sbstory-bar #sbstory-continue\s*\{\s*padding-inline: 8px !important;/u);
    assert.match(css, /@media \(pointer: coarse\)[\s\S]*?@container \(width < 28em\)[\s\S]*?\.sbstory-words-unit\s*\{\s*position: absolute;\s*clip-path: inset\(50%\);/u);
    assert.match(css, /@media \(pointer: coarse\)[\s\S]*?@container \(width < 22em\)\s*\{\s*#sbstory-bar #sbstory-words\s*\{\s*display: none;/u);
    assert.match(css, /#sbstory-bar \.sbstory-btn\s*\{[^}]*border-radius: var\(--sb-radius-button, 10px\) !important;/u);
    assert.match(css, /\.sbstory-direction\s*\{[^}]*min-height: var\(--sbstory-action-size\)/u);
    assert.match(css, /\.mes_edit:not\(:focus\)\s*\{[^}]*clip-path: inset\(50%\)/u);
    assert.doesNotMatch(css, /\.mes_edit[^{}]*\{[^}]*display: none/u);
    assert.doesNotMatch(css, /\.ch_name[^{}]*\{[^}]*display: none/u);
    assert.match(css, /\.mes_reasoning_details:has\(\.reasoning_edit_textarea\)\s*\{\s*display: block !important;/u);
    assert.doesNotMatch(css, /\.sbstory-thought-text\s*\{[^}]*overflow-y/u);
    assert.match(css, /\.sbstory-dialog-header\s*\{[^}]*flex: 0 0 auto;/u);
});
