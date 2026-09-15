// ui.js — screens: paste day roster, record (Set bar + rows + bottom bar), players tick-list,
// export, boot/persistence, and the games switcher / menu / score / add-sub / replace-day bottom
// sheets.
// build note: import lines below are for node tests; the inliner strips single-line imports only,
// so each import must stay on one line.
import { STORAGE_KEY, UNREADABLE_KEY, newSession, gameLabel, dayLabel, formatDate, openDayRoster, replaceDay, hasUnexportedStats, setPlayerTicked, addSub, setActiveGame, deleteGame, setActiveSet, tap, undo, setScore, clearSet, isSetPlayed, getCount, parseSession, serialiseSession, runSelfCheck, buildDayStatsPayload, APP_VERSION, MAX_SCORE } from './session.js';
import { decodeDayRoster, decodeDayStats } from './codec.js';

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

const state = {
  session: newSession(),
  screen: 'paste', // 'paste' | 'record' | 'export'
  sheet: null, // null | { kind, ... }
  minusMode: false,
  banner: null, // null | { kind: 'err'|'warn', text }
  pasteError: null,
  pasteText: '',
  saveFailed: false,
  selfCheckOk: true,
  exportData: null, // null | { summary, text, payload } — set when the export screen is showing
  exportStatus: null, // null | { kind: 'ok'|'err', text }
};

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The session IS the day — no `.day` wrapper.
function currentDay() { return state.session; }
function currentGame() { const d = state.session; return d.games.find((g) => g.gameId === d.activeGameId) || null; }

// Reads the day directory (not a per-game `players` list — that no longer exists on a game).
function firstName(day, playerId) {
  const p = day.players.find((x) => x.id === playerId);
  const name = p ? p.name : '';
  const space = name.indexOf(' ');
  return space === -1 ? name : name.slice(0, space);
}

function statLetter(stat) {
  return stat === 'serve' ? 'S' : 'R';
}

// Sum of every recorded count for `playerId` across every set of `game`, used to decide whether a
// player's row in the players sheet gets the "N counts" hint and a locked style.
function totalCounts(game, playerId) {
  let total = 0;
  for (const set of game.sets) {
    if (!set) continue;
    const c = set.counts[playerId];
    if (!c) continue;
    total += c.serve.in + c.serve.out + c.return.in + c.return.out;
  }
  return total;
}

// Phone-local 24h clock, e.g. "09:07" — used for the switcher's "exported HH:MM".
function formatTime(iso) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// Copies text to the clipboard when available, otherwise selects it in the textarea so the coach
// can copy manually. Verbatim per the Task 7 brief.
async function copyPayload(text, textarea) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall through */ }
  textarea.focus(); textarea.setSelectionRange(0, textarea.value.length); return false;
}

function bannerBlock(kind, text, dismissible) {
  const cls = kind === 'err' ? 'banner err' : 'banner';
  const role = kind === 'err' ? 'alert' : 'status';
  const dismissBtn = dismissible ? '<button type="button" class="btn sm" data-action="dismiss-banner">Dismiss</button>' : '';
  return `<div class="${cls}" role="${role}"><span>${esc(text)}</span>${dismissBtn}</div>`;
}

function topBannerHtml() {
  if (state.saveFailed) return bannerBlock('err', 'Could not save — export your stats now.');
  if (state.banner) return bannerBlock(state.banner.kind, state.banner.text, !!state.banner.dismissible);
  return '';
}

// ---------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------

function load() {
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { /* storage unavailable */ }
  if (raw === null) return { session: newSession(), banner: null };
  const parsed = parseSession(raw);
  if (parsed.ok) {
    // parseSession only reports `droppedDays` on the schema-1 migration path — its presence is
    // how we know a migration just happened and the on-disk envelope is still schema 1.
    const migrated = parsed.droppedDays !== undefined;
    if (migrated) {
      // Re-commit immediately so the schema-2 envelope replaces the schema-1 one on disk;
      // otherwise every boot re-migrates from the same stale schema-1 save.
      try { localStorage.setItem(STORAGE_KEY, serialiseSession(parsed.value)); } catch { /* best effort */ }
    }
    const parts = [];
    let singular = false;
    if (parsed.dropped > 0) { parts.push(`${parsed.dropped} game${parsed.dropped === 1 ? '' : 's'}`); singular = parsed.dropped === 1; }
    if (migrated && parsed.droppedDays > 0) { parts.push(`${parsed.droppedDays} day${parsed.droppedDays === 1 ? '' : 's'}`); singular = parts.length === 1 && parsed.droppedDays === 1; }
    if (parts.length > 0) {
      try { localStorage.setItem(UNREADABLE_KEY, raw); } catch { /* best effort */ }
      const was = parts.length === 1 && singular ? 'was' : 'were';
      const text = `${parts.join(' and ')} could not be read and ${was} set aside; the rest were kept.`;
      return { session: parsed.value, banner: { kind: 'warn', text } };
    }
    return { session: parsed.value, banner: null };
  }
  try { localStorage.setItem(UNREADABLE_KEY, raw); } catch { /* best effort */ }
  return { session: newSession(), banner: { kind: 'warn', text: 'The saved session could not be read and was set aside; starting fresh.' } };
}

