/** Collapses runs of whitespace to one space and clips to `max` characters with an ellipsis. */
export const clip = (s: string, max: number): string => {
  const flat = s.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
