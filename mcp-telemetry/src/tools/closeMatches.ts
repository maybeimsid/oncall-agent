// Suggestions for an unknown service name, shared by the tools that take one.

const MAX_SUGGESTIONS = 5;
const MAX_DISTANCE = 2;

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost));
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

/** Up to 5 known names within edit distance 2 (substrings count as 0), closest first. */
export function closeMatches(name: string, known: string[]): string[] {
  return known
    .map((k) => ({ k, d: k.includes(name) || name.includes(k) ? 0 : editDistance(name, k) }))
    .filter((x) => x.d <= MAX_DISTANCE)
    .sort((x, y) => x.d - y.d || x.k.localeCompare(y.k))
    .slice(0, MAX_SUGGESTIONS)
    .map((x) => x.k);
}
