import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_RULES,
    DEFAULT_SETTINGS,
    EXTRA_KEY,
    buildDirection,
    buildRules,
    buildTransformPrompt,
    classifyBlock,
    cleanTransformResult,
    clampTokens,
    computeJoins,
    contextWindow,
    endsMidSentence,
    escapeMacros,
    getCuts,
    normalizeSettings,
    parseStoryArg,
    resolveEnabled,
    wordCount,
} from '../src/core.js';

test('endsMidSentence recognises unfinished text and ignores decoration', () => {
    assert.equal(endsMidSentence('She opened the door and'), true);
    assert.equal(endsMidSentence('She opened the door.'), false);
    assert.equal(endsMidSentence('"Run," he said.'), false);
    assert.equal(endsMidSentence('He said "no."'), false);
    assert.equal(endsMidSentence('He said "no"'), true);
    assert.equal(endsMidSentence('Wait…'), false);
    assert.equal(endsMidSentence('Really?!'), false);
    assert.equal(endsMidSentence('the *door*'), true);
    assert.equal(endsMidSentence('(and then'), true);
    assert.equal(endsMidSentence('A finished paragraph\n'), false);
    assert.equal(endsMidSentence('Still going   '), true);
    assert.equal(endsMidSentence(''), false);
    assert.equal(endsMidSentence('   '), false);
    assert.equal(endsMidSentence(null), false);
    assert.equal(endsMidSentence('***'), false);
});

test('getCuts and classifyBlock derive origin from is_user and the recorded cuts', () => {
    assert.deepEqual(getCuts({}), []);
    assert.deepEqual(getCuts({ extra: { [EXTRA_KEY]: { cuts: [3, -1, 'x', 7.5, 9] } } }), [3, 9]);
    assert.deepEqual(classifyBlock({ is_user: false, mes: 'model text' }), { origin: 'model', cut: null, cuts: [] });
    assert.deepEqual(classifyBlock({ is_user: true, mes: 'mine' }), { origin: 'user', cut: null, cuts: [] });
    assert.deepEqual(classifyBlock({ is_user: true, mes: 'mine and theirs', extra: { [EXTRA_KEY]: { cuts: [4, 10] } } }), { origin: 'mixed', cut: 4, cuts: [4, 10] });
});

test('computeJoins marks blocks that finish the previous visible block', () => {
    const chat = [
        { mes: 'A full sentence.' },
        { mes: 'She opened the door and' },
        { mes: 'hidden', is_system: true },
        { mes: 'saw nothing.' },
        { mes: 'Another start' },
    ];
    assert.deepEqual([...computeJoins(chat)], [3]);
    assert.deepEqual([...computeJoins(null)], []);
    assert.deepEqual([...computeJoins([{ mes: 'alone and' }])], []);
});

test('buildRules fills the length hint and falls back to the default text', () => {
    assert.equal(buildRules('Write {{length}} now', { lengthHint: 'one paragraph' }), 'Write one paragraph now');
    assert.equal(buildRules('Write {{LENGTH}}', { lengthHint: 'a lot' }), 'Write a lot');
    assert.equal(buildRules('   ', { lengthHint: 'x' }), DEFAULT_RULES.replace('{{length}}', 'x'));
    assert.equal(buildRules(undefined, {}), DEFAULT_RULES.replace('{{length}}', DEFAULT_SETTINGS.lengthHint));
    assert.ok(!buildRules(DEFAULT_RULES, {}).includes('{{length}}'));
});

test('buildDirection wraps the text, collapses whitespace and neutralises macros', () => {
    assert.equal(buildDirection('  make it  rain\nhard '), '[Direction for the next passage only: make it rain hard]');
    assert.equal(buildDirection('use {{char}} twice'), '[Direction for the next passage only: use { {char} } twice]');
    assert.equal(buildDirection(''), '');
    assert.equal(buildDirection(null), '');
    assert.equal(escapeMacros('{{a}} {{b}}'), '{ {a} } { {b} }');
});

test('contextWindow returns the selection with a few paragraphs either side', () => {
    const value = 'P1 first.\n\nP2 second.\n\nP3 third with SELECTED words.\n\nP4 fourth.\n\nP5 fifth.\n\nP6 sixth.';
    const start = value.indexOf('SELECTED');
    const end = start + 'SELECTED words'.length;
    const window = contextWindow(value, start, end, 2);
    assert.equal(window.selection, 'SELECTED words');
    assert.equal(window.before, 'P2 second.\n\nP3 third with');
    assert.equal(window.after, '.\n\nP4 fourth.');
    const reversed = contextWindow(value, end, start, 1);
    assert.equal(reversed.selection, 'SELECTED words');
    assert.equal(reversed.before, 'P3 third with');
    assert.equal(contextWindow('abc', 0, 3).before, '');
    assert.equal(contextWindow('abc', 0, 3).after, '');
});

