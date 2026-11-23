import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { sameGameBoard } from '../contracts/board-history.ts';
import { DIFFICULTIES, DIFFICULTY_RULES, completionStats } from '../contracts/game.ts';
import type { ActiveGame, Difficulty, GameSnapshot, Stats } from '../contracts/game.ts';
import { generateInWorker } from '../engine/generate-in-worker.ts';
import { restoreGame, startGame, updateGame } from '../engine/game.ts';
import type { GameAction, GameSession } from '../engine/game.ts';
import { useInstallState } from '../pwa/useInstallState.ts';
import { BoardPreview, GameBoard } from './Board.tsx';
import { SyncClient } from '../sync/client.ts';
import type { SyncView } from '../sync/client.ts';
import { canReapply, replicaStats } from '../sync/journal.ts';
import type { Replica } from '../sync/journal.ts';

type Screen = 'home' | 'game' | 'stats' | 'settings' | 'shop' | 'recovery';
type Prompt =
  | { type: 'difficulty' | 'complete' }
  | { type: 'clear-all'; gameId: string }
  | { type: 'replace' | 'generating' | 'generation-error'; difficulty: Difficulty };

const DIGITS = Array.from({ length: 9 }, (_, index) => index + 1);
const SETTINGS_TEETH = Array.from({ length: 8 }, (_, index) => index);

function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function Dialog({ title, description, children, onDismiss }: {
  title: string;
  description?: string;
  children: ReactNode;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    return () => { dialog?.close(); };
  }, []);

  return (
    <dialog className="prompt" ref={ref} aria-labelledby="prompt-title"
      aria-describedby={description ? 'prompt-description' : undefined}
      onCancel={(event) => { event.preventDefault(); onDismiss(); }}>
      <h2 id="prompt-title">{title}</h2>
      {description && <p id="prompt-description">{description}</p>}
      {children}
    </dialog>
  );
}

