// Builds the site into _site/: a home page plus sets/<slug>/index.html for each
// appearance. Reads the published CSVs of your links sheet. No dependencies; Node 20+.
//
//   node build.mjs            build from the live sheet
//   node build.mjs --serve    build, then preview at http://localhost:8080

import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, extname } from 'node:path';

const config = JSON.parse(await readFile(new URL('./config.json', import.meta.url), 'utf8'));
const OUT = '_site';

/* ---------- data ---------- */

const csvUrl = gid =>
  `https://docs.google.com/spreadsheets/d/e/${config.pubId}/pub?gid=${gid}&single=true&output=csv`;

function parseCSV(t) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

function toObjects(rows) {
  const keys = (rows[0] || []).map(h => h.trim().toLowerCase());
  return rows.slice(1)
    .filter(r => r.some(v => v.trim()))
    .map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] || '').trim()])));
}

async function loadCSV(gid, label) {
  const res = await fetch(csvUrl(gid));
  if (!res.ok) throw new Error(`${label} tab returned HTTP ${res.status}. Is the sheet published, and is the gid right?`);
  const text = await res.text();
  if (text.trimStart().startsWith('<')) throw new Error(`${label} tab returned a web page, not CSV. Check pubId and gid.`);
  return toObjects(parseCSV(text));
}

const isUnknown = v => /^unknown$/i.test((v || '').trim());
const byId = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const slugify = s => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function ytId(url) {
  const m = (url || '').match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/);
  return m ? m[1] : '';
}

/* ---------- templates ---------- */

const canSubmit = /^https:\/\/script\.google\.com\//.test(config.submitUrl || '');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout({ title, description, root, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=League+Spartan:wght@400;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${root}assets/site.css">
</head>
<body${canSubmit ? ` data-submit="${esc(config.submitUrl)}"` : ''}>
<div class="site" id="top">
${body}
<p class="updated">Updated ${new Date().toUTCString()}</p>
</div>
<script src="${root}assets/player.js" defer></script>
</body>
</html>
`;
}

// Tab "21-Miami" → "Miami". The sheet script already does this; this is a fallback.
const cityName = tab => (tab || '').replace(/^\s*\d+\s*[-–—]\s*/, '').replace(/\s*\(.*\)\s*$/, '').trim();

// Left-hand list. Clicking a gig opens its page, where it's expanded with its dates and
// the day you're reading highlighted (assets/player.js keeps that in step as you scroll).
// On the home page every gig starts collapsed.
function cityNav(list, current, root, isHome) {
  return `<nav class="cities" aria-label="Gigs">