function commit(session) {
  state.session = session;
  try { localStorage.setItem(STORAGE_KEY, serialiseSession(session)); state.saveFailed = false; }
  catch { state.saveFailed = true; }
  render();
}

// ---------------------------------------------------------------------------------------------
// Paste screen — the day roster, three-way ingest (opened / sameDay / otherDay / error)
// ---------------------------------------------------------------------------------------------

function renderPaste() {
  const showCancel = state.session.date !== null;
  const errorHtml = state.pasteError
    ? `<div class="banner err" role="alert"><span>${esc(state.pasteError)}</span><button type="button" class="btn sm" data-action="dismiss-paste-error">Dismiss</button></div>`
    : '';
  return `
<div class="screen screen-pad">
  <p class="summary-line" style="margin-bottom:12px;font-weight:650;font-size:15px;">Open the day</p>
  ${topBannerHtml()}
  ${errorHtml}
  <textarea id="pasteText" class="paste-box" placeholder="Paste the day roster payload here" autocapitalize="off" autocorrect="off" spellcheck="false">${esc(state.pasteText)}</textarea>
  <p class="helper">Paste the day roster copied from CoachIQ Rotation Planner</p>
  <div style="display:flex;gap:8px;margin-top:14px;">
    <button type="button" class="btn primary block" data-action="open-roster">Open day</button>
    ${showCancel ? '<button type="button" class="btn block" data-action="cancel-paste">Cancel</button>' : ''}
  </div>
</div>`;
}

function onOpenDay() {
  const textarea = document.getElementById('pasteText');
  const text = textarea ? textarea.value : state.pasteText;
  state.pasteText = text;
  const decoded = decodeDayRoster(text);
  if (!decoded.ok) {
    state.pasteError = decoded.error;
    render();
    return;
  }
  state.pasteError = null;
  const nowIso = new Date().toISOString();
  const result = openDayRoster(state.session, decoded.value, nowIso);
  if (result.kind === 'opened') {
    state.pasteText = '';
    state.screen = 'record';
    commit(result.session);
    return;
  }
  if (result.kind === 'sameDay') {
    const g = result.added.games, p = result.added.players;
    const parts = [];
    if (g > 0) parts.push(`${g} new game${g === 1 ? '' : 's'}`);
    if (p > 0) parts.push(`${p} player${p === 1 ? '' : 's'} added`);
    state.banner = { kind: 'warn', text: parts.length > 0 ? `Day updated — ${parts.join(', ')}.` : 'Day updated.', dismissible: true };
    state.screen = 'record';
    commit(result.session);
    return;
  }
  if (result.kind === 'otherDay') {
    // Keep state.pasteText so Cancel on the replace-day sheet returns her to an intact paste.
    state.sheet = { kind: 'replaceDay', roster: result.roster, unexported: result.unexported };
    render();
    return;
  }
  // kind === 'error' — a same-date merge that would break a cap. The decoder's own error strings
  // (e.g. `game "<gid>" names 13 players; the limit is 12`) are shown verbatim; the payload can't
  // be hand-edited (any edit invalidates the checksum), so her only remedy is fixing it in the
  // planner and re-sending.
  state.pasteError = result.error;
  render();
}

function onCancelPaste() {
  state.pasteError = null;
  if (state.session.date !== null) state.screen = 'record';
  render();
}

// ---------------------------------------------------------------------------------------------
// Replace-day sheet — opening a different day while stats may be unexported
// ---------------------------------------------------------------------------------------------

function renderReplaceDaySheet(sheet) {
  const oldDate = formatDate(state.session.date);
  const newDate = formatDate(sheet.roster.date);
  const warnHtml = sheet.unexported
    ? `<div class="banner err" role="alert" style="margin:0 0 16px;"><span>${esc(oldDate)} has stats you have not exported yet. They will be lost.</span></div>`
    : '';
  return `
<div class="screen sheet-host">
  <div class="sheet">
    <h3>Open a different day?</h3>
    <p class="helper" style="margin-bottom:14px;">This will close <b>${esc(oldDate)}</b> and open <b>${esc(newDate)}</b>.</p>
    ${warnHtml}
    <div class="actions" style="flex-direction:column;">
      <button type="button" class="btn block" data-action="replace-day-export-first">Export first</button>
      <button type="button" class="btn danger block" style="margin-top:8px;" data-action="replace-day-replace">Replace the day</button>
      <button type="button" class="btn block" style="margin-top:8px;" data-action="close-sheet">Cancel</button>
    </div>
  </div>
</div>`;
}

function onReplaceDayExportFirst() {
  const sheet = state.sheet;
  if (!sheet || sheet.kind !== 'replaceDay') return;
  // Close the sheet and run the export against the CURRENT (still-open) day. state.pasteText —
  // holding the new day's payload — is untouched, so she can reopen the paste screen (via the
  // switcher's "Paste a new day roster…") and hit Open day again once the export is done.
  state.sheet = null;
  onExport();
}

function onReplaceDayConfirm() {
  const sheet = state.sheet;
  if (!sheet || sheet.kind !== 'replaceDay') return;
  const nowIso = new Date().toISOString();
  const session = replaceDay(state.session, sheet.roster, nowIso);
  state.sheet = null;
  state.pasteText = '';
  state.pasteError = null;
  state.screen = 'record';
  commit(session);
}