function Statistics({ stats }: { stats: Stats }) {
  return (
    <>
      {!DIFFICULTIES.some((difficulty) => stats[difficulty].completedCount > 0)
        && <p className="empty-note">Complete a puzzle to see your times here.</p>}
      <table className="stats-table" aria-label="Statistics by difficulty">
        <thead>
          <tr><th scope="col">Difficulty</th><th scope="col">Solved</th><th scope="col">Best time</th>
            <th scope="col"><abbr title="Average time">Avg. time</abbr></th></tr>
        </thead>
        <tbody>
          {DIFFICULTIES.map((difficulty) => {
            const { completedCount, bestTimeMs, totalTimeMs } = stats[difficulty];
            return (
              <tr key={difficulty}>
                <th scope="row"><span className="difficulty-dot" data-difficulty={difficulty} />
                  {DIFFICULTY_RULES[difficulty].label}</th>
                <td>{completedCount}</td>
                <td>{bestTimeMs === null ? '—' : duration(bestTimeMs)}</td>
                <td>{completedCount === 0 ? '—' : duration(totalTimeMs / completedCount)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

const phaseLabels = {
  loading: 'Opening saved progress…',
  syncing: 'Syncing…',
  synced: 'Synced',
  offline: 'Offline',
  error: 'Sync unavailable',
  'session-only': 'Progress stays in this tab',
};

function SaveStatus({ view, saving, onRetry, onReview }: {
  view: SyncView;
  saving: boolean;
  onRetry: () => void;
  onReview: () => void;
}) {
  const pending = view.replica?.pending.length ?? 0;
  const held = view.replica?.recovery.length ?? 0;
  const label = saving && view.phase !== 'session-only' ? 'Saving…'
    : view.phase === 'synced' && pending > 0 ? 'Saved locally' : phaseLabels[view.phase];
  return (
    <div className="sync-status">
      <p className="save-message" role="status">
        {label}{pending > 0 && view.phase !== 'session-only' ? ` · ${pending} pending` : ''}
      </p>
      <div className="sync-actions">
        {(view.phase === 'offline' || view.phase === 'error')
          && <button type="button" className="back-button" onClick={onRetry}>Retry sync</button>}
        {held > 0 && <button type="button" className="back-button" onClick={onReview}>Review saved changes ({held})</button>}
      </div>
    </div>
  );
}

function Recovery({ replica, onDecide }: { replica: Replica | null; onDecide: (id: string, reapply: boolean) => void }) {
  const items = replica?.recovery ?? [];
  return (
    <>
      <p className="empty-note">{items.length
        ? 'Choose which changes to sync again. Restoring a puzzle can replace the shared game.'
        : 'You’re up to date on saved changes.'}</p>
      <ul className="recovery-list">
        {items.map((item) => {
          const { operationId, intent, reason } = item;
          const game = intent.kind === 'import-completion' ? intent.completion : intent.game;
          const what = intent.kind === 'save-game' ? 'puzzle' : 'completion';
          return (
            <li key={operationId}>
              <strong>{DIFFICULTY_RULES[game.difficulty].label} {what} · {duration(game.elapsedMs)}</strong>
              <p className="save-message">{reason}</p>
              <div className="sync-actions">
                {canReapply(item, replica?.server ?? null) && (
                  <button type="button" className="button secondary" onClick={() => onDecide(operationId, true)}>
                    {what === 'puzzle' ? 'Use this puzzle' : 'Sync completion'}
                  </button>
                )}
                <button type="button" className="back-button" onClick={() => onDecide(operationId, false)}>Discard</button>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [client] = useState(() => new SyncClient());
  const [view, setView] = useState<SyncView>({ phase: 'loading', replica: null });
  const [writes, setWrites] = useState(0);
  const [gameWrites, setGameWrites] = useState(0);
  const [notice, setNotice] = useState('');
  const [session, setSession] = useState<GameSession | null>(null);
  const [selectedGiven, setSelectedGiven] = useState<number | null>(null);
  const [eraserEnabled, setEraserEnabled] = useState(false);
  const install = useInstallState();
  const sessionRef = useRef<GameSession | null>(null);
  const pending = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const newGameButton = useRef<HTMLButtonElement>(null);
  const clearAllButton = useRef<HTMLButtonElement>(null);
  const activeGame = view.replica?.active ?? null;

  useEffect(() => client.start(setView), [client]);

  const commit = useCallback((snapshot: GameSnapshot, previous?: ActiveGame) => {
    setWrites((count) => count + 1);
    if (!previous) setGameWrites((count) => count + 1);
    void client.save(snapshot, previous).finally(() => {
      setWrites((count) => count - 1);
      if (!previous) setGameWrites((count) => count - 1);
    });
  }, [client]);

  const setCurrent = useCallback((game: GameSession | null) => {
    sessionRef.current = game;
    setSession(game);
    if (game === null) {
      setSelectedGiven(null);
      setEraserEnabled(false);
    }
  }, []);

  const act = useCallback((action: GameAction) => {
    const current = sessionRef.current;
    if (current === null) return;

    const result = updateGame(current, action, performance.now());
    if (result.session !== current) setCurrent(result.session);
    if (result.session.snapshot !== current.snapshot) {
      if (action.type === 'erase') setSelectedGiven(null);
      const checkpoint = action.type === 'select' || action.type === 'checkpoint' || action.type === 'foreground';
      const previous = checkpoint && current.snapshot.status === 'active' ? current.snapshot : undefined;
      commit(result.session.snapshot, previous);
    }
    if (result.completion) setPrompt({ type: 'complete' });
  }, [commit, setCurrent]);

  function selectCell(index: number) {
    const snapshot = sessionRef.current?.snapshot;
    if (snapshot?.status !== 'active') return;
    if (snapshot.givens[index] !== null) {
      // Givens can be inspected without changing the saved editable cell.
      setSelectedGiven(index);
      return;
    }
    setSelectedGiven(null);
    act({ type: 'select', cell: index });
  }

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [screen]);

  useEffect(() => {
    if (screen !== 'game') return;
    const foreground = () => act({
      type: 'foreground',
      active: document.visibilityState === 'visible' && document.hasFocus(),
    });
    const pause = () => act({ type: 'foreground', active: false });
    foreground();
    const timer = window.setInterval(() => act({ type: 'checkpoint' }), 1000);
    document.addEventListener('visibilitychange', foreground);
    window.addEventListener('focus', foreground);
    window.addEventListener('blur', pause);
    window.addEventListener('pageshow', foreground);
    window.addEventListener('pagehide', pause);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', foreground);
      window.removeEventListener('focus', foreground);
      window.removeEventListener('blur', pause);
      window.removeEventListener('pageshow', foreground);
      window.removeEventListener('pagehide', pause);
    };
  }, [act, screen]);

  useEffect(() => {
    const current = sessionRef.current;
    if (screen !== 'game' || writes !== 0 || !current || current.snapshot.status !== 'active') return;
    const snapshot = current.snapshot;
    if (!activeGame || activeGame.gameId !== snapshot.gameId) {
      setCurrent(null);
      setPrompt(null);
      setNotice(activeGame ? 'The shared game changed. Continue to open the latest puzzle.'
        : 'That puzzle is no longer active.');
      setScreen('home');
      return;
    }
    if (snapshot.elapsedMs === activeGame.elapsedMs && snapshot.selectedCell === activeGame.selectedCell
      && sameGameBoard(snapshot, activeGame)) return;

    const restored = restoreGame(activeGame);
    if (restored) {
      setCurrent(updateGame(restored, {
        type: 'foreground', active: document.visibilityState === 'visible' && document.hasFocus(),
      }, performance.now()).session);
    }
  }, [activeGame, screen, setCurrent, writes]);

  useEffect(() => () => pending.current?.abort(), []);

  function navigate(destination: Screen) {
    if (screen === destination) return;
    if (screen === 'game') {
      act({ type: 'foreground', active: false });
      setCurrent(null);
    }
    setPrompt(null);
    setScreen(destination);
  }

  function dismissPrompt() {
    pending.current?.abort();
    pending.current = null;
    setPrompt(null);
    const focusTarget = prompt?.type === 'clear-all' ? clearAllButton : screen === 'home' ? newGameButton : heading;
    requestAnimationFrame(() => {
      focusTarget.current?.focus({ preventScroll: true });
    });
  }

  async function generate(difficulty: Difficulty) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setPrompt({ type: 'generating', difficulty });
    try {
      const result = await generateInWorker(difficulty, {}, controller.signal);
      if (controller.signal.aborted) return;
      if (result.status !== 'generated') {
        setPrompt({ type: 'generation-error', difficulty });
        return;
      }
      const next = startGame(result.puzzle);
      commit(next.snapshot);
      setCurrent(next);
      setNotice('');
      setPrompt(null);
      setScreen('game');
    } catch {
      if (!controller.signal.aborted) setPrompt({ type: 'generation-error', difficulty });
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }

  function continueGame() {
    const next = restoreGame(activeGame);
    if (next === null) {
      setNotice('The saved puzzle couldn’t be restored. Start a new game to play.');
      return;
    }
    setCurrent(next);
    setNotice('');
    setScreen('game');
  }

  const snapshot = session?.snapshot;
  const gameTitle = snapshot ? `${DIFFICULTY_RULES[snapshot.difficulty].label} puzzle` : 'Puzzle';
  const selectedCell = selectedGiven ?? snapshot?.selectedCell ?? null;
  const isPlaying = snapshot?.status === 'active';
  const eraserActive = isPlaying && eraserEnabled;
  const canEnter = isPlaying && !eraserActive && selectedGiven === null && snapshot.selectedCell !== null;
  const saveStatus = <SaveStatus view={view} saving={gameWrites > 0}
    onRetry={() => client.retry()} onReview={() => navigate('recovery')} />;
  const offlineStatus = {
    ready: view.phase === 'session-only' ? 'Sudoku can open offline. Progress stays in this tab.'
      : 'Offline play is ready on this device.',
    preparing: 'Preparing app files for offline play…',
    unavailable: 'Offline launch is unavailable. Open Sudoku again on a trusted connection.',
  };

  return (
    <>
      <header className="site-header">
        <div className="header-inner">
          <button type="button" className="wordmark" aria-label="Sudoku home" onClick={() => navigate('home')}>
            <span className="brand-grid" aria-hidden="true">
              {DIGITS.map((digit) => <span key={digit} />)}
            </span>
            Sudoku
          </button>
          <nav className="tools" aria-label="Main navigation">
            <button type="button" className="nav-button" aria-current={screen === 'stats' ? 'page' : undefined}
              aria-label="Statistics" onClick={() => navigate('stats')}>Stats</button>
            <button type="button" className="nav-button" aria-current={screen === 'shop' ? 'page' : undefined}
              onClick={() => navigate('shop')}>Shop</button>
            <button type="button" className="nav-button settings-button"
              aria-current={screen === 'settings' ? 'page' : undefined}
              aria-label="Settings" onClick={() => navigate('settings')}>
              <span className="gear" aria-hidden="true">
                {SETTINGS_TEETH.map((tooth) => <span key={tooth} />)}
              </span>
            </button>
          </nav>
        </div>
      </header>

      {install.updateWaiting && (
        <p className="update-message" role="status">
          An update is ready. Close all Sudoku windows and reopen when you’re ready.
        </p>
      )}

      {screen === 'home' && (
        <main className="page home-page">
          <div className="home-panel">
            <section className="home-controls">
              <h1 ref={heading} tabIndex={-1}>Sudoku</h1>
              <div className="home-actions">
                <button type="button" className="button primary" ref={newGameButton}
                  disabled={view.replica === null}
                  onClick={() => setPrompt({ type: 'difficulty' })}>New Game</button>
                <button type="button" className="button secondary" onClick={continueGame}
                  disabled={activeGame === null}>Continue Game</button>
              </div>
              {view.replica?.invalidSave ? (
                <p className="save-message error-message" role="alert">The saved puzzle couldn’t be restored. Start a new game to play.</p>
              ) : (
                <p className="save-message">
                  {activeGame
                    ? `${DIFFICULTY_RULES[activeGame.difficulty].label} puzzle in progress`
                    : 'No puzzle in progress'}
                </p>
              )}
              {notice && <p className="save-message" role="alert">{notice}</p>}
              {view.phase === 'offline' && !activeGame && view.replica?.server === null && (
                <p className="save-message">Reconnect to Tailscale to look for a shared puzzle, or start one offline.</p>
              )}
              {saveStatus}
            </section>
            <div className="home-preview" aria-hidden="true">
              <BoardPreview snapshot={activeGame} />
            </div>
          </div>
        </main>
      )}

      {screen === 'game' && snapshot && (
        <main className="page game-page">
          <div className="game-panel">
            <div className="game-heading">
              <h1 ref={heading} tabIndex={-1}>{gameTitle}</h1>
              {snapshot.status === 'solved' && (
                <span className="elapsed" aria-label={`Completion time ${duration(snapshot.elapsedMs)}`}>
                  {duration(snapshot.elapsedMs)}
                </span>
              )}
            </div>
            <GameBoard key={snapshot.gameId} snapshot={snapshot} selectedCell={selectedCell} eraserActive={eraserActive}
              onSelect={selectCell} onAction={act} />
            <div className="board-tools">
              <div className="board-actions">
                <button type="button" className="button secondary erase-button"
                  aria-pressed={eraserActive} disabled={!isPlaying}
                  onClick={() => setEraserEnabled((enabled) => !enabled)}>Eraser</button>
                <button type="button" className="button secondary"
                  disabled={!isPlaying || !snapshot.undoHistory?.entries.length}
                  onClick={() => act({ type: 'undo' })}>Undo</button>
                <button type="button" className="button secondary clear-all-button" ref={clearAllButton}
                  disabled={!isPlaying} onClick={() => setPrompt({ type: 'clear-all', gameId: snapshot.gameId })}>
                  Clear All
                </button>
              </div>
              <p id="keyboard-help" className="keyboard-help">{eraserActive
                ? 'Arrow keys move · Enter, Space or Delete erases'
                : 'Arrow keys move · 1–9 enter · Delete erases'}</p>
            </div>
            <div className="keypad" role="group" aria-label="Number pad">
              {DIGITS.map((digit) => (
                <button type="button" key={digit} disabled={!canEnter}
                  onClick={() => act({ type: 'place', digit })}>{digit}</button>
              ))}
            </div>
            <div className="game-footer">
              <button type="button" className="back-button" onClick={() => navigate('home')}>Back to Home</button>
              {saveStatus}
            </div>
          </div>
        </main>
      )}

      {(screen === 'stats' || screen === 'settings' || screen === 'shop' || screen === 'recovery') && (
        <main className="page details-page">
          <section className="details-panel">
            <h1 ref={heading} tabIndex={-1}>{screen === 'stats' ? 'Statistics'
              : screen === 'settings' ? 'Settings' : screen === 'shop' ? 'Shop' : 'Saved changes'}</h1>
            {screen === 'stats' && <Statistics stats={view.replica ? replicaStats(view.replica) : completionStats([])} />}
            {screen === 'settings' && (
              <section className="install-settings" aria-labelledby="install-heading">
                <h2 id="install-heading">Install and offline play</h2>
                <p role="status">{offlineStatus[install.availability]}</p>
                {!install.standalone && (
                  <p>On iPhone, open Sudoku in Safari and choose <strong>Share → Add to Home Screen</strong>.
                    Then open Sudoku from its icon while connected to Tailscale.</p>
                )}
              </section>
            )}
            {screen === 'shop' && <p className="empty-note">Coming later</p>}
            {screen === 'recovery' && <Recovery replica={view.replica}
              onDecide={(id, reapply) => { void client.resolveRecovery(id, reapply); }} />}
            <button type="button" className="back-button" onClick={() => navigate('home')}>Back to Home</button>
          </section>
        </main>
      )}

      {prompt?.type === 'difficulty' && (
        <Dialog title="Choose Difficulty" onDismiss={dismissPrompt}>
          <div className="difficulty-options">
            {DIFFICULTIES.map((difficulty, index) => (
              <button type="button" key={difficulty} data-initial-focus={index === 0 ? '' : undefined}
                onClick={() => activeGame ? setPrompt({ type: 'replace', difficulty }) : void generate(difficulty)}>
                <span className="difficulty-dot" data-difficulty={difficulty} />
                {DIFFICULTY_RULES[difficulty].label}
              </button>
            ))}
          </div>
          <button type="button" className="button secondary dialog-cancel" onClick={dismissPrompt}>Cancel</button>
        </Dialog>
      )}
      {prompt?.type === 'replace' && (
        <Dialog title="Start New Puzzle?" description="Your current puzzle will be replaced when the new puzzle is ready."
          onDismiss={dismissPrompt}>
          <div className="dialog-actions">
            <button type="button" className="button secondary" data-initial-focus onClick={dismissPrompt}>Cancel</button>
            <button type="button" className="button primary" onClick={() => void generate(prompt.difficulty)}>Start New</button>
          </div>
        </Dialog>
      )}
      {prompt?.type === 'clear-all' && snapshot?.gameId === prompt.gameId && isPlaying && (
        <Dialog title="Clear All Entries?" description="This erases all numbers and candidate notes you entered. The original clues will stay."
          onDismiss={dismissPrompt}>
          <div className="dialog-actions">
            <button type="button" className="button secondary" data-initial-focus onClick={dismissPrompt}>Cancel</button>
            <button type="button" className="button primary" onClick={() => {
              if (sessionRef.current?.snapshot.gameId === prompt.gameId) act({ type: 'clear-all' });
              dismissPrompt();
            }}>Clear All</button>
          </div>
        </Dialog>
      )}
      {prompt?.type === 'generating' && (
        <Dialog title="Generating Puzzle" description={`${DIFFICULTY_RULES[prompt.difficulty].label} puzzle`}
          onDismiss={dismissPrompt}>
          <button type="button" className="button secondary dialog-cancel" data-initial-focus onClick={dismissPrompt}>Cancel</button>
        </Dialog>
      )}
      {prompt?.type === 'generation-error' && (
        <Dialog title="Couldn’t Generate a Puzzle" description="Try again to generate a new puzzle." onDismiss={dismissPrompt}>
          <div className="dialog-actions">
            <button type="button" className="button secondary" onClick={dismissPrompt}>Cancel</button>
            <button type="button" className="button primary" data-initial-focus
              onClick={() => void generate(prompt.difficulty)}>Retry</button>
          </div>
        </Dialog>
      )}
      {prompt?.type === 'complete' && snapshot && (
        <Dialog title="Congratulations!" description={`Puzzle solved in ${duration(snapshot.elapsedMs)}.`}
          onDismiss={dismissPrompt}>
          <div className="dialog-actions">
            <button type="button" className="button secondary" onClick={dismissPrompt}>View Puzzle</button>
            <button type="button" className="button primary" data-initial-focus
              onClick={() => navigate('home')}>Back to Home</button>
          </div>
        </Dialog>
      )}
    </>
  );
}
