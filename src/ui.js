/**
 * DOM layer: the story bar, the selection-rewrite row, block stamping, the
 * tap-to-edit bridge into the host's own message editor, the wand entry and
 * the settings drawer. The manuscript look itself is style.css under body.sbstory.
 */
import * as api from './api.js';
import { BODY_CLASS, DEFAULT_RULES, classifyBlock, computeJoins, wordCount } from './core.js';

const BAR_ID = 'sbstory-bar';
const ROW_ID = 'sbstory-transforms';
const MENU_ITEM_ID = 'sbstory-menu-item';
const DRAWER_ID = 'sbstory-settings';
const HINT_KEY = 'SillyBunnyStoryMode_editHintShown';

let bar = null;
let directionWrap = null;
let directionInput = null;
let wordsEl = null;
let row = null;
let rowStatus = null;
let rowStop = null;
let abortController = null;
let pendingSelection = null;
let menuItem = null;
let drawer = null;
let drawerHandlers = { onChatToggle: null, onChange: null };
let menuToggle = null;
let lastEditorId = null;
let selectionFrame = 0;

export function el(tag, { className = '', text = '', attrs = {} } = {}) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }
    if (text) {
        node.textContent = text;
    }
    for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined || value === false) {
            continue;
        }
        node.setAttribute(key, value === true ? '' : String(value));
    }
    return node;
}

function iconButton({ id, icon, label, title, className = 'menu_button sbstory-btn', onClick }) {
    const button = el('button', { className, attrs: { type: 'button', id, title: title || label } });
    button.append(
        el('i', { className: `fa-solid ${icon}`, attrs: { 'aria-hidden': 'true' } }),
        el('span', { className: 'sbstory-btn-label', text: label }),
    );
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
        event.preventDefault();
        void onClick(event);
    });
    return button;
}

// ---------------------------------------------------------------- story bar

export function mountBar() {
    if (bar) {
        placeBar();
        return bar;
    }
    bar = el('div', { className: 'flex-container flexGap5 sbstory-bar', attrs: { id: BAR_ID, hidden: true, role: 'toolbar', 'aria-label': 'Story Mode' } });
    wordsEl = el('span', { className: 'sbstory-words', attrs: { 'aria-live': 'polite' } });
    directionWrap = el('div', { className: 'sbstory-direction-wrap', attrs: { hidden: true } });
    directionInput = el('input', {
        className: 'text_pole sbstory-direction',
        attrs: {
            id: 'sbstory-direction',
            type: 'text',
            placeholder: 'Where should the next passage go? Used once, then cleared.',
            'aria-label': 'Direction for the next passage',
            autocomplete: 'off',
        },
    });
    directionInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            void onContinue();
        }
    });
    directionWrap.append(directionInput);
    bar.append(
        iconButton({ id: 'sbstory-continue', icon: 'fa-feather-pointed', label: 'Continue', title: 'Continue the story from where the text stops. Text in the box is added first.', onClick: onContinue }),
        iconButton({ id: 'sbstory-retry', icon: 'fa-arrows-rotate', label: 'Retry', title: 'Redo the last continuation', onClick: () => api.retry() }),
        iconButton({ id: 'sbstory-undo', icon: 'fa-rotate-left', label: 'Undo', title: 'Remove the last continuation', onClick: () => api.undo() }),
        iconButton({ id: 'sbstory-redo', icon: 'fa-rotate-right', label: 'Redo', title: 'Put the last removed continuation back', onClick: () => api.redo() }),
        iconButton({ id: 'sbstory-direction-toggle', icon: 'fa-compass', label: 'Direction', title: 'Tell the model where the next passage should go. Used once.', onClick: toggleDirection }),
        wordsEl,
        directionWrap,
    );
    placeBar();
    return bar;
}

function placeBar() {
    const sendForm = document.getElementById('send_form');
    const anchor = document.getElementById('nonQRFormItems');
    if (!sendForm || !bar) {
        return;
    }
    if (anchor && anchor.parentElement === sendForm) {
        if (bar.nextElementSibling !== anchor) {
            sendForm.insertBefore(bar, anchor);
        }
    } else if (bar.parentElement !== sendForm) {
        sendForm.prepend(bar);
    }
}

