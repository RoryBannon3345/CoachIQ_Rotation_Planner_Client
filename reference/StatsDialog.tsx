/**
 * The game Stats dialog — the whole of the coach's traffic with the separate iPhone stats app,
 * in one modal: send this game's roster over, bring its numbers back, read them.
 *
 * Modal mechanics are `AboutDialog.tsx`'s, copied rather than shared (portal to `document.body`,
 * Escape, backdrop mousedown, a Tab trap, focus returned to the trigger) with one difference: the
 * trap's `FOCUSABLE` also covers the fields, because unlike About this card is full of them.
 *
 * Every decision this file makes is a rendering decision. What the payload says, what an import
 * would do, and what the numbers add up to are all answered by pure modules that are tested
 * without a DOM — `contract/statsContract.ts`, `store/rosterPayload.ts`, `store/importStats.ts`,
 * `store/statsView.ts` — and nothing here recomputes any of it.
 *
 * The one flow worth reading twice is the two-step import of a payload whose game id names no
 * game here. `importGameStats` refuses a preview whose `gameId` is `null` or disagrees with the
 * game it is asked to write to (see its docblock: `replacesExisting`, `matched`/`joining` and
 * every score conflict are facts about one specific game). So the first, unresolved preview is
 * never applied — it only supplies the `Import into` list. Picking a game re-runs `previewImport`
 * against that game and *that* answer is what the coach sees and what Import applies.
 *
 * Nothing here needs a print rule: `@media print` hides every child of `<body>` except
 * `.print-root`, and the backdrop is one of those children.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { decodeStats, MAX_ROSTER_PLAYERS } from '../contract/statsContract';
import type { StatsPayload } from '../contract/statsContract';
import { formatDate, plural } from '../format';
import { gameLabel } from '../store/gameSummary';
import { previewImport } from '../store/importStats';
import type { ImportPreview } from '../store/importStats';
import { buildRosterPayload, rosterCandidates } from '../store/rosterPayload';
import { selectActiveGame } from '../store/selectors';
import { buildStatsView } from '../store/statsView';
import type { StatLine, StatsTable } from '../store/statsView';
import { appStore, toAppState, useAppStore } from '../store/useAppStore';
import { copyText } from './clipboard';

export interface StatsDialogProps {
  /** The button that opened this dialog — focus returns here on close. */
  triggerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

/** Everything inside the card a Tab can land on. Wider than `AboutDialog`'s: this card is mostly
 *  fields. Each entry excludes its disabled form — an over-limit roster disables both the Copy
 *  button and the payload textarea, and a trap that stopped on them would be a dead end. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

/** Which slice of the record the table shows. `0 | 1 | 2` index `StatsView.sets`. */
type Scope = 'all' | 0 | 1 | 2;

const SCOPES: { key: Scope; label: string }[] = [
  { key: 'all', label: 'All sets' },
  { key: 0, label: 'Set 1' },
  { key: 1, label: 'Set 2' },
  { key: 2, label: 'Set 3' },
];

/** Where the one status line is showing — the mockup puts the copy confirmation under the roster
 *  and the import confirmation under the paste box. One piece of state, so two `role="status"`
 *  banners can never be on screen at once. */
interface StatusLine {
  where: 'roster' | 'import';
  text: string;
}

const COPIED = 'Copied — paste it into the stats app.';
const COPY_FALLBACK =
  'The clipboard is not available here — the payload below is selected; press Ctrl+C to copy it.';

/** "nothing to divide", not a zero. */
const DASH = '—';

/** The four cells of one stat group. `pct === null` and `total === 0` are the same condition
 *  (see `statLine`), so one test drives both dashes. */
function StatCells({ line }: { line: StatLine }) {
  const nothing = line.pct === null;
  return (
    <>
      <td className="num grp">{line.in}</td>
      <td className="num">{line.out}</td>
      <td className={nothing ? 'num dash' : 'num'}>{nothing ? DASH : line.total}</td>
      <td className={nothing ? 'num dash' : 'num'}>
        {line.pct === null ? DASH : `${Math.round(line.pct * 100)}%`}
      </td>
    </>
  );
}

/**
 * The preview's one-line summary of what the import would bring in. Counts, except for the new
 * guests: those are people who do not exist in this app at all yet, so the coach is shown their
 * names rather than a number she cannot check.
 */
