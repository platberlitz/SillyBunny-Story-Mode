# SillyBunny Story Mode

NovelAI-style co-writing inside SillyBunny. Turn it on for a chat and the chat stops being a row of speech bubbles and becomes one continuous manuscript that you and the model extend together. Press Continue and the model picks up exactly where the text stops - mid-sentence if that's where you left it. Tap any paragraph to edit it. Undo takes back the last continuation, Retry redoes it.

I built this because I wanted the NovelAI editor without giving up everything SillyBunny already does well. The character card, the lorebook, Author's Note, Summarize and the In-Chat Agent companions all keep working, because the chat *is* the manuscript: every paragraph is still a normal message underneath, so nothing else needs to know Story Mode exists.

It borrows from [errata](https://github.com/tealios/errata) as well: select a passage while editing and have it rewritten, expanded or compressed in place, and give the model a one-line direction for the next passage only.

## Install

1. Install `https://github.com/platberlitz/SillyBunny-Story-Mode` from SillyBunny's extension installer. For a manual install, put this folder in `data/<user>/extensions/SillyBunny-Story-Mode` for one user or `public/scripts/extensions/third-party/SillyBunny-Story-Mode` for everyone.
2. Reload SillyBunny and make sure Story Mode is enabled under Customize › Extensions.

No build step, no dependencies.

## Using it

**Turn it on** for the chat you're in: the wand menu has a 'Story Mode' entry, or type `/story on` (`/story off`, or just `/story` to toggle). It's remembered per chat. A card can ask for it by default (see below), and there's a setting to start every chat in it if that's how you write.

**Continue** is the button above the composer. With text in the box, your text goes in as the next block and the model continues from the end of it. With the box empty, the model extends the last paragraph. Either way it's SillyBunny's own Continue underneath, so if you're on Claude with 'Continue prefill' ticked, a model block is handed back as a prefill and continuations really do pick up mid-word.

**Retry** redoes the last continuation. **Undo** removes it, **Redo** puts it back. If the last block came from the normal send button instead, Retry swipes it and Undo deletes it, which is just SillyBunny doing what it always does.

**Direction** opens a one-line box. Whatever you type there goes to the model for the next continuation only and is cleared afterwards. 'Have the stranger turn out to be her brother', that sort of thing. It's NovelAI's inline instruction without the curly braces.

**Edit anything by tapping it.** That's SillyBunny's own message editor, restyled so the box looks like the page. Escape keeps your changes (the host normally throws them away on Escape, which I kept tripping over), and so does the tick.

**Rewrite a selection.** While a paragraph is open for editing, select some text and a small row appears: Rewrite, Expand, Compress, Custom... The result replaces the selection and nothing is saved until you close the editor, unless SillyBunny's message-edit auto-save setting is on. The row confirms when the browser added it to Ctrl+Z history. By default the model only sees the selection and a couple of paragraphs either side, which is cheap and quick; there's a setting to send the whole story if you'd rather it matched the voice better.

**Shading.** Text the model wrote gets a faint shade; yours doesn't. When the model finishes a paragraph you started, only its part is shaded. Editing a block resets that block to plain. Turn shading off in the settings if it annoys you.

## What the model actually sees

The usual SillyBunny prompt. Story Mode adds one short system line just before the block being continued: you're co-writing one manuscript, keep going from exactly where the text stops, write roughly this much. You can edit that text in the settings, and a card can carry its own version.

Everything else comes from what you already have:

- the card's description, personality and scenario sit at the top, like NovelAI's Memory
- Author's Note and the card's own depth prompt land a few messages from the end, like NovelAI's Author's Note
- World Info is the Lorebook
- the Summarize extension is the rolling memory, and the bundled In-Chat Agent companions (Plot Compass, Direction Menu, Continuity, Memory Shard, Lorebook Scout) keep working because they read the chat

## Setting up a card for Story Mode

A card turns out to be a decent container for a whole story. This is how I'd lay one out:

- **Description, personality, scenario** - write them as a story bible: the world, the premise, the cast in a paragraph each, the tone. This is the always-on block, so it's the NovelAI 'Memory'.
- **First message and alternate greetings** - the openings. Ship a few prologues and pick one when you start; greeting swipes switch between them.
- **Example messages** - two or three short passages in the voice you want. Tense, person, rhythm.
- **System prompt** - the co-writing rules for this card, if the general ones don't fit. With 'Prefer character prompt' on it replaces the preset's main prompt.
- **Post-history instructions** - the last-minute reminder: pacing, 'end mid-scene', 'never summarise'.
- **Character's note (depth prompt)** - a shipped Author's Note, N messages from the end.
- **Embedded lorebook** - the Lorebook proper. One concept per entry. Import it when SillyBunny offers to, because an embedded book isn't scanned until it's a real lorebook file.
- **Creator notes and tags** - the blurb and genre; never sent to the model.
- **Story Mode's own card settings** - in Customize › Extensions › Story Mode while the card is open: 'open this character's chats in Story Mode', and optional rules that replace the general ones. Both live inside the card, so they travel with it.

For an ensemble, put a 'Narrator' card (world and style) and one card per lead into a group with 'join character cards' on. The persona is either the protagonist (first person: its description is the protagonist's memory) or nobody (third person: use an empty one). To talk to a character about the story, open a second chat with the same card, or turn on the bundled Actor Interview companion.

## Things to know

- Chat completion APIs are the happy path. Text completion backends prefix every block with a name (`Ann:`), which spoils the manuscript illusion; use an instruct template with names off if you go that way.
- Empty-box Continue works in groups. If the composer contains text, send it first; the host does not add composer text during a group continuation, so Story Mode refuses rather than continuing the wrong block.
- Story Mode pauses the host's Auto-continue setting only while its own request runs, then restores it. One Story Continue stays one undoable passage.
- The shading of a model tail inside your own paragraph is measured against the rendered text, so markdown that straddles the join can shift it by a few characters. Cosmetic.
- Rewrites and the custom instruction are one-shot calls with no streaming, and the host's Stop button doesn't reach them; use the Stop in the row.
- Redo history lives in memory, is forgotten when you switch chats and is discarded after a divergent edit or generation. Revision-checked cut points are saved with each message, so Undo survives a reload without applying stale offsets to edited text.

## Settings

Customize › Extensions › Story Mode: the per-chat switch, the start-in-Story-Mode default, the open card's own switch and rules, shading, serif font, the rules text (with a reset), the length hint, and whether rewrites see the whole story.

## Development

```
npm test      # node --test
npm run check # node --check on every JavaScript file
```

`src/core.js` is pure and covered by tests, `src/api.js` is every call into the host, `src/ui.js` is the DOM, `style.css` is the manuscript look gated on `body.sbstory`. The version lives in `manifest.json` and `package.json`.