async function onContinue() {
    const textarea = document.getElementById('send_textarea');
    const hasText = Boolean(textarea && String(textarea.value).trim());
    const direction = directionInput?.value?.trim() ?? '';
    if (direction) {
        api.setDirection(direction);
    } else {
        api.clearDirection();
    }
    await api.continueStory({ hasText });
}

function toggleDirection() {
    if (!directionWrap) {
        return;
    }
    directionWrap.hidden = !directionWrap.hidden;
    if (!directionWrap.hidden) {
        directionInput.focus();
    }
}

export function clearDirectionInput() {
    if (directionInput) {
        directionInput.value = '';
    }
}

export function setBusy(busy) {
    if (!bar) {
        return;
    }
    bar.toggleAttribute('data-busy', Boolean(busy));
    for (const id of ['sbstory-continue', 'sbstory-retry', 'sbstory-undo', 'sbstory-redo']) {
        const button = document.getElementById(id);
        if (button) {
            button.disabled = Boolean(busy);
        }
    }
}

export function updateWords() {
    if (!wordsEl) {
        return;
    }
    const count = wordCount(api.ctx().chat);
    wordsEl.textContent = `${count.toLocaleString()} ${count === 1 ? 'word' : 'words'}`;
}

// ---------------------------------------------------------------- selection rewrites (inside the host editor)

export function mountTransformRow() {
    if (row) {
        return row;
    }
    row = el('div', { className: 'sbstory-transforms', attrs: { id: ROW_ID, hidden: true, role: 'toolbar', 'aria-label': 'Rewrite the selected text' } });
    for (const [kind, label, icon, title] of [
        ['rewrite', 'Rewrite', 'fa-pen-nib', 'Rewrite the selection for clarity and flow'],
        ['expand', 'Expand', 'fa-up-right-and-down-left-from-center', 'Expand the selection with more detail'],
        ['compress', 'Compress', 'fa-down-left-and-up-right-to-center', 'Tighten the selection'],
        ['custom', 'Custom…', 'fa-wand-magic-sparkles', 'Change the selection with your own instruction'],
    ]) {
        row.append(iconButton({ icon, label, title, className: 'menu_button sbstory-tbtn', onClick: () => runTransform(kind) }));
    }
    rowStop = iconButton({ icon: 'fa-stop', label: 'Stop', title: 'Stop waiting for the rewrite', className: 'menu_button sbstory-tbtn sbstory-stop', onClick: () => abortController?.abort() });
    rowStop.hidden = true;
    rowStatus = el('span', { className: 'sbstory-tstatus', attrs: { 'aria-live': 'polite' } });
    row.append(rowStop, rowStatus);
    return row;
}

function currentEditSelection() {
    const textarea = document.getElementById('curEditTextarea');
    if (!textarea) {
        return null;
    }
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    return end > start ? { textarea, start, end } : null;
}

function setStatus(text) {
    if (rowStatus) {
        rowStatus.textContent = text;
    }
}

export function refreshTransformRow() {
    if (!row) {
        return;
    }
    if (!document.body.classList.contains(BODY_CLASS)) {
        hideRow();
        return;
    }
    const selection = currentEditSelection();
    const textarea = selection?.textarea ?? document.getElementById('curEditTextarea');
    if (!textarea || (!selection && !abortController)) {
        hideRow();
        return;
    }
    if (selection) {
        pendingSelection = selection;
    }
    const host = textarea.parentElement;
    if (host && (row.parentElement !== host || row.nextElementSibling !== textarea)) {
        host.insertBefore(row, textarea);
    }
    row.hidden = false;
}

function hideRow() {
    if (row) {
        row.hidden = true;
    }
    if (!abortController) {
        pendingSelection = null;
        setStatus('');
    }
}

function setRowBusy(busy, status = '') {
    if (!row) {
        return;
    }
    row.toggleAttribute('data-busy', busy);
    if (rowStop) {
        rowStop.hidden = !busy;
    }
    setStatus(status);
}

async function askInstruction() {
    const context = api.ctx();
    if (typeof context.Popup?.show?.input === 'function') {
        return context.Popup.show.input('Custom rewrite', 'What should change in the selected passage?', '');
    }
    return globalThis.prompt?.('What should change in the selected passage?') ?? null;
}