test('buildTransformPrompt shapes the prompt and sizes the reply', () => {
    const selection = 'x'.repeat(350);
    const rewrite = buildTransformPrompt('rewrite', { before: 'B', selection, after: 'A' });
    assert.ok(rewrite.systemPrompt.includes('replacement passage only'));
    assert.match(rewrite.prompt, /^Rewrite the passage/);
    assert.ok(rewrite.prompt.includes('Text before the passage:\nB'));
    assert.ok(rewrite.prompt.includes(`Passage to change:\n${selection}`));
    assert.ok(rewrite.prompt.includes('Text after the passage:\nA'));
    assert.ok(rewrite.prompt.endsWith('Replacement passage:'));
    assert.equal(rewrite.responseLength, 200);
    assert.equal(buildTransformPrompt('expand', { selection }).responseLength, 300);
    assert.equal(buildTransformPrompt('compress', { selection }).responseLength, 125);
    assert.equal(buildTransformPrompt('rewrite', { selection: 'short' }).responseLength, 64);
    assert.equal(buildTransformPrompt('expand', { selection: 'y'.repeat(5000) }).responseLength, 1024);
    const custom = buildTransformPrompt('custom', { selection: 's', instruction: ' Make it sad ' });
    assert.match(custom.prompt, /^Make it sad\n\nPassage to change:/);
    assert.match(buildTransformPrompt('custom', { selection: 's' }).prompt, /^Improve the passage\./);
    assert.match(buildTransformPrompt('nonsense', { selection: 's' }).prompt, /^Rewrite the passage/);
    assert.equal(clampTokens(NaN), 64);
});

test('cleanTransformResult strips fences, labels and unwanted wrapping quotes', () => {
    assert.equal(cleanTransformResult('```text\nHello there.\n```'), 'Hello there.');
    assert.equal(cleanTransformResult('Replacement passage: Hello there.'), 'Hello there.');
    assert.equal(cleanTransformResult('"Hello there."', 'plain selection'), 'Hello there.');
    assert.equal(cleanTransformResult('"Hello there."', '"quoted selection"'), '"Hello there."');
    assert.equal(cleanTransformResult('“Hello.”'), 'Hello.');
    assert.equal(cleanTransformResult('  spaced  '), 'spaced');
    assert.equal(cleanTransformResult(null), '');
});

test('normalizeSettings applies defaults and keeps valid values', () => {
    assert.deepEqual(normalizeSettings(undefined), { ...DEFAULT_SETTINGS });
    assert.deepEqual(normalizeSettings('junk'), { ...DEFAULT_SETTINGS });
    const custom = normalizeSettings({ defaultOn: true, tint: false, serif: true, rules: 'R', lengthHint: ' ', transformsUseFullContext: true, extra: 1 });
    assert.deepEqual(custom, { version: 1, defaultOn: true, tint: false, serif: true, rules: 'R', lengthHint: DEFAULT_SETTINGS.lengthHint, transformsUseFullContext: true });
});

test('resolveEnabled prefers the chat flag, then the card, then the global default', () => {
    assert.equal(resolveEnabled({ chatFlag: false, cardDefault: true, globalDefault: true }), false);
    assert.equal(resolveEnabled({ chatFlag: true, cardDefault: false, globalDefault: false }), true);
    assert.equal(resolveEnabled({ cardDefault: true, globalDefault: false }), true);
    assert.equal(resolveEnabled({ cardDefault: false, globalDefault: true }), false);
    assert.equal(resolveEnabled({ globalDefault: true }), true);
    assert.equal(resolveEnabled({}), false);
    assert.equal(resolveEnabled(), false);
});

test('parseStoryArg understands on, off, toggle and rejects junk', () => {
    assert.equal(parseStoryArg('on', false), true);
    assert.equal(parseStoryArg('OFF', true), false);
    assert.equal(parseStoryArg('', true), false);
    assert.equal(parseStoryArg(undefined, false), true);
    assert.equal(parseStoryArg('toggle', false), true);
    assert.equal(parseStoryArg('maybe', false), null);
});

test('wordCount ignores hidden blocks', () => {
    assert.equal(wordCount([{ mes: 'one two' }, { mes: 'three', is_system: true }, { mes: '  four\nfive ' }, null]), 4);
    assert.equal(wordCount(undefined), 0);
});
