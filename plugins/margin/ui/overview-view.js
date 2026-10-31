// The viewer's Overview tab: the candidate cards, the outline rows and the detail card of the row
// opened, rendered from GET /api/overview's document through ./overview.js's model. It owns those
// nodes, the open detail card and the clicks and keys that dismiss it; everything outside the tab
// goes through the callbacks createOverviewView takes. Overview data reaches the page as text only.

import { CANDIDATE_COLOURS, buildOutline, noteCounts } from './overview.js';

const NO_ROOT_FOLDER = 'A file at the root has no folder to annotate; use a general note';

const candidateColour = (index) => CANDIDATE_COLOURS[index % CANDIDATE_COLOURS.length];
const reading = (value, unit) => (value === null ? 'not measured' : `${value} ${unit}`);
const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

function textNode(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

// Read from the path the event was dispatched along, which still holds the ancestors of a target
// that a handler removed, as the composer does with its own Add button.
const eventInside = (event, selector) => event.composedPath().some((node) => node instanceof Element && node.matches(selector));

// `nodes` are the tab's pane, its notice line and its body. The callbacks:
//   listed(anchor)          whether a new note on the anchor would be accepted now
//   notes()                 the session's notes
//   ended()                 true once the run is over: every action is disabled
//   openCode(path, line)    shows the file in the Code tab, at the line when one is given
//   annotate(anchor)        opens the composer on the anchor
// Escape while a detail card is open closes it and marks the event handled (defaultPrevented).
export function createOverviewView({ nodes, listed, notes, ended, openCode, annotate }) {
  const state = {
    // The run's overview: null without one, { doc } once read, { error } when the read failed.
    overview: null,
    shown: false, // the tab is the center pane on screen
    dirty: true, // the tab needs rendering the next time it is shown
    detail: null, // the path whose detail card is open, or null
    // The rendered outline: { doc, model, box, nodes: path → file row node }, or null.
    outline: null,
  };

  function enableUnless(button, why, onClick) {
    const reason = ended() ? 'The review has ended' : why;
    if (reason) {
      button.disabled = true;
      button.title = reason;
    } else {
      button.addEventListener('click', onClick);
    }
    return button;
  }

  function setNotice(text) {
    nodes.notice.textContent = text;
    nodes.notice.title = text;
  }

  function render() {
    if (!state.overview || !state.shown) {
      state.dirty = true;
      return;
    }
    state.dirty = false;
    if (state.overview.error) {
      state.outline = null;
      state.detail = null;
      setNotice('');
      nodes.body.replaceChildren(textNode('div', 'empty', `Could not load the overview: ${state.overview.error}`));
      return;
    }
    const { doc } = state.overview;
    setNotice(doc.notices.join(' · '));
    const model = buildOutline(doc, { listed });
    const counts = noteCounts(notes());
    const filesHead = textNode('h3', 'ov-head', `Files (${doc.files.length})`);
    filesHead.append(barLegend());
    let outline = null;
    if (doc.files.length) {
      const box = document.createElement('div');
      box.className = 'outline';
      const rows = new Map();
      for (const group of model.groups) {
        for (const row of group.rows) {
          if (row.type === 'folder') {
            box.append(outlineFolderRow(row, counts));
          } else {
            const node = outlineFileRow(row, doc, counts);
            rows.set(row.path, node);
            box.append(node);
          }
        }
      }
      outline = { doc, model, box, nodes: rows };
    }
    const { scrollTop } = nodes.pane;
    nodes.body.replaceChildren(candidateSection(doc, counts), filesHead, outline ? outline.box : textNode('div', 'empty', 'No files in this overview.'));
    nodes.pane.scrollTop = scrollTop;
    state.outline = outline;
    if (state.detail !== null && !placeDetail(state.detail, { reveal: false })) {
      state.detail = null;
    }
  }

  function barLegend() {
    const legend = document.createElement('span');
    legend.className = 'legend';
    legend.append(textNode('i', 'churn', ''), 'churn', textNode('i', 'tangle', ''), 'tangle');
    return legend;
  }

  function candidateSection(doc, counts) {
    const section = document.createElement('section');
    section.className = 'cands';
    section.append(textNode('h3', 'ov-head', `Candidates (${doc.candidates.length})`));
    if (doc.candidates.length === 0) {
      section.append(textNode('p', 'ov-none muted', 'No candidates.'));
    }
    doc.candidates.forEach((candidate, index) => section.append(candidateCard(candidate, index, counts)));
    return section;
  }

  function candidateCard(candidate, index, counts) {
    const card = document.createElement('article');
    card.className = 'cand';
    card.dataset.name = candidate.name;
    card.style.setProperty('--c', candidateColour(index));

    const head = document.createElement('div');
    head.className = 'cand-head';
    head.append(
      textNode('span', 'cand-name', candidate.name),
      textNode('span', 'tier', candidate.tier),
      textNode('span', 'muted', candidate.category),
      textNode('span', 'muted', `~${candidate.est_diff_lines} lines`),
    );
    const field = (label, text) => {
      const line = document.createElement('p');
      line.className = 'cand-field';
      line.append(textNode('b', '', `${label}: `), text);
      return line;
    };
    card.append(
      head,
      textNode('p', 'cand-next', candidate.next_change),
      field('friction', candidate.friction),
      field('deletion test', candidate.deletion_test),
      field('files', candidate.files.join(', ')),
    );
    if (candidate.next_sites.length) {
      const sites = document.createElement('ul');
      sites.className = 'sites';
      for (const site of candidate.next_sites) {
        const link = textNode('button', 'link', `${site.path}:${site.line} — ${site.what}`);
        const siteListed = listed({ kind: 'file', path: site.path });
        enableUnless(link, siteListed ? '' : `${site.path} is not in this review's listing`, () => {
          openCode(site.path, site.line);
        });
        const item = document.createElement('li');
        item.append(link);
        sites.append(item);
      }
      card.append(sites);
    }
    const count = counts.get(`candidate:${candidate.name}`) ?? 0;
    const actions = document.createElement('div');
    actions.className = 'cand-actions';
    actions.append(
      enableUnless(textNode('button', '', count ? `Note on candidate (${count})` : 'Note on candidate'), '', () => {
        annotate({ kind: 'candidate', name: candidate.name });
      }),
    );
    card.append(actions);
    return card;
  }

  function outlineNoteButton(count, noun, why, anchor) {
    const btn = textNode('button', `note-btn${count ? ' has' : ''}`, count ? String(count) : '+');
    btn.title = `Annotate this ${noun}`;
    return enableUnless(btn, why, (event) => {
      event.stopPropagation();
      annotate(anchor);
    });
  }

  function outlineFolderRow(row, counts) {
    const node = document.createElement('div');
    node.className = 'o-row o-folder';
    node.style.setProperty('--d', String(row.depth));
    const name = textNode('span', 'o-name', row.path === '.' ? '.' : `${row.name}/`);
    name.title = row.path;
    const contents = row.folders ? `${plural(row.files, 'file')} · ${plural(row.folders, 'folder')}` : plural(row.files, 'file');
    node.append(name, textNode('span', 'o-count muted', contents), textNode('span', 'spacer', ''));
    let why = row.listed ? '' : "This folder is not in this review's listing";
    if (row.path === '.') {
      why = NO_ROOT_FOLDER;
    }
    node.append(outlineNoteButton(counts.get(`folder:${row.path}`) ?? 0, 'folder', why, { kind: 'folder', path: row.path }));
    return node;
  }

  function outlineBars(row) {
    const { file } = row;
    const stack = document.createElement('span');
    stack.className = row.churnBar === null && row.tangleBar === null ? 'stack none' : 'stack';
    stack.title = `churn ${reading(file.churn, 'commits in 6 months')} · tangle ${reading(file.indentation, 'summed indentation')}`;
    for (const [className, fraction] of [['churn', row.churnBar], ['tangle', row.tangleBar]]) {
      const bar = document.createElement('i');
      bar.className = className;
      bar.style.width = fraction === null ? '0' : `${Math.max(4, fraction * 100)}%`;
      stack.append(bar);
    }
    return stack;
  }

  function outlineFlags(row, doc, counts) {
    const { file } = row;
    const flags = document.createElement('span');
    flags.className = 'o-flags';
    for (const kind of file.mixes ?? []) {
      const mix = textNode('i', 'mix', Array.from(kind)[0]);
      mix.title = `also ${kind}`;
      flags.append(mix);
    }
    for (const index of row.candidates) {
      const { name } = doc.candidates[index];
      const count = counts.get(`candidate:${name}`) ?? 0;
      const dot = document.createElement('i');
      dot.className = count ? 'dot has-note' : 'dot';
      dot.style.setProperty('--c', candidateColour(index));
      dot.title = count ? `${name} · ${plural(count, 'note')}` : name;
      dot.addEventListener('click', (event) => {
        event.stopPropagation();
        revealCandidate(name);
      });
      flags.append(dot);
    }
    if (file.outside.length) {
      const out = textNode('span', 'o-out', `↗${file.outside.length}`);
      out.title = `${plural(file.outside.length, 'import')} from outside the overview`;
      flags.append(out);
    }
    return flags;
  }

  function outlineFileRow(row, doc, counts) {
    const { file } = row;
    const node = document.createElement('div');
    node.className = 'o-row o-file';
    node.dataset.path = row.path;
    node.style.setProperty('--d', String(row.depth));
    const name = textNode('span', 'o-name', row.name);
    name.title = row.path;
    const role = textNode('span', 'o-role', file.role ?? '');
    role.title = file.role ?? '';
    node.append(
      name,
      outlineBars(row),
      textNode('span', 'o-lines', file.lines === null ? '–' : String(file.lines)),
      textNode('span', 'o-kind', file.kind ?? ''),
      outlineFlags(row, doc, counts),
      role,
      outlineNoteButton(counts.get(`file:${row.path}`) ?? 0, 'file', row.listed ? '' : "This file is not in this review's listing", { kind: 'file', path: row.path }),
    );
    node.addEventListener('click', () => toggleDetail(row.path));
    return node;
  }

  // Opens a candidate's card: it scrolls into view, takes the focus and stays outlined until another
  // card is opened or the overview re-renders. The outline sits outside the box, so nothing moves.
  function revealCandidate(name) {
    const cards = [...nodes.body.querySelectorAll('.cand')];
    const card = cards.find((c) => c.dataset.name === name);
    if (!card) {
      return;
    }
    for (const other of cards) {
      other.classList.toggle('target', other === card);
    }
    card.tabIndex = -1;
    card.scrollIntoView({ block: 'nearest' });
    card.focus({ preventScroll: true });
  }

  // ---- the outline's detail card --------------------------------------------

  function toggleDetail(path) {
    const same = state.detail === path;
    closeDetail();
    if (!same && placeDetail(path, { reveal: true })) {
      state.detail = path;
    }
  }

  function closeDetail() {
    state.detail = null;
    state.outline?.box.querySelector('.o-pop')?.remove();
    state.outline?.box.querySelector('.o-file.open')?.classList.remove('open');
  }

  function placeDetail(path, { reveal }) {
    const node = state.outline?.nodes.get(path);
    if (!node) {
      return false;
    }
    const row = state.outline.model.groups.flatMap((g) => g.rows).find((r) => r.path === path && r.type === 'file');
    const card = detailCard(row, state.outline);
    state.outline.box.append(card);
    node.classList.add('open');
    card.style.top = `${node.offsetTop + node.offsetHeight + 2}px`;
    if (reveal) {
      card.scrollIntoView({ block: 'nearest' });
    }
    return true;
  }

  function detailCard(row, { doc, model }) {
    const { file, path, folder } = row;
    const counts = noteCounts(notes());
    const card = document.createElement('div');
    card.className = 'o-pop';
    card.style.setProperty('--d', String(row.depth));

    const head = document.createElement('div');
    head.className = 'pop-head';
    const close = textNode('button', 'ghost small', '×');
    close.title = 'Close (Esc)';
    close.addEventListener('click', closeDetail);
    head.append(textNode('span', 'pop-path', path), textNode('span', 'spacer', ''), close);

    const role = textNode('p', file.role === null ? 'pop-role muted' : 'pop-role', file.role ?? 'No role recorded.');

    const facts = document.createElement('dl');
    facts.className = 'pop-facts';
    const fact = (label, ...value) => {
      const dd = document.createElement('dd');
      dd.append(...value);
      facts.append(textNode('dt', '', label), dd);
    };
    const list = (paths) => (paths.length ? paths.join(', ') : 'none');
    fact('kind', [file.kind ?? 'not recorded', ...(file.mixes ?? []).map((kind) => `also ${kind}`)].join(', '));
    fact('lines', file.lines === null ? 'not measured' : String(file.lines));
    fact('churn', reading(file.churn, 'commits in 6 months'));
    fact('tangle', reading(file.indentation, 'summed indentation'));
    fact('exports', file.exports === null ? 'not recorded' : list(file.exports));
    fact('imports', list(file.imports));
    fact('imported by', list(model.importedBy.get(path)));
    if (row.candidates.length) {
      const links = row.candidates.flatMap((index, i) => {
        const { name } = doc.candidates[index];
        const link = textNode('button', 'link', name);
        link.style.color = candidateColour(index);
        link.addEventListener('click', () => revealCandidate(name));
        return i ? [', ', link] : [link];
      });
      fact('candidates', ...links);
    }
    if (file.outside.length) {
      fact('outside imports', file.outside.join(', '));
    }

    const generated = textNode('p', 'pop-gen muted', `Overview generated ${new Date(doc.generatedAt).toLocaleString()}`);

    const actions = document.createElement('div');
    actions.className = 'pop-actions';
    const unlisted = `${path} is not in this review's listing`;
    const fileNotes = counts.get(`file:${path}`) ?? 0;
    const folderNotes = counts.get(`folder:${folder}`) ?? 0;
    actions.append(
      enableUnless(textNode('button', 'primary', 'Open code'), row.listed ? '' : unlisted, () => {
        openCode(path);
      }),
      enableUnless(textNode('button', '', fileNotes ? `Note on file (${fileNotes})` : 'Note on file'), row.listed ? '' : unlisted, () => {
        annotate({ kind: 'file', path });
      }),
    );
    if (folder === '') {
      const rootFolder = textNode('button', '', 'Note on folder');
      rootFolder.disabled = true;
      rootFolder.title = NO_ROOT_FOLDER;
      actions.append(rootFolder);
    } else {
      const label = `Note on ${folder}/${folderNotes ? ` (${folderNotes})` : ''}`;
      actions.append(
        enableUnless(textNode('button', '', label), row.folderListed ? '' : `${folder}/ is not in this review's listing`, () => {
          annotate({ kind: 'folder', path: folder });
        }),
      );
    }

    card.append(head, role, facts, generated, actions);
    return card;
  }

  // ---- dismissal ------------------------------------------------------------

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.detail !== null && !eventInside(event, 'textarea, input')) {
      closeDetail();
      event.preventDefault();
    }
  });
  // Clicks in the Notes panel and the composer leave the card open beside the note being written.
  document.addEventListener('click', (event) => {
    if (state.detail !== null && !eventInside(event, '.o-pop, .o-file, .notes, .composer')) {
      closeDetail();
    }
  });

  return {
    get overview() {
      return state.overview;
    },
    setOverview(overview) {
      state.overview = overview;
      state.dirty = true;
    },
    // The tab comes on screen or leaves it: shown, it renders what changed while it was hidden;
    // hidden, its detail card closes.
    show(shown) {
      state.shown = shown;
      if (!shown) {
        closeDetail();
      } else if (state.dirty) {
        render();
      }
    },
    render,
    revealCandidate,
  };
}