async function runTransform(kind) {
    const selection = pendingSelection ?? currentEditSelection();
    if (!selection || abortController) {
        return;
    }
    let instruction = '';
    if (kind === 'custom') {
        const answer = await askInstruction();
        if (answer === null || answer === undefined || !String(answer).trim()) {
            return;
        }
        instruction = String(answer);
    }
    const { textarea, start, end } = selection;
    const value = textarea.value;
    abortController = new AbortController();
    setRowBusy(true, 'Working…');
    try {
        const result = await api.runTransform({ kind, instruction, value, start, end, signal: abortController.signal });
        if (!result) {
            setStatus('Nothing came back.');
            return;
        }
        if (textarea.value !== value) {
            setStatus('The text changed while waiting, so nothing was replaced.');
            return;
        }
        textarea.setRangeText(result, start, end, 'select');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
        setStatus('Replaced. Ctrl+Z inside the box undoes it; Done or Escape keeps it.');
    } catch (error) {
        if (abortController?.signal.aborted || error?.name === 'AbortError') {
            setStatus('Stopped.');
        } else {
            console.error('[Story Mode] rewrite failed', error);
            setStatus('That did not work; the console has the error.');
        }
    } finally {
        abortController = null;
        setRowBusy(false, rowStatus?.textContent ?? '');
        refreshTransformRow();
    }
}

function scheduleSelectionRefresh() {
    cancelAnimationFrame(selectionFrame);
    selectionFrame = requestAnimationFrame(() => refreshTransformRow());
}

export function bindSelectionWatch() {
    if (document.documentElement.dataset.sbstorySelection) {
        return;
    }
    document.documentElement.dataset.sbstorySelection = '1';
    document.addEventListener('selectionchange', scheduleSelectionRefresh);
    for (const type of ['mouseup', 'keyup', 'touchend', 'select']) {
        document.addEventListener(type, (event) => {
            if (event.target instanceof Element && event.target.id === 'curEditTextarea') {
                scheduleSelectionRefresh();
            }
        }, true);
    }
}

/** Called from the #chat mutation observer: notices a host editor opening so an unchanged close keeps its cuts. */
export function checkEditor() {
    const textarea = document.getElementById('curEditTextarea');
    if (!textarea) {
        lastEditorId = null;
        return;
    }
    const mesid = Number(textarea.closest('.mes')?.getAttribute('mesid'));
    if (!Number.isInteger(mesid) || mesid === lastEditorId) {
        return;
    }
    lastEditorId = mesid;
    api.noteEditOpened(mesid);
}

// ---------------------------------------------------------------- block stamping (origin, joins, model-tail shading)

export function stampBlocks() {
    const context = api.ctx();
    const chat = context.chat;
    if (!Array.isArray(chat)) {
        return;
    }
    const joins = computeJoins(chat);
    const tint = api.getSettings().tint;
    for (const mesEl of document.querySelectorAll('#chat .mes[mesid]')) {
        const index = Number(mesEl.getAttribute('mesid'));
        const message = chat[index];
        if (!message) {
            continue;
        }
        const { origin, cut } = classifyBlock(message);
        mesEl.dataset.sbstoryOrigin = origin;
        if (joins.has(index)) {
            mesEl.dataset.sbstoryJoin = '';
        } else {
            delete mesEl.dataset.sbstoryJoin;
        }
        if (origin === 'mixed' && tint) {
            wrapTail(mesEl, message, index, cut);
        } else {
            unwrapTail(mesEl);
        }
    }
    updateWords();
}

export function cleanupStamps() {
    for (const mesEl of document.querySelectorAll('#chat .mes[data-sbstory-origin]')) {
        delete mesEl.dataset.sbstoryOrigin;
        delete mesEl.dataset.sbstoryJoin;
        unwrapTail(mesEl);
    }
}

function unwrapTail(mesEl) {
    const text = mesEl.querySelector('.mes_text');
    if (!text || !text.querySelector('.sbstory-model')) {
        return;
    }
    for (const span of text.querySelectorAll('.sbstory-model')) {
        span.replaceWith(...span.childNodes);
    }
    text.normalize();
    delete text.dataset.sbstoryWrapped;
}

/**
 * Shades the model's part of a block the user started. The user's prefix is
 * rendered the same way the host renders the block, and its visible length is
 * used to find the split point in the rendered text.
 * ponytail: markup that spans the cut moves the shading by a few characters.
 */
