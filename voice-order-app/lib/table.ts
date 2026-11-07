// Plain-code detection of "Table 12" style pickup requests. No AI involved.

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

// Words that may surround a table number in a pickup request.
const FILLER = new Set([
  "table", "tables", "number", "no", "order", "orders", "for", "what", "whats",
  "s", "the", "pickup", "pick", "up", "ready", "please", "get", "is", "on",
  "my", "give", "me", "show", "check", "food", "at", "hey", "ok", "okay",
]);

function wordsToNumber(tokens: string[]): number | null {
  if (tokens.length === 0) return null;
  if (tokens.length === 1 && /^\d+$/.test(tokens[0])) return parseInt(tokens[0], 10);
  let total: number;
  let i = 1;
  if (tokens[0] in TENS) {
    total = TENS[tokens[0]];
    if (tokens[1] !== undefined && tokens[1] in ONES && ONES[tokens[1]] >= 1 && ONES[tokens[1]] <= 9) {
      total += ONES[tokens[1]];
      i = 2;
    }
  } else if (tokens[0] in ONES) {
    total = ONES[tokens[0]];
  } else {
    return null;
  }
  return i === tokens.length ? total : null;
}

/**
 * Returns the table number if the transcript is ONLY a table reference
 * ("Table 12", "table twelve please", "what's the order for table 4"),
 * otherwise null (meaning it's a new order to be parsed).
 */
export function parseRecall(transcript: string): number | null {
  const tokens = transcript
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const remaining = tokens.filter((t) => !FILLER.has(t));
  return wordsToNumber(remaining);
}