// ---------------------------------------------------------------------------------------------
// Score sheet
// ---------------------------------------------------------------------------------------------

function renderScoreSheet(sheet) {
  const errHtml = sheet.error
    ? `<div class="banner err" role="alert" style="margin:-4px 0 12px;"><span>${esc(sheet.error)}</span></div>`
    : '';
  return `
<div class="screen sheet-host">
  <div class="sheet">
    <h3>Set ${sheet.n} score</h3>
    <p class="helper" style="margin-bottom:14px;">Enter the final score once the set is over.</p>
    <div class="score-row">
      <div><label for="scoreUs">Us</label><input id="scoreUs" type="text" inputmode="numeric" pattern="[0-9]*" value="${esc(sheet.us)}"></div>
      <div><label for="scoreThem">Them</label><input id="scoreThem" type="text" inputmode="numeric" pattern="[0-9]*" value="${esc(sheet.them)}"></div>
    </div>
    ${errHtml}
    <div class="actions">
      <button type="button" class="btn danger" data-action="score-clear">Clear score</button>
      <button type="button" class="btn primary" data-action="score-done">Done</button>
    </div>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------------------------
// Add-a-sub sheet — opened only from inside the players sheet; a successful add returns there.
// ---------------------------------------------------------------------------------------------

function renderAddSubSheet(sheet) {
  const errHtml = sheet.error
    ? `<div class="banner err" role="alert" style="margin:-4px 0 12px;"><span>${esc(sheet.error)}</span></div>`
    : '';
  return `
<div class="screen sheet-host">
  <div class="sheet">
    <h3>Add a sub</h3>
    <label for="subName">Name</label>
    <input id="subName" type="text" placeholder="Player name" value="${esc(sheet.name)}">
    ${errHtml}
    <div class="actions">
      <button type="button" class="btn" data-action="close-sheet">Cancel</button>
      <button type="button" class="btn primary" data-action="sub-add">Add</button>
    </div>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------------------------
// Players sheet (guide §5 rule 1) — always the whole day directory, this game's roster pre-ticked.
// ---------------------------------------------------------------------------------------------

function renderPlayersSheet(sheet) {
  const day = currentDay();
  const game = day.games.find((g) => g.gameId === sheet.gameId);
  if (!game) return '';
  const i = day.games.indexOf(game);
  const ticked = new Set(game.playerIds);
  const errHtml = sheet.error
    ? `<div class="banner err" role="alert" style="margin:-4px 0 12px;"><span>${esc(sheet.error)}</span></div>`
    : '';
  const rows = day.players.map((p) => {
    const isTicked = ticked.has(p.id);
    const count = totalCounts(game, p.id);
    const hintHtml = count > 0 ? `<span class="thint">${count} count${count === 1 ? '' : 's'}</span>` : '';
    const subChip = p.sub ? ' <span class="gchip">Sub</span>' : '';
    return `
      <li class="tick${count > 0 ? ' locked' : ''}" role="button" tabindex="0" data-action="toggle-tick" data-pid="${esc(p.id)}">
        <input type="checkbox" tabindex="-1" ${isTicked ? 'checked' : ''}>
        <span class="tname">${esc(p.name)}${subChip}</span>
        ${hintHtml}
      </li>`;
  }).join('');
  return `
<div class="screen sheet-host">
  <div class="sheet">
    <h3>Players</h3>
    <p class="helper">${esc(gameLabel(game, i))} · tick who is playing this game</p>
    ${errHtml}
    <ul class="ticklist">
      ${rows}
      <li class="tick addsub"><button type="button" class="btn block" data-action="open-add-sub-from-players">+ Add a sub…</button></li>
    </ul>
    <div class="tickfoot">
      <span>${ticked.size} of ${day.players.length}</span>
      <button type="button" class="btn primary sm" data-action="close-sheet">Done</button>
    </div>
  </div>
</div>`;
}

function onOpenPlayers() {
  const game = currentGame();
  if (!game) return;
  state.sheet = { kind: 'players', gameId: game.gameId, error: null };
  render();
}

// Toggling ticks the tick-list, not a stat — it must NOT stamp lastChangedAt, or a coach who only
// opens the players sheet (no taps at all) would falsely mark the day dirty.
function onToggleTick(pid) {
  const sheet = state.sheet;
  if (!sheet || sheet.kind !== 'players') return;
  const game = state.session.games.find((g) => g.gameId === sheet.gameId);
  if (!game) return;
  const ticked = game.playerIds.includes(pid);
  const result = setPlayerTicked(state.session, sheet.gameId, pid, !ticked);
  if (!result.ok) {
    // Surface as an inline banner in the sheet — never silently revert.
    state.sheet = { ...sheet, error: result.error };
    render();
    return;
  }
  state.sheet = { ...sheet, error: null };
  commit(result.session);
}

function onOpenAddSubFromPlayers() {
  const sheet = state.sheet;
  if (!sheet || sheet.kind !== 'players') return;
  state.sheet = { kind: 'addSub', name: '', error: null, gameId: sheet.gameId, returnTo: 'players' };
  render();
}

// ---------------------------------------------------------------------------------------------
// Game switcher sheet
// ---------------------------------------------------------------------------------------------

function renderSwitcherSheet() {
  const day = currentDay();
  // One day-level marker, not per game — the export now covers the whole day.
  const exportedPart = day.lastExportedAt ? ` · exported ${formatTime(day.lastExportedAt)}` : '';
  const rows = day.games.map((g, i) => {
    const played = g.sets.filter(isSetPlayed).length;
    const subtitle = `${played} set${played === 1 ? '' : 's'} · ${g.playerIds.length} player${g.playerIds.length === 1 ? '' : 's'}`;
    return `
    <li>
      <div class="gmeta" role="button" tabindex="0" data-action="switch-game" data-gid="${esc(g.gameId)}"><span class="gtitle">${esc(gameLabel(g, i))}</span><span class="gsub">${esc(subtitle)}</span></div>
      <button type="button" class="btn danger sm" data-action="ask-delete-game" data-gid="${esc(g.gameId)}">Delete</button>
    </li>`;
  }).join('');
  // Tapping anywhere in the sheet that isn't a row/button (the backdrop included) closes it —
  // there is no explicit Cancel button in the approved mockup for this sheet.
  return `
<div class="screen sheet-host" data-action="close-sheet">
  <div class="sheet">
    <h3>Games</h3>
    <p class="helper" style="margin:-2px 0 14px;">${esc(dayLabel(day))}${exportedPart}</p>
    <ul class="glist">
      ${rows}
      <li class="newgame" style="padding-top:14px;"><button type="button" class="btn block" data-action="switcher-paste-new-day">Paste a new day roster…</button></li>
    </ul>
  </div>
</div>`;
}

function onSwitcherPasteNewDay() {
  state.sheet = null;
  state.screen = 'paste';
  render();
}

// ---------------------------------------------------------------------------------------------
// Menu sheet
// ---------------------------------------------------------------------------------------------

function renderMenuSheet() {
  const game = currentGame();
  const n = game ? game.activeSet : 1;
  // Same backdrop-closes convention as the switcher sheet — see note above.
  return `
<div class="screen sheet-host" data-action="close-sheet">
  <div class="sheet">
    <h3>Menu</h3>
    <ul class="menu">
      <li><button type="button" data-action="open-players">Players…</button></li>
      <li><button type="button" data-action="menu-clear-set">Clear Set ${n}…</button></li>
      <li><button type="button" data-action="menu-delete-game">Delete game…</button></li>
      <li><button type="button" data-action="menu-new-day">Start a new day…</button></li>
      <li class="muted-line"><span>Codec self-check: ${state.selfCheckOk ? 'OK' : 'FAILED'}</span></li>
      <li class="muted-line"><span>v${esc(APP_VERSION)}</span></li>
    </ul>
  </div>
</div>`;
}

function onMenuNewDay() {
  state.sheet = { kind: 'confirmNewDay' };
  render();
}

// ---------------------------------------------------------------------------------------------
// Confirmation sheets — delete game, clear set, start a new day
// ---------------------------------------------------------------------------------------------

function renderConfirmDeleteSheet(sheet) {
  return `
<div class="screen sheet-host">
  <div class="sheet">
    <h3>Delete this game?</h3>
    <p class="helper" style="margin-bottom:16px;">Delete ${esc(sheet.label)} and its stats? This cannot be undone.</p>
    <div class="actions">
      <button type="button" class="btn" data-action="close-sheet">Cancel</button>
      <button type="button" class="btn danger" data-action="confirm-delete-game">Delete</button>
    </div>
  </div>
</div>`;
}

function renderConfirmClearSetSheet(sheet) {
  return `
<div class="screen sheet-host">
  <div class="sheet">
    <h3>Clear every count and the score for Set ${sheet.n}?</h3>
    <div class="actions" style="margin-top:16px;">
      <button type="button" class="btn" data-action="close-sheet">Cancel</button>
      <button type="button" class="btn danger" data-action="confirm-clear-set">Clear</button>
    </div>
  </div>
</div>`;
}

// The escape hatch when the tournament is over. Reuses hasUnexportedStats — the same guard that
// protects a replace-day paste — so starting fresh carries the same warning when stats haven't
// gone out yet.
function renderConfirmNewDaySheet() {
  const day = currentDay();
  const warnHtml = hasUnexportedStats(day)
    ? `<div class="banner err" role="alert" style="margin:0 0 16px;"><span>${esc(dayLabel(day))} has stats you have not exported yet. They will be lost.</span></div>`
    : '';
  return `
<div class="screen sheet-host">
  <div class="sheet">
    <h3>Start a new day?</h3>
    <p class="helper" style="margin-bottom:14px;">This clears today's games and stats from this device.</p>
    ${warnHtml}
    <div class="actions">
      <button type="button" class="btn" data-action="close-sheet">Cancel</button>
      <button type="button" class="btn danger" data-action="confirm-new-day">Start new day</button>
    </div>
  </div>
</div>`;
}

function renderSheet() {
  const sheet = state.sheet;
  if (sheet.kind === 'score') return renderScoreSheet(sheet);
  if (sheet.kind === 'addSub') return renderAddSubSheet(sheet);
  if (sheet.kind === 'players') return renderPlayersSheet(sheet);
  if (sheet.kind === 'switcher') return renderSwitcherSheet();
  if (sheet.kind === 'menu') return renderMenuSheet();
  if (sheet.kind === 'replaceDay') return renderReplaceDaySheet(sheet);
  if (sheet.kind === 'confirmDelete') return renderConfirmDeleteSheet(sheet);
  if (sheet.kind === 'confirmClearSet') return renderConfirmClearSetSheet(sheet);
  if (sheet.kind === 'confirmNewDay') return renderConfirmNewDaySheet();
  return '';
}

// ---------------------------------------------------------------------------------------------
// Recording screen
// ---------------------------------------------------------------------------------------------

function renderRow(game, n, player) {
  const c = getCount(game, n, player.id);
  const subChip = player.sub ? ' <span class="gchip">Sub</span>' : '';
  return `
<div class="row">
  <div class="name">${esc(player.name)}${subChip}</div>
  <button type="button" class="cnt in" data-action="tap-count" data-pid="${esc(player.id)}" data-stat="serve" data-side="in">${c.serve.in}</button>
  <button type="button" class="cnt out" data-action="tap-count" data-pid="${esc(player.id)}" data-stat="serve" data-side="out">${c.serve.out}</button>
  <button type="button" class="cnt in" data-action="tap-count" data-pid="${esc(player.id)}" data-stat="return" data-side="in">${c.return.in}</button>
  <button type="button" class="cnt out" data-action="tap-count" data-pid="${esc(player.id)}" data-stat="return" data-side="out">${c.return.out}</button>
</div>`;
}

function renderRecord() {
  const day = currentDay();
  const game = currentGame();
  if (!game) {
    state.screen = 'paste';
    return renderPaste();
  }
  const i = day.games.indexOf(game);
  const n = game.activeSet;
  const ticked = new Set(game.playerIds);
  // Directory order, stable — never derived from `game.playerIds`' own order.
  const players = day.players.filter((p) => ticked.has(p.id));
  // `roster: []` (and so an empty tick list) is legal (guide §5 rule 2) — never auto-tick
  // everybody and never treat it as an error; offer the players sheet instead.
  const rowsHtml = players.length === 0
    ? `<div class="rows empty-state"><p>No players ticked for this game yet.</p><button type="button" class="btn primary" data-action="open-players">Tick players…</button></div>`
    : `<div class="rows">${players.map((p) => renderRow(game, n, p)).join('')}</div>`;
  const seg = [1, 2, 3, 4, 5].map((setN) => `<button type="button" class="${setN === n ? 'on' : ''}" aria-label="Set ${setN}" data-action="select-set" data-n="${setN}">${setN}</button>`).join('');
  const setRecord = game.sets[n - 1];
  const scoreLabel = setRecord && setRecord.score ? `${setRecord.score[0]}–${setRecord.score[1]}` : 'score';
  const top = game.history.length ? game.history[game.history.length - 1] : null;
  const undoLabel = top ? `↶ Undo ${firstName(day, top.playerId)} ${statLetter(top.stat)} ${top.side}` : '↶ Undo';
  const undoDisabled = game.history.length === 0 ? 'disabled' : '';
  const minusPressed = state.minusMode ? 'true' : 'false';
  return `
<div class="screen${state.minusMode ? ' minus' : ''}">
  <div class="topbar">
    <button type="button" class="btn icon sm" data-action="open-switcher">Games ▾</button>
    <span class="title-group">
      <span class="title-team">${esc(day.team)}</span>
      <span class="title">${esc(gameLabel(game, i))} · ${esc(formatDate(day.date))}</span>
    </span>
    <button type="button" class="btn icon sm" data-action="open-menu">⋯</button>
  </div>
  ${topBannerHtml()}
  <div class="setbar">
    <div class="seg" role="group" aria-label="Which set">${seg}</div>
    <button type="button" class="btn sm" data-action="open-score">${esc(scoreLabel)}</button>
  </div>
  <div class="colhead"><span>Player</span><span>Serve In</span><span>Serve Out</span><span>Return In</span><span>Return Out</span></div>
  ${rowsHtml}
  <div class="bottombar">
    <button type="button" class="btn sm undo" data-action="undo" ${undoDisabled}>${esc(undoLabel)}</button>
    <button type="button" class="btn icon sm minus${state.minusMode ? ' primary' : ''}" data-action="toggle-minus" aria-pressed="${minusPressed}">−</button>
    <button type="button" class="btn sm primary" data-action="export" ${state.selfCheckOk ? '' : 'disabled'}>Export</button>
  </div>
</div>`;
}

// The five stat-changing handlers (tap, score set, score clear, clear-set, undo) stamp
// lastChangedAt themselves, here in the UI — the pure state functions kept frozen signatures by
// design and structurally cannot. This is what makes hasUnexportedStats's "exported, then
// recorded more" branch actually fire. Deliberately NOT done in commit() generally: a mere game
// or set switch must not mark the day dirty and falsely trip the replace-day warning.
function onTapCount(btn) {
  const game = currentGame();
  if (!game) return;
  const pid = btn.dataset.pid;
  const stat = btn.dataset.stat;
  const side = btn.dataset.side;
  const delta = state.minusMode ? -1 : 1;
  const previousSession = state.session;
  const tapped = tap(state.session, game.gameId, game.activeSet, pid, stat, side, delta);
  // one-shot: only switches itself off when the tap actually changed something — a no-op tap
  // (count already at 0) must not silently consume minus mode.
  if (state.minusMode && tapped !== previousSession) state.minusMode = false;
  commit({ ...tapped, lastChangedAt: new Date().toISOString() });
}

function onUndo() {
  const game = currentGame();
  if (!game || game.history.length === 0) return;
  const result = undo(state.session, game.gameId);
  commit({ ...result.session, lastChangedAt: new Date().toISOString() });
}

function onSelectSet(n) {
  const game = currentGame();
  if (!game) return;
  commit(setActiveSet(state.session, game.gameId, n));
}

// ---------------------------------------------------------------------------------------------
// Sheet openers — score, switcher, menu
// ---------------------------------------------------------------------------------------------

function onOpenScore() {
  const game = currentGame();
  if (!game) return;
  const n = game.activeSet;
  const setRecord = game.sets[n - 1];
  const score = setRecord && setRecord.score;
  state.sheet = { kind: 'score', n, us: score ? String(score[0]) : '', them: score ? String(score[1]) : '', error: null };
  render();
}

function onOpenSwitcher() {
  state.sheet = { kind: 'switcher' };
  render();
}

function onOpenMenu() {
  state.sheet = { kind: 'menu' };
  render();
}

function onScoreClear() {
  const game = currentGame();
  const sheet = state.sheet;
  if (!game || !sheet || sheet.kind !== 'score') return;
  const session = setScore(state.session, game.gameId, sheet.n, null);
  state.sheet = null;
  commit({ ...session, lastChangedAt: new Date().toISOString() });
}

function onScoreDone() {
  const game = currentGame();
  const sheet = state.sheet;
  if (!game || !sheet || sheet.kind !== 'score') return;
  const usText = (sheet.us || '').trim();
  const themText = (sheet.them || '').trim();
  const us = Number(usText);
  const them = Number(themText);
  const valid = usText !== '' && themText !== '' && Number.isInteger(us) && Number.isInteger(them) && us >= 0 && us <= MAX_SCORE && them >= 0 && them <= MAX_SCORE;
  if (!valid) {
    state.sheet = { ...sheet, error: 'Enter both scores or clear the score' };
    render();
    return;
  }
  const session = setScore(state.session, game.gameId, sheet.n, [us, them]);
  state.sheet = null;
  commit({ ...session, lastChangedAt: new Date().toISOString() });
}

function onSubAdd() {
  const sheet = state.sheet;
  if (!sheet || sheet.kind !== 'addSub') return;
  const game = state.session.games.find((g) => g.gameId === sheet.gameId);
  if (!game) return;
  const result = addSub(state.session, game.gameId, sheet.name || '');
  if (!result.ok) {
    state.sheet = { ...sheet, error: result.error };
    render();
    return;
  }
  if (sheet.returnTo === 'players') {
    // She has just proved she is picking players — return to the players sheet rather than
    // closing, so the sub she just added is right there to tick.
    state.sheet = { kind: 'players', gameId: game.gameId, error: null };
    commit(result.session);
    return;
  }
  state.sheet = null;
  commit(result.session);
}

function onSwitchGame(gameId) {
  const session = setActiveGame(state.session, gameId);
  state.sheet = null;
  state.screen = 'record';
  commit(session);
}

function onAskDeleteGame(gameId) {
  const game = state.session.games.find((g) => g.gameId === gameId);
  if (!game) return;
  const i = state.session.games.indexOf(game);
  state.sheet = { kind: 'confirmDelete', gameId, label: gameLabel(game, i) };
  render();
}

function onConfirmDeleteGame() {
  const sheet = state.sheet;
  if (!sheet || sheet.kind !== 'confirmDelete') return;
  const session = deleteGame(state.session, sheet.gameId);
  state.sheet = null;
  // A day with no games left is not a day — deleteGame returns a fresh newSession() in that case.
  state.screen = session.date !== null ? 'record' : 'paste';
  commit(session);
}

function onMenuClearSet() {
  const game = currentGame();
  if (!game) return;
  state.sheet = { kind: 'confirmClearSet', gameId: game.gameId, n: game.activeSet };
  render();
}

function onConfirmClearSet() {
  const sheet = state.sheet;
  if (!sheet || sheet.kind !== 'confirmClearSet') return;
  const session = clearSet(state.session, sheet.gameId, sheet.n);
  state.sheet = null;
  commit({ ...session, lastChangedAt: new Date().toISOString() });
}

function onMenuDeleteGame() {
  const game = currentGame();
  if (!game) return;
  const i = state.session.games.indexOf(game);
  state.sheet = { kind: 'confirmDelete', gameId: game.gameId, label: gameLabel(game, i) };
  render();
}

function onConfirmNewDay() {
  const sheet = state.sheet;
  if (!sheet || sheet.kind !== 'confirmNewDay') return;
  state.sheet = null;
  state.screen = 'paste';
  commit(newSession());
}

// ---------------------------------------------------------------------------------------------
// Export screen
// ---------------------------------------------------------------------------------------------

function renderExport() {
  const data = state.exportData;
  const status = state.exportStatus;
  const statusHtml = status ? bannerBlock(status.kind === 'err' ? 'err' : 'ok', status.text) : '';
  const shareBtn = typeof navigator.share === 'function' ? '<button type="button" class="btn sm" data-action="export-share">Share…</button>' : '';
  const gameLines = data.payload.games.map((g) => {
    const game = state.session.games.find((x) => x.gameId === g.gameId);
    const label = game ? gameLabel(game, state.session.games.indexOf(game)) : g.gameId;
    const setsText = g.sets.map((s) => `Set ${s.n} ${s.score ? `${s.score[0]}–${s.score[1]}` : 'no score'}`).join(' · ');
    return `<p class="summary-line">${esc(label)} · ${esc(setsText)}</p>`;
  }).join('');
  return `
<div class="screen screen-pad">
  <p class="summary-line" style="font-weight:650;font-size:15px;">Export stats</p>
  <p class="summary-line">${esc(data.summary)}</p>
  ${gameLines}
  <textarea id="exportPayload" class="payload" rows="6" readonly aria-label="Stats payload">${esc(data.text)}</textarea>
  <div class="actions" style="display:flex;gap:8px;margin-top:12px;">
    <button type="button" class="btn sm" data-action="export-copy">Copy</button>
    ${shareBtn}
    <button type="button" class="btn sm" style="margin-left:auto;" data-action="export-back">Back</button>
  </div>
  <p class="helper">One payload covers the whole day — every game, each with its own sets.</p>
  ${statusHtml}
</div>`;
}

function onExport() {
  const day = currentDay();
  if (day.games.length === 0) return;
  const nowIso = new Date().toISOString();
  const result = buildDayStatsPayload(day, nowIso);
  if (!result.ok) {
    state.banner = { kind: 'err', text: result.error, dismissible: true };
    render();
    return;
  }
  // The export screen must show exactly what buildDayStatsPayload built — round-trip it through
  // the same decoder the planner uses. This is a dev-only guard, never shown to the coach.
  const decoded = decodeDayStats(result.value.text);
  console.assert(decoded.ok && JSON.stringify(decoded.value) === JSON.stringify(result.value.payload), 'exported stats payload failed to round-trip through decodeDayStats');
  state.exportData = { summary: result.value.summary, text: result.value.text, payload: result.value.payload };
  state.exportStatus = null;
  state.screen = 'export';
  // lastExportedAt lives on the day — one field, not a games.map — because the export now covers
  // every game at once.
  commit({ ...state.session, lastExportedAt: nowIso });
}

async function onExportCopy() {
  const textarea = document.getElementById('exportPayload');
  const text = state.exportData ? state.exportData.text : (textarea ? textarea.value : '');
  const ok = await copyPayload(text, textarea);
  state.exportStatus = ok
    ? { kind: 'ok', text: "Copied — paste it into the planner's Stats dialog." }
    : { kind: 'err', text: 'The clipboard is not available here — select the text and copy it.' };
  render();
}

// Stats never go by mailto: — a day sheet is roughly 13 KB, about six times what a mailto: URL
// can be relied on to carry. Do not add a mailto share option here; Share… uses navigator.share
// (which has no such size ceiling) and Copy relies on the clipboard.
function onExportShare() {
  const data = state.exportData;
  if (!data) return;
  navigator.share({ title: data.summary, text: data.text }).then(() => {
    state.exportStatus = { kind: 'ok', text: 'Shared.' };
    render();
  }).catch(() => { /* an AbortError on cancel is not an error */ });
}

function onExportBack() {
  state.exportData = null;
  state.exportStatus = null;
  state.screen = 'record';
  render();
}

// ---------------------------------------------------------------------------------------------
// Delegated click handling
// ---------------------------------------------------------------------------------------------

function handleAppClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  runAction(btn);
}

