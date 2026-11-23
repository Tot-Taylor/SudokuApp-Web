import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { GameSnapshot } from '../contracts/game.ts';
import { CELLS, DIGITS, SIDE, conflictingCells, digitBit } from '../engine/board.ts';
import type { Board } from '../engine/board.ts';
import type { GameAction } from '../engine/game.ts';
import { cellHighlight } from './cell-highlight.ts';

const ROWS = Array.from({ length: SIDE }, (_, row) => CELLS.slice(row * SIDE, (row + 1) * SIDE));
const SAMPLE = Array.from('530070000600195000098000060800060003400803001700020006060000280000419005000080079',
  (digit) => Number(digit) || null);

export function BoardPreview({ snapshot }: { snapshot: GameSnapshot | null }) {
  const givens: Board = snapshot?.givens ?? SAMPLE;
  const values: Board = snapshot?.values ?? SAMPLE;
  return (
    <div className="board preview-board" aria-hidden="true">
      {ROWS.map((row, index) => (
        <div className="grid-row" key={index}>
          {row.map((cell) => (
            <div className="grid-cell" key={cell.index} data-given={givens[cell.index] !== null}>
              {values[cell.index]}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const ARROW_OFFSET: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0],
};

export function GameBoard({
  snapshot, selectedCell, eraserActive, onSelect, onDigit, onAction,
}: {
  snapshot: GameSnapshot;
  selectedCell: number | null;
  eraserActive: boolean;
  onSelect: (index: number) => void;
  onDigit: (digit: number) => void;
  onAction: (action: GameAction) => void;
}) {
  const { givens, values, candidateNotes, status } = snapshot;
  const conflicts = conflictingCells(values);
  const [focusIndex, setFocusIndex] = useState(() => selectedCell ?? givens.indexOf(null));
  const cellRefs = useRef<Array<HTMLDivElement | null>>([]);

  function moveFocus(index: number) {
    cellRefs.current[index]?.focus();
  }

  function activateCell(index: number) {
    if (eraserActive) onAction({ type: 'erase', cell: index });
    else onSelect(index);
  }

  function handleKey(event: KeyboardEvent<HTMLDivElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const cell = CELLS[index]!;
    const offset = ARROW_OFFSET[event.key];
    if (offset) {
      event.preventDefault();
      const row = Math.max(0, Math.min(SIDE - 1, cell.row + offset[0]));
      const column = Math.max(0, Math.min(SIDE - 1, cell.column + offset[1]));
      const target = row * SIDE + column;
      moveFocus(target);
      onSelect(target);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const target = cell.row * SIDE + (event.key === 'End' ? SIDE - 1 : 0);
      moveFocus(target);
      onSelect(target);
      return;
    }
    if (status !== 'active') return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateCell(index);
      return;
    }
    if (givens[index] !== null) return;

    if (/^[1-9]$/.test(event.key)) {
      event.preventDefault();
      if (eraserActive) return;
      onSelect(index);
      onDigit(Number(event.key));
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      if (!eraserActive) onSelect(index);
      onAction({ type: 'erase', cell: index });
    }
  }

  return (
    <div className="board" role="grid" aria-label="Sudoku board" aria-describedby="keyboard-help"
      aria-readonly={status === 'solved'}>
      {ROWS.map((row, index) => (
        <div className="grid-row" role="row" key={index}>
          {row.map((cell) => {
            const value = values[cell.index];
            const isGiven = givens[cell.index] !== null;
            const hasConflict = conflicts.has(cell.index);
            const highlight = cellHighlight(values, selectedCell, cell.index);
            const notes = value === null ? candidateNotes?.[cell.index] : undefined;
            const candidates = notes ? DIGITS.filter((digit) => notes & digitBit(digit)) : null;
            const contents = candidates ? `empty, candidates ${candidates.join(', ')}` : value ?? 'empty';
            const label = `Row ${cell.row + 1}, column ${cell.column + 1}, ${contents}${isGiven ? ', given' : ''}`;
            return (
              <div
                className="grid-cell"
                key={cell.index}
                ref={(node) => { cellRefs.current[cell.index] = node; }}
                role="gridcell"
                tabIndex={cell.index === focusIndex ? 0 : -1}
                aria-label={label}
                aria-selected={highlight === 'selected'}
                aria-readonly={isGiven || status === 'solved'}
                aria-invalid={hasConflict || undefined}
                aria-description={hasConflict ? 'Duplicate number in its row, column, or box.' : undefined}
                data-given={isGiven}
                data-highlight={highlight}
                onFocus={() => setFocusIndex(cell.index)}
                onClick={() => {
                  moveFocus(cell.index);
                  activateCell(cell.index);
                }}
                onKeyDown={(event) => handleKey(event, cell.index)}
              >
                {candidates ? (
                  <span className="candidate-marks" aria-hidden="true">
                    {DIGITS.map((digit) => <span key={digit}>{candidates.includes(digit) ? digit : null}</span>)}
                  </span>
                ) : value}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
