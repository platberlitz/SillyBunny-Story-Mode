/**
 * Everything that talks to the SillyBunny host. The context is resolved fresh
 * on every call: getContext() copies chatId/characterId/chatMetadata by value.
 */
import {
    CARD_KEY,
    CHAT_KEY,
    EXTRA_KEY,
    PROMPT_DIRECTION_KEY,
    PROMPT_RULES_KEY,
    SETTINGS_KEY,
    buildDirection,
    buildManuscript,
    buildRules,
    buildTransformPrompt,
    canRevertBlock,
    cleanTransformResult,
    contextWindow,
    countWords,
    getCuts,
    normalizeSettings,
    resolveEnabled,
    textRevision,
} from './core.js';

/** extension_prompt_types.IN_CHAT / extension_prompt_roles.SYSTEM */
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;
const RULES_DEPTH = 1;
const DIRECTION_DEPTH = 0;

export function ctx() {
    return globalThis.SillyTavern.getContext();
}

export function toast(kind, message) {
    globalThis.toastr?.[kind]?.(message);
}

// ---------------------------------------------------------------- settings

/** Read-only: defaults are filled in on the returned copy, never written into settings.json (only updateSettings writes). */
export function getSettings() {
    return normalizeSettings(ctx().extensionSettings?.[SETTINGS_KEY]);
}

export function updateSettings(patch) {
    const context = ctx();
    const next = normalizeSettings({ ...getSettings(), ...patch });
    if (context.extensionSettings) {
        context.extensionSettings[SETTINGS_KEY] = next;
        context.saveSettingsDebounced?.();
    }
    return next;
}

// ---------------------------------------------------------------- per chat / per card

export function hasChat() {
    const context = ctx();
    return Boolean(context.chatId) || (Array.isArray(context.chat) && context.chat.length > 0);
}

