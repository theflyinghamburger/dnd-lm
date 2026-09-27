// ponytail: chars/4 is a tokenizer-free estimate, good to ±20% and biased to
// overcount at this layer's typical prose. A real tokenizer is a one-line swap
// in `estimateTokens` if budget headroom ever turns out to matter.
/** The divisor `estimateTokens` uses, named so a budget can be turned back into characters. */
export const CHARS_PER_TOKEN = 4;

/**
 * Its own module so `NotesService` can count tokens without importing
 * `context.ts`, which injects it — a runtime import cycle would leave one
 * class undefined in the other's DI metadata.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);