<ul>
<li><a class="city about-link" href="${root}about/"${current === 'about' ? ' aria-current="page"' : ''}>About</a></li>
${list.map(a => {
    const href = `${root}sets/${a.slug}/`;
    if (a !== current) return `<li><a class="city" href="${href}">${esc(a.label)}</a></li>`;
    // A page with no dates (Despacio Classics) is a plain link, not an expander.
    if (!a.dates.length) return `<li><a class="city" href="${href}" aria-current="page">${esc(a.label)}</a></li>`;
    const multi = a.dates.length > 1;
    const dates = (a.dates.length ? a.dates : ['Setlist'])
      .map((d, i) => `<li><a href="${multi ? `#${dayId(d)}` : '#top'}"${!isHome && i === 0 ? ' class="active" aria-current="location"' : ''}>${esc(d)}</a></li>`)
      .join('');
    return `<li><details${isHome ? '' : ' open'}><summary aria-current="page">${esc(a.label)}</summary><ul class="dates">${dates}</ul></details></li>`;
  }).join('\n')}
<li><a class="city all-songs-link" href="${root}songs/"${current === 'songs' ? ' aria-current="page"' : ''}>All songs</a></li>
</ul>
</nav>`;
}

const dayId = d => `d-${d.replace(/\//g, '-')}`;

function trackItem(t, i, playedAt, root) {
  const artist = t['artist'];
  const title = t['song title'];
  const id = t['unique id'];
  const unknown = isUnknown(artist) && isUnknown(title);
  const yt = unknown ? '' : ytId(t['youtube']);

  const song = unknown
    ? '<span class="title">Unknown - Unknown</span>'
    : songLine(artist, title || 'Untitled');

  // Tracks without a URL are still listed, just with no Play button.
  const play = yt
    ? `<button type="button" class="play" data-yt="${yt}" aria-expanded="false" aria-label="Play ${esc([artist, title].filter(Boolean).join(' – ') || 'track')} on YouTube">Play</button>`
    : '';
  // Anyone can submit a YouTube link for an identified track (only the link, never artist/title).
  const fix = canSubmit && !unknown && !isUnknown(title)
    ? `<button type="button" class="fix">${yt ? 'Wrong link?' : 'Add link'}</button>`
    : '';

  return `<li class="track${unknown ? ' unidentified' : ''}" id="t-${esc(slugify(id) || String(i + 1))}" data-gid="${esc(t['gid'])}" data-id="${esc(id)}">
  <span class="pos">${String(i + 1).padStart(2, '0')}</span>
  <span class="song">${song}${playedAt ? `<span class="count">${playedAtLine(playedAt, root)}</span>` : ''}</span>
  <span class="sources">${play}${fix}</span>
  <div class="player" hidden></div>
</li>`;
}

// Artist – Title on one line (wrapping on narrow screens), artist first as in DJ tracklists.
function songLine(artist, title) {
  return `<span class="line">${artist ? `<span class="artist">${esc(artist)}</span><span class="sep"> – </span>` : ''}<span class="title">${esc(title)}</span></span>`;
}

function page({ list, current, root, main, title, description, isHome }) {
  return layout({
    title, description, root,
    body: `<a class="site-title" href="${root || './'}">${esc(config.siteTitle)}</a>
<div class="layout">
${cityNav(list, current, root, isHome)}
<main>
${main}
</main>
</div>`,
  });
}

// One list per day. Multi-day gigs get a date heading before each day's tracks,
// which the date links in the left-hand list jump to.
// Player bar above each setlist: Previous, Play/Pause, Next, what's playing, and an
// Autoplay switch (off by default). assets/player.js makes it work.
const icon = d => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
const shuffleButton = `<button type="button" class="btn shuffle" data-action="shuffle" aria-pressed="false" aria-label="Shuffle" title="Shuffle">${icon('M10.6 9.2 5.4 4 4 5.4l5.2 5.2 1.4-1.4zM14.5 4l2 2L4 18.6 5.4 20 18 7.5l2 2V4h-5.5zm.3 9.4-1.4 1.4 3.1 3.1-2 2H20v-5.5l-2 2-3.2-3z')}</button>`;

const playerBar = `<div class="controls" role="group" aria-label="Player">
  <div class="transport">
    <button type="button" class="btn" data-action="prev" aria-label="Previous track">${icon('M6 5h2v14H6zM20 5v14L9 12z')}</button>
    <button type="button" class="btn toggle" data-action="toggle" data-state="paused" aria-label="Play">${icon('M8 5v14l11-7z').replace('<svg', '<svg class="i-play"')}${icon('M7 5h4v14H7zM13 5h4v14h-4z').replace('<svg', '<svg class="i-pause"')}</button>
    <button type="button" class="btn" data-action="next" aria-label="Next track">${icon('M16 5h2v14h-2zM4 5v14l11-7z')}</button>
    ${shuffleButton}
  </div>
  <p class="now" aria-live="polite"></p>
  <label class="autoplay"><input type="checkbox" role="switch"> Autoplay</label>
</div>
`;

// Pages that aren't a gig (Despacio Classics) show where each song was played.
function tracklist(a, root, residencies) {
  const days = [];
  a.tracks.forEach((t, i) => {
    const d = t['date'] || '';
    if (!days.length || days[days.length - 1].date !== d) days.push({ date: d, items: [] });
    const playedAt = a.gig || !residencies ? null : residencies.get(masterKey(t['artist'], t['song title']));
    days[days.length - 1].items.push(trackItem(t, i, playedAt, root));
  });
  const multi = a.dates.length > 1;
  return days.map(day => `${multi && day.date ? `<h2 class="day" id="${dayId(day.date)}">${esc(day.date)}</h2>\n` : ''}<ol class="tracks">
${day.items.join('\n')}
</ol>`).join('\n');
}

function setPage(a, list, root = '../../', isHome = false, residencies) {
  const count = a.tracks.length;
  return page({
    list, current: a, root, isHome,
    title: `${a.label} | ${config.siteTitle}`,
    description: `${a.year ? `${config.siteTitle} setlist, ${a.city}` : `${config.siteTitle}: ${a.city}`}${a.event ? `, ${a.event}` : ''}. ${count} track${count === 1 ? '' : 's'}.`,
    main: `<h1>${esc(a.label)}</h1>
${a.event ? `<p class="event">${esc(a.event)}</p>` : ''}
${count ? playerBar + tracklist(a, root, residencies) : '<p class="empty">No tracks on this setlist yet.</p>'}`,
  });
}

// The home page is the most recent gig's setlist.
const homePage = (list, residencies) => setPage(list[0], list, '', true, residencies);

// Tags that fold an entry into the original song: it's the same record, just labelled
// differently.
const STRIP_TAG = /(?:2\s*many\s*dj'?s|despacio)\s+(?:re-?)?edit|unknown\s+(?:version|edit)|remaster(?:ed)?|single\s+version|album\s+version|original\s+mix|radio\s+(?:edit|version|mix)/i;

// Tags that name the definitive version. They merge with the plain entry and their title
// is the one shown: "Kiss (Extended Mix)" over "Kiss".
const DEFINITIVE_TAG = /vocal\s+mix|extended\s+(?:mix|version|edit)|(?:12|7)\s*(?:["“”]|\s*inch)\s*(?:single\s*)?(?:version|mix|edit)?/i;

// Tags for a different recording. Each one is its own song, and a plain entry of the same
// title folds into it rather than sitting alongside it as a duplicate.
const OTHER_TAG = /remix|(?:club|dance|disco)\s+mix|instrumental|\bdub\b|a-?cappella|\blive\b|\bdemo\b|session|\bmono\b|reprise|bootleg|rework|\bvip\b|re-?edit|\bedit\b|\bpart\s*\d/i;

// Parts are separate tracks, so a plain entry never folds into one.
const PART_TAG = /\bpart\s*\d/i;

// A bracketed year on its own, like "[1978]" or "(1978)", is just a release date:
// it comes off so the entry folds into the plain title. A year alongside something
// else, like "(Live 1978)", is left alone.
const YEAR_ONLY = /^[\s([]*(?:19|20)\d{2}[\s)\]]*$/;

// Strips a tag from a title, whether bracketed or after a dash.
function stripTag(title, tag) {
  let t = String(title || '').trim();
  t = t.replace(/\s*[([][^)\]]*[)\]]/g, m => (tag.test(m) ? ' ' : m));
  t = t.replace(/\s+[-–—]\s+[^-–—]*$/, m => (tag.test(m) ? '' : m));
  return t.replace(/\s+/g, ' ').trim() || String(title || '').trim();
}

// For display: the "same record" tags and a bare year come off.
const displayTitle = title => stripTag(
  String(title || '').replace(/\s*[([][^)\]]*[)\]]/g, m => (YEAR_ONLY.test(m) ? ' ' : m)).replace(/\s+/g, ' ').trim(),
  STRIP_TAG);

// For grouping: every version tag comes off, so all versions of a song sit together.
const baseTitle = title => stripTag(stripTag(displayTitle(title), DEFINITIVE_TAG), OTHER_TAG);

// Which recording this entry is: "" for the original (and definitive versions), or the
// tag itself, e.g. "soulwaxremix", so each recording gets its own row.
function variantKey(title) {
  const t = displayTitle(title);
  const parts = [];
  (t.match(/[([][^)\]]*[)\]]/g) || []).forEach(m => { if (OTHER_TAG.test(m)) parts.push(m); });
  const dash = t.match(/\s+[-–—]\s+[^-–—]*$/);
  if (dash && OTHER_TAG.test(dash[0])) parts.push(dash[0]);
  return parts.join(' ').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Punctuation and brackets are ignored when grouping, so "(Soulwax Remix)" and
// "Soulwax Remix" are one song.
const normalize = v => String(v || '').toLowerCase()
  .replace(/\bfeat(uring)?\.?\b[^)\]]*/g, ' ')
  .replace(/\band\b/g, '&')
  .replace(/\bthe\b/g, ' ')
  .replace(/[^a-z0-9&]+/g, '');

