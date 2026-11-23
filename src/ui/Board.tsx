import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { GameSnapshot } from '../contracts/game.ts';
import { CELLS, SIDE } from '../engine/board.ts';
import type { Board } from '../engine/board.ts';
import type { GameAction } from '../engine/game.ts';

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
  snapshot, onAction,
}: {
  snapshot: GameSnapshot;
  onAction: (action: GameAction) => void;
}) {
  const { givens, values, selectedCell, status } = snapshot;
  const [focusIndex, setFocusIndex] = useState(() => selectedCell ?? givens.indexOf(null));
  const cellRefs = useRef<Array<HTMLDivElement | null>>([]);

  function select(index: number) {
    if (status === 'active' && givens[index] === null) onAction({ type: 'select', cell: index });
  }

  function moveFocus(index: number) {
    cellRefs.current[index]?.focus();
    select(index);
  }

  function handleKey(event: KeyboardEvent<HTMLDivElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const cell = CELLS[index]!;
    const offset = ARROW_OFFSET[event.key];
    if (offset) {
      event.preventDefault();
      const row = Math.max(0, Math.min(SIDE - 1, cell.row + offset[0]));
      const column = Math.max(0, Math.min(SIDE - 1, cell.column + offset[1]));
      moveFocus(row * SIDE + column);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      moveFocus(cell.row * SIDE + (event.key === 'End' ? SIDE - 1 : 0));
      return;
    }
    if (status !== 'active' || givens[index] !== null) return;

    if (/^[1-9]$/.test(event.key)) {
      event.preventDefault();
      select(index);
      onAction({ type: 'place', digit: Number(event.key) });
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault();
      select(index);
      onAction({ type: 'erase' });
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(index);
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
            const isSelected = cell.index === selectedCell;
            const label = `Row ${cell.row + 1}, column ${cell.column + 1}, ${value ?? 'empty'}${isGiven ? ', given' : ''}`;
            return (
              <div
                className="grid-cell"
                key={cell.index}
                ref={(node) => { cellRefs.current[cell.index] = node; }}
                role="gridcell"
                tabIndex={cell.index === focusIndex ? 0 : -1}
                aria-label={label}
                aria-selected={isSelected}
                aria-readonly={isGiven || status === 'solved'}
                data-given={isGiven}
                onFocus={() => setFocusIndex(cell.index)}
                onClick={() => { moveFocus(cell.index); }}
                onKeyDown={(event) => handleKey(event, cell.index)}
              >
                {value}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