// A plain <button> already turns Enter/Space into a click event on its own; this only covers the
// non-button elements we use as tap targets (the switcher's and players sheet's `[role="button"]`
// rows), which get no such behaviour for free.
function handleAppKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  const btn = e.target.closest('[role="button"][data-action]');
  if (!btn) return;
  e.preventDefault();
  runAction(btn);
}

function runAction(btn) {
  // Snapshot the textarea before any re-render wipes the DOM, so a re-render triggered while the
  // paste screen is up (e.g. Dismiss) never loses what the coach already typed or pasted.
  if (state.screen === 'paste') {
    const textarea = document.getElementById('pasteText');
    if (textarea) state.pasteText = textarea.value;
  }
  // Same idea for the score / add-sub sheets: snapshot their inputs before any action (including
  // a failed Done/Add that re-renders with an inline error) can wipe the DOM out from under them.
  // The players sheet has no free-text input, so it needs no such snapshot.
  if (state.sheet && state.sheet.kind === 'score') {
    const us = document.getElementById('scoreUs');
    const them = document.getElementById('scoreThem');
    if (us) state.sheet.us = us.value;
    if (them) state.sheet.them = them.value;
  }
  if (state.sheet && state.sheet.kind === 'addSub') {
    const nameInput = document.getElementById('subName');
    if (nameInput) state.sheet.name = nameInput.value;
  }
  const action = btn.dataset.action;
  // data-action stays "open-roster" (not "open-day") deliberately: scripts/verify-build.mjs — the
  // only thing in this repo that drives ui.js end-to-end — queries this exact selector to advance
  // past the paste screen, and it is out of this task's file scope to change.
  if (action === 'open-roster') return onOpenDay();
  if (action === 'cancel-paste') return onCancelPaste();
  if (action === 'dismiss-paste-error') { state.pasteError = null; return render(); }
  if (action === 'dismiss-banner') { state.banner = null; return render(); }
  if (action === 'close-sheet') { state.sheet = null; return render(); }
  if (action === 'select-set') return onSelectSet(Number(btn.dataset.n));
  if (action === 'tap-count') return onTapCount(btn);
  if (action === 'toggle-minus') { state.minusMode = !state.minusMode; return render(); }
  if (action === 'undo') return onUndo();
  if (action === 'open-switcher') return onOpenSwitcher();
  if (action === 'open-menu') return onOpenMenu();
  if (action === 'open-players') return onOpenPlayers();
  if (action === 'open-score') return onOpenScore();
  if (action === 'score-clear') return onScoreClear();
  if (action === 'score-done') return onScoreDone();
  if (action === 'toggle-tick') return onToggleTick(btn.dataset.pid);
  if (action === 'open-add-sub-from-players') return onOpenAddSubFromPlayers();
  if (action === 'sub-add') return onSubAdd();
  if (action === 'switch-game') return onSwitchGame(btn.dataset.gid);
  if (action === 'switcher-paste-new-day') return onSwitcherPasteNewDay();
  if (action === 'ask-delete-game') return onAskDeleteGame(btn.dataset.gid);
  if (action === 'confirm-delete-game') return onConfirmDeleteGame();
  if (action === 'menu-clear-set') return onMenuClearSet();
  if (action === 'confirm-clear-set') return onConfirmClearSet();
  if (action === 'menu-delete-game') return onMenuDeleteGame();
  if (action === 'menu-new-day') return onMenuNewDay();
  if (action === 'confirm-new-day') return onConfirmNewDay();
  if (action === 'replace-day-export-first') return onReplaceDayExportFirst();
  if (action === 'replace-day-replace') return onReplaceDayConfirm();
  if (action === 'export') return onExport();
  if (action === 'export-copy') return onExportCopy();
  if (action === 'export-share') return onExportShare();
  if (action === 'export-back') return onExportBack();
}