const songKey = t => `${normalize(t['artist'])}|${normalize(baseTitle(t['song title']))}`;

// The key the sheet script uses to match Master Songs rows to tracks: edits, remasters and
// definitive versions fold into the song, but remixes, live takes etc. stay separate.
const masterKey = (artist, title) =>
  `${normalize(artist)}|${normalize(stripTag(displayTitle(title), DEFINITIVE_TAG))}`;

// Every residency each song was played at, newest first: song key → [{ label, path }].
// Worked out from the setlists at every build, so a new gig is included automatically.
// Residencies too small to have a page are listed without a link.
function residencyIndex(apps, byGid, list) {
  const pages = new Map(list.map(a => [a.gid, a]));
  const gigs = apps
    .filter(r => r['gid'] && /^\s*\d+\s*[-–—]/.test(r['tab'] || ''))
    .map(r => ({ gid: r['gid'], order: parseFloat(r['order']) || 0,
                 label: [r['city'] || cityName(r['tab']), r['year']].filter(Boolean).join(' ') }))
    .sort((a, b) => b.order - a.order);
  const index = new Map();
  gigs.forEach(g => {
    const page = pages.get(g.gid);
    const seen = new Set();
    (byGid[g.gid] || []).forEach(t => {
      if (!t['song title'] || isUnknown(t['song title'])) return;
      const k = masterKey(t['artist'], t['song title']);
      if (seen.has(k)) return; // first time it was played at this gig
      seen.add(k);
      const path = page ? `sets/${page.slug}/#t-${slugify(t['unique id'])}` : '';
      (index.get(k) || index.set(k, []).get(k)).push({ label: g.label, path });
    });
  });
  return index;
}

