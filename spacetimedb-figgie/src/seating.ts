export const DECK_SIZE = 40;
export const POT = 200;
export const START_CASH = 350;

// Seat as many bots as possible in the fewest valid tables. Six or seven
// fill just one table; eight fit at two fours, and nine sit five plus four.
export function tableSizes(visitors: number): number[] {
  if (visitors < 4) return [];
  let tables = Math.ceil(visitors / 5);
  if (4 * tables > visitors) tables--;
  const seated = Math.min(visitors, 5 * tables);
  return Array.from({ length: tables }, (_, i) => Math.ceil((seated - i) / tables));
}

export function dealHands(deck: number[], seats: number): number[][] {
  const handSize = DECK_SIZE / seats;
  return Array.from({ length: seats }, (_, i) => {
    const counts = [0, 0, 0, 0];
    for (const card of deck.slice(i * handSize, (i + 1) * handSize)) counts[card]++;
    return counts;
  });
}
