export const SIDE = 9;
export const CELL_COUNT = SIDE * SIDE;
export const DIGITS = Array.from({ length: SIDE }, (_, index) => index + 1);
export const ALL_DIGITS = (1 << SIDE) - 1;

export type Board = readonly (number | null)[];

export const CELLS = Array.from({ length: CELL_COUNT }, (_, index) => {
  const row = Math.floor(index / SIDE);
  const column = index % SIDE;
  const box = Math.floor(row / 3) * 3 + Math.floor(column / 3);
  return { index, row, column, box };
});

const boxUnits = Array.from({ length: SIDE }, (_, box) =>
  CELLS.filter((cell) => cell.box === box),
);

export const UNITS = [
  ...Array.from({ length: SIDE }, (_, row) => CELLS.filter((cell) => cell.row === row)),
  ...Array.from({ length: SIDE }, (_, column) => CELLS.filter((cell) => cell.column === column)),
  ...boxUnits,
];

export function conflictingCells(values: Board): Set<number> {
  const conflicts = new Set<number>();
  for (const unit of UNITS) {
    const firstByValue = new Map<number, number>();
    for (const { index } of unit) {
      const value = values[index];
      if (value == null) continue;
      const first = firstByValue.get(value);
      if (first === undefined) {
        firstByValue.set(value, index);
      } else {
        conflicts.add(first);
        conflicts.add(index);
      }
    }
  }
  return conflicts;
}

export function isDigit(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= SIDE;
}

export function isCellIndex(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < CELL_COUNT;
}

export function digitBit(value: number): number {
  return 1 << (value - 1);
}

export function bitDigit(bit: number): number {
  return 32 - Math.clz32(bit);
}

export const BIT_COUNTS = new Uint8Array(ALL_DIGITS + 1);
for (let mask = 1; mask <= ALL_DIGITS; mask += 1) {
  BIT_COUNTS[mask] = (BIT_COUNTS[mask >> 1] ?? 0) + (mask & 1);
}

type Cell = (typeof CELLS)[number];
type UsedDigits = { rows: Uint16Array; columns: Uint16Array; boxes: Uint16Array };

export function changeUsedDigits(used: UsedDigits, cell: Cell, bit: number): void {
  used.rows[cell.row]! ^= bit;
  used.columns[cell.column]! ^= bit;
  used.boxes[cell.box]! ^= bit;
}

export function availableDigits(used: UsedDigits, { row, column, box }: Cell): number {
  return ALL_DIGITS & ~(used.rows[row]! | used.columns[column]! | used.boxes[box]!);
}

export function boardMasks(board: Board): UsedDigits | null {
  if (board.length !== CELL_COUNT) return null;

  const used = {
    rows: new Uint16Array(SIDE),
    columns: new Uint16Array(SIDE),
    boxes: new Uint16Array(SIDE),
  };
  for (const cell of CELLS) {
    const value = board[cell.index];
    if (value === null) continue;
    if (value === undefined || !isDigit(value)) return null;

    const bit = digitBit(value);
    if ((availableDigits(used, cell) & bit) === 0) return null;
    changeUsedDigits(used, cell, bit);
  }
  return used;
}

/** Checks Sudoku legality for a solver placement, ignoring the value already in the target cell. */
export function canPlace(board: Board, index: number, value: number): boolean {
  if (board.length !== CELL_COUNT || !isCellIndex(index) || !isDigit(value)) return false;
  const current = board[index];
  if (current !== null && (current === undefined || !isDigit(current))) return false;

  const withoutTarget = board.slice();
  withoutTarget[index] = null;
  const used = boardMasks(withoutTarget);
  return used !== null && (availableDigits(used, CELLS[index]!) & digitBit(value)) !== 0;
}