// "Played at Miami 2025 · Ghent 2024". Three or more collapse to "5 residencies", which
// expands to the names when clicked. Each name links to the song in that set.
function playedAtLine(playedAt, root) {
  if (!playedAt || !playedAt.length) return '';
  const names = playedAt.map(r => r.path
    ? `<a class="gig" href="${esc(root + r.path)}">${esc(r.label)}</a>`
    : `<span class="gig">${esc(r.label)}</span>`).join(' · ');
  if (playedAt.length < 3) return `Played at ${names}`;
  return `<details class="played"><summary>Played at ${playedAt.length} residencies</summary><span class="gigs">${names}</span></details>`;
}

// Which spelling to show: a definitive version wins, then the bracketed spelling,
// then the shortest.
const preferredTitle = titles =>
  titles.find(t => DEFINITIVE_TAG.test(t) && t.includes('(')) ||
  titles.find(t => DEFINITIVE_TAG.test(t)) ||
  titles.find(t => t.includes('(')) ||
  titles.slice().sort((a, b) => a.length - b.length)[0];

// The All songs page comes straight from the megalist tab of the spreadsheet. Versions of
// the same song are merged into one row, ranked by plays when the tab counts them.
// Songs with no link are listed too; Shuffle only picks from the ones that can be played.
function allSongsPage(list, megalist, residencies) {
  // With a hand-curated song list there are no duplicates to collapse, so
  // "mergeVersions": false in config.json shows the list exactly as written.
  if (config.mergeVersions === false) return allSongsPlain(list, megalist, residencies);

  // Group by song, then by which recording each entry is.
  const groups = new Map();
  megalist
    .filter(t => t['song title'] && !(isUnknown(t['artist']) && isUnknown(t['song title'])))
    .forEach(t => {
      const k = songKey(t);
      if (!k || k === '|') return;
      const group = groups.get(k) || new Map();
      group.base = group.base || baseTitle(t['song title']);
      group.artist = group.artist || normalize(t['artist']);
      const vk = variantKey(t['song title']);
      const v = group.get(vk) || { track: t, titles: [], plays: 0, versions: 0, yt: '', tag: vk };
      v.titles.push(displayTitle(t['song title']));
      v.plays += parseFloat(t['plays'] || 0) || 0;
      v.versions++;
      if (!v.yt && ytId(t['youtube'])) { v.yt = ytId(t['youtube']); v.track = t; }
      group.set(vk, v);
      groups.set(k, group);
    });

  // "You Make Me Feel Soulwax Remix" without brackets can't be stripped like "(Soulwax
  // Remix)", so it lands in its own group. Fold any such group into the plain song whose
  // title it starts with, keeping the leftover words as its recording tag.
  const byArtist = new Map();
  groups.forEach((group, k) => {
    const list = byArtist.get(group.artist) || [];
    list.push({ k, group, norm: normalize(group.base) });
    byArtist.set(group.artist, list);
  });
  byArtist.forEach(list => {
    list.slice().sort((a, b) => b.norm.length - a.norm.length).forEach(entry => {
      if (!OTHER_TAG.test(entry.group.base)) return; // no stray tag in this title
      const host = list
        .filter(o => o.k !== entry.k && o.norm.length < entry.norm.length && entry.norm.startsWith(o.norm))
        .sort((a, b) => b.norm.length - a.norm.length)[0];
      if (!host || !groups.has(entry.k)) return;
      const tag = entry.norm.slice(host.norm.length);
      entry.group.forEach(v => {
        const target = host.group.get(tag) || { track: v.track, titles: [], plays: 0, versions: 0, yt: '', tag };
        target.titles.push(...v.titles);
        target.plays += v.plays;
        target.versions += v.versions;
        if (!target.yt && v.yt) { target.yt = v.yt; target.track = v.track; }
        host.group.set(tag, target);
      });
      groups.delete(entry.k);
    });
  });

  // A plain entry alongside "(Soulwax Remix)" or "(Live)" is the same listing twice:
  // fold it into the tagged recording (the most played one, if there are several).
  const songs = [];
  groups.forEach(group => {
    const plain = group.get('');
    const tagged = [...group.values()].filter(v => v.tag && !PART_TAG.test(v.titles[0]));
    if (plain && tagged.length && !plain.titles.some(t => DEFINITIVE_TAG.test(t))) {
      const into = tagged.slice().sort((a, b) => b.plays - a.plays)[0];
      into.plays += plain.plays;
      into.versions += plain.versions;
      if (!into.yt && plain.yt) { into.yt = plain.yt; into.track = plain.track; }
      group.delete('');
    }
    group.forEach(v => songs.push(v));
  });

  const ranked = songs
    .map(song => ({ ...song, title: preferredTitle(song.titles) }))
    .sort((a, b) =>
      (b.plays - a.plays) ||
      String(a.track['artist']).localeCompare(String(b.track['artist'])) ||
      a.title.localeCompare(b.title));

  return renderSongs(list, ranked);
}

