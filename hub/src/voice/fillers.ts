// Hesitation sounds in dictation (change voice-input, D3): Scribe gets `no_verbatim=true`, and what it still leaves of
// «э-э-э», «эм», «ммм», «хм», «uh», «um» is dropped here. Only sounds that are never words: «а», «ну», «вот», «типа» stay,
// «мм» and «м» stay too (millimetres, metres).

/** A standalone hesitation: «э», «ээ», «э-э-э», «эм», «эмм», «ммм», «м-м-м», «хм», «uh», «um», «hmm». */
const FILLER = /(?<![\p{L}\p{N}-])(?:э+(?:[-‐–—]+э+)*м*|м{3,}|м+(?:[-‐–—]+м+)+|хм+|uh+|um+|h?m{3,}|hmm+)(?![\p{L}\p{N}-])/giu;

/** The text without hesitation sounds; punctuation left dangling by a removed sound goes with it. */
export function stripFillers(text: string): string {
  const out = text.replace(FILLER, ' ');
  if (out === text) return text;
  return (
    out
      .replace(/[ \t]{2,}/g, ' ')
      // «Привет. . Давай», «Подожди... ... ладно»: the sentence mark of the removed sound goes
      .replace(/([.!?…])[ \t]+[.!?…,;:]+/g, '$1')
      .replace(/[ \t]+([,.;:!?…])/g, '$1')
      .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
      .replace(/[,;:]+(?=\s*[.!?…])/g, '')
      .replace(/([.!?…])\s*[,;:]+/g, '$1')
      .replace(/^[\s,;:.!?…]+/, '')
      // a sentence that began with the removed sound; not after «...» or «…»
      .replace(/(^|(?<!\.)[.!?]\s+)(\p{Ll})/gu, (_m, before: string, letter: string) => before + letter.toUpperCase())
      .trim()
  );
}