function wrapTail(mesEl, message, index, cut) {
    const text = mesEl.querySelector('.mes_text');
    if (!text || text.querySelector('#curEditTextarea')) {
        return;
    }
    const key = `${cut}:${String(message.mes ?? '').length}`;
    if (text.dataset.sbstoryWrapped === key) {
        return;
    }
    unwrapTail(mesEl);
    let prefixLength = 0;
    try {
        const html = api.ctx().messageFormatting(String(message.mes ?? '').slice(0, cut), message.name, message.is_system, message.is_user, index, {}, false);
        const probe = document.createElement('div');
        probe.innerHTML = html;
        prefixLength = probe.textContent.replace(/\s+$/u, '').length;
    } catch (error) {
        console.warn('[Story Mode] could not measure the user prefix', error);
        return;
    }
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
    const tail = [];
    let seen = 0;
    let node;
    while ((node = walker.nextNode())) {
        const length = node.nodeValue.length;
        if (seen + length <= prefixLength) {
            seen += length;
            continue;
        }
        if (seen < prefixLength) {
            node.splitText(prefixLength - seen);
            seen = prefixLength;
            continue;
        }
        tail.push(node);
    }
    for (const textNode of tail) {
        if (!textNode.nodeValue) {
            continue;
        }
        const span = document.createElement('span');
        span.className = 'sbstory-model';
        textNode.replaceWith(span);
        span.append(textNode);
    }
    text.dataset.sbstoryWrapped = key;
}

// ---------------------------------------------------------------- tap to edit, Escape saves

function showEditHintOnce() {
    const storage = api.ctx().accountStorage;
    try {
        if (storage?.getItem?.(HINT_KEY)) {
            return;
        }
        storage?.setItem?.(HINT_KEY, '1');
    } catch {
        return;
    }
    api.toast('info', 'Tap any paragraph to edit it. Escape or the tick keeps your changes.');
}

export function bindClickToEdit() {
    const chat = document.getElementById('chat');
    if (!chat || chat.dataset.sbstoryBound) {
        return;
    }
    chat.dataset.sbstoryBound = '1';
    chat.addEventListener('click', (event) => {
        if (!document.body.classList.contains(BODY_CLASS)) {
            return;
        }
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }
        if (target.closest('#curEditTextarea, #sbstory-transforms, a, img, video, audio, summary, details, button, input, textarea, select, label, .mes_buttons, .mes_edit_buttons, .swipe_left, .swipeRightBlock, .code-copy, .mes_reasoning_details')) {
            return;
        }
        const editing = document.getElementById('curEditTextarea');
        const mes = target.closest('.mes');
        if (!mes) {
            if (editing) {
                editing.closest('.mes')?.querySelector('.mes_edit_done')?.click();
            }
            return;
        }
        if (!target.closest('.mes_text')) {
            return;
        }
        if (editing && editing.closest('.mes') === mes) {
            return;
        }
        if (String(globalThis.getSelection?.() ?? '').length > 0) {
            return;
        }
        const button = mes.querySelector('.mes_edit');
        if (!button) {
            return;
        }
        button.click();
        showEditHintOnce();
    });
}

export function bindEscapeSave() {
    if (document.documentElement.dataset.sbstoryEscape) {
        return;
    }
    document.documentElement.dataset.sbstoryEscape = '1';
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || event.isComposing) {
            return;
        }
        if (!document.body.classList.contains(BODY_CLASS)) {
            return;
        }
        const textarea = document.getElementById('curEditTextarea');
        if (!textarea || document.activeElement !== textarea) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (abortController) {
            abortController.abort();
            return;
        }
        textarea.closest('.mes')?.querySelector('.mes_edit_done')?.click();
    }, true);
}

// ---------------------------------------------------------------- wand entry

export function ensureMenuItem({ onToggle }) {
    const host = document.getElementById('extensionsMenu');
    if (!host) {
        return;
    }
    menuToggle = onToggle;
    if (!menuItem) {
        // Wand entries must be divs: the host styles `#extensionsMenu > div`.
        menuItem = el('div', { className: 'list-group-item flex-container flexGap5 interactable', attrs: { id: MENU_ITEM_ID, role: 'button', tabindex: '0' } });
        menuItem.append(
            el('span', { className: 'fa-solid fa-feather-pointed extensionsMenuExtensionButton', attrs: { 'aria-hidden': 'true' } }),
            el('span', { className: 'sbstory-menu-label', text: 'Story Mode' }),
        );
        const activate = (event) => {
            event.preventDefault();
            void menuToggle?.();
        };
        menuItem.addEventListener('click', activate);
        menuItem.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                activate(event);
            }
        });
    }
    if (menuItem.parentElement !== host) {
        host.append(menuItem);
    }
    refreshMenuItem(api.isEnabled());
    // a11y.js restamps every `.options-content .list-group-item` as a listitem a tick later.
    setTimeout(() => menuItem?.setAttribute('role', 'button'), 0);
}