// Draws the All songs page from a ranked list of songs.
function renderSongs(list, ranked) {
  const items = ranked.map((song, i) => {
    const t = song.track;
    const play = song.yt
      ? `<button type="button" class="play" data-yt="${song.yt}" aria-expanded="false" aria-label="Play ${esc([t['artist'], song.title].filter(Boolean).join(' – '))} on YouTube">Play</button>`
      : '';
    const fix = canSubmit ? `<button type="button" class="fix">${song.yt ? 'Wrong link?' : 'Add link'}</button>` : '';
    const playedAt = playedAtLine(song.playedAt, '../');
    const meta = [
      playedAt || (song.plays ? `${song.plays} residenc${song.plays === 1 ? 'y' : 'ies'}` : ''),
      song.versions > 1 ? `${song.versions} versions` : '',
    ].filter(Boolean).join(', ');
    return `<li class="track" id="s-${esc(slugify(song.title) || String(i + 1))}" data-gid="${esc(t['gid'])}" data-id="${esc(t['unique id'])}" data-rank="${i}">
  <span class="song">
    ${songLine(t['artist'], song.title)}
    ${meta ? `<span class="count">${meta}</span>` : ''}
  </span>
  <span class="sources">${play}${fix}</span>
  <div class="player" hidden></div>
</li>`;
  }).join('\n');

  const ranksShown = ranked.some(song => song.plays > 0);
  return page({
    list, current: 'songs', root: '../',
    title: `All songs | ${config.siteTitle}`,
    description: `Every song identified at a Despacio residency${ranksShown ? ', ranked by how many residencies played it' : ''}.`,
    main: `<h1>All songs</h1>
<p class="event">${ranked.length} songs${ranksShown ? '<span class="ranked-note">, ranked by how many residencies played them</span>' : ''}.</p>
${playerBar}
<div class="filter">
  <input type="search" id="song-filter" placeholder="Filter by song or artist" autocomplete="off" aria-label="Filter songs">
  <p class="filter-count" aria-live="polite"></p>
</div>
<div class="sort" role="group" aria-label="Sort songs">
  <span class="sort-label">Sort:</span>
  ${ranksShown ? '<button type="button" data-sort="played" aria-pressed="true">Most played</button>' : ''}
  <button type="button" data-sort="az" aria-pressed="${ranksShown ? 'false' : 'true'}">A–Z</button>
  <button type="button" data-sort="random" aria-pressed="false">Random</button>
</div>
<ol class="tracks no-pos">
${items}
</ol>`,
  });
}
// Songs played at the same number of residencies are listed A–Z by artist, then title,
// the same way the A–Z button sorts: "The" is ignored and songs with no artist go last.
const noThe = v => String(v || '').trim().replace(/^the\s+/i, '');
const azCompare = (x, y) => x.localeCompare(y, undefined, { sensitivity: 'base', numeric: true });
const azOrder = (a, b) => {
  const aa = noThe(a.track['artist']), ba = noThe(b.track['artist']);
  return (!aa - !ba) || azCompare(aa, ba) || azCompare(noThe(a.title), noThe(b.title));
};

