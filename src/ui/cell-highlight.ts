import { CELLS } from '../engine/board.ts';
import type { Board } from '../engine/board.ts';

export function cellHighlight(values: Board, selectedIndex: number | null, index: number) {
  if (selectedIndex === null) return undefined;
  if (index === selectedIndex) return 'selected';

  const selectedValue = values[selectedIndex];
  if (selectedValue != null && values[index] === selectedValue) return 'match';

  const selected = CELLS[selectedIndex]!;
  const cell = CELLS[index]!;
  if (cell.row === selected.row || cell.column === selected.column || cell.box === selected.box) return 'peer';
  return undefined;
}