function previewFacts(p: ImportPreview): string {
  const parts = [`${p.payload.sets.length} ${plural(p.payload.sets.length, 'set', 'sets')}`];
  parts.push(`${p.matched.length} ${plural(p.matched.length, 'player', 'players')} matched`);
  if (p.joining.length > 0) {
    parts.push(
      `${p.joining.length} ${plural(p.joining.length, 'team member joins', 'team members join')} this game`,
    );
  }
  if (p.newGuests.length > 0) {
    parts.push(
      `${p.newGuests.length} new ${plural(p.newGuests.length, 'guest', 'guests')}: ${p.newGuests
        .map((g) => g.name)
        .join(', ')}`,
    );
  }
  return parts.join(' · ');
}

/**
 * `Set 1 25–21 · Set 2 23–25 (already recorded 23–25)`, or nothing at all.
 *
 * Only sets the stats app actually scored appear: a set it left blank changes no score here, so
 * it has nothing to say on this line. The `(already recorded …)` aside is exactly the case the
 * "Also replace set scores that differ" checkbox governs — `ScorePreview.conflicts` is true only
 * when both scores exist and disagree.
 */
function PreviewScores({ preview }: { preview: ImportPreview }) {
  const lines = preview.scores.flatMap((s) =>
    s.incoming === null ? [] : [{ ...s, incoming: s.incoming }],
  );
  if (lines.length === 0) return null;
  return (
    <p>
      {lines.map((s, i) => (
        <span key={s.n}>
          {i > 0 ? ' · ' : ''}
          Set {s.n} {s.incoming[0]}–{s.incoming[1]}
          {s.conflicts && s.existing !== null && (
            <span className="was">
              {' '}
              (already recorded {s.existing[0]}–{s.existing[1]})
            </span>
          )}
        </span>
      ))}
    </p>
  );
}