// One row per entry from the source tab, ranked by plays, ties A–Z.
// Songs found in the setlists are ranked by how many residencies played them; any that
// can't be matched (e.g. spelled differently) fall back to the tab's own count.
function allSongsPlain(list, source, residencies = new Map()) {
  const ranked = source
    .filter(t => t['song title'] && !(isUnknown(t['artist']) && isUnknown(t['song title'])))
    .map(t => {
      const playedAt = residencies.get(masterKey(t['artist'], t['song title'])) || [];
      return {
        track: t, title: String(t['song title']).trim(),
        plays: playedAt.length || parseFloat(t['plays'] || 0) || 0, versions: 1,
        yt: ytId(t['youtube']), playedAt,
      };
    })
    .sort((a, b) => (b.plays - a.plays) || azOrder(a, b));
  return renderSongs(list, ranked);
}

// About page. Edit the text here; it rebuilds with the site.
function aboutPage(list) {
  const root = '../';
  return page({
    list, current: 'about', root,
    title: `About | ${config.siteTitle}`,
    description: `About ${config.siteTitle}: how these setlists are built from the Despacio community spreadsheet.`,
    main: `<h1>About</h1>
<div class="prose">
<p>Setlists come from the song ID heroes of
<a href="https://discord.gg/despacio">discord.gg/despacio</a> and
<a href="https://www.reddit.com/r/despacio/">r/despacio</a>, who identify these tracks by ear in
the <a href="https://docs.google.com/spreadsheets/d/13JSLgoeB9lnosv_R2m4ZqYSlqM5A9y8hb4b2v_KaW7U/edit">spreadsheet of truth</a>.
This is a fan project, not affiliated with Despacio, Soulwax, 2manydjs or James Murphy.</p>

<h2>Where the links come from</h2>
<p>Links are found automatically by searching YouTube for each song, and shared between residencies
when the same song is played more than once. Some tracks have no link yet, and some songs
simply aren't on YouTube.</p>

<h2>Edits and versions</h2>
<p>If a song is labeled a "2manydjs Edit", "Despacio Edit", or "Unknown Version" the site
defaults to the original song. The tracklist still shows the title exactly as the community
wrote it.</p>

<h2>Tracks marked Unknown</h2>
<p>Tracks the community hasn't identified yet are listed in their place in the set as
"Unknown - Unknown", so the running order stays true to the night. When someone identifies one
in the spreadsheet, it appears here with its title, and a link follows soon after.</p>

<h2>Fixing a link</h2>
<p>If a link is wrong or broken, use <strong>Wrong link?</strong> next to the track and paste a
better one. Tracks with no link have <strong>Add link</strong> instead. Your change appears for
everyone within the hour, and it also fixes the same song at other residencies. Only the link can be
changed here; artists and titles come from the spreadsheet.</p>

<h2>Which residencies appear</h2>
<p>If you do not see a residency, it's because it has less than 25 identified tracks. Once the
community spreadsheet has reached that threshold, the residency will appear on the site.</p>

<h2>Playing a set</h2>
<p>Each track plays its own YouTube video. Turn on <strong>Autoplay</strong> in the player bar
and the next track with a link starts when one ends, so a set can keep playing in the
background. Playback stops after the last track with a link.</p>

<h2>How often this updates</h2>
<p>The spreadsheet is read every hour, so new tracks and corrections appear the same day.
New links are found overnight.</p>

</div>`,
  });
}

