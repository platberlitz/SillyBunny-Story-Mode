/**
 * Story Mode: NovelAI-style co-writing on top of the normal SillyBunny chat.
 * The chat is the manuscript (one message = one block); this file only wires
 * the host's events to src/api.js (host I/O) and src/ui.js (DOM).
 */
import * as api from './src/api.js';
import * as ui from './src/ui.js';
import { BODY_CLASS, parseStoryArg } from './src/core.js';

const subscriptions = [];
let active = false;
let observer = null;
let stampFrame = 0;
let commandsReady = false;

function ctx() {
    return globalThis.SillyTavern.getContext();
}

function subscribe(context, eventType, handler) {
    if (!eventType) {
        return;
    }
    context.eventSource.on(eventType, handler);
    subscriptions.push({ eventType, handler });
}

function unsubscribeAll() {
    const context = ctx();
    for (const { eventType, handler } of subscriptions.splice(0)) {
        context.eventSource.removeListener(eventType, handler);
    }
}

function assertCapabilities(context) {
    const missing = [];
    for (const [name, available] of [
        ['extension settings', context.extensionSettings && typeof context.saveSettingsDebounced === 'function'],
        ['event source', typeof context.eventSource?.on === 'function' && typeof context.eventSource?.removeListener === 'function'],
        ['chat metadata', typeof context.saveMetadataDebounced === 'function'],
        ['generation', typeof context.generate === 'function' && typeof context.generateRaw === 'function' && typeof context.generateQuietPrompt === 'function'],
        ['prompt injection', typeof context.setExtensionPrompt === 'function'],
        ['message editing', typeof context.updateMessageBlock === 'function' && typeof context.deleteLastMessage === 'function' && typeof context.addOneMessage === 'function' && typeof context.saveChat === 'function'],
        ['swipes', typeof context.swipe?.right === 'function'],
        ['card fields', typeof context.writeExtensionField === 'function'],
        ['message formatting', typeof context.messageFormatting === 'function'],
    ]) {
        if (!available) {
            missing.push(name);
        }
    }
    for (const event of ['APP_READY', 'CHAT_CHANGED', 'MESSAGE_SENT', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_EDITED']) {
        if (!context.eventTypes?.[event]) {
            missing.push(`event ${event}`);
        }
    }
    if (missing.length > 0) {
        throw new Error(`Unsupported SillyBunny context; missing ${missing.join(', ')}`);
    }
}

function scheduleStamp() {
    if (!document.body.classList.contains(BODY_CLASS)) {
        return;
    }
    cancelAnimationFrame(stampFrame);
    stampFrame = requestAnimationFrame(() => {
        try {
            ui.stampBlocks();
        } catch (error) {
            console.warn('[Story Mode] stamping failed', error);
        }
    });
}

/** Re-resolves the per-chat state and makes the page match it. */
function apply() {
    const enabled = api.isEnabled();
    if (enabled) {
        api.setRules();
    } else {
        api.clearRules();
        api.clearDirection();
    }
    ui.applyState(enabled);
    ui.renderDrawer();
}

async function setEnabled(enabled) {
    if (!api.hasChat()) {
        api.toast('info', 'Open a chat first, then turn Story Mode on.');
        ui.renderDrawer();
        return false;
    }
    api.setChatFlag(enabled);
    apply();
    return enabled;
}

async function onStoryCommand(arg) {
    const next = parseStoryArg(arg, api.isEnabled());
    if (next === null) {
        return 'Use /story on, /story off or /story toggle.';
    }
    if (!api.hasChat()) {
        return 'Open a chat first.';
    }
    await setEnabled(next);
    return next ? 'on' : 'off';
}

function observeChat() {
    const chat = document.getElementById('chat');
    if (!chat || observer) {
        return;
    }
    observer = new MutationObserver(() => {
        ui.checkEditor();
        scheduleStamp();
    });
    observer.observe(chat, { childList: true, subtree: true });
}

function mountAll() {
    ui.mountBar();
    ui.mountTransformRow();
    ui.bindClickToEdit();
    ui.bindEscapeSave();
    ui.bindSelectionWatch();
    ui.ensureMenuItem({ onToggle: () => setEnabled(!api.isEnabled()) });
    ui.ensureDrawer({ onChatToggle: setEnabled, onChange: apply });
    observeChat();
    if (!commandsReady) {
        commandsReady = api.registerCommands({ onToggle: onStoryCommand });
    }
    apply();
}

function start() {
    if (active) {
        return;
    }
    const context = ctx();
    assertCapabilities(context);
    const events = context.eventTypes;
    try {
        api.setHooks({
            afterGeneration: () => {
                ui.clearDirectionInput();
                ui.setBusy(false);
                scheduleStamp();
            },
        });
        subscribe(context, events.APP_READY, () => {
            try {
                mountAll();
            } catch (error) {
                console.error('[Story Mode] could not mount', error);
            }
        });
        subscribe(context, events.CHAT_CHANGED, () => {
            api.clearRedo();
            api.resetInflight();
            ui.setBusy(false);
            apply();
        });
        subscribe(context, events.MESSAGE_SENT, (index) => api.onMessageSent(index));
        subscribe(context, events.GENERATION_STARTED, (type, params, dryRun) => {
            api.onGenerationStarted(type, params, dryRun);
            if (api.isInflight()) {
                ui.setBusy(true);
            }
        });
        subscribe(context, events.GENERATION_ENDED, () => api.onGenerationEnded());
        subscribe(context, events.GENERATION_STOPPED, () => api.onGenerationEnded());
        subscribe(context, events.MESSAGE_EDITED, (index) => {
            api.onMessageEdited(index);
            scheduleStamp();
        });
        for (const name of ['MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_RECEIVED', 'MORE_MESSAGES_LOADED', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED']) {
            subscribe(context, events[name], scheduleStamp);
        }
        active = true;
        // APP_READY is sticky in the host, but enabling after load still needs a direct mount.
        if (document.getElementById('send_form')) {
            mountAll();
        }
    } catch (error) {
        active = false;
        unsubscribeAll();
        throw error;
    }
}

async function stop() {
    if (!active) {
        return;
    }
    active = false;
    unsubscribeAll();
    observer?.disconnect();
    observer = null;
    cancelAnimationFrame(stampFrame);
    try {
        api.clearRules();
        api.clearDirection();
        api.resetInflight();
        api.clearRedo();
    } catch (error) {
        console.warn('[Story Mode] cleanup skipped a step', error);
    }
    ui.unmountAll();
}

export function activate() {
    start();
}

export function enable() {
    start();
}

export function disable() {
    return stop();
}
