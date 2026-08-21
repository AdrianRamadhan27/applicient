export type DiffToken = { type: "same" | "add" | "remove"; text: string };

function tokenize(s: string): string[] {
  return s.match(/\S+|\s+/g) ?? [];
}

/** Word-level diff via a plain LCS dynamic program — texts here are
 * sentence/paragraph length (a CV bullet vs. its source evidence
 * item), so the O(n*m) table is trivially small; no need for a
 * Myers-diff library for this size of input. */
export function wordDiff(a: string, b: string): DiffToken[] {
  const aTokens = tokenize(a);
  const bTokens = tokenize(b);
  const n = aTokens.length;
  const m = bTokens.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aTokens[i] === bTokens[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aTokens[i] === bTokens[j]) {
      result.push({ type: "same", text: aTokens[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "remove", text: aTokens[i] });
      i++;
    } else {
      result.push({ type: "add", text: bTokens[j] });
      j++;
    }
  }
  while (i < n) {
    result.push({ type: "remove", text: aTokens[i] });
    i++;
  }
  while (j < m) {
    result.push({ type: "add", text: bTokens[j] });
    j++;
  }
  return result;
}