export function refreshMenuItem(enabled) {
    if (!menuItem) {
        return;
    }
    const label = menuItem.querySelector('.sbstory-menu-label');
    if (label) {
        label.textContent = enabled ? 'Story Mode: on (tap to turn off)' : 'Story Mode: off (tap to turn on)';
    }
    menuItem.setAttribute('aria-pressed', String(Boolean(enabled)));
    menuItem.setAttribute('role', 'button');
}

// ---------------------------------------------------------------- settings drawer

export function ensureDrawer(handlers) {
    drawerHandlers = { ...drawerHandlers, ...handlers };
    const host = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!host) {
        return;
    }
    if (!drawer) {
        drawer = el('div', { className: 'inline-drawer sbstory-drawer', attrs: { id: DRAWER_ID, 'data-extension-name': 'SillyBunny-Story-Mode' } });
        const toggle = el('div', { className: 'inline-drawer-toggle inline-drawer-header', attrs: { tabindex: '0', 'aria-expanded': 'false', 'aria-controls': `${DRAWER_ID}-content` } });
        toggle.append(el('b', { text: 'Story Mode' }), el('div', { className: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' }));
        toggle.addEventListener('click', () => {
            toggle.setAttribute('aria-expanded', String(toggle.getAttribute('aria-expanded') !== 'true'));
        });
        toggle.addEventListener('keydown', (event) => {
            if ((event.key === 'Enter' || event.key === ' ') && event.target === toggle) {
                event.preventDefault();
                toggle.click();
            }
        });
        const content = el('div', { className: 'inline-drawer-content', attrs: { id: `${DRAWER_ID}-content` } });
        drawer.append(toggle, content);
    }
    if (drawer.parentElement !== host) {
        host.append(drawer);
    }
    renderDrawer();
}

function checkboxRow({ id, label, checked, onChange, hint = '' }) {
    const wrap = el('label', { className: 'checkbox_label sbstory-row', attrs: { for: id } });
    const input = el('input', { attrs: { type: 'checkbox', id } });
    input.checked = Boolean(checked);
    input.addEventListener('change', () => void onChange(input.checked));
    wrap.append(input, el('span', { text: label }));
    if (hint) {
        wrap.title = hint;
    }
    return wrap;
}

function field(labelText, control, hint = '') {
    const wrap = el('div', { className: 'sbstory-field' });
    const label = el('label', { text: labelText, attrs: { for: control.id } });
    wrap.append(label, control);
    if (hint) {
        wrap.append(el('small', { className: 'sbstory-hint', text: hint }));
    }
    return wrap;
}

export function renderDrawer() {
    if (!drawer) {
        return;
    }
    const content = drawer.querySelector('.inline-drawer-content');
    if (!content) {
        return;
    }
    const settings = api.getSettings();
    const character = api.currentCharacter();
    const card = api.getCardConfig();
    const hasChat = api.hasChat();
    content.replaceChildren();

    const chatToggle = checkboxRow({
        id: 'sbstory-opt-chat',
        label: hasChat ? 'Story Mode in this chat' : 'Story Mode in this chat (open a chat first)',
        checked: hasChat && api.isEnabled(),
        onChange: (value) => drawerHandlers.onChatToggle?.(value),
    });
    chatToggle.querySelector('input').disabled = !hasChat;
    content.append(chatToggle);

    content.append(checkboxRow({
        id: 'sbstory-opt-default',
        label: 'Start chats in Story Mode unless the card or chat says otherwise',
        checked: settings.defaultOn,
        onChange: (value) => {
            api.updateSettings({ defaultOn: value });
            drawerHandlers.onChange?.();
        },
    }));

    if (character) {
        const section = el('div', { className: 'sbstory-card-section' });
        section.append(el('div', { className: 'sbstory-section-title', text: `This card: ${character.name ?? 'character'}` }));
        section.append(checkboxRow({
            id: 'sbstory-opt-card-default',
            label: 'Open this character\'s chats in Story Mode',
            checked: card?.default === true,
            hint: 'Stored in the card, so it travels with it.',
            onChange: async (value) => {
                await api.setCardConfig({ default: value ? true : undefined });
                drawerHandlers.onChange?.();
            },
        }));
        const instruction = el('textarea', { className: 'text_pole sbstory-textarea', attrs: { id: 'sbstory-opt-card-rules', rows: '4', placeholder: 'Leave empty to use the rules below.' } });
        instruction.value = card?.instruction ?? '';
        instruction.addEventListener('change', async () => {
            await api.setCardConfig({ instruction: instruction.value.trim() });
            drawerHandlers.onChange?.();
        });
        section.append(field('Co-writing rules for this card (optional)', instruction, 'Replaces the general rules when this card is open. {{length}} becomes the length hint.'));
        content.append(section);
    }

    content.append(checkboxRow({
        id: 'sbstory-opt-tint',
        label: 'Shade the model\'s text',
        checked: settings.tint,
        onChange: (value) => {
            api.updateSettings({ tint: value });
            drawerHandlers.onChange?.();
        },
    }));
    content.append(checkboxRow({
        id: 'sbstory-opt-serif',
        label: 'Serif font in the manuscript',
        checked: settings.serif,
        onChange: (value) => {
            api.updateSettings({ serif: value });
            drawerHandlers.onChange?.();
        },
    }));

    const rules = el('textarea', { className: 'text_pole sbstory-textarea', attrs: { id: 'sbstory-opt-rules', rows: '6' } });
    rules.value = settings.rules;
    rules.addEventListener('change', () => {
        api.updateSettings({ rules: rules.value.trim() || DEFAULT_RULES });
        drawerHandlers.onChange?.();
    });
    const rulesField = field('Rules sent before the block being continued', rules, '{{length}} becomes the length hint; {{user}} is the usual macro.');
    const reset = el('button', { className: 'menu_button sbstory-reset', text: 'Reset rules', attrs: { type: 'button' } });
    reset.addEventListener('click', () => {
        rules.value = DEFAULT_RULES;
        api.updateSettings({ rules: DEFAULT_RULES });
        drawerHandlers.onChange?.();
    });
    rulesField.append(reset);
    content.append(rulesField);

    const length = el('input', { className: 'text_pole', attrs: { id: 'sbstory-opt-length', type: 'text' } });
    length.value = settings.lengthHint;
    length.addEventListener('change', () => {
        api.updateSettings({ lengthHint: length.value.trim() || undefined });
        drawerHandlers.onChange?.();
    });
    content.append(field('How much to write per continuation', length, 'Plain words, e.g. "one paragraph" or "two to four paragraphs".'));

    content.append(checkboxRow({
        id: 'sbstory-opt-fullctx',
        label: 'Rewrites see the whole story (slower, costs more, matches voice better)',
        checked: settings.transformsUseFullContext,
        onChange: (value) => {
            api.updateSettings({ transformsUseFullContext: value });
        },
    }));
}

// ---------------------------------------------------------------- mode application / teardown

export function applyState(enabled) {
    const settings = api.getSettings();
    document.body.classList.toggle(BODY_CLASS, enabled);
    document.body.classList.toggle('sbstory-serif', enabled && settings.serif);
    document.body.classList.toggle('sbstory-notint', enabled && !settings.tint);
    if (bar) {
        placeBar();
        bar.hidden = !enabled;
    }
    refreshMenuItem(enabled);
    if (enabled) {
        stampBlocks();
    } else {
        cleanupStamps();
        hideRow();
    }
}

export function unmountAll() {
    abortController?.abort();
    abortController = null;
    document.body.classList.remove(BODY_CLASS, 'sbstory-serif', 'sbstory-notint');
    cleanupStamps();
    bar?.remove();
    row?.remove();
    menuItem?.remove();
    drawer?.remove();
    bar = null;
    directionWrap = null;
    directionInput = null;
    wordsEl = null;
    row = null;
    rowStatus = null;
    rowStop = null;
    menuItem = null;
    drawer = null;
    pendingSelection = null;
    lastEditorId = null;
}