/* ---------- build ---------- */

async function build() {
  if (config.pubId.startsWith('PASTE')) throw new Error('Fill in pubId, appearancesGid and tracksGid in config.json.');

  const [apps, tracks] = await Promise.all([
    loadCSV(config.appearancesGid, 'Appearances'),
    loadCSV(config.tracksGid, 'Tracks'),
  ]);

  const byGid = {};
  tracks.forEach(t => { (byGid[t['gid']] ||= []).push(t); });
  // The megalist tab has no page of its own; it feeds the All songs page.
  const allSongsTab = (config.allSongsTab || 'megalist').trim().toLowerCase();
  const megalist = tracks.filter(t => String(t['appearance'] || '').trim().toLowerCase() === allSongsTab);
  if (!megalist.length) {
    const names = [...new Set(tracks.map(t => String(t['appearance'] || '').trim()))];
    console.warn(`No rows for the All songs page: nothing in the Tracks tab has Appearance "${allSongsTab}".`);
    console.warn(`Appearance values found: ${names.join(' | ') || '(none)'}`);
  }

  const used = new Set();
  const list = apps
    .filter(r => r['gid'] && (r['city'] || cityName(r['tab'])))
    .map(r => {
      let slug = slugify(r['slug'] || r['tab'] || '') || r['gid'];
      if (used.has(slug)) slug = `${slug}-${r['gid']}`;
      used.add(slug);
      return {
        gid: r['gid'], slug,
        city: r['city'] || cityName(r['tab']),
        year: r['year'],
        label: [r['city'] || cityName(r['tab']), r['year']].filter(Boolean).join(' '),
        event: r['event'],
        gig: /^\s*\d+\s*[-–—]/.test(r['tab'] || ''),
        order: parseFloat(r['order']) || 0,
        // Order comes from the sheet script's Position column (Unique ID order, or row
        // order for older tabs without IDs); Unique ID is the fallback.
        tracks: (byGid[r['gid']] || []).sort((a, b) =>
          (parseFloat(a['position']) - parseFloat(b['position'])) || byId(a['unique id'], b['unique id'])),
      };
    })
    .map(a => ({ ...a, dates: [...new Set(a.tracks.map(t => t['date']).filter(Boolean))] }))
    // Gigs with fewer than minTracks tracks (default 25) don't appear.
    .filter(a => a.tracks.length >= (Number(config.minTracks) || 1))
    .sort((a, b) => b.order - a.order); // newest first

  await rm(OUT, { recursive: true, force: true });
  await mkdir(join(OUT, 'sets'), { recursive: true });
  await cp('assets', join(OUT, 'assets'), { recursive: true });
  await writeFile(join(OUT, '.nojekyll'), '');
  if (!list.length) throw new Error(`No gigs with at least ${config.minTracks || 1} tracks found in the Tracks tab.`);
  const residencies = residencyIndex(apps, byGid, list);
  await writeFile(join(OUT, 'index.html'), homePage(list, residencies));

  await mkdir(join(OUT, 'about'), { recursive: true });
  await writeFile(join(OUT, 'about', 'index.html'), aboutPage(list));
  await mkdir(join(OUT, 'songs'), { recursive: true });
  await writeFile(join(OUT, 'songs', 'index.html'), allSongsPage(list, megalist, residencies));

  for (let i = 0; i < list.length; i++) {
    const dir = join(OUT, 'sets', list[i].slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), setPage(list[i], list, '../../', false, residencies));
  }
  console.log(`Built ${list.length} appearance pages and ${tracks.length} tracks into ${OUT}/`);
  console.log(`All songs page: ${megalist.length} rows from the "${allSongsTab}" tab.`);
}

function serve() {
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
  createServer(async (req, res) => {
    let path = join(OUT, decodeURIComponent(req.url.split('?')[0]));
    if (path.endsWith('/')) path = join(path, 'index.html');
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end('Not found'); }
  }).listen(8080, () => console.log('Preview at http://localhost:8080'));
}

try {
  await build();
  if (process.argv.includes('--serve')) serve();
} catch (e) {
  console.error(`Build failed: ${e.message}`);
  process.exit(1); // a failed build leaves the last good version of the site online
}