// ---------------------------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------------------------

function render() {
  const app = document.getElementById('app');
  // Preserve the player list's scroll position (and the sheet's, if one is open and scrollable —
  // essential now, not just polite, since a 24-row players sheet overflows and every tick
  // re-renders the whole DOM) across a re-render, since app.innerHTML rebuilds the whole DOM and
  // would otherwise snap both back to the top on every tap.
  const rowsEl = document.querySelector('.rows');
  const rowsScrollTop = rowsEl ? rowsEl.scrollTop : null;
  const sheetEl = document.querySelector('.sheet');
  const sheetScrollTop = sheetEl ? sheetEl.scrollTop : null;
  // Same idea for focus + text selection in the score / add-sub sheet inputs, so an in-progress
  // edit that triggers a re-render (e.g. a snapshot in runAction) doesn't drop the cursor.
  const active = document.activeElement;
  const activeId = active && active.id && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') ? active.id : null;
  const selStart = activeId && typeof active.selectionStart === 'number' ? active.selectionStart : null;
  const selEnd = activeId && typeof active.selectionEnd === 'number' ? active.selectionEnd : null;
  let html;
  if (state.screen === 'export' && state.exportData) html = renderExport();
  else if (state.screen === 'record' && currentGame()) html = renderRecord();
  else html = renderPaste();
  if (state.sheet) html += renderSheet();
  app.innerHTML = html;
  if (rowsScrollTop !== null) {
    const newRows = document.querySelector('.rows');
    if (newRows) newRows.scrollTop = rowsScrollTop;
  }
  if (sheetScrollTop !== null) {
    const newSheet = document.querySelector('.sheet');
    if (newSheet) newSheet.scrollTop = sheetScrollTop;
  }
  if (activeId) {
    const el = document.getElementById(activeId);
    if (el) {
      el.focus();
      if (selStart !== null && selEnd !== null && typeof el.setSelectionRange === 'function') {
        try { el.setSelectionRange(selStart, selEnd); } catch { /* inputs without text selection support */ }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

function boot() {
  const check = runSelfCheck();
  const loaded = load();
  state.session = loaded.session;
  state.selfCheckOk = check.ok;
  state.banner = check.ok ? loaded.banner : { kind: 'err', text: 'Codec self-check failed — do not export until this build is fixed.' };
  // Keys off the new empty state: `date === null` is the only pre-paste state.
  state.screen = state.session.date !== null ? 'record' : 'paste';
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
  document.getElementById('app').addEventListener('click', handleAppClick);
  document.getElementById('app').addEventListener('keydown', handleAppKeydown);
  document.addEventListener('visibilitychange', () => { if (document.hidden) commit(state.session); });
  render();
}

boot();
