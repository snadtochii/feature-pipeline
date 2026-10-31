// Round and session orchestration for the margin viewer: the notes file as the viewer holds it,
// the write queue that keeps it current through PUT /api/session, the merge of the server's copy
// after every change, the change-wait loop, and the Send, Finish and Cancel lifecycle. It mirrors
// the server's round rules — what a Send sends, the diagram's structural changes since the round's
// starting file, which notes are withheld, and when a round is out. It touches no DOM, so the
// self-test imports it in Node; everything it shows goes through `view`.

import { diffDiagrams } from './diagram-diff.js';

// A note is sent once the server has stamped it with the round it went out in.
export const isSent = (a) => typeof a.round === 'number';

const LOST_CONTACT = 'Lost contact with the server — retrying';

const pause = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// `api(method, url, body)` answers the reply's JSON, or throws an Error carrying `status` — the
// HTTP status, or 0 when the server could not be reached. `view` is what the page shows:
//   overall()                the overall direction text as typed
//   composer()               the open composer's { dirty, commit }, or null
//   editing()                the id of the unsent note the composer edits, or null
//   closeComposer()
//   confirm(text)            asks the human; true to go on
//   saveState(text)          the save indicator
//   notify(text, { error })  the last action's message; clearNotice() drops it without a repaint
//   dropped(notes)           says which unsent notes a refresh removed
//   renderStatus()           repaints the status strip
//   renderControls()         repaints Send, Finish and Cancel from busy, ending and ended
//   refreshed()              re-renders what a refresh changed; may return a promise
//   showEnd(status)          raises the end-of-run overlay
// `sleep(ms)` and `saveDelay` exist so the self-test runs the timing without waiting it out.
export function createRounds({ api, view, sleep = pause, saveDelay = 400 }) {
  const state = {
    // The notes file as the viewer holds it: { root, scope, out, overall, round, rounds,
    // overallReplies, annotations }. The server owns the sent notes and the round fields; the
    // viewer owns the unsent notes and the overall text (mergeSession).
    session: null,
    files: [], // repo-relative paths in scope, sorted
    fileSet: new Set(), // state.files as a set, rebuilt with it
    candidates: new Set(), // the names of the run's overview candidates; null while unknown
    boxIds: new Set(), // the box ids of the run's diagram; none for a run without one
    arrowIds: new Set(), // the arrow ids of the run's diagram
    changeCount: 0, // the diagram's structural changes since the round's starting file
    storedIds: new Set(), // the ids of the unsent notes the server held at the last read or write
    saveTimer: null,
    // The last write sent to the server. Writes run one after another, so an older snapshot can
    // never land after a newer one; each sends the session as it stands when its turn comes.
    writes: Promise.resolve(),
    // The last change count seen from GET /api/session or GET /api/changes.
    changes: 0,
    // The change poll's connection problem, '' while the server answers.
    connection: '',
    // A Send, Finish or Cancel request is in flight; Send, Finish and Cancel are disabled.
    busy: false,
    // The server has begun ending the run: autosave stops until the end overlay comes up.
    ending: false,
    ended: false, // true once the end-of-run overlay is up
    // A diagram session: the server holds no notes session, so nothing is saved or merged, and
    // `session` is an empty one the renderers read.
    standalone: false,
  };

  const annotations = () => state.session.annotations;

  function setFiles(files) {
    state.files = files;
    state.fileSet = new Set(files);
  }

  // The names of the run's overview candidates; none for a run without an overview, and null when
  // the overview could not be loaded, so the names the server holds are unknown.
  function setCandidates(names) {
    state.candidates = names === null ? null : new Set(names);
  }

  // The box and arrow ids of the diagram the server holds now, and the number of structural
  // changes a Send would record against `baseline`, the round's starting file; none for a run
  // without a diagram (`document` null) and no changes without a baseline.
  function setDiagram(document, baseline = null) {
    state.boxIds = new Set((document?.boxes ?? []).map((box) => box.id));
    state.arrowIds = new Set((document?.arrows ?? []).map((arrow) => arrow.id));
    state.changeCount = document && baseline ? diffDiagrams(baseline, document).length : 0;
  }

  // A box or arrow anchor whose id the current diagram does not hold, as when its box was deleted
  // or the agent's redraw dropped it.
  const removed = (anchor) => (anchor.kind === 'box' || anchor.kind === 'arrow') && !listed(anchor);

  // The contract's anchor rule (CONTRACT.md §7) against the current listing, the run's overview
  // candidates and its diagram: whether the server would accept a new note on this anchor now.
  function listed(anchor) {
    switch (anchor.kind) {
      case 'scope':
        return true;
      case 'folder':
        return anchor.path !== '' && anchor.path !== '.' && state.files.some((path) => path.startsWith(`${anchor.path}/`));
      case 'candidate':
        return state.candidates?.has(anchor.name) ?? false;
      case 'box':
        return state.boxIds.has(anchor.id);
      case 'arrow':
        return state.arrowIds.has(anchor.id);
      default:
        return state.fileSet.has(anchor.path);
    }
  }

  const unsent = () => annotations().filter((a) => !isSent(a));

  const WITHHELD_KINDS = new Set(['candidate', 'box', 'arrow']);

  // An unsent candidate note whose candidate the run's overview does not name, or an unsent box
  // or arrow note whose id the current diagram does not hold: the server withholds it at every
  // Send, and the viewer shows it read-only. A box or arrow note is sent again once its id
  // returns. While the candidate names are unknown, every unsent candidate note is read-only.
  const withheld = (a) => !isSent(a) && WITHHELD_KINDS.has(a.anchor.kind) && !listed(a.anchor);

  const sendable = () => unsent().filter((a) => !withheld(a));

  // While the names are unknown, the viewer cannot tell which unsent candidate notes a Send would
  // stamp, so Send is held as long as one exists: no Send stamps a note shown as read-only.
  const sendHeld = () => state.candidates === null && unsent().some((a) => a.anchor.kind === 'candidate');

  // Whether the overall text, trimmed, differs from the text the last round sent.
  function overallChanged() {
    return view.overall().trim() !== (state.session.rounds?.at(-1)?.overall ?? '').trim();
  }

  // The server's rule for a Send: an unsent note it does not withhold, an overall text the last
  // round did not send, or a structural change to the diagram — unless Send is held.
  const canSend = () => !sendHeld() && (sendable().length > 0 || overallChanged() || state.changeCount > 0);

  // The server's lock rule (`roundOut` in `server/lib/session.mjs`): the last round sent has no
  // note reply and no overall reply yet, so the diagram takes no save until the agent answers.
  function roundOut() {
    const round = state.session?.round ?? 0;
    if (round === 0) {
      return false;
    }
    const answered = (replies) => (replies ?? []).some((reply) => reply.round === round);
    return !answered(state.session.overallReplies) && !annotations().some((a) => answered(a.replies));
  }

  // ---- the viewer's own notes ----------------------------------------------

  function addNote(note) {
    annotations().push(note);
  }

  // Only an unsent note is edited or deleted; a sent note sharing its id stays as the server
  // holds it.
  function updateNote(id, fields) {
    const target = annotations().find((a) => a.id === id && !isSent(a));
    if (target) {
      Object.assign(target, fields);
    }
  }

  function deleteNote(id) {
    state.session.annotations = annotations().filter((a) => !(a.id === id && !isSent(a)));
  }

  const unsentIds = (list) => new Set(list.filter((a) => !isSent(a)).map((a) => a.id));

  // The server refuses a whole write that carries a new note on an anchor it does not list
  // (CONTRACT.md §7), as when a box is deleted before its note's first save. Returns the notes
  // removed.
  function dropUnstored() {
    const dropped = annotations().filter((a) => !isSent(a) && !state.storedIds.has(a.id) && !listed(a.anchor));
    if (dropped.length > 0) {
      state.session.annotations = annotations().filter((a) => !dropped.includes(a));
      if (dropped.some((a) => a.id === view.editing())) {
        view.closeComposer();
      }
      scheduleSave();
    }
    return dropped;
  }

  // ---- persistence ---------------------------------------------------------

  function payload() {
    return { overall: view.overall(), annotations: annotations() };
  }

  function stopSaveTimer() {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }

  function scheduleSave() {
    if (state.standalone || state.ending || state.ended) {
      return;
    }
    clearTimeout(state.saveTimer);
    view.saveState('saving…');
    state.saveTimer = setTimeout(save, saveDelay);
  }

  // Queues one write behind the previous one; the payload is read when the write starts, not
  // when it is queued, so a queued write always carries the newest session.
  function enqueue(write) {
    const run = state.writes.then(write);
    state.writes = run.catch(() => {});
    return run;
  }

  // PUTs the session as it stands when the write's turn comes.
  async function writeSession() {
    try {
      const body = payload();
      const res = await api('PUT', '/api/session', body);
      state.storedIds = unsentIds(body.annotations);
      view.saveState(`saved ${new Date(res.updatedAt).toLocaleTimeString()}`);
    } catch (err) {
      if (err.status === 409) {
        markEnding();
      } else {
        view.saveState(`save failed: ${err.message}`);
      }
    }
  }

  function save() {
    stopSaveTimer();
    return enqueue(writeSession);
  }

  // ---- server changes ------------------------------------------------------

  // Reads the session the page opens with. The caller renders it, then starts watchChanges.
  async function load() {
    const data = await api('GET', '/api/session');
    state.standalone = data.session === null;
    state.session = data.session ?? { root: '', scope: [], out: null, overall: '', round: 0, rounds: [], overallReplies: [], annotations: [] };
    setFiles(data.files);
    state.storedIds = unsentIds(state.session.annotations);
    state.changes = data.changes;
    return data.session;
  }

  // Takes the server's copy in by ownership: the sent notes, the round fields, the overall
  // replies and `out` come from the server; the unsent notes and the overall text stay as the
  // viewer holds them. When the two copies disagree on what is unsent, a save levels the server.
  // A local note the server does not hold whose anchor fails the anchor rule against the current
  // listing is one the server drops on every write, so it is removed here and returned; a stored
  // candidate note is kept whatever the overview names.
  function mergeSession(server) {
    const sent = server.annotations.filter(isSent);
    const sentIds = new Set(sent.map((a) => a.id));
    const stored = server.annotations.filter((a) => !isSent(a));
    const storedIds = new Set(stored.map((a) => a.id));
    state.storedIds = storedIds;
    const local = annotations().filter((a) => !isSent(a) && !sentIds.has(a.id));
    const keep = (a) => storedIds.has(a.id) || listed(a.anchor);
    const kept = local.filter(keep);
    const dropped = local.filter((a) => !keep(a));
    const ids = (list) => list.map((a) => a.id).join('\n');
    const overall = view.overall();
    const differs = ids(kept) !== ids(stored) || server.overall !== overall;
    state.session = { ...server, overall, annotations: [...sent, ...kept] };
    // An edit of a note that has since been sent has nothing left to update.
    const editing = view.editing();
    if (editing !== null && !kept.some((a) => a.id === editing)) {
      view.closeComposer();
    }
    if (differs) {
      scheduleSave();
    }
    return dropped;
  }

  // Flushes a pending save, reads the session behind every queued write, merges it, and has the
  // view re-render what depends on it.
  async function refresh() {
    if (state.standalone) {
      return;
    }
    const pending = state.saveTimer !== null;
    stopSaveTimer();
    let dropped = [];
    await enqueue(async () => {
      if (pending) {
        await writeSession();
      }
      const data = await api('GET', '/api/session');
      // The merge checks local notes against the refreshed listing, so the listing comes first.
      setFiles(data.files);
      dropped = mergeSession(data.session);
      state.changes = Math.max(state.changes, data.changes);
    });
    // A successful refresh is the next action that clears the last action's message, so the
    // round state shows again; the run-ending message stays until the end overlay.
    if (!state.ending) {
      view.clearNotice();
      if (dropped.length) {
        view.dropped(dropped);
      }
    }
    await view.refreshed();
  }

  // Holds one GET /api/changes for the life of the page. A change refreshes the page and re-arms
  // the wait; the end of the run raises the end overlay. Requests start at least a second apart,
  // and a failure retries after a backoff from 1 s, doubling up to 10 s. The held wait answers
  // only at the next change, which can be a whole round away, so after a lost connection a
  // request the server answers at once confirms it is back before the wait re-arms. A refresh
  // that fails with the server answering is the refresh's error, not a lost connection.
  async function watchChanges() {
    let backoff = 1000;
    while (!state.ended) {
      const started = Date.now();
      let failed = false;
      try {
        if (state.connection) {
          await api('GET', '/api/session');
          state.connection = '';
          view.renderStatus();
        }
        const res = await api('GET', `/api/changes?after=${state.changes}`);
        if (res.status !== 'changed') {
          end(res.status);
          return;
        }
      } catch {
        failed = true;
        state.connection = LOST_CONTACT;
        view.renderStatus();
      }
      if (!failed) {
        try {
          await refresh();
        } catch (err) {
          failed = true;
          if (err.status === 0) {
            state.connection = LOST_CONTACT;
            view.renderStatus();
          } else {
            view.notify(`The page could not refresh: ${err.message} — retrying`, { error: true });
          }
        }
      }
      if (failed) {
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 10000);
      } else {
        backoff = 1000;
        await sleep(Math.max(0, 1000 - (Date.now() - started)));
      }
    }
  }

  // ---- rounds and the end of the run ---------------------------------------

  // Raises the end-of-run overlay once, whichever end came first: the viewer's own Finish or
  // Cancel, or an end the change poll reports.
  function end(status) {
    if (state.ended) {
      return;
    }
    state.ended = true;
    stopSaveTimer();
    view.showEnd(status);
  }

  // Disables Send, Finish and Cancel while a lifecycle request is in flight, and for good once the
  // run is ending; when idle, Send follows its own rule again.
  function setBusy(flag) {
    state.busy = flag || state.ending;
    view.renderControls();
  }

  // The server refused a write because the run is ending: saving stops, and the change poll's end
  // document raises the overlay.
  function markEnding() {
    state.ending = true;
    stopSaveTimer();
    setBusy(true);
    view.notify('The review has ended.');
  }

  // A note still open in the composer is added (or its update applied) first, so it goes out too.
  function commitComposer() {
    const composer = view.composer();
    if (composer?.dirty()) {
      composer.commit();
    }
  }

  // Sends the round. The write queues behind any write in flight, so its body is the newest
  // session; the refresh that follows locks the sent notes and shows the waiting state.
  async function sendRound() {
    commitComposer();
    if (!canSend()) {
      return;
    }
    view.clearNotice();
    setBusy(true);
    stopSaveTimer();
    try {
      const res = await enqueue(() => api('POST', '/api/submit', payload()));
      view.saveState(`round ${res.round} sent ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      if (err.status === 409 && err.message === 'nothing to send') {
        view.notify('Nothing new to send.');
      } else if (err.status === 409) {
        markEnding();
      } else {
        view.notify(`Send failed: ${err.message}`, { error: true });
      }
      setBusy(false);
      return;
    }
    try {
      await refresh();
    } catch (err) {
      view.notify(`The round was sent, but the page could not refresh: ${err.message}`, { error: true });
    }
    setBusy(false);
  }

  // Finish adds a note still open in the composer, then asks before ending the run. Unsent work
  // stays in the notes file without a round, and the dialog names it.
  async function finishRun() {
    if (state.standalone) {
      await endRun('/api/finish', 'finished');
      return;
    }
    commitComposer();
    const count = unsent().length;
    const kept = [];
    if (count) {
      kept.push(`${count} unsent ${count === 1 ? 'note' : 'notes'}`);
    }
    if (overallChanged()) {
      kept.push('the overall direction edit');
    }
    const clause = kept.length ? ` Kept in the notes file but not sent to the agent: ${kept.join(' and ')}.` : '';
    if (view.confirm(`Finish the review?${clause}`)) {
      await endRun('/api/finish', 'finished');
    }
  }

  // Cancel discards a note still open in the composer, and says so before ending the run.
  async function cancelRun() {
    const writing = view.composer()?.dirty() ? ' The note you are writing is discarded too.' : '';
    if (view.confirm(`Cancel the review? The unsent notes are discarded: the agent never receives them, and the review ends.${writing}`)) {
      view.closeComposer();
      await endRun('/api/cancel', 'cancelled');
    }
  }

  // Posts Finish or Cancel behind any write in flight, so its body is the newest session, and
  // raises the end overlay once the server has saved the run's end.
  async function endRun(route, status) {
    view.clearNotice();
    setBusy(true);
    stopSaveTimer();
    try {
      await enqueue(() => api('POST', route, payload()));
    } catch (err) {
      if (err.status === 409) {
        markEnding();
      } else {
        view.notify(`${status === 'finished' ? 'Finish' : 'Cancel'} failed: ${err.message}`, { error: true });
        setBusy(false);
      }
      return;
    }
    end(status);
  }

  return {
    get session() {
      return state.session;
    },
    get files() {
      return state.files;
    },
    get connection() {
      return state.connection;
    },
    get busy() {
      return state.busy;
    },
    get ended() {
      return state.ended;
    },
    get standalone() {
      return state.standalone;
    },
    changeCount: () => state.changeCount,
    setCandidates,
    setDiagram,
    listed,
    removed,
    unsent,
    withheld,
    sendable,
    sendHeld,
    overallChanged,
    canSend,
    roundOut,
    addNote,
    updateNote,
    deleteNote,
    dropUnstored,
    load,
    scheduleSave,
    save,
    refresh,
    watchChanges,
    sendRound,
    finishRun,
    cancelRun,
  };
}