/** The chat as plain prose, its word count, and a file name built from the character (or group) and today's date. */
export function manuscript() {
    const context = ctx();
    const text = buildManuscript(context.chat);
    const who = context.groupId
        ? context.groups?.find((group) => group?.id === context.groupId)?.name
        : context.name2;
    const safeName = String(who || 'Story').replace(/[\\/:*?"<>|]+/gu, '').trim() || 'Story';
    const date = new Date().toISOString().slice(0, 10);
    return { text, words: countWords(text), fileName: `${safeName} - ${date}.txt` };
}

export function getChatFlag() {
    const value = ctx().chatMetadata?.[CHAT_KEY]?.enabled;
    return typeof value === 'boolean' ? value : undefined;
}

export async function setChatFlag(enabled) {
    const context = ctx();
    const meta = context.chatMetadata;
    if (!meta) {
        return false;
    }
    const current = meta[CHAT_KEY] && typeof meta[CHAT_KEY] === 'object' ? meta[CHAT_KEY] : {};
    meta[CHAT_KEY] = { ...current, enabled: Boolean(enabled) };
    await context.saveMetadata();
    return true;
}

export function currentCharacter() {
    const context = ctx();
    if (context.groupId) {
        return null;
    }
    const id = context.characterId;
    if (id === undefined || id === null || id === '') {
        return null;
    }
    return context.characters?.[id] ?? null;
}

export function getCardConfig() {
    const character = currentCharacter();
    const config = character?.data?.extensions?.[CARD_KEY];
    if (!config || typeof config !== 'object') {
        return character ? { default: undefined, instruction: '' } : null;
    }
    return {
        default: typeof config.default === 'boolean' ? config.default : undefined,
        instruction: typeof config.instruction === 'string' ? config.instruction : '',
    };
}

let cardWrite = Promise.resolve();

/**
 * The host persists card fields with a merge, so a key can only be cleared by
 * writing an explicit empty value: `default: null` means "no preference".
 */
export async function setCardConfig(patch) {
    const context = ctx();
    const character = context.groupId ? null : context.characters?.[context.characterId];
    if (!character) {
        return false;
    }
    const characterId = context.characterId;
    const write = cardWrite.catch(() => {}).then(async () => {
        const stored = character.data?.extensions?.[CARD_KEY];
        const current = stored && typeof stored === 'object'
            ? { default: typeof stored.default === 'boolean' ? stored.default : undefined, instruction: typeof stored.instruction === 'string' ? stored.instruction : '' }
            : { default: undefined, instruction: '' };
        const merged = { ...current, ...patch };
        const next = {
            default: typeof merged.default === 'boolean' ? merged.default : null,
            instruction: typeof merged.instruction === 'string' ? merged.instruction.trim() : '',
        };
        await context.writeExtensionField(characterId, CARD_KEY, next);
        return true;
    });
    cardWrite = write;
    return write;
}

export function isEnabled() {
    if (!hasChat()) {
        return false;
    }
    return resolveEnabled({
        chatFlag: getChatFlag(),
        cardDefault: getCardConfig()?.default,
        globalDefault: getSettings().defaultOn,
    });
}

// ---------------------------------------------------------------- prompt injections

export function setRules() {
    const settings = getSettings();
    const card = getCardConfig();
    const text = buildRules(card?.instruction || settings.rules, { lengthHint: settings.lengthHint });
    ctx().setExtensionPrompt(PROMPT_RULES_KEY, text, IN_CHAT, RULES_DEPTH, false, ROLE_SYSTEM);
}

export function clearRules() {
    ctx().setExtensionPrompt(PROMPT_RULES_KEY, '', IN_CHAT, RULES_DEPTH, false, ROLE_SYSTEM);
}

export function setDirection(text) {
    const value = buildDirection(text);
    ctx().setExtensionPrompt(PROMPT_DIRECTION_KEY, value, IN_CHAT, DIRECTION_DEPTH, false, ROLE_SYSTEM);
    return Boolean(value);
}

export function clearDirection() {
    ctx().setExtensionPrompt(PROMPT_DIRECTION_KEY, '', IN_CHAT, DIRECTION_DEPTH, false, ROLE_SYSTEM);
}

// ---------------------------------------------------------------- cuts (where the model's text starts in a block)

export function lastIndex() {
    const chat = ctx().chat;
    return Array.isArray(chat) ? chat.length - 1 : -1;
}

export function messageAt(index) {
    return ctx().chat?.[index] ?? null;
}

function storyExtra(message) {
    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }
    const existing = message.extra[EXTRA_KEY];
    if (!existing || typeof existing !== 'object') {
        message.extra[EXTRA_KEY] = {};
    }
    return message.extra[EXTRA_KEY];
}

function chatIdentity(context = ctx()) {
    return context.groupId
        ? `group:${context.groupId}:${context.chatId ?? ''}`
        : `character:${context.characterId ?? ''}:${context.chatId ?? ''}`;
}

function captureChat() {
    const context = ctx();
    return { context, chat: context.chat, key: chatIdentity(context) };
}

function isCurrentChat(action) {
    const context = ctx();
    return chatIdentity(context) === action.key && context.chat === action.chat;
}

function pushMessageCut(message) {
    if (!message) {
        return null;
    }
    const cut = String(message.mes ?? '').length;
    const cuts = getCuts(message);
    if (cuts.at(-1) !== cut) {
        setCuts(message, [...cuts, cut]);
    }
    return cut;
}

export function pushCut(index) {
    return pushMessageCut(messageAt(index));
}

export function dropCuts(index) {
    const message = messageAt(index);
    if (message) {
        setCuts(message, []);
    }
}

function setCuts(message, cuts) {
    let state = null;
    if (cuts.length) {
        state = { cuts: [...cuts], revision: textRevision(message.mes) };
        Object.assign(storyExtra(message), state);
    } else if (message.extra && typeof message.extra === 'object') {
        delete message.extra[EXTRA_KEY];
    }
    const swipeInfo = Array.isArray(message.swipe_info) && typeof message.swipe_id === 'number'
        ? message.swipe_info[message.swipe_id]
        : null;
    if (swipeInfo && typeof swipeInfo === 'object') {
        swipeInfo.extra ??= {};
        if (state) {
            swipeInfo.extra[EXTRA_KEY] = structuredClone(state);
        } else {
            delete swipeInfo.extra[EXTRA_KEY];
        }
    }
}

/** The host mirrors `mes` into the active swipe after every reply; keep that true after our own edits. */
function syncSwipe(message) {
    if (Array.isArray(message.swipes) && message.swipe_id !== undefined && message.swipe_id !== null) {
        message.swipes[message.swipe_id] = message.mes;
    }
}

/** Seal generated text to its cuts, pruning an empty continuation before persistence. */
function sealCuts(message) {
    if (!message?.extra?.[EXTRA_KEY]) {
        return false;
    }
    const cuts = getCuts(message, { ignoreRevision: true });
    if (cuts.length && cuts[cuts.length - 1] >= String(message.mes ?? '').length) {
        cuts.pop();
    }
    setCuts(message, cuts);
    return true;
}

function hasCutMetadata(message) {
    return Boolean(message?.extra && typeof message.extra === 'object' && Object.hasOwn(message.extra, EXTRA_KEY));
}

// ---------------------------------------------------------------- edit snapshots

const editSnapshots = new Map();

/** Remember a block's text when its editor opens; an unchanged close keeps its cuts. */
export function noteEditOpened(index) {
    const message = messageAt(index);
    if (message) {
        editSnapshots.set(Number(index), String(message.mes ?? ''));
    }
}

export function onMessageEdited(index) {
    const id = Number(index);
    const snapshot = editSnapshots.get(id);
    editSnapshots.delete(id);
    const message = messageAt(id);
    if (!message) {
        return false;
    }
    if (snapshot !== undefined && snapshot === String(message.mes ?? '')) {
        return false;
    }
    dropCuts(id);
    return true;
}

// ---------------------------------------------------------------- generation lifecycle

let inflight = null;
const hooks = { beforeGeneration: null, afterGeneration: null, busyChanged: null };

export function setHooks(partial) {
    Object.assign(hooks, partial);
}

export function isInflight() {
    return inflight !== null;
}

export function resetInflight() {
    inflight = null;
    refreshBusy();
}

/**
 * The host's own generating markers are the truth. GENERATION_ENDED is not a
 * reliable terminal: on the mobile shell it never arrived after a streamed
 * continue (verified live 2026-08-22), so a flag set on GENERATION_STARTED would stick.
 */
function hostGenerating() {
    if (typeof document === 'undefined') {
        return false;
    }
    return document.body?.dataset?.generating === 'true'
        || Boolean(document.getElementById?.('send_form')?.classList?.contains('sb-generating-controls'));
}

export function refreshBusy() {
    hooks.busyChanged?.(isBusy());
}

export function onGenerationStarted(type, _options, dryRun = false) {
    if (dryRun || type === 'quiet') {
        return;
    }
    if (!inflight) {
        clearRedo();
    }
    refreshBusy();
}

/** MESSAGE_SENT: the host just added the composer text as a user block; record where the model's text will start. */
export function onMessageSent(index) {
    const action = inflight;
    if (!action?.expectCut || !isCurrentChat(action)) {
        return;
    }
    const candidate = Number(index);
    const id = Number.isInteger(candidate) && action.chat?.[candidate] ? candidate : action.chat.length - 1;
    const message = action.chat?.[id];
    if (id !== action.expectedIndex || !message?.is_user) {
        return;
    }
    action.expectCut = false;
    action.mesid = id;
    action.message = message;
    pushMessageCut(message);
}

async function finalize(action) {
    try {
        if (inflight === action && isCurrentChat(action) && action.chat[action.mesid] === action.message && sealCuts(action.message)) {
            await action.context.saveChat();
        }
    } finally {
        if (inflight === action) {
            inflight = null;
            clearDirection();
        }
        hooks.afterGeneration?.(action);
    }
}

export async function finishOpenEdit() {
    if (typeof document === 'undefined') {
        return true;
    }
    const textarea = document.getElementById('curEditTextarea');
    const done = textarea?.closest('.mes')?.querySelector('.mes_edit_done');
    if (!textarea || !done) {
        return true;
    }
    done.click();
    const deadline = Date.now() + 2000;
    while (document.getElementById('curEditTextarea') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const closed = !document.getElementById('curEditTextarea');
    if (!closed) {
        toast('info', 'Finish the open edit before changing the story.');
    }
    return closed;
}

// A synchronous lock so two quick taps on Continue/Retry/Undo/Redo cannot both start.
let busy = false;

export function isBusy() {
    return busy || hostGenerating();
}

async function locked(action) {
    if (isBusy()) {
        return false;
    }
    busy = true;
    hooks.busyChanged?.(true);
    try {
        return await action();
    } finally {
        busy = false;
        hooks.busyChanged?.(isBusy());
    }
}

function composer() {
    return typeof document !== 'undefined' ? document.getElementById?.('send_textarea') ?? null : null;
}

function composerHasText(fallback) {
    const textarea = composer();
    return textarea ? String(textarea.value ?? '').length > 0 : Boolean(fallback);
}

/**
 * The host's continue always consumes the composer, so a Retry with a draft in
 * the box would post the draft as a new block. Park the draft, run, hand it back
 * (with anything typed meanwhile appended).
 */
async function withEmptyComposer(fn) {
    const textarea = composer();
    const draft = textarea ? String(textarea.value ?? '') : '';
    if (!draft) {
        return fn();
    }
    const setValue = (value) => {
        textarea.value = value;
        textarea.dispatchEvent?.(new Event('input', { bubbles: true }));
    };
    setValue('');
    try {
        return await fn();
    } finally {
        setValue(draft + String(textarea.value ?? ''));
    }
}

/**
 * NovelAI-style output length: cap the continuation's reply through the host's
 * generation events instead of touching the preset. Returns the unhook function.
 *
 * Other requests can run inside the same Generate before ours (In-Chat Agents
 * rewrite prompts with their own model calls), so the clamp is armed on
 * GENERATE_AFTER_DATA, which the host fires once per Generate after those
 * intercepts and right before the request: text completion already carries its
 * settings in that payload; chat completion gets them one event later.
 */
function hookTokenCap(context, maxTokens) {
    const cap = Number(maxTokens);
    const events = context.eventTypes;
    const source = context.eventSource;
    if (!(cap > 0) || !events || typeof source?.on !== 'function') {
        return () => {};
    }
    const clamp = (value) => Math.min(Number(value) > 0 ? Number(value) : cap, cap);
    const clampChat = (data) => {
        if (data && typeof data === 'object') {
            data.max_tokens = clamp(data.max_tokens);
        }
    };
    const clampText = (params) => {
        if (params && typeof params === 'object') {
            const value = clamp(params.max_new_tokens ?? params.max_tokens);
            params.max_new_tokens = value;
            params.max_tokens = value;
        }
    };
    const listeners = [];
    const listen = (type, handler) => {
        if (type) {
            source.on(type, handler);
            listeners.push([type, handler]);
        }
    };
    const unlisten = (type, handler) => source.removeListener?.(type, handler);
    if (events.GENERATE_AFTER_DATA) {
        // ponytail: a text-completion agent that rewrites the prompt through generateQuietPrompt runs a nested
        // Generate whose GENERATE_AFTER_DATA arrives first and takes this one-shot; ours then runs uncapped.
        const onData = (data, dryRun) => {
            if (dryRun) {
                return;
            }
            unlisten(events.GENERATE_AFTER_DATA, onData);
            if (data && typeof data === 'object' && ('max_new_tokens' in data || 'max_tokens' in data)) {
                clampText(data);
                return;
            }
            const once = (payload) => {
                unlisten(events.CHAT_COMPLETION_SETTINGS_READY, once);
                clampChat(payload);
            };
            listen(events.CHAT_COMPLETION_SETTINGS_READY, once);
        };
        listen(events.GENERATE_AFTER_DATA, onData);
    } else {
        listen(events.CHAT_COMPLETION_SETTINGS_READY, clampChat);
        listen(events.TEXT_COMPLETION_SETTINGS_READY, clampText);
    }
    return () => {
        for (const [type, handler] of listeners.splice(0)) {
            unlisten(type, handler);
        }
    };
}

/**
 * Continue the manuscript. With text in the composer the host adds it as the
 * user's block first (Generate consumes the textarea for type 'continue') and
 * then continues that block; with an empty composer it extends the last block.
 */
async function continueUnlocked({ hasText: hasTextHint = false, direction = '', preserveRedo = false } = {}) {
    if (isInflight()) {
        return false;
    }
    const action = { ...captureChat(), direction, expectCut: false, expectedIndex: -1, mesid: -1, message: null };
    inflight = action;
    let started = false;
    try {
        if (!await finishOpenEdit() || !isCurrentChat(action)) {
            return false;
        }
        const { context, chat } = action;
        const hasText = composerHasText(hasTextHint);
        const last = chat.length - 1;
        if (last < 0 && !hasText) {
            toast('info', 'Write something first, then continue.');
            return false;
        }
        if (hasText && context.groupId) {
            toast('info', 'Send that text first in group chats, then use Continue.');
            return false;
        }
        if (!hasText && context.chat[last]?.is_system) {
            toast('info', 'The last block is hidden from the model. Unhide it or write something first.');
            return false;
        }
        if (!preserveRedo) {
            clearRedo();
        }
        action.expectCut = hasText;
        action.expectedIndex = hasText ? chat.length : -1;
        action.mesid = hasText ? -1 : last;
        if (direction) {
            setDirection(direction);
        } else {
            clearDirection();
        }
        if (!hasText) {
            action.message = chat[last];
            pushMessageCut(action.message);
        }
        started = true;
        hooks.beforeGeneration?.();
        const autoContinue = context.powerUserSettings?.auto_continue;
        const restoreAutoContinue = autoContinue?.enabled === true;
        if (restoreAutoContinue) {
            autoContinue.enabled = false;
        }
        const unhookTokenCap = hookTokenCap(context, getSettings().maxTokens);
        try {
            await context.generate('continue');
        } finally {
            unhookTokenCap();
            if (restoreAutoContinue && autoContinue.enabled === false) {
                autoContinue.enabled = true;
            }
        }
        return true;
    } catch (error) {
        console.error('[Story Mode] continue failed', error);
        toast('error', 'Story Mode could not continue the text.');
        return true;
    } finally {
        if (started) {
            await finalize(action);
        } else if (inflight === action) {
            inflight = null;
        }
    }
}

export function continueStory(options) {
    return locked(() => continueUnlocked(options));
}

// ---------------------------------------------------------------- retry / undo / redo

const redoByChat = new Map();

function redoStack(key = chatIdentity()) {
    if (!redoByChat.has(key)) {
        redoByChat.set(key, []);
    }
    return redoByChat.get(key);
}

export function clearRedo() {
    redoByChat.clear();
}

export function canRedo() {
    return redoStack().length > 0;
}

export function canUndo() {
    return canRevertBlock(messageAt(lastIndex()));
}

function redoMatches(entry, chat, key) {
    if (!entry || entry.chat !== chat || entry.chatKey !== key) {
        return false;
    }
    if (entry.kind === 'tail') {
        const message = chat[entry.mesid];
        return entry.mesid === chat.length - 1 && String(message?.mes ?? '') === entry.prefix;
    }
    if (entry.kind === 'message') {
        const previous = chat.at(-1);
        return entry.previous === null
            ? chat.length === 0
            : chat.length === entry.index
                && String(previous?.mes ?? '') === entry.previous.text
                && Boolean(previous?.is_user) === entry.previous.isUser
                && Boolean(previous?.is_system) === entry.previous.isSystem;
    }
    return false;
}

export function clearRedoIfDiverged() {
    const context = ctx();
    const key = chatIdentity(context);
    const stack = redoByChat.get(key);
    if (stack?.length && !redoMatches(stack.at(-1), context.chat, key)) {
        redoByChat.delete(key);
        return true;
    }
    return false;
}

async function truncateLastContinuation(action) {
    const { context, chat } = action;
    const index = chat.length - 1;
    const message = chat[index];
    if (!message) {
        return null;
    }
    const cuts = getCuts(message);
    if (!cuts.length) {
        return null;
    }
    const cut = cuts.pop();
    const text = String(message.mes ?? '');
    if (cut >= text.length) {
        return null;
    }
    const tail = text.slice(cut);
    message.mes = text.slice(0, cut);
    syncSwipe(message);
    setCuts(message, cuts);
    const saving = context.saveChat();
    if (isCurrentChat(action)) {
        await context.updateMessageBlock(index, message);
    }
    await saving;
    return { mesid: index, cut, tail, prefix: message.mes };
}

export function undo() {
    return locked(async () => {
        if (isInflight()) {
            return false;
        }
        const action = captureChat();
        if (!await finishOpenEdit() || !isCurrentChat(action)) {
            return false;
        }
        const { context, chat } = action;
        const index = chat.length - 1;
        const message = chat[index];
        if (!message) {
            return false;
        }
        if (getCuts(message).length) {
            const removed = await truncateLastContinuation(action);
            if (removed) {
                redoStack(action.key).push({ kind: 'tail', chat: action.chat, chatKey: action.key, ...removed });
            }
            return true;
        }
        if (hasCutMetadata(message)) {
            toast('info', 'This block changed since its continuation was recorded, so it cannot be undone safely.');
            return false;
        }
        if (!message.is_user && !message.is_system) {
            const copy = structuredClone(message);
            const previous = index > 0 ? {
                text: String(chat[index - 1]?.mes ?? ''),
                isUser: Boolean(chat[index - 1]?.is_user),
                isSystem: Boolean(chat[index - 1]?.is_system),
            } : null;
            const deleting = context.deleteLastMessage();
            const saving = context.saveChat({ allowShrink: true });
            await deleting;
            await saving;
            if (isCurrentChat(action)) {
                context.swipe?.refresh?.();
            }
            redoStack(action.key).push({ kind: 'message', chat: action.chat, chatKey: action.key, index, previous, message: copy });
            return true;
        }
        toast('info', 'Nothing to undo: the last block is yours. Tap it to edit.');
        return false;
    });
}

export function redo() {
    return locked(async () => {
        if (isInflight()) {
            return false;
        }
        const action = captureChat();
        if (!await finishOpenEdit() || !isCurrentChat(action)) {
            return false;
        }
        const { context, chat } = action;
        const entry = redoStack(action.key).pop();
        if (!entry) {
            return false;
        }
        if (entry.kind === 'tail') {
            const message = chat[entry.mesid];
            if (!redoMatches(entry, chat, action.key) || !message) {
                toast('info', 'That block changed since the undo, so there is nothing safe to put back.');
                return false;
            }
            const cuts = getCuts(message);
            message.mes = String(message.mes ?? '') + entry.tail;
            syncSwipe(message);
            setCuts(message, [...cuts, entry.cut]);
            const saving = context.saveChat();
            if (isCurrentChat(action)) {
                await context.updateMessageBlock(entry.mesid, message);
            }
            await saving;
            return true;
        }
        if (entry.kind === 'message') {
            if (!redoMatches(entry, chat, action.key)) {
                toast('info', 'The story changed since the undo, so there is nothing safe to put back.');
                return false;
            }
            chat.push(entry.message);
            const saving = context.saveChat();
            if (isCurrentChat(action)) {
                context.addOneMessage(entry.message);
                context.swipe?.refresh?.();
            }
            await saving;
            return true;
        }
        return false;
    });
}

export function retry() {
    return locked(async () => {
        if (isInflight()) {
            return false;
        }
        const action = captureChat();
        if (!await finishOpenEdit() || !isCurrentChat(action)) {
            return false;
        }
        const { context, chat } = action;
        const index = chat.length - 1;
        const message = chat[index];
        if (!message) {
            return false;
        }
        if (getCuts(message).length) {
            return withEmptyComposer(async () => {
                const removed = await truncateLastContinuation(action);
                if (!isCurrentChat(action)) {
                    if (removed && String(message.mes ?? '') === removed.prefix) {
                        redoStack(action.key).push({ kind: 'tail', chat: action.chat, chatKey: action.key, ...removed });
                    }
                    return false;
                }
                if (!removed) {
                    return false;
                }
                const result = await continueUnlocked({ hasText: false, preserveRedo: true });
                const replacementSucceeded = action.chat[removed.mesid] === message
                    && String(message.mes ?? '').length > removed.prefix.length
                    && getCuts(message).includes(removed.cut);
                if (replacementSucceeded) {
                    clearRedo();
                } else if (String(message.mes ?? '') === removed.prefix) {
                    redoStack(action.key).push({ kind: 'tail', chat: action.chat, chatKey: action.key, ...removed });
                }
                return result;
            });
        }
        if (hasCutMetadata(message)) {
            toast('info', 'This block changed since its continuation was recorded, so it cannot be retried safely.');
            return false;
        }
        if (!message.is_user && !message.is_system) {
            if (context.swipe?.isAllowed?.() === false) {
                toast('info', 'Swipes are off or a generation is still running.');
                return false;
            }
            await context.swipe.right(null, { source: 'story-mode' });
            return true;
        }
        toast('info', 'Nothing to retry yet: the last block is yours.');
        return false;
    });
}

// ---------------------------------------------------------------- in-chat agents gate

/**
 * The host's In-Chat Agents decide what runs from each agent's global enabled
 * flag, read from event handlers and from their own timers alike. There is no
 * per-chat switch and no veto hook, so while Story Mode is on in the open chat
 * the non-allowed agents are kept switched off in memory (never saved; a reload
 * restores them from disk) and switched back on when the mode or the chat changes.
 */
let agentStore = null;
let agentStoreLoad = null;
const gatedAgents = [];

export function loadAgentStore() {
    agentStoreLoad ??= import('/scripts/extensions/in-chat-agents/agent-store.js')
        .then((mod) => {
            agentStore = typeof mod?.getAgents === 'function' && typeof mod?.getEnabledAgents === 'function' && typeof mod?.setAgentEnabledForScope === 'function' ? mod : null;
            return agentStore;
        })
        .catch(() => {
            agentStore = null;
            return null;
        });
    return agentStoreLoad;
}

export function hasAgentStore() {
    return agentStore !== null;
}

/** Every agent the user has, for the settings list; null when In-Chat Agents is not available. */
export function listAgents(store = agentStore) {
    if (!store) {
        return null;
    }
    return store.getAgents().map((agent) => ({
        id: String(agent.id ?? ''),
        name: String(agent.name ?? '').trim() || 'Unnamed agent',
        enabled: typeof store.isAgentEnabledForCurrentScope === 'function' ? Boolean(store.isAgentEnabledForCurrentScope(agent)) : Boolean(agent.enabled),
    })).filter((agent) => agent.id);
}

/**
 * Makes the in-memory agent flags match the allow-list for the current chat:
 * gated while Story Mode is on here and the setting is on, released otherwise.
 * Returns the ids currently held off.
 */
export function applyAgentGate(store = agentStore) {
    if (!store) {
        return [];
    }
    const settings = getSettings();
    const active = settings.agentGate && isEnabled();
    const allowed = new Set(settings.allowedAgents);
    for (const agent of gatedAgents.splice(0)) {
        if (active && !allowed.has(String(agent.id))) {
            gatedAgents.push(agent);
        } else {
            store.setAgentEnabledForScope(agent, true);
        }
    }
    if (active) {
        for (const agent of store.getEnabledAgents()) {
            if (!allowed.has(String(agent.id)) && !gatedAgents.includes(agent)) {
                store.setAgentEnabledForScope(agent, false);
                gatedAgents.push(agent);
            }
        }
    }
    return gatedAgents.map((agent) => String(agent.id));
}

/** Switches every gated agent back on. Safe to call any number of times. */
export function releaseAgentGate(store = agentStore) {
    const agents = gatedAgents.splice(0);
    for (const agent of agents) {
        store?.setAgentEnabledForScope(agent, true);
    }
    return agents.length;
}

// ---------------------------------------------------------------- selection transforms

export async function runTransform({ kind, instruction = '', value, start, end, signal }) {
    const context = ctx();
    const window = contextWindow(value, start, end);
    if (!window.selection.trim()) {
        return '';
    }
    const { systemPrompt, prompt, responseLength } = buildTransformPrompt(kind, { ...window, instruction });
    const raw = getSettings().transformsUseFullContext
        ? await context.generateQuietPrompt({ quietPrompt: `${systemPrompt}\n\n${prompt}`, skipWIAN: true, responseLength, signal })
        : await context.generateRaw({ systemPrompt, prompt, responseLength, signal });
    const result = cleanTransformResult(raw, window.selection);
    if (!result) {
        return '';
    }
    const leading = window.selection.match(/^\s*/u)?.[0] ?? '';
    const trailing = window.selection.match(/\s*$/u)?.[0] ?? '';
    return `${leading}${result}${trailing}`;
}

// ---------------------------------------------------------------- slash command

let commandsRegistered = false;

export function registerCommands({ onToggle }) {
    if (commandsRegistered) {
        return true;
    }
    const context = ctx();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = context;
    if (!SlashCommandParser || !SlashCommand || !SlashCommandArgument) {
        return false;
    }
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'story',
        callback: (_named, unnamed) => onToggle(String(unnamed ?? '')),
        returns: 'on or off',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'on, off or toggle',
                typeList: [ARGUMENT_TYPE?.STRING ?? 'string'],
                isRequired: false,
                enumList: ['on', 'off', 'toggle'],
            }),
        ],
        helpString: 'Turns Story Mode on or off for the current chat. With no argument it toggles.',
    }));
    commandsRegistered = true;
    return true;
}
