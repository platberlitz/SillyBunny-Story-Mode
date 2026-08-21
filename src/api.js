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
    buildRules,
    buildTransformPrompt,
    cleanTransformResult,
    contextWindow,
    getCuts,
    normalizeSettings,
    resolveEnabled,
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

export function getSettings() {
    const context = ctx();
    const settings = normalizeSettings(context.extensionSettings?.[SETTINGS_KEY]);
    if (context.extensionSettings) {
        context.extensionSettings[SETTINGS_KEY] = settings;
    }
    return settings;
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

export function getChatFlag() {
    const value = ctx().chatMetadata?.[CHAT_KEY]?.enabled;
    return typeof value === 'boolean' ? value : undefined;
}

export function setChatFlag(enabled) {
    const context = ctx();
    const meta = context.chatMetadata;
    if (!meta) {
        return false;
    }
    const current = meta[CHAT_KEY] && typeof meta[CHAT_KEY] === 'object' ? meta[CHAT_KEY] : {};
    meta[CHAT_KEY] = { ...current, enabled: Boolean(enabled) };
    context.saveMetadataDebounced?.();
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

/**
 * The host persists card fields with a merge, so a key can only be cleared by
 * writing an explicit empty value: `default: null` means "no preference".
 */
export async function setCardConfig(patch) {
    const context = ctx();
    const character = currentCharacter();
    if (!character) {
        return false;
    }
    const current = getCardConfig() ?? { default: undefined, instruction: '' };
    const merged = { ...current, ...patch };
    const next = {
        default: merged.default === true ? true : null,
        instruction: typeof merged.instruction === 'string' ? merged.instruction.trim() : '',
    };
    await context.writeExtensionField(context.characterId, CARD_KEY, next);
    return true;
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

export function pushCut(index) {
    const message = messageAt(index);
    if (!message) {
        return null;
    }
    const cut = String(message.mes ?? '').length;
    storyExtra(message).cuts = [...getCuts(message), cut];
    return cut;
}

export function dropCuts(index) {
    const message = messageAt(index);
    if (message?.extra && typeof message.extra === 'object') {
        delete message.extra[EXTRA_KEY];
    }
}

function setCuts(message, cuts) {
    if (cuts.length) {
        storyExtra(message).cuts = cuts;
    } else if (message.extra && typeof message.extra === 'object') {
        delete message.extra[EXTRA_KEY];
    }
}

/** The host mirrors `mes` into the active swipe after every reply; keep that true after our own edits. */
function syncSwipe(message) {
    if (Array.isArray(message.swipes) && message.swipe_id !== undefined && message.swipe_id !== null) {
        message.swipes[message.swipe_id] = message.mes;
    }
}

/** A continuation that produced nothing leaves a cut at the end of the text; drop it. */
function pruneEmptyCut(index) {
    const message = messageAt(index);
    if (!message) {
        return;
    }
    const cuts = getCuts(message);
    if (cuts.length && cuts[cuts.length - 1] >= String(message.mes ?? '').length) {
        cuts.pop();
        setCuts(message, cuts);
    }
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
        return;
    }
    if (snapshot !== undefined && snapshot === String(message.mes ?? '')) {
        return;
    }
    dropCuts(id);
}

// ---------------------------------------------------------------- generation lifecycle

const inflight = { requested: false, armed: false, expectCut: false, mesid: -1 };
const hooks = { afterGeneration: null };

export function setHooks(partial) {
    Object.assign(hooks, partial);
}

export function isInflight() {
    return inflight.requested || inflight.armed;
}

export function resetInflight() {
    inflight.requested = false;
    inflight.armed = false;
    inflight.expectCut = false;
    inflight.mesid = -1;
}

/** GENERATION_STARTED (type, params, dryRun): only our own continue arms the lifecycle. */
export function onGenerationStarted(type, _params, dryRun) {
    if (!inflight.requested || dryRun || type !== 'continue') {
        return;
    }
    inflight.armed = true;
}

/** MESSAGE_SENT: the host just added the composer text as a user block; record where the model's text will start. */
export function onMessageSent(index) {
    if (!inflight.requested || !inflight.expectCut) {
        return;
    }
    const id = Number.isInteger(Number(index)) && messageAt(Number(index)) ? Number(index) : lastIndex();
    inflight.expectCut = false;
    inflight.mesid = id;
    pushCut(id);
}

export function onGenerationEnded() {
    if (!inflight.armed) {
        return;
    }
    finalize();
}

function finalize() {
    if (!inflight.requested && !inflight.armed) {
        return;
    }
    const mesid = inflight.mesid;
    resetInflight();
    if (mesid >= 0) {
        pruneEmptyCut(mesid);
    }
    clearDirection();
    hooks.afterGeneration?.();
}

export async function finishOpenEdit() {
    if (typeof document === 'undefined') {
        return;
    }
    const textarea = document.getElementById('curEditTextarea');
    const done = textarea?.closest('.mes')?.querySelector('.mes_edit_done');
    if (!textarea || !done) {
        return;
    }
    done.click();
    const deadline = Date.now() + 2000;
    while (document.getElementById('curEditTextarea') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

// A synchronous lock so two quick taps on Continue/Retry/Undo/Redo cannot both start.
let busy = false;

export function isBusy() {
    return busy;
}

async function locked(action) {
    if (busy) {
        return false;
    }
    busy = true;
    try {
        return await action();
    } finally {
        busy = false;
    }
}

/**
 * Continue the manuscript. With text in the composer the host adds it as the
 * user's block first (Generate consumes the textarea for type 'continue') and
 * then continues that block; with an empty composer it extends the last block.
 */
async function continueUnlocked({ hasText = false } = {}) {
    if (isInflight()) {
        return false;
    }
    inflight.requested = true;
    let started = false;
    try {
        await finishOpenEdit();
        const context = ctx();
        const last = lastIndex();
        if (last < 0 && !hasText) {
            toast('info', 'Write something first, then continue.');
            return false;
        }
        if (!hasText && context.chat[last]?.is_system) {
            toast('info', 'The last block is hidden from the model. Unhide it or write something first.');
            return false;
        }
        inflight.expectCut = hasText;
        inflight.mesid = hasText ? -1 : last;
        if (!hasText) {
            pushCut(last);
        }
        started = true;
        await context.generate('continue');
        return true;
    } catch (error) {
        console.error('[Story Mode] continue failed', error);
        toast('error', 'Story Mode could not continue the text.');
        return true;
    } finally {
        if (started) {
            finalize();
        } else {
            resetInflight();
        }
    }
}

export function continueStory(options) {
    return locked(() => continueUnlocked(options));
}

// ---------------------------------------------------------------- retry / undo / redo

const redoByChat = new Map();

function redoStack() {
    const key = String(ctx().chatId ?? '');
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

async function truncateLastContinuation() {
    const context = ctx();
    const index = lastIndex();
    const message = messageAt(index);
    if (!message) {
        return null;
    }
    const cuts = getCuts(message);
    if (!cuts.length) {
        return null;
    }
    const cut = cuts.pop();
    const text = String(message.mes ?? '');
    const tail = text.slice(cut);
    message.mes = text.slice(0, cut);
    syncSwipe(message);
    setCuts(message, cuts);
    await context.updateMessageBlock(index, message);
    await context.saveChat();
    return { mesid: index, cut, tail };
}

export function undo() {
    return locked(async () => {
        const context = ctx();
        if (isInflight()) {
            return false;
        }
        await finishOpenEdit();
        const index = lastIndex();
        const message = messageAt(index);
        if (!message) {
            return false;
        }
        if (getCuts(message).length) {
            const removed = await truncateLastContinuation();
            if (removed) {
                redoStack().push({ kind: 'tail', ...removed });
            }
            return true;
        }
        if (!message.is_user) {
            const copy = structuredClone(message);
            await context.deleteLastMessage();
            await context.saveChat();
            context.swipe?.refresh?.();
            redoStack().push({ kind: 'message', message: copy });
            return true;
        }
        toast('info', 'Nothing to undo: the last block is yours. Tap it to edit.');
        return false;
    });
}

export function redo() {
    return locked(async () => {
        const context = ctx();
        if (isInflight()) {
            return false;
        }
        const entry = redoStack().pop();
        if (!entry) {
            return false;
        }
        if (entry.kind === 'tail') {
            const message = messageAt(entry.mesid);
            if (!message || entry.mesid !== lastIndex() || String(message.mes ?? '').length !== entry.cut) {
                toast('info', 'That block changed since the undo, so there is nothing safe to put back.');
                return false;
            }
            storyExtra(message).cuts = [...getCuts(message), entry.cut];
            message.mes = String(message.mes ?? '') + entry.tail;
            syncSwipe(message);
            await context.updateMessageBlock(entry.mesid, message);
            await context.saveChat();
            return true;
        }
        if (entry.kind === 'message') {
            context.chat.push(entry.message);
            context.addOneMessage(entry.message);
            await context.saveChat();
            context.swipe?.refresh?.();
            return true;
        }
        return false;
    });
}

export function retry() {
    return locked(async () => {
        const context = ctx();
        if (isInflight()) {
            return false;
        }
        await finishOpenEdit();
        const index = lastIndex();
        const message = messageAt(index);
        if (!message) {
            return false;
        }
        if (getCuts(message).length) {
            const removed = await truncateLastContinuation();
            if (removed) {
                redoStack().push({ kind: 'tail', ...removed });
            }
            return continueUnlocked({ hasText: false });
        }
        if (!message.is_user) {
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
    return cleanTransformResult(raw, window.selection);
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