function StatsTableView({ table }: { table: StatsTable }) {
  return (
    <div className="table-wrap">
      <table className="stats-table">
        <thead>
          <tr className="groups">
            <th rowSpan={2}>Player</th>
            <th colSpan={4} className="group grp">
              Serve
            </th>
            <th colSpan={4} className="group grp">
              Return
            </th>
          </tr>
          <tr>
            <th className="num grp">In</th>
            <th className="num">Out</th>
            <th className="num">Total</th>
            <th className="num">%</th>
            <th className="num grp">In</th>
            <th className="num">Out</th>
            <th className="num">Total</th>
            <th className="num">%</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.playerId}>
              <td>
                {row.name}
                {row.guest && <span className="gchip">Guest</span>}
              </td>
              <StatCells line={row.serve} />
              <StatCells line={row.return} />
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <StatCells line={table.totals.serve} />
            <StatCells line={table.totals.return} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export function StatsDialog({ triggerRef, onClose }: StatsDialogProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const payloadRef = useRef<HTMLTextAreaElement>(null);

  const game = useAppStore(selectActiveGame);
  // Safe to hand over bare — `buildStatsView` is identity-cached; see its docblock.
  const view = useAppStore(buildStatsView);
  const players = useAppStore((s) => s.players);
  const games = useAppStore((s) => s.games);
  const teams = useAppStore((s) => s.teams);
  const importGameStats = useAppStore((s) => s.importGameStats);
  const gameId = game.id;

  // `rosterCandidates` and `buildRosterPayload` take the whole `AppState`, which no single
  // selector hands back, and both build fresh arrays — handing either to `useAppStore` is the
  // render loop `statsView.ts` documents. So this subscribes to the slices they actually read and
  // pulls the state itself inside the memo: each memo re-runs exactly when one of its own slices
  // changes, and reads the same store snapshot the render is already showing.
  //
  // The two read different slices, and the dep lists say which. `rosterCandidates` reads
  // `players` and `games` only. `buildRosterPayload` reads those *and* `teams`, because the
  // encoded payload carries the team's name — so a rename has to rebuild the payload text even
  // though it changes nobody's tick.
  const candidates = useMemo(
    () => rosterCandidates(toAppState(appStore.getState()), gameId),
    [players, games, gameId],
  );

  /** Everyone, ticked, to start with — the common case is "send the whole game". The lazy
   *  initialiser reads `candidates` once, at mount; `App` keys this dialog on the active game, so
   *  a game switch remounts it rather than leaving one game's ticks on another's roster. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(candidates.map((c) => c.id)),
  );
  const [pasted, setPasted] = useState('');
  /** The decoded payload awaiting confirmation — the preview panel is open exactly while this is
   *  set, including when resolving it against the picked game failed. */
  const [pending, setPending] = useState<StatsPayload | null>(null);
  /** Non-empty only on the unresolved path; this is what keeps the `Import into` select up. */
  const [gameChoices, setGameChoices] = useState<{ id: string; label: string }[]>([]);
  const [pickedGameId, setPickedGameId] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [replaceScores, setReplaceScores] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusLine | null>(null);
  const [scope, setScope] = useState<Scope>('all');

  const payload = useMemo(
    () => buildRosterPayload(toAppState(appStore.getState()), gameId, selected),
    [players, games, teams, gameId, selected],
  );

  useEffect(() => {
    closeRef.current?.focus();
    const trigger = triggerRef.current;
    return () => trigger?.focus();
    // Mount/unmount only — refocusing on a re-render would fight the coach (as `AboutDialog`).
  }, []);

  // One document-level listener for both keys rather than the card's own `onKeyDown`, for the
  // reasons `AboutDialog.tsx` spells out: Escape must work from `<body>` too, and so must the trap.
  useEffect(() => {
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || cardRef.current === null) return;
      const focusable = [...cardRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && focusable.includes(active);
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleBackdropMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    // Only a press on the backdrop itself — a press that starts inside the card bubbles here too.
    if (event.target === event.currentTarget) onClose();
  };

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const handleCopy = () => {
    if (!payload.ok) return;
    // `copyText` resolves either way and never throws; the second handler is belt and braces, so
    // that no path out of this button can reach the console (`scripts/interaction-check.mjs`
    // clicks it in the built file and fails the run on a single console error).
    void copyText(payload.value, payloadRef.current).then(
      (copied) => setStatus({ where: 'roster', text: copied ? COPIED : COPY_FALLBACK }),
      () => setStatus({ where: 'roster', text: COPY_FALLBACK }),
    );
  };

  /** Preview `statsPayload` against one specific game — the answer that can actually be applied. */
  const resolveInto = (statsPayload: StatsPayload, pick: string) => {
    const result = previewImport(toAppState(appStore.getState()), statsPayload, pick);
    if (!result.ok) {
      setError(result.error);
      setPreview(null);
      return;
    }
    setError(null);
    setPreview(result.value);
  };

  const clearPreview = () => {
    setPending(null);
    setPreview(null);
    setGameChoices([]);
    setError(null);
  };

  const handleImportClick = () => {
    setStatus(null);
    const decoded = decodeStats(pasted);
    if (!decoded.ok) {
      clearPreview();
      setError(decoded.error);
      return;
    }
    const first = previewImport(toAppState(appStore.getState()), decoded.value);
    if (!first.ok) {
      clearPreview();
      setError(first.error);
      return;
    }

    setPending(decoded.value);
    setReplaceScores(false);
    if (first.value.gameId !== null) {
      setGameChoices([]);
      setPickedGameId(first.value.gameId);
      setPreview(first.value);
      setError(null);
      return;
    }

    // Unresolved. The first preview is informational only — offer the choice, then show the
    // coach the preview for the default pick, which is the one Import would apply.
    const choices = first.value.candidateGames;
    setGameChoices(choices);
    // `choices` is the active team's games, and invariant 3 says that team always has at least
    // one — so the fallback is unreachable and gets no message of its own; it exists only to
    // narrow `string | undefined`.
    const pick = choices[0]?.id;
    if (pick === undefined) return;
    setPickedGameId(pick);
    resolveInto(decoded.value, pick);
  };

  const handlePick = (id: string) => {
    setPickedGameId(id);
    if (pending !== null) resolveInto(pending, id);
  };

  const confirmImport = () => {
    // Both halves are the store action's own precondition; checking them here is what lets the
    // button stay disabled rather than silently doing nothing.
    if (preview === null || preview.gameId === null) return;
    const target = games.find((g) => g.id === preview.gameId);
    importGameStats(preview, { gameId: preview.gameId, replaceScores });
    const sets = preview.payload.sets.length;
    setStatus({
      where: 'import',
      text: `Imported — ${sets} ${plural(sets, 'set', 'sets')} of stats saved for ${
        target === undefined ? 'this game' : gameLabel(target)
      }.`,
    });
    setPasted('');
    clearPreview();
  };

  const over = selected.size > MAX_ROSTER_PLAYERS;

  const statsBody = () => {
    if (view.record === null) return <p className="empty">No stats imported for this game yet.</p>;
    if (scope === 'all') return <StatsTableView table={view.all} />;
    const table = view.sets[scope];
    if (table === null) return <p className="muted">Set {scope + 1} was not played.</p>;
    return <StatsTableView table={table} />;
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown}>
      <div
        className="modal stats"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="Game statistics"
        tabIndex={-1}
      >
        <div className="stats-head">
          <h2>
            Stats<span className="sep">·</span>
            {gameLabel(game)}
            <span className="sep">·</span>
            {formatDate(game.date)}
          </h2>
          <button
            type="button"
            className="btn icon stats-x"
            aria-label="Close Stats"
            ref={closeRef}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="stats-section">
          <h3>Send roster to the stats app</h3>
          <ul className="tick-list">
            {candidates.map((c) => (
              <li key={c.id}>
                <label className="tick">
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                  {c.name}
                  {c.guest && <span className="gchip">Guest</span>}
                </label>
              </li>
            ))}
          </ul>
          <div className="roster-bar">
            <span className={over ? 'count-chip err' : 'count-chip'}>
              {selected.size} of {MAX_ROSTER_PLAYERS}
            </span>
            <span className="grow" />
            <button type="button" className="btn sm" disabled={!payload.ok} onClick={handleCopy}>
              Copy roster
            </button>
          </div>
          {/* `buildRosterPayload`'s own refusal, not a copy of it: it names how many to untick. */}
          {!payload.ok && <p className="helper">{payload.error}</p>}
          <textarea
            className="payload"
            rows={3}
            readOnly
            disabled={!payload.ok}
            aria-label="Roster payload"
            ref={payloadRef}
            value={payload.ok ? payload.value : ''}
          />
          {status !== null && status.where === 'roster' && (
            <div className="banner" role="status">
              <span>{status.text}</span>
              <button type="button" className="btn sm" onClick={() => setStatus(null)}>
                Dismiss
              </button>
            </div>
          )}
        </div>

        <div className="stats-section">
          <h3>Import stats from the stats app</h3>
          <div className="import-row">
            <textarea
              placeholder="Paste the stats payload here"
              aria-label="Stats payload"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
            <button type="button" className="btn" onClick={handleImportClick}>
              Import…
            </button>
          </div>

          {pending !== null && (
            <div className="game-form preview" role="dialog" aria-label="Import these stats?">
              <h4>Import these stats?</h4>
              {gameChoices.length > 0 && (
                <>
                  <p>This payload was made for a game this app does not have.</p>
                  <label htmlFor="stats-import-into">Import into</label>
                  <select
                    id="stats-import-into"
                    value={pickedGameId}
                    onChange={(e) => handlePick(e.target.value)}
                  >
                    {gameChoices.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {preview !== null && (
                <>
                  <p>{previewFacts(preview)}</p>
                  <PreviewScores preview={preview} />
                  {preview.replacesExisting && (
                    <p className="warn-line">This replaces the stats already stored for this game.</p>
                  )}
                </>
              )}
              <label className="checkbox-row" htmlFor="stats-replace-scores">
                <input
                  type="checkbox"
                  id="stats-replace-scores"
                  checked={replaceScores}
                  onChange={(e) => setReplaceScores(e.target.checked)}
                />
                Also replace set scores that differ
              </label>
              <div className="form-actions">
                <button type="button" className="btn sm" onClick={clearPreview}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={preview === null}
                  onClick={confirmImport}
                >
                  Import
                </button>
              </div>
            </div>
          )}

          {error !== null && (
            <div className="banner err" role="alert">
              <span>{error}</span>
              <button type="button" className="btn sm" onClick={() => setError(null)}>
                Dismiss
              </button>
            </div>
          )}
          {status !== null && status.where === 'import' && (
            <div className="banner" role="status">
              <span>{status.text}</span>
              <button type="button" className="btn sm" onClick={() => setStatus(null)}>
                Dismiss
              </button>
            </div>
          )}
        </div>

        <div className="stats-section">
          <h3>Statistics</h3>
          <div className="stats-toolbar">
            <div className="seg" role="group" aria-label="Which sets">
              {SCOPES.map((s) => (
                <button
                  key={String(s.key)}
                  type="button"
                  className={scope === s.key ? 'on' : undefined}
                  aria-pressed={scope === s.key}
                  disabled={view.record === null}
                  onClick={() => setScope(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          {statsBody()}
        </div>
      </div>
    </div>,
    document.body,
  );
}
