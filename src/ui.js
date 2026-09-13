// ui.js — screens: paste roster, record (Set bar + rows + bottom bar), export, boot/persistence,
// and the games switcher / menu / score / add-sub bottom sheets.
// build note: import lines below are for node tests; the inliner strips single-line imports only,
// so each import must stay on one line.
import { STORAGE_KEY, UNREADABLE_KEY, newSession, gameLabel, formatDate, openRoster, updateRoster, setActiveGame, deleteGame, setActiveSet, tap, undo, setScore, clearSet, addSub, isSetPlayed, getCount, parseSession, serialiseSession, runSelfCheck, buildStatsPayload, APP_VERSION, MAX_SCORE } from './session.js';
import { decodeRoster, decodeStats } from './codec.js';

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
  exportData: null, // null | { summary, text } — set when the export screen is showing
  exportStatus: null, // null | { kind: 'ok'|'err', text }
};

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function currentGame() {
  return state.session.games.find((g) => g.gameId === state.session.activeGameId) || null;
}

function firstName(game, playerId) {
  const p = game.players.find((x) => x.id === playerId);
  const name = p ? p.name : '';
  const space = name.indexOf(' ');
  return space === -1 ? name : name.slice(0, space);
}

function statLetter(stat) {
  return stat === 'serve' ? 'S' : 'R';
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
// Persistence — Task 5 brief, Step 2 (verbatim shape).
// ---------------------------------------------------------------------------------------------

function load() {
  let raw = null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { /* storage unavailable */ }
  if (raw === null) return { session: newSession(), banner: null };
  const parsed = parseSession(raw);
  if (parsed.ok) {
    if (parsed.dropped > 0) {
      try { localStorage.setItem(UNREADABLE_KEY, raw); } catch { /* best effort */ }
      const text = parsed.dropped === 1
        ? '1 game could not be read and was set aside; the rest were kept.'
        : `${parsed.dropped} games could not be read and were set aside; the rest were kept.`;
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
// Paste screen
// ---------------------------------------------------------------------------------------------

function renderPaste() {
  const showCancel = state.session.games.length > 0;
  const errorHtml = state.pasteError
    ? `<div class="banner err" role="alert"><span>${esc(state.pasteError)}</span><button type="button" class="btn sm" data-action="dismiss-paste-error">Dismiss</button></div>`
    : '';
  return `
<div class="screen screen-pad">
  <p class="summary-line" style="margin-bottom:12px;font-weight:650;font-size:15px;">Open a game</p>
  ${topBannerHtml()}
  ${errorHtml}
  <textarea id="pasteText" class="paste-box" placeholder="Paste the roster payload here" autocapitalize="off" autocorrect="off" spellcheck="false">${esc(state.pasteText)}</textarea>
  <p class="helper">Paste the roster copied from CoachIQ Rotation Planner</p>
  <div style="display:flex;gap:8px;margin-top:14px;">
    <button type="button" class="btn primary block" data-action="open-roster">Open game</button>
    ${showCancel ? '<button type="button" class="btn block" data-action="cancel-paste">Cancel</button>' : ''}
  </div>
</div>`;
}

function onOpenRoster() {
  const textarea = document.getElementById('pasteText');
  const text = textarea ? textarea.value : state.pasteText;
  state.pasteText = text;
  const decoded = decodeRoster(text);
  if (!decoded.ok) {
    state.pasteError = decoded.error;
    render();
    return;
  }
  state.pasteError = null;
  const result = openRoster(state.session, decoded.value, new Date().toISOString());
  if (result.kind === 'opened') {
    state.pasteText = '';
    state.screen = 'record';
    commit(result.session);
    return;
  }
  // kind === 'exists'
  state.sheet = { kind: 'gameExists', game: result.game, roster: decoded.value };
  render();
}

function onCancelPaste() {
  state.pasteError = null;
  if (state.session.activeGameId) state.screen = 'record';
  render();
}

// ---------------------------------------------------------------------------------------------
// "Game already open" sheet
// ---------------------------------------------------------------------------------------------

function renderGameExistsSheet(sheet) {
  const label = gameLabel(sheet.game);
  const played = sheet.game.sets.filter(isSetPlayed).length;
  return `
<div class="screen sheet-host">
  <div class="sheet">
    <h3>This game is already open</h3>
    <p class="helper" style="margin-bottom:16px;">${esc(label)} is already open with ${played} set${played === 1 ? '' : 's'} recorded.</p>
    <div class="actions" style="flex-direction:column;">
      <button type="button" class="btn primary block" data-action="game-exists-open">Open it</button>
      <button type="button" class="btn block" style="margin-top:8px;" data-action="game-exists-update">Update roster</button>
      <button type="button" class="btn block" style="margin-top:8px;" data-action="close-sheet">Cancel</button>
    </div>
  </div>
</div>`;
}

function renderGameExistsErrorSheet(sheet) {
  return `
<div class="screen sheet-host">
  <div class="sheet">
    <h3>Can't update this roster</h3>
    <div class="banner err" role="alert" style="margin:0 0 16px;"><span>${esc(sheet.message)}</span></div>
    <div class="actions"><button type="button" class="btn primary block" data-action="close-sheet">OK</button></div>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------------------------
// Score sheet (Task 6, Step 1)
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
// Add-a-sub sheet (Task 6, Step 2)
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
// Game switcher sheet (Task 6, Step 3)
// ---------------------------------------------------------------------------------------------

function renderSwitcherSheet() {
  const rows = state.session.games.map((g) => {
    const played = g.sets.filter(isSetPlayed).length;
    const setWord = played === 1 ? '1 set' : `${played} sets`;
    const exportedPart = g.lastExportedAt ? ` · exported ${formatTime(g.lastExportedAt)}` : '';
    const subtitle = `${formatDate(g.date)} · ${setWord}${exportedPart}`;
    return `
    <li>
      <div class="gmeta" role="button" tabindex="0" data-action="switch-game" data-gid="${esc(g.gameId)}"><span class="gtitle">vs ${esc(g.opponent)}</span><span class="gsub">${esc(subtitle)}</span></div>
      <button type="button" class="btn danger sm" data-action="ask-delete-game" data-gid="${esc(g.gameId)}">Delete</button>
    </li>`;
  }).join('');
  // Tapping anywhere in the sheet that isn't a row/button (the backdrop included) closes it —
  // there is no explicit Cancel button in the approved mockup for this sheet.
  return `
<div class="screen sheet-host" data-action="close-sheet">
  <div class="sheet">
    <h3>Games</h3>
    <ul class="glist">
      ${rows}
      <li class="newgame" style="padding-top:14px;"><button type="button" class="btn block" data-action="switcher-new-game">+ New game (paste roster)</button></li>
    </ul>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------------------------
// Menu sheet (Task 6, Step 4)
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
      <li><button type="button" data-action="menu-add-sub">Add a sub…</button></li>
      <li><button type="button" data-action="menu-clear-set">Clear Set ${n}…</button></li>
      <li><button type="button" data-action="menu-delete-game">Delete game…</button></li>
      <li class="muted-line"><span>Codec self-check: ${state.selfCheckOk ? 'OK' : 'FAILED'}</span></li>
      <li class="muted-line"><span>v${esc(APP_VERSION)}</span></li>
    </ul>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------------------------
// Confirmation sheets — delete game, clear set (Task 6, Steps 3 & 4)
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

function renderSheet() {
  const sheet = state.sheet;
  if (sheet.kind === 'gameExists') return renderGameExistsSheet(sheet);
  if (sheet.kind === 'gameExistsError') return renderGameExistsErrorSheet(sheet);
  if (sheet.kind === 'score') return renderScoreSheet(sheet);
  if (sheet.kind === 'addSub') return renderAddSubSheet(sheet);
  if (sheet.kind === 'switcher') return renderSwitcherSheet();
  if (sheet.kind === 'menu') return renderMenuSheet();
  if (sheet.kind === 'confirmDelete') return renderConfirmDeleteSheet(sheet);
  if (sheet.kind === 'confirmClearSet') return renderConfirmClearSetSheet(sheet);
  return '';
}

function onGameExistsOpen() {
  const sheet = state.sheet;
  if (!sheet || sheet.kind !== 'gameExists') return;
  const session = setActiveGame(state.session, sheet.game.gameId);
  state.sheet = null;
  state.screen = 'record';
  commit(session);
}

function onGameExistsUpdate() {
  const sheet = state.sheet;
  if (!sheet || sheet.kind !== 'gameExists') return;
  const result = updateRoster(state.session, sheet.game.gameId, sheet.roster);
  if (!result.ok) {
    state.sheet = { kind: 'gameExistsError', message: result.error };
    render();
    return;
  }
  const session = setActiveGame(result.session, sheet.game.gameId);
  state.sheet = null;
  state.screen = 'record';
  commit(session);
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
  const game = currentGame();
  if (!game) {
    state.screen = 'paste';
    return renderPaste();
  }
  const n = game.activeSet;
  const rows = game.players.map((p) => renderRow(game, n, p)).join('');
  const seg = [1, 2, 3].map((setN) => `<button type="button" class="${setN === n ? 'on' : ''}" data-action="select-set" data-n="${setN}">Set ${setN}</button>`).join('');
  const setRecord = game.sets[n - 1];
  const scoreLabel = setRecord && setRecord.score ? `${setRecord.score[0]}–${setRecord.score[1]}` : 'score';
  const top = game.history.length ? game.history[game.history.length - 1] : null;
  const undoLabel = top ? `↶ Undo ${firstName(game, top.playerId)} ${statLetter(top.stat)} ${top.side}` : '↶ Undo';
  const undoDisabled = game.history.length === 0 ? 'disabled' : '';
  const minusPressed = state.minusMode ? 'true' : 'false';
  return `
<div class="screen${state.minusMode ? ' minus' : ''}">
  <div class="topbar">
    <button type="button" class="btn icon sm" data-action="open-switcher">Games ▾</button>
    <span class="title-group">
      ${game.team ? `<span class="title-team">${esc(game.team)}</span>` : ''}
      <span class="title">${esc(gameLabel(game))}</span>
    </span>
    <button type="button" class="btn icon sm" data-action="open-menu">⋯</button>
  </div>
  ${topBannerHtml()}
  <div class="setbar">
    <div class="seg" role="group" aria-label="Which set">${seg}</div>
    <button type="button" class="btn sm" data-action="open-score">${esc(scoreLabel)}</button>
  </div>
  <div class="colhead"><span>Player</span><span>Serve In</span><span>Serve Out</span><span>Return In</span><span>Return Out</span></div>
  <div class="rows">${rows}</div>
  <div class="bottombar">
    <button type="button" class="btn sm undo" data-action="undo" ${undoDisabled}>${esc(undoLabel)}</button>
    <button type="button" class="btn icon sm minus${state.minusMode ? ' primary' : ''}" data-action="toggle-minus" aria-pressed="${minusPressed}">−</button>
    <button type="button" class="btn sm primary" data-action="export" ${state.selfCheckOk ? '' : 'disabled'}>Export</button>
  </div>
</div>`;
}

function onTapCount(btn) {
  const game = currentGame();
  if (!game) return;
  const pid = btn.dataset.pid;
  const stat = btn.dataset.stat;
  const side = btn.dataset.side;
  const delta = state.minusMode ? -1 : 1;
  const previousSession = state.session;
  const nextSession = tap(state.session, game.gameId, game.activeSet, pid, stat, side, delta);
  // one-shot: only switches itself off when the tap actually changed something — a no-op tap
  // (count already at 0) must not silently consume minus mode.
  if (state.minusMode && nextSession !== previousSession) state.minusMode = false;
  commit(nextSession);
}

function onUndo() {
  const game = currentGame();
  if (!game || game.history.length === 0) return;
  const result = undo(state.session, game.gameId);
  commit(result.session);
}

function onSelectSet(n) {
  const game = currentGame();
  if (!game) return;
  commit(setActiveSet(state.session, game.gameId, n));
}

// ---------------------------------------------------------------------------------------------
// Sheet openers — score, add-sub, switcher, menu (Task 6)
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
  commit(session);
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
  commit(session);
}

function onSubAdd() {
  const game = currentGame();
  const sheet = state.sheet;
  if (!game || !sheet || sheet.kind !== 'addSub') return;
  const result = addSub(state.session, game.gameId, sheet.name || '');
  if (!result.ok) {
    state.sheet = { ...sheet, error: result.error };
    render();
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

function onSwitcherNewGame() {
  state.sheet = null;
  state.screen = 'paste';
  render();
}

function onAskDeleteGame(gameId) {
  const game = state.session.games.find((g) => g.gameId === gameId);
  if (!game) return;
  state.sheet = { kind: 'confirmDelete', gameId, label: gameLabel(game) };
  render();
}

function onConfirmDeleteGame() {
  const sheet = state.sheet;
  if (!sheet || sheet.kind !== 'confirmDelete') return;
  const session = deleteGame(state.session, sheet.gameId);
  state.sheet = null;
  state.screen = session.activeGameId ? 'record' : 'paste';
  commit(session);
}

function onMenuAddSub() {
  state.sheet = { kind: 'addSub', name: '', error: null };
  render();
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
  commit(session);
}

function onMenuDeleteGame() {
  const game = currentGame();
  if (!game) return;
  state.sheet = { kind: 'confirmDelete', gameId: game.gameId, label: gameLabel(game) };
  render();
}

// ---------------------------------------------------------------------------------------------
// Export screen (Task 7)
// ---------------------------------------------------------------------------------------------

function renderExport() {
  const data = state.exportData;
  const status = state.exportStatus;
  const statusHtml = status ? bannerBlock(status.kind === 'err' ? 'err' : 'ok', status.text) : '';
  const shareBtn = typeof navigator.share === 'function' ? '<button type="button" class="btn sm" data-action="export-share">Share…</button>' : '';
  return `
<div class="screen screen-pad">
  <p class="summary-line" style="font-weight:650;font-size:15px;">Export stats</p>
  <p class="summary-line">${esc(data.summary)}</p>
  <textarea id="exportPayload" class="payload" rows="6" readonly aria-label="Stats payload">${esc(data.text)}</textarea>
  <div class="actions" style="display:flex;gap:8px;margin-top:12px;">
    <button type="button" class="btn sm" data-action="export-copy">Copy</button>
    ${shareBtn}
    <button type="button" class="btn sm" style="margin-left:auto;" data-action="export-back">Back</button>
  </div>
  ${statusHtml}
</div>`;
}

function onExport() {
  const game = currentGame();
  if (!game) return;
  const nowIso = new Date().toISOString();
  const result = buildStatsPayload(game, nowIso);
  if (!result.ok) {
    state.banner = { kind: 'err', text: result.error, dismissible: true };
    render();
    return;
  }
  // Task 7, Step 4: the export screen must show exactly what buildStatsPayload built — round-trip
  // it through the same decoder the planner uses. This is a dev-only guard, never shown to the coach.
  const decoded = decodeStats(result.value.text);
  console.assert(decoded.ok && JSON.stringify(decoded.value) === JSON.stringify(result.value.payload), 'exported stats payload failed to round-trip through decodeStats');
  state.exportData = { summary: result.value.summary, text: result.value.text };
  state.exportStatus = null;
  state.screen = 'export';
  const session = { ...state.session, games: state.session.games.map((g) => (g.gameId === game.gameId ? { ...g, lastExportedAt: nowIso } : g)) };
  commit(session);
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
// non-button elements we use as tap targets (currently the switcher's `[role="button"]` rows),
// which get no such behaviour for free.
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
  if (action === 'open-roster') return onOpenRoster();
  if (action === 'cancel-paste') return onCancelPaste();
  if (action === 'dismiss-paste-error') { state.pasteError = null; return render(); }
  if (action === 'dismiss-banner') { state.banner = null; return render(); }
  if (action === 'close-sheet') { state.sheet = null; return render(); }
  if (action === 'game-exists-open') return onGameExistsOpen();
  if (action === 'game-exists-update') return onGameExistsUpdate();
  if (action === 'select-set') return onSelectSet(Number(btn.dataset.n));
  if (action === 'tap-count') return onTapCount(btn);
  if (action === 'toggle-minus') { state.minusMode = !state.minusMode; return render(); }
  if (action === 'undo') return onUndo();
  if (action === 'open-switcher') return onOpenSwitcher();
  if (action === 'open-menu') return onOpenMenu();
  if (action === 'open-score') return onOpenScore();
  if (action === 'score-clear') return onScoreClear();
  if (action === 'score-done') return onScoreDone();
  if (action === 'sub-add') return onSubAdd();
  if (action === 'switch-game') return onSwitchGame(btn.dataset.gid);
  if (action === 'switcher-new-game') return onSwitcherNewGame();
  if (action === 'ask-delete-game') return onAskDeleteGame(btn.dataset.gid);
  if (action === 'confirm-delete-game') return onConfirmDeleteGame();
  if (action === 'menu-add-sub') return onMenuAddSub();
  if (action === 'menu-clear-set') return onMenuClearSet();
  if (action === 'confirm-clear-set') return onConfirmClearSet();
  if (action === 'menu-delete-game') return onMenuDeleteGame();
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
  // Preserve the player list's scroll position (and the sheet's, if one is open and scrollable)
  // across a re-render, since app.innerHTML rebuilds the whole DOM and would otherwise snap both
  // back to the top on every tap.
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
  state.screen = state.session.activeGameId ? 'record' : 'paste';
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
  document.getElementById('app').addEventListener('click', handleAppClick);
  document.getElementById('app').addEventListener('keydown', handleAppKeydown);
  document.addEventListener('visibilitychange', () => { if (document.hidden) commit(state.session); });
  render();
}

boot();
