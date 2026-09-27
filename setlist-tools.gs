/**
 * Setlist tools — runs in YOUR OWN Google Sheet (the "links sheet"), not the
 * community sheet. It reads the community sheet, mirrors every setlist into a
 * Tracks tab here, and adds YouTube links. The community sheet is never edited.
 *
 * Setup:
 *   1. Create a new Google Sheet. Extensions → Apps Script, paste this file.
 *   2. Put the community sheet's ID in SOURCE_ID below (the long string between
 *      /d/ and /edit in its URL). You need at least view access to it.
 *   3. Services (+) → YouTube Data API v3 → Add. Save, reload the sheet.
 *   4. Setlist tools → Set up automatic updates.
 *   5. Setlist tools → Set up mirror and backups (see "0. Mirror and backups" below).
 */

const CONFIG = {
  SOURCE_ID: '13JSLgoeB9lnosv_R2m4ZqYSlqM5A9y8hb4b2v_KaW7U', // Despacio Song IDs (TSOT)
  // Only tabs named like "21-Miami" are setlists: a number, a dash, then the city.
  // Every other tab in the community sheet is ignored and never appears on the site.
  CITY_TAB: /^\s*(\d+)\s*[-–—]\s*(.+?)\s*$/,

  // Tabs that aren't gigs but still get a page. Order sorts them against the gig
  // numbers, so -1 puts this at the bottom of the list on the site.
  EXTRA_TABS: {
    // The site's All songs page. It gets no page of its own in the list.
    'megalist': { label: 'All songs', slug: 'songs', order: -2, listOnly: true, searchRank: 0 },
    'Canonical Tracks': {
      label: 'Despacio Classics', slug: 'despacio-classics', order: -1, searchRank: -1,
      note: 'Songs played at five or more Despacio residencies.',
      // Only rows where all five "Played at" columns (C–G) have something in them,
      // i.e. songs played at five or more gigs.
      requirePlayedAt: 5,
    },
  },
  // Accepted column names in the community sheet. Case, punctuation and anything in
  // parentheses are ignored, so "Artist(s)" matches "artist" and "Unique ID #" matches "unique id".
  // The header row can be anywhere in the first 15 rows of a tab.
  SOURCE_HEADERS: {
    id: ['unique id', 'uniqueid', 'unique', 'uid', 'track id', 'id'],
    // "artist title" is the megalist's name for its artist column; "track title" its title column.
    artist: ['artist', 'artists', 'artist name', 'artist title'],
    title: ['title', 'song title', 'track title', 'song', 'track', 'song name', 'track name', 'name'],
    youtube: ['youtube'],                       // links fans have already added
    idStatus: ['identification status'],
    date: ['date'],
    // How many times a song has been played, if the tab counts it.
    plays: ['plays', 'times played', 'play count', 'count', 'played', 'played at', 'gigs', 'residencies', 'total'],
  },
  TRACKS: 'Tracks',
  // Your own hand-curated song list. One row per song; its links win everywhere.
  MASTER: 'Master Songs',
  MASTER_HEADERS: ['Artist', 'Title', 'YouTube', 'Residencies', 'Notes'],
  APPEARANCES: 'Appearances',
  // Master link: the Master Songs link in effect at the last sync, so an edit to it can be spotted.
  TRACK_HEADERS: ['Appearance', 'gid', 'Unique ID', 'Artist', 'Song Title', 'Status', 'YouTube', 'Date', 'Position', 'Plays', 'Master link'],
  APPEARANCE_HEADERS: ['Tab', 'gid', 'City', 'Year', 'Event', 'Order', 'Slug'],

  // Which gig each city tab is, by the number at the start of the tab name.
  // A tab not listed here (e.g. a new "22-..." tab) uses the city from its name
  // and the year from its Date column, so new gigs still appear automatically.
  GIGS: {
    1:  { city: 'Manchester', year: 2013, event: 'Manchester International Festival (New Century Hall), July 18–20, 2013' },
    2:  { city: 'London',     year: 2013, event: 'Hammersmith Town Hall, December 19–21, 2013' },
    3:  { city: 'London',     year: 2014, event: 'Camden Roundhouse, March 7–8, 2014' },
    4:  { city: 'Barcelona',  year: 2014, event: 'Sónar Festival, June 12–14, 2014' },
    5:  { city: 'Pilton',     year: 2014, event: 'Glastonbury Festival, June 25–29, 2014' },
    9:  { city: 'Indio',      year: 2016, event: 'Coachella, April 15–17 & 22–24, 2016' },
    10: { city: 'New York',   year: 2016, event: 'Panorama Festival, July 22–24, 2016' },
    13: { city: 'Barcelona',  year: 2018, event: 'Sónar Festival, June 14–16, 2018' },
    15: { city: 'Pasadena',   year: 2022, event: "This Ain't No Picnic, August 27–28, 2022" },
    16: { city: 'Miami',      year: 2022, event: 'III Points Festival, October 21–22, 2022' },
    17: { city: 'Indio',      year: 2023, event: 'Coachella, April 2023' },
    18: { city: 'Miami',      year: 2023, event: 'III Points Festival, October 20–21, 2023' },
    19: { city: 'Ghent',      year: 2024, event: 'Zebrastraat, March 2024' },
    20: { city: 'San Francisco', year: 2025, event: 'Portola Festival, September 20 & 21, 2025' },
    21: { city: 'Miami',      year: 2025, event: 'III Points Festival, October 2025' },
  },

  // Upcoming gigs whose tab number isn't known yet, recognized by the dates in the
  // tab's Date column (MM/DD/YYYY). Once the tab exists you can move the entry into
  // GIGS above by its number, but it works from here too.
  GIGS_BY_DATE: [
    { dates: ['09/26/2026', '09/27/2026'], city: 'San Francisco', year: 2026, event: 'Portola Festival, September 26 & 27, 2026' },
  ],
  YT_SEARCHES_PER_RUN: 90,   // 100 quota units each; free quota is 10,000/day
  STATUS: { UNKNOWN: 'Unknown', NO_MATCH: 'No match', FOUND: 'Found', SUBMITTED: 'Submitted', MASTER: 'Master' },
  SUBMISSIONS: 'Submissions',          // log of every link visitors submit, for undoing
  MAX_SUBMISSIONS_PER_HOUR: 100,       // simple brake on spam
};

// Column positions in the Tracks tab (0-based)
const T = Object.fromEntries(CONFIG.TRACK_HEADERS.map((h, i) => [h, i]));

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Setlist tools')
    .addItem('Sync from community sheet now', 'syncFromSource')
    .addItem('Show last sync result', 'showLastSync')
    .addItem('Report megalist duplicates', 'reportMegalistDuplicates')
    .addItem('Report shared links', 'reportSharedLinks')
    .addItem('Report All songs without links', 'reportMissingMasterLinks')
    .addSeparator()
    .addItem('Build / refresh master song list', 'buildMasterList')
    .addItem('Find YouTube links now', 'fillYouTubeLinks')
    .addItem('Undo selected submissions', 'undoSubmissions')
    .addSeparator()
    .addItem('Set up mirror and backups', 'setUpMirror')
    .addItem('Mirror community sheet now', 'mirrorNow')
    .addItem('Accept upstream changes (override guard)', 'acceptUpstreamChanges')
    .addItem('Save full Drive backup now', 'weeklyBackup')
    .addSeparator()
    .addItem('Set up automatic updates', 'setUpTriggers')
    .addItem('Stop automatic updates', 'removeTriggers')
    .addToUi();
}

/* ---------- helpers ---------- */

const isUnknown_ = v => /^unknown$/i.test(String(v).trim());
const byId_ = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function rows_(sh) {
  const n = sh.getLastRow() - 1;
  return n < 1 ? [] : sh.getRange(2, 1, n, sh.getLastColumn()).getValues();
}

const normHeader_ = h => String(h).replace(/\(.*?\)/g, ' ').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function findCol_(headers, aliases) {
  const norm = headers.map(normHeader_);
  for (const a of aliases) { const i = norm.indexOf(a); if (i >= 0) return i; }
  return -1;
}

// Finds the first row (within the top 15) with Artist and Title columns. Gig tabs must
// also have Unique ID; extra tabs like Canonical Tracks don't need one.
function findHeaderRow_(values, needId) {
  for (let r = 0; r < Math.min(values.length, 15); r++) {
    const h = values[r];
    if (findCol_(h, CONFIG.SOURCE_HEADERS.artist) >= 0 &&
        findCol_(h, CONFIG.SOURCE_HEADERS.title) >= 0 &&
        (!needId || findCol_(h, CONFIG.SOURCE_HEADERS.id) >= 0)) return r;
  }
  return -1;
}

function interactive_() {
  try { SpreadsheetApp.getUi(); return true; } catch (e) { return false; }
}

function notify_(msg) {
  if (interactive_()) SpreadsheetApp.getActive().toast(msg, 'Setlist tools', 6);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return; // another run is busy; the next trigger will catch up
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------- 0. Mirror and backups ---------- */

// The Mirror is a spreadsheet you own holding an exact, plain-text copy of every tab in
// the community sheet. Nothing edits it by hand, and everything else reads from it, so
// a bad edit or a deleted tab upstream can't reach the site before you've seen it.
//   Guardrails: a tab that disappears upstream, or loses more than MIRROR_MAX_DROP of its
//   rows, is NOT overwritten. The last good copy stays, and you get an email.
//   To accept such a change on purpose, run Setlist tools → Accept upstream changes.
// Backups: a full Drive copy every week (the newest MIRROR_KEEP_COPIES are kept), and the
// GitHub "Back up spreadsheet" workflow saves the Mirror as CSV files daily, with history.

const MIRROR_MAX_DROP = 0.2;   // 20%
const MIRROR_MIN_ROWS = 20;    // smaller tabs aren't guarded (too noisy)
const MIRROR_KEEP_COPIES = 12; // weekly Drive copies to keep (about 3 months)
const MIRROR_LOG = 'Mirror Log';

const props_ = () => PropertiesService.getScriptProperties();
const mirrorId_ = () => props_().getProperty('MIRROR_ID');

// Where every reader gets the community data: the Mirror once it exists.
function sourceBook_() {
  return SpreadsheetApp.openById(mirrorId_() || CONFIG.SOURCE_ID);
}

const filledRows_ = values => values.filter(r => r.some(c => String(c).trim() !== '')).length;
const hash_ = values => Utilities.base64Encode(
  Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(values)));

// Copies every community tab into the Mirror. Returns { changed, issues }.
function refreshMirror_(force) {
  const id = mirrorId_();
  if (!id) return { changed: [], issues: [] };
  const community = SpreadsheetApp.openById(CONFIG.SOURCE_ID);
  const mirror = SpreadsheetApp.openById(id);
  const p = props_();
  const changed = [], issues = [];
  const upstream = new Set();

  community.getSheets().forEach(s => {
    const name = s.getName();
    upstream.add(name);
    const values = s.getDataRange().getDisplayValues(); // exactly as fans see it
    const h = hash_(values);
    let m = mirror.getSheetByName(name);
    if (!force && m && p.getProperty(`hash:${name}`) === h) return; // unchanged since last copy

    if (m && !force) {
      const before = filledRows_(m.getDataRange().getDisplayValues());
      const after = filledRows_(values);
      if (before >= MIRROR_MIN_ROWS && after < before * (1 - MIRROR_MAX_DROP)) {
        issues.push(`"${name}" dropped from ${before} to ${after} rows. Kept the last good copy.`);
        return;
      }
    }
    if (!m) m = mirror.insertSheet(name);
    m.clear();
    if (values.length && values[0].length) {
      const range = m.getRange(1, 1, values.length, values[0].length);
      range.setNumberFormat('@'); // plain text: "007" and "3/5" stay as written
      range.setValues(values);
    }
    p.setProperty(`hash:${name}`, h);
    changed.push(name);
  });

  // Tabs that vanished upstream stay in the Mirror (and so on the site) until accepted.
  mirror.getSheets().forEach(m => {
    const name = m.getName();
    if (upstream.has(name)) return;
    if (force) {
      if (mirror.getSheets().length > 1) mirror.deleteSheet(m);
      p.deleteProperty(`hash:${name}`);
    } else if (name !== 'Sheet1' || m.getLastRow() > 0) {
      issues.push(`"${name}" is gone from the community sheet. Kept the last good copy.`);
    }
  });

  logMirror_(changed, issues);
  alertIssues_(issues);
  return { changed: changed, issues: issues };
}

function logMirror_(changed, issues) {
  if (!changed.length && !issues.length) return;
  const sh = sheet_(MIRROR_LOG, ['When', 'Tabs updated', 'Warnings']);
  sh.insertRowAfter(1);
  sh.getRange(2, 1, 1, 3).setValues([[new Date(), changed.join(', '), issues.join('\n')]]);
  if (sh.getLastRow() > 501) sh.deleteRows(502, sh.getLastRow() - 501); // newest 500
}

// Emails you when the warnings change, not every hour they persist.
function alertIssues_(issues) {
  const p = props_();
  const key = issues.join('\n');
  if (key === (p.getProperty('lastIssues') || '')) return;
  p.setProperty('lastIssues', key);
  if (!issues.length) return;
  const to = Session.getEffectiveUser().getEmail();
  if (!to) return;
  MailApp.sendEmail(to, 'Despacio Tracklists: community sheet changed unexpectedly',
    issues.join('\n') + '\n\nThe site keeps showing the last good copy. If the change is intended, ' +
    'open your links sheet and run Setlist tools → Accept upstream changes.\n\n' +
    SpreadsheetApp.getActive().getUrl());
}

// One-time setup: creates the Mirror, fills it, and turns on the weekly Drive backup.
function setUpMirror() {
  let id = mirrorId_();
  if (!id) {
    id = SpreadsheetApp.create('Despacio Song IDs – Mirror').getId();
    props_().setProperty('MIRROR_ID', id);
  }
  withLock_(() => {
    refreshMirror_(true);
    const mirror = SpreadsheetApp.openById(id);
    const blank = mirror.getSheetByName('Sheet1');
    if (blank && mirror.getSheets().length > 1 && blank.getLastRow() === 0) mirror.deleteSheet(blank);
  });
  weeklyBackup();
  setUpTriggers();
  SpreadsheetApp.getUi().alert(
    `The Mirror is ready:\n${SpreadsheetApp.openById(id).getUrl()}\n\n` +
    'The site now reads from it, and a first full backup is in your Drive under ' +
    '"Despacio Song IDs backups".\n\nOne more step for the daily GitHub backup: open the Mirror, ' +
    'File → Share → Publish to web, choose "Entire document" and "Microsoft Excel (.xlsx)", ' +
    'click Publish, and copy the link.');
}

function mirrorNow() {
  if (!mirrorId_()) { SpreadsheetApp.getUi().alert('Run Setlist tools → Set up mirror and backups first.'); return; }
  const r = withLock_(() => refreshMirror_(false));
  if (!r) return notify_('Busy with another run. Try again in a minute.');
  SpreadsheetApp.getUi().alert(
    (r.changed.length ? `Updated: ${r.changed.join(', ')}` : 'No tabs changed.') +
    (r.issues.length ? `\n\nWarnings:\n${r.issues.join('\n')}` : ''));
}

// Copies everything as it is now, ignoring the guardrails, then syncs.
function acceptUpstreamChanges() {
  const ui = SpreadsheetApp.getUi();
  const ok = ui.alert('Accept upstream changes?',
    'This copies the community sheet exactly as it is right now, including any shrunken or deleted tabs.',
    ui.ButtonSet.OK_CANCEL);
  if (ok !== ui.Button.OK) return;
  withLock_(() => refreshMirror_(true));
  syncFromSource();
}

// A full copy of the community sheet in your Drive, formatting and all. Runs weekly.
function weeklyBackup() {
  const p = props_();
  let folder;
  try { folder = DriveApp.getFolderById(p.getProperty('BACKUP_FOLDER')); }
  catch (e) {
    folder = DriveApp.createFolder('Despacio Song IDs backups');
    p.setProperty('BACKUP_FOLDER', folder.getId());
  }
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  DriveApp.getFileById(CONFIG.SOURCE_ID).makeCopy(`Despacio Song IDs – ${stamp}`, folder);

  // Keep the newest copies; older ones go to the Drive trash (recoverable for 30 days).
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort((a, b) => b.getDateCreated() - a.getDateCreated())
    .slice(MIRROR_KEEP_COPIES).forEach(f => f.setTrashed(true));
  notify_(`Saved a full copy to Drive: Despacio Song IDs – ${stamp}`);
}

/* ---------- 1. Sync ---------- */

// Mirrors every community tab into Tracks, matched by tab + Unique ID. The tab is
// recognized by its gig number ("21" in "21-Miami"), or by its internal gid as a fallback,
// so renaming a tab or rebuilding the Mirror doesn't lose any links.
// A YouTube URL, once found, is kept for good: the track is never searched again,
// even if fans later edit its artist or title. Tracks without a URL are searched
// again only if their artist or title changes (e.g. an Unknown gets identified).
// A visitor's submitted link beats every other link, including Master Songs, until
// you change that song's link in Master Songs (the newer edit wins) or undo it.
function syncFromSource() {
  withLock_(() => {
    // Refresh the Mirror first, then read from it. If the community sheet can't be
    // reached, the site keeps building from the last copy.
    try { refreshMirror_(false); }
    catch (e) { alertIssues_([`Couldn't read the community sheet: ${e.message}. Using the last copy.`]); }
    const src = sourceBook_();
    const tracks = sheet_(CONFIG.TRACKS, CONFIG.TRACK_HEADERS);

    const prev = {}, prevByTab = {};
    rows_(tracks).forEach(r => {
      prev[`${r[T.gid]}|${r[T['Unique ID']]}`] = r;
      prevByTab[`${tabKey_(r[T.Appearance])}|${r[T['Unique ID']]}`] = r;
    });
    // Before the Master link column existed, treat every Master Songs link as unchanged.
    const hadMasterCol = tracks.getRange(1, 1, 1, tracks.getLastColumn()).getValues()[0]
      .includes('Master link');
    const prevMasterLink = p => hadMasterCol ? String(p[T['Master link']] || '').trim() : null;

    const out = [];
    const tabs = [];
    const skipped = [];
    const years = {};   // gid → year from the tab's Date column
    const tabDates = {}; // gid → the tab's dates, to recognize gigs in GIGS_BY_DATE
    src.getSheets().forEach(s => {
      if (!CONFIG.CITY_TAB.test(s.getName()) && !extraTab_(s)) return;
      const values = s.getDataRange().getDisplayValues(); // exactly as fans see it
      const extra = extraTab_(s);
      const hr = findHeaderRow_(values, !extra);
      if (hr < 0) { skipped.push(s.getName()); return; } // missing Artist / Title (and Unique ID for gigs)
      const h = values[hr];
      const body = values.slice(hr + 1);
      const cId = findCol_(h, CONFIG.SOURCE_HEADERS.id);
      const cA = findCol_(h, CONFIG.SOURCE_HEADERS.artist);
      const cT = findCol_(h, CONFIG.SOURCE_HEADERS.title);
      const cYT = findCol_(h, CONFIG.SOURCE_HEADERS.youtube);
      const cSt = findCol_(h, CONFIG.SOURCE_HEADERS.idStatus);
      const cDate = findCol_(h, CONFIG.SOURCE_HEADERS.date);
      const required = extra && extra.requirePlayedAt ? playedAtCols_(h, extra.requirePlayedAt) : null;
      const cPlays = findCol_(h, CONFIG.SOURCE_HEADERS.plays);
      const playedAt = playedAtCols_(h, 99); // "Played at 1..N" columns, if the tab has them
      tabs.push(s);
      if (cDate >= 0) {
        years[s.getSheetId()] = commonYear_(body.map(r => r[cDate]));
        tabDates[s.getSheetId()] = body.map(r => formatDate_(r[cDate])).filter(Boolean);
      }
      let lastDate = ''; // rows with a blank Date take the date of the row above

      const gid = s.getSheetId();
      // Tabs with Unique IDs are ordered by them, and rows without one are left out
      // (tracks fans couldn't place). Older tabs with no Unique IDs at all use the
      // order of their rows instead.
      const hasIds = cId >= 0 && body.some(r => String(r[cId]).trim());
      const seen = {};
      const tabRows = [];
      body.forEach(r => {
        const artist = String(r[cA]).trim();
        const title = String(r[cT]).trim();
        const date = cDate >= 0 ? formatDate_(r[cDate]) : '';
        if (date) lastDate = date;
        // Skip notes rows like "GAP IN RECORDING", and blank rows.
        if (!artist && !title) return;
        // Despacio Classics: only songs with every "Played at" column filled in.
        if (required && !required.every(c => String(r[c]).trim())) return;
        if (cSt >= 0 && /^administrative$/i.test(String(r[cSt]).trim())) return;
        let id = cId >= 0 ? String(r[cId]).trim() : '';
        if (!id) {
          if (hasIds) return;
          // No Unique IDs in this tab: make one from the song, so links stay with
          // the right track even if fans insert or move rows.
          const base = slugify_(`${artist} ${title}`) || 'track';
          seen[base] = (seen[base] || 0) + 1;
          id = `auto-${base}-${seen[base]}`;
        }
        const p = prevByTab[`${tabKey_(s.getName())}|${id}`] || prev[`${gid}|${id}`];
        const same = p && String(p[T.Artist]) === artist && String(p[T['Song Title']]) === title;
        // Which link to use: one a visitor submitted on the site, then one fans added
        // in the community sheet, then the one the search found earlier.
        const community = cYT >= 0 && /youtu\.?be/.test(String(r[cYT])) ? String(r[cYT]).trim() : '';
        const prevUrl = p ? String(p[T.YouTube]).trim() : '';
        const submitted = p && p[T.Status] === CONFIG.STATUS.SUBMITTED && prevUrl;
        const url = submitted ? prevUrl : (community || prevUrl);

        const row = new Array(CONFIG.TRACK_HEADERS.length).fill('');
        row[T.Appearance] = s.getName();
        row[T.gid] = gid;
        row[T['Unique ID']] = id;
        row[T.Artist] = artist;
        row[T['Song Title']] = title;
        row[T.YouTube] = url;
        row.community = !submitted && !!community && url === community;
        row.submitted = !!submitted;
        row.prev = p;
        row[T.Date] = date || lastDate;
        // A plays count, either from a column that holds one or by counting filled "Played at" cells.
        if (cPlays >= 0 && String(r[cPlays]).trim()) row[T.Plays] = String(r[cPlays]).trim();
        else if (playedAt.length) row[T.Plays] = playedAt.filter(c => String(r[c]).trim()).length;
        if (submitted) row[T.Status] = CONFIG.STATUS.SUBMITTED;
        else if (url) row[T.Status] = CONFIG.STATUS.FOUND;
        else if (isUnknown_(artist) && isUnknown_(title)) row[T.Status] = CONFIG.STATUS.UNKNOWN;
        else if (same && p[T.Status] === CONFIG.STATUS.NO_MATCH) row[T.Status] = CONFIG.STATUS.NO_MATCH;
        tabRows.push(row);
      });
      if (hasIds) tabRows.sort((a, b) => byId_(a[T['Unique ID']], b[T['Unique ID']]));
      tabRows.forEach((row, i) => { row[T.Position] = i + 1; out.push(row); });
    });

    const swapped = fixSwapped_(out);
    const master = masterList_();
    // A Master Songs link counts as edited when it differs from the one this row saw last sync.
    const masterEdited = (p, url) => !!p && prevMasterLink(p) !== null && prevMasterLink(p) !== url;
    let mastered = 0;
    out.forEach(r => {
      const url = master.links[masterKey_(r[T.Artist], r[T['Song Title']])];
      if (!url) return;
      r[T['Master link']] = url;
      // A visitor's link stays, unless you've changed this song's Master Songs link since.
      if (r.submitted && !masterEdited(r.prev, url)) return;
      r.submitted = false;
      if (String(r[T.YouTube]).trim() !== url) {
        r[T.YouTube] = url;
        mastered++;
      }
      r[T.Status] = CONFIG.STATUS.MASTER;
    });
    // The master list also feeds the site's All songs page. Its rows are rebuilt every
    // sync, so links they got before (from a visitor, the nightly search, or a residency)
    // are looked up by song and carried over rather than lost.
    const prevMaster = {};
    Object.keys(prev).forEach(key => {
      const p = prev[key];
      if (String(p[T.gid]) === 'master') prevMaster[masterKey_(p[T.Artist], p[T['Song Title']])] = p;
    });
    const masterRows = [];
    master.rows.forEach((m, i) => {
      const p = prevMaster[masterKey_(m.artist, m.title)];
      const prevUrl = p ? String(p[T.YouTube]).trim() : '';
      const submitted = p && p[T.Status] === CONFIG.STATUS.SUBMITTED && prevUrl &&
        !(m.url && masterEdited(p, m.url));
      const row = new Array(CONFIG.TRACK_HEADERS.length).fill('');
      row[T.Appearance] = CONFIG.MASTER;
      row[T.gid] = 'master';
      row[T['Unique ID']] = `master-${i + 1}`;
      row[T.Artist] = m.artist;
      row[T['Song Title']] = m.title;
      row[T.YouTube] = submitted ? prevUrl : m.url;
      row[T.Status] = submitted ? CONFIG.STATUS.SUBMITTED : (m.url ? CONFIG.STATUS.MASTER : '');
      row[T['Master link']] = m.url;
      row.submitted = !!submitted;
      row.prev = p;
      row[T.Position] = i + 1;
      row[T.Plays] = m.plays;
      masterRows.push(row);
      out.push(row);
    });

    // Share links between every row, All songs included, so a song linked at any
    // residency is linked on the All songs page too.
    shareLinks_(out);

    // All songs rows are merged titles ("Song (Extended Mix)" is listed as "Song"), so
    // match what's still missing on the same merged key the master list uses. Then fall
    // back to the link the row had last time (e.g. from the nightly search).
    const byMaster = {};
    out.forEach(r => {
      const u = String(r[T.YouTube]).trim();
      if (u && r[T.gid] !== 'master' && !isUnknown_(r[T['Song Title']])) {
        const k = masterKey_(r[T.Artist], r[T['Song Title']]);
        if (!byMaster[k]) byMaster[k] = u;
      }
    });
    masterRows.forEach(r => {
      if (String(r[T.YouTube]).trim()) return;
      const shared = byMaster[masterKey_(r[T.Artist], r[T['Song Title']])];
      const p = r.prev;
      const prevUrl = p ? String(p[T.YouTube]).trim() : '';
      if (shared) { r[T.YouTube] = shared; r[T.Status] = CONFIG.STATUS.FOUND; }
      else if (prevUrl) { r[T.YouTube] = prevUrl; r[T.Status] = CONFIG.STATUS.FOUND; }
      else if (p && p[T.Status] === CONFIG.STATUS.NO_MATCH) r[T.Status] = CONFIG.STATUS.NO_MATCH; // don't search again
    });
    tabs.sort((a, b) => tabNumber_(a) - tabNumber_(b));
    const tabOrder = Object.fromEntries(tabs.map((s, i) => [s.getSheetId(), i]));
    out.sort((a, b) => (tabOrder[a[T.gid]] - tabOrder[b[T.gid]]) || (a[T.Position] - b[T.Position]));

    tracks.clear(); // also drops any columns left over from older versions
    const H = CONFIG.TRACK_HEADERS;
    tracks.getRange(1, 1, 1, H.length).setValues([H]).setFontWeight('bold');
    tracks.setFrozenRows(1);
    if (out.length) {
      // Plain text, so IDs like "007" and titles like "3/5" aren't turned into numbers or dates
      tracks.getRange(2, 1, out.length, H.length).setNumberFormat('@').setValues(out);
    }

    rebuildAppearances_(tabs, years, tabDates);
    PropertiesService.getScriptProperties().setProperty('lastSync',
      JSON.stringify({ when: new Date().toISOString(), tracks: out.length, cities: tabs.length, skipped, swapped }));
    notify_(`Synced ${out.length} tracks from ${tabs.length} cities.` +
      (swapped ? ` Fixed ${swapped} rows with artist and title swapped.` : '') +
      (mastered ? ` ${mastered} links set from the master song list.` : '') +
      (skipped.length ? ` Skipped (no Unique ID / Artist / Title columns): ${skipped.join(', ')}` : ''));
  });
}

// One row per city tab. City, year and event come from GIGS (by tab number) or
// GIGS_BY_DATE (by the tab's dates); otherwise the city comes from the tab name and
// the year from its Date column. The page address is city + year, e.g. sets/miami-2025/.
function rebuildAppearances_(tabs, years, tabDates) {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.APPEARANCES) || SpreadsheetApp.getActive().insertSheet(CONFIG.APPEARANCES);
  const used = new Set();
  const rows = tabs.filter(s => !(extraTab_(s) && extraTab_(s).listOnly)).map(s => {
    const n = tabNumber_(s);
    const extra = extraTab_(s);
    const dates = tabDates[s.getSheetId()] || [];
    const gig = extra ? {} : (CONFIG.GIGS[n] ||
      CONFIG.GIGS_BY_DATE.find(g => g.dates.some(d => dates.indexOf(d) >= 0)) || {});
    const city = gig.city || tabCity_(s);
    const year = extra ? '' : (gig.year || years[s.getSheetId()] || '');
    let slug = (extra && extra.slug) || slugify_(`${city} ${year}`) || String(s.getSheetId());
    if (used.has(slug)) slug = `${slug}-${n}`; // e.g. two Miami gigs in one year
    used.add(slug);
    return [s.getName(), s.getSheetId(), city, year, gig.event || (extra && extra.note) || '', n, slug];
  });

  sh.clear();
  const H = CONFIG.APPEARANCE_HEADERS;
  sh.getRange(1, 1, 1, H.length).setValues([H]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (rows.length) sh.getRange(2, 1, rows.length, H.length).setNumberFormat('@').setValues(rows);
}

// The "Played at 1..5" columns, by header; falls back to columns C–G by position.
function playedAtCols_(headers, howMany) {
  const cols = [];
  headers.forEach((h, i) => { if (/^played at\b/.test(normHeader_(h))) cols.push(i); });
  if (howMany === 99) return cols; // all of them, for counting plays
  return cols.length >= howMany ? cols.slice(0, howMany) : [2, 3, 4, 5, 6].slice(0, howMany);
}

// "9/20/2025" or "2025-09-20" → "09/20/2025". Anything else (e.g. "??") → ''.
function formatDate_(v) {
  const t = String(v).trim();
  let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}/${m[1]}`;
  return '';
}

// Most common 4-digit year in a tab's Date column ("9/20/2025" → 2025).
function commonYear_(dates) {
  const count = {};
  dates.forEach(d => { const m = String(d).match(/\b(19|20)\d{2}\b/); if (m) count[m[0]] = (count[m[0]] || 0) + 1; });
  const best = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
  return best ? Number(best) : '';
}

// Matches the tab name however it's capitalized or spaced ("megalist", "Megalist ").
function extraTab_(s) {
  const want = String(s.getName()).trim().toLowerCase();
  const key = Object.keys(CONFIG.EXTRA_TABS).find(k => k.trim().toLowerCase() === want);
  return key ? CONFIG.EXTRA_TABS[key] : null;
}
// Identifies a tab across renames and Mirror rebuilds: its gig number, or its name for other tabs.
const tabKey_ = name => {
  const m = String(name).match(CONFIG.CITY_TAB);
  return m ? `#${Number(m[1])}` : String(name).trim().toLowerCase();
};
const tabNumber_ = s => extraTab_(s) ? extraTab_(s).order : Number(s.getName().match(CONFIG.CITY_TAB)[1]);
// "15-Pasadena (TANP)" → "Pasadena"
const tabCity_ = s => extraTab_(s) ? extraTab_(s).label
  : s.getName().match(CONFIG.CITY_TAB)[2].replace(/\s*\(.*\)\s*$/, '').trim();

function slugify_(name) {
  return String(name).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function showLastSync() {
  const raw = PropertiesService.getScriptProperties().getProperty('lastSync');
  const r = raw ? JSON.parse(raw) : null;
  SpreadsheetApp.getUi().alert(!r ? 'No sync has run yet.' :
    `Last sync: ${new Date(r.when).toLocaleString()}\n${r.tracks} tracks from ${r.cities} cities.` +
    (r.swapped ? `\n${r.swapped} rows had artist and title swapped and were corrected.` : '') +
    (r.skipped.length ? `\n\nSkipped (couldn't find Unique ID, Artist and Title columns):\n${r.skipped.join('\n')}` : '\n\nNo tabs skipped.'));
}

/* ---------- Megalist duplicate report ---------- */

// Writes a "Megalist Report" tab: how many entries carry each version tag, and every
// group of entries the site would merge into one song. Read-only on the community sheet.
function reportMegalistDuplicates() {
  const src = sourceBook_();
  const tab = src.getSheets().find(s => String(s.getName()).trim().toLowerCase() === 'megalist');
  if (!tab) { SpreadsheetApp.getUi().alert('No tab called "megalist" in the community sheet.'); return; }

  const values = tab.getDataRange().getDisplayValues();
  const hr = findHeaderRow_(values, false);
  if (hr < 0) { SpreadsheetApp.getUi().alert('Could not find Artist and Title columns in megalist.'); return; }
  const h = values[hr];
  const cA = findCol_(h, CONFIG.SOURCE_HEADERS.artist);
  const cT = findCol_(h, CONFIG.SOURCE_HEADERS.title);

  const entries = values.slice(hr + 1)
    .map(r => ({ artist: String(r[cA]).trim(), title: String(r[cT]).trim() }))
    .filter(e => e.artist || e.title);

  // How many entries mention each version tag.
  const tags = [
    ['2manydjs Edit', /2\s*many\s*dj'?s\s+(?:re-?)?edit/i],
    ['Despacio Edit', /despacio\s+(?:re-?)?edit/i],
    ['Remaster', /remaster(?:ed)?/i],
    ['Unknown Version / Edit', /unknown\s+(?:version|edit)/i],
    ['Remix', /remix/i],
    ['Vocal Mix', /vocal\s+mix/i],
    ['12" / 7" Version', /(?:12|7)\s*(?:["“”]|\s*inch)/i],
    ['Extended Mix', /extended\s+(?:mix|version|edit)/i],
    ['Radio Edit', /radio\s+(?:edit|mix|version)/i],
    ['Single / Album Version, Original Mix', /single\s+version|album\s+version|original\s+mix/i],
    ['Club / Dance / Disco Mix', /(?:club|dance|disco)\s+mix/i],
    ['Bootleg / Rework / VIP / Re-edit', /bootleg|rework|\bvip\b|re-?edit/i],
    ['Part 1 / 2', /\bpart\s*\d/i],
    ['Dub', /\bdub\b/i],
    ['Instrumental', /instrumental/i],
    ['Live', /\blive\b/i],
  ];

  // Group the way the site does: strip the "same song" tags, ignore punctuation.
  const groups = {};
  entries.forEach(e => {
    const base = baseTitle_(e.title);
    const k = `${normSong_(e.artist)}|${normSong_(base)}`;
    if (!groups[k]) groups[k] = { artist: e.artist, base: base, titles: [] };
    groups[k].titles.push(e.title);
  });
  const dupes = Object.keys(groups).map(k => groups[k]).filter(g => g.titles.length > 1)
    .sort((a, b) => b.titles.length - a.titles.length);

  const sh = sheet_('Megalist Report', ['Artist', 'Merged title', 'Entries', 'Entries as written']);
  sh.clear();
  const out = [];
  out.push(['Megalist entries', entries.length, '', '']);
  out.push(['Songs after merging', Object.keys(groups).length, '', '']);
  out.push(['Groups with more than one entry', dupes.length, '', '']);
  out.push(['', '', '', '']);
  out.push(['Entries mentioning', 'Count', '', '']);
  tags.forEach(t => out.push([t[0], entries.filter(e => t[1].test(e.title)).length, '', '']));
  out.push(['', '', '', '']);
  out.push(['Artist', 'Merged title', 'Entries', 'Entries as written']);
  dupes.forEach(g => out.push([g.artist, g.base, g.titles.length, g.titles.join('  |  ')]));

  sh.getRange(1, 1, out.length, 4).setValues(out);
  sh.getRange(1, 1, 1, 4).setFontWeight('bold');
  sh.getRange(5, 1, 1, 2).setFontWeight('bold');
  sh.getRange(5 + tags.length + 2, 1, 1, 4).setFontWeight('bold');
  SpreadsheetApp.getActive().setActiveSheet(sh);
  SpreadsheetApp.getUi().alert(`${entries.length} megalist entries, ${Object.keys(groups).length} songs after merging. See the Megalist Report tab.`);
}

// Same rules the site uses: strip the tags that mean "same song", ignore punctuation.
const STRIP_TAG_ = /(?:2\s*many\s*dj'?s|despacio)\s+(?:re-?)?edit|unknown\s+(?:version|edit)|remaster(?:ed)?|single\s+version|album\s+version|original\s+mix|radio\s+(?:edit|version|mix)/i;
const DEFINITIVE_TAG_ = /vocal\s+mix|extended\s+(?:mix|version|edit)|(?:12|7)\s*(?:["“”]|\s*inch)\s*(?:single\s*)?(?:version|mix|edit)?/i;

function stripTag_(title, tag) {
  let t = String(title || '').trim();
  t = t.replace(/\s*[([][^)\]]*[)\]]/g, m => (tag.test(m) ? ' ' : m));
  t = t.replace(/\s+[-–—]\s+[^-–—]*$/, m => (tag.test(m) ? '' : m));
  return t.replace(/\s+/g, ' ').trim() || String(title || '').trim();
}

// A bracketed year on its own, like "[1978]", is just a release date.
const YEAR_ONLY_ = /^[\s([]*(?:19|20)\d{2}[\s)\]]*$/;

// Same as the site: a bare year, edits and remasters fold in, and so do definitive versions.
function baseTitle_(title) {
  const noYear = String(title || '')
    .replace(/\s*[([][^)\]]*[)\]]/g, m => (YEAR_ONLY_.test(m) ? ' ' : m))
    .replace(/\s+/g, ' ').trim();
  return stripTag_(stripTag_(noYear || String(title || '').trim(), STRIP_TAG_), DEFINITIVE_TAG_);
}

const normSong_ = v => String(v || '').toLowerCase()
  .replace(/\bfeat(uring)?\.?\b[^)\]]*/g, ' ')
  .replace(/\band\b/g, '&')
  .replace(/\bthe\b/g, ' ')
  .replace(/[^a-z0-9&]+/g, '');

/* ---------- Master song list ---------- */

// Creates or refreshes the Master Songs tab: one row per song, merged the way the site
// merges them, with the best link found so far. Your edits are kept: an existing row's
// Artist, Title, YouTube and Notes are never overwritten, and rows you add by hand stay.
// New songs are appended at the bottom so you can work through them.
function buildMasterList() {
  const tracks = SpreadsheetApp.getActive().getSheetByName(CONFIG.TRACKS);
  if (!tracks) { SpreadsheetApp.getUi().alert('Run a sync first.'); return; }
  const sh = sheet_(CONFIG.MASTER, CONFIG.MASTER_HEADERS);

  // What's already in the master list, by song.
  const existing = rows_(sh).filter(r => String(r[0]).trim() || String(r[1]).trim());
  const have = {};
  existing.forEach(r => { have[masterKey_(r[0], r[1])] = true; });

  // Every song in Tracks, merged, with its residency count and a link if one is known.
  const songs = {};
  rows_(tracks).forEach(r => {
    const artist = String(r[T.Artist]).trim();
    const title = String(r[T['Song Title']]).trim();
    if (!title || isUnknown_(title)) return;
    const k = masterKey_(artist, title);
    if (!songs[k]) songs[k] = { artist: artist, title: baseTitle_(title), gigs: {}, url: '' };
    const song = songs[k];
    if (CONFIG.CITY_TAB.test(String(r[T.Appearance]))) song.gigs[String(r[T.gid])] = true;
    if (!song.url) song.url = String(r[T.YouTube]).trim();
  });

  const added = Object.keys(songs).filter(k => !have[k]).map(k => songs[k])
    .sort((a, b) => (Object.keys(b.gigs).length - Object.keys(a.gigs).length) ||
                     a.artist.localeCompare(b.artist))
    .map(s => [s.artist, s.title, s.url, Object.keys(s.gigs).length, '']);

  if (added.length) {
    sh.getRange(existing.length + 2, 1, added.length, CONFIG.MASTER_HEADERS.length)
      .setNumberFormat('@').setValues(added);
  }
  SpreadsheetApp.getActive().setActiveSheet(sh);
  notify_(`Master song list: ${existing.length} rows kept, ${added.length} new songs added.`);
}

const masterKey_ = (artist, title) => `${normSong_(artist)}|${normSong_(baseTitle_(title))}`;

// The master list's links, applied to every track that matches. Also returns the rows
// themselves, so the site's All songs page can be built from this list.
function masterList_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG.MASTER);
  if (!sh) return { links: {}, rows: [] };
  const rows = rows_(sh)
    .map(r => ({ artist: String(r[0]).trim(), title: String(r[1]).trim(),
                 url: String(r[2]).trim(), plays: String(r[3]).trim() }))
    .filter(r => r.artist || r.title);
  const links = {};
  rows.forEach(r => { if (r.url) links[masterKey_(r.artist, r.title)] = r.url; });
  return { links: links, rows: rows };
}

/* ---------- All songs without links ---------- */

// Writes an "All Songs Missing Links" tab: every All songs row with no link, and why.
//   Waiting for search - not searched yet; the nightly search gets to it (90 a night,
//                        residencies first, then All songs)
//   No match           - searched, YouTube had nothing suitable; add one with Add link
//   Possible match     - a residency has the same title with a link, but the artist is
//                        spelled differently, so it isn't shared automatically
// Read-only: nothing is changed.
function reportMissingMasterLinks() {
  const tracks = SpreadsheetApp.getActive().getSheetByName(CONFIG.TRACKS);
  if (!tracks) { SpreadsheetApp.getUi().alert('Run a sync first.'); return; }
  const data = rows_(tracks);
  const titleOnly = t => normSong_(baseTitle_(t));

  // Linked residency songs, by title alone, to spot artist-spelling differences.
  const byTitle = {};
  data.forEach(r => {
    const u = String(r[T.YouTube]).trim();
    if (!u || String(r[T.gid]) === 'master' || isUnknown_(r[T['Song Title']])) return;
    const k = titleOnly(r[T['Song Title']]);
    if (k && !byTitle[k]) byTitle[k] = r;
  });

  const out = [], counts = { 'Waiting for search': 0, 'No match': 0, 'Possible match': 0 };
  data.forEach(r => {
    if (String(r[T.gid]) !== 'master' || String(r[T.YouTube]).trim()) return;
    const near = byTitle[titleOnly(r[T['Song Title']])];
    const why = near ? 'Possible match'
      : r[T.Status] === CONFIG.STATUS.NO_MATCH ? 'No match' : 'Waiting for search';
    counts[why]++;
    out.push([r[T.Artist], r[T['Song Title']], why,
      near ? `${near[T.Artist]} – ${near[T['Song Title']]} (${near[T.Appearance]})` : '',
      near ? String(near[T.YouTube]).trim() : '']);
  });
  const order = { 'Possible match': 0, 'No match': 1, 'Waiting for search': 2 };
  out.sort((a, b) => order[a[2]] - order[b[2]]);

  const sh = sheet_('All Songs Missing Links', ['Artist', 'Title', 'Why', 'Residency song with the same title', 'Its link']);
  sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 5).clearContent();
  if (out.length) sh.getRange(2, 1, out.length, 5).setValues(out);
  const nights = Math.ceil(counts['Waiting for search'] / CONFIG.YT_SEARCHES_PER_RUN);
  SpreadsheetApp.getUi().alert(`${out.length} All songs rows have no link:\n\n` +
    `${counts['Possible match']} possible matches (artist spelled differently at a residency)\n` +
    `${counts['No match']} searched with no YouTube result\n` +
    `${counts['Waiting for search']} waiting for the nightly search` +
    (nights ? ` (about ${nights} night${nights === 1 ? '' : 's'} at ${CONFIG.YT_SEARCHES_PER_RUN} a night)` : '') +
    `\n\nSee the All Songs Missing Links tab.`);
}

/* ---------- Shared link report ---------- */

// Tags that mean a different recording, so two entries sharing a video are NOT duplicates.
const DISTINCT_TAG_ = /remix|(?:club|dance|disco)\s+mix|instrumental|\bdub\b|a-?cappella|\blive\b|\bdemo\b|session|\bmono\b|reprise|bootleg|rework|\bvip\b|\bpart\s*\d/i;

// Lists every group of songs that ended up on the same YouTube video, and says whether
// they look like the same song (same artist, near-identical titles, no distinct-recording
// tag) or a fallback match the search guessed. Read-only: nothing is merged.
function reportSharedLinks() {
  const tracks = SpreadsheetApp.getActive().getSheetByName(CONFIG.TRACKS);
  if (!tracks) { SpreadsheetApp.getUi().alert('Run a sync first.'); return; }

  const byVideo = {};
  rows_(tracks).forEach(r => {
    const vid = youTubeId_(String(r[T.YouTube]));
    const artist = String(r[T.Artist]).trim();
    const title = String(r[T['Song Title']]).trim();
    if (!vid || !title || isUnknown_(title)) return;
    const song = `${artist} — ${title}`;
    const key = `${normSong_(artist)}|${normSong_(baseTitle_(title))}`;
    if (!byVideo[vid]) byVideo[vid] = { songs: {}, order: [] };
    if (!byVideo[vid].songs[key]) {
      byVideo[vid].songs[key] = { artist: artist, title: title, label: song, count: 0 };
      byVideo[vid].order.push(key);
    }
    byVideo[vid].songs[key].count++;
  });

  const out = [];
  Object.keys(byVideo).forEach(vid => {
    const group = byVideo[vid];
    if (group.order.length < 2) return;
    const songs = group.order.map(k => group.songs[k]);
    const verdict = sameSong_(songs) ? 'Same song' : 'Check: likely different songs';
    out.push([vid, songs.length, verdict, songs.map(s => s.label).join('  |  '),
              `https://www.youtube.com/watch?v=${vid}`]);
  });
  out.sort((a, b) => (a[2] === b[2] ? b[1] - a[1] : (a[2] < b[2] ? -1 : 1)));

  const sh = sheet_('Shared Links Report', ['Video', 'Songs', 'Verdict', 'Entries', 'Link']);
  sh.clear();
  const header = ['Video', 'Songs', 'Verdict', 'Entries', 'Link'];
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (out.length) sh.getRange(2, 1, out.length, header.length).setValues(out);
  sh.setFrozenRows(1);
  SpreadsheetApp.getActive().setActiveSheet(sh);
  SpreadsheetApp.getUi().alert(`${out.length} videos are shared by more than one song. See the Shared Links Report tab.`);
}

// Same artist, no distinct-recording tag, and titles close enough that one is contained
// in the other (e.g. "Like an Eagle" and "Like an Eagle 79").
function sameSong_(songs) {
  const artist = normSong_(songs[0].artist);
  if (songs.some(s => normSong_(s.artist) !== artist)) return false;
  if (songs.some(s => DISTINCT_TAG_.test(s.title))) return false;
  const titles = songs.map(s => normSong_(baseTitle_(s.title))).sort((a, b) => a.length - b.length);
  return titles.every(t => t.indexOf(titles[0]) === 0 || titles[0].indexOf(t) === 0);
}

/* ---------- Swapped artist / title ---------- */

// Some megalist rows have the artist and the title in the wrong columns. The residency
// tabs are the reliable source, so any row whose artist+title is unknown but whose
// title+artist matches a residency track is put the right way round.
function fixSwapped_(rows) {
  // Version tags are ignored on both sides, so a swapped "Song (Despacio Edit)" still
  // matches the residency's plain "Song".
  const pairKey_ = (artist, title) => `${normSong_(artist)}|${normSong_(baseTitle_(title))}`;

  const known = {};
  rows.forEach(r => {
    if (!CONFIG.CITY_TAB.test(String(r[T.Appearance]))) return; // residency tabs only
    known[pairKey_(r[T.Artist], r[T['Song Title']])] = true;
  });

  let fixed = 0;
  rows.forEach(r => {
    if (CONFIG.CITY_TAB.test(String(r[T.Appearance]))) return;
    const artist = String(r[T.Artist]).trim();
    const title = String(r[T['Song Title']]).trim();
    if (!artist || !title) return;
    const direct = pairKey_(artist, title);
    const reversed = pairKey_(title, artist);
    if (!known[direct] && known[reversed]) {
      r[T.Artist] = title;
      r[T['Song Title']] = artist;
      fixed++;
    }
  });
  return fixed;
}

/* ---------- Sharing links between gigs ---------- */

// Versions that aren't on YouTube are searched as the original song:
//   "Vaudou (2manydjs Edit)"                → "Vaudou"
//   "Need You Tonight (Despacio Edit)"      → "Need You Tonight"
//   "When We're Dancing Close and Slow (Unknown Version)" → "When We're Dancing Close and Slow"
//   "Dance, Dance, Dance (Unknown Edit)"    → "Dance, Dance, Dance"
// Only the search uses this; the site shows the title as the community wrote it.
const VERSION_WORDS = "(?:(?:2\\s*many\\s*dj'?s|despacio)\\s+(?:re-?)?edit|unknown\\s+(?:version|edit))";
const EDIT_TAG = new RegExp(
  "\\s*[(\\[][^)\\]]*\\b" + VERSION_WORDS + "\\b[^)\\]]*[)\\]]" +   // "(… Despacio Edit …)"
  "|\\s+[-–—]\\s*" + VERSION_WORDS + "\\s*$", "gi");                 // "… - Despacio Edit" at the end
const searchTitle_ = title => String(title).replace(EDIT_TAG, '').trim() || String(title).trim();

// Same artist + title (ignoring case, extra spaces, and the version tags above) = same song,
// so an edit or unknown version shares its link with the original.
const songKey_ = (artist, title) =>
  [artist, searchTitle_(title)].map(v => String(v).trim().toLowerCase().replace(/\s+/g, ' ')).join('|');

// A looser key for matching the same song across tabs that spell it differently:
// punctuation, "the", "&"/"and", and "feat. …" are ignored, so "Hall & Oates" matches
// "Hall and Oates" and "Song (feat. X)" matches "Song".
const looseKey_ = (artist, title) => [artist, searchTitle_(title)].map(v => String(v)
  .toLowerCase()
  .replace(/\bfeat(uring)?\.?\b[^)\]]*/g, ' ')
  .replace(/\band\b/g, '&')
  .replace(/\bthe\b/g, ' ')
  .replace(/[^a-z0-9&]+/g, '')).join('|');

// Tracks without a link borrow one from the same song at another gig, so each song
// is only ever searched once. Priority: visitor-submitted, then community, then found.
function shareLinks_(rows) {
  const known = {}, loose = {};
  [rows.filter(r => r.submitted), rows.filter(r => r.community), rows].forEach(set => set.forEach(r => {
    const url = String(r[T.YouTube]).trim();
    if (!url || isUnknown_(r[T['Song Title']])) return;
    const k = songKey_(r[T.Artist], r[T['Song Title']]);
    const l = looseKey_(r[T.Artist], r[T['Song Title']]);
    if (!known[k]) known[k] = url;
    if (!loose[l]) loose[l] = url;
  }));
  rows.forEach(r => {
    if (String(r[T.YouTube]).trim() || isUnknown_(r[T['Song Title']])) return;
    const url = known[songKey_(r[T.Artist], r[T['Song Title']])] ||
                loose[looseKey_(r[T.Artist], r[T['Song Title']])];
    if (url) { r[T.YouTube] = url; r[T.Status] = CONFIG.STATUS.FOUND; }
  });
}

/* ---------- 2. YouTube ---------- */

// Searches only tracks that have no URL and no status, newest gig first. Skips Unknown tracks
// (both columns "Unknown") and any track whose title is Unknown.
function fillYouTubeLinks() {
  withLock_(() => {
    const tracks = sheet_(CONFIG.TRACKS, CONFIG.TRACK_HEADERS);
    const data = rows_(tracks);
    let searched = 0, found = 0, reused = 0;
    const known = {};
    data.forEach(r => {
      const u = String(r[T.YouTube]).trim();
      const key = songKey_(r[T.Artist], r[T['Song Title']]);
      if (u && !known[key]) known[key] = u;
    });

    // Newest residency first (the top of the site), then down each setlist in order;
    // then the megalist, then anything else. A song found anywhere covers the same song
    // everywhere, so nothing is searched twice.
    const gigNumber = r => {
      const name = String(r[T.Appearance]);
      const m = name.match(CONFIG.CITY_TAB);
      if (m) return Number(m[1]);
      const key = Object.keys(CONFIG.EXTRA_TABS).find(k => k.trim().toLowerCase() === name.trim().toLowerCase());
      const rank = key && CONFIG.EXTRA_TABS[key].searchRank;
      return typeof rank === 'number' ? rank : -1;
    };
    const order = data.map((r, i) => i).sort((a, b) =>
      (gigNumber(data[b]) - gigNumber(data[a])) || (Number(data[a][T.Position]) - Number(data[b][T.Position])));
    const missed = {}; // songs YouTube had nothing for in this run: don't search them twice

    for (let n = 0; n < order.length && searched < CONFIG.YT_SEARCHES_PER_RUN; n++) {
      const i = order[n];
      const r = data[i];
      const artist = String(r[T.Artist]).trim();
      const title = String(r[T['Song Title']]).trim();
      if (String(r[T.YouTube]).trim() || r[T.Status]) continue; // has a URL, or already searched/skipped
      if (!title || isUnknown_(title)) continue;

      const k = songKey_(artist, title);
      if (missed[k]) {
        tracks.getRange(i + 2, T.Status + 1).setValue(CONFIG.STATUS.NO_MATCH);
        continue;
      }
      if (known[k]) { // same song already has a link: no API call
        tracks.getRange(i + 2, T.Status + 1, 1, 2).setValues([[CONFIG.STATUS.FOUND, known[k]]]);
        reused++;
        continue;
      }

      let url;
      try {
        url = searchYouTube_(isUnknown_(artist) ? '' : artist, searchTitle_(title));
      } catch (e) {
        if (interactive_()) SpreadsheetApp.getUi().alert(`YouTube search stopped: ${e.message}\n\nIf this mentions quota, the daily limit is used up. It resets at midnight Pacific time.`);
        break;
      }
      searched++;
      if (url) { found++; known[k] = url; } else missed[k] = true;
      tracks.getRange(i + 2, T.Status + 1, 1, 2).setValues([[url ? CONFIG.STATUS.FOUND : CONFIG.STATUS.NO_MATCH, url]]);
    }
    notify_(`Searched ${searched} tracks, found ${found} YouTube links, reused ${reused}.`);
  });
}

// Prefers YouTube's auto-generated "Artist - Topic" uploads (official studio audio).
function searchYouTube_(artist, title) {
  const res = YouTube.Search.list('snippet', {
    q: `${artist} ${title}`.trim(), type: 'video', videoCategoryId: '10', maxResults: 5,
  });
  const items = (res.items || []).filter(it => it.id && it.id.videoId);
  if (!items.length) return '';
  const topic = items.find(it => / - Topic$/.test(it.snippet.channelTitle || ''));
  return `https://www.youtube.com/watch?v=${(topic || items[0]).id.videoId}`;
}

/* ---------- 3. Link submissions from the website ---------- */
// Deployed as a web app (Deploy → New deployment → Web app, Execute as: Me,
// Who has access: Anyone). The site sends { gid, id, url }. Only the YouTube link
// can change; artist and title are never touched.

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'Bad request.' }); }
  const gid = String(body.gid || '').trim();
  const id = String(body.id || '').trim();
  const vid = youTubeId_(String(body.url || ''));
  if (!gid || !id) return json_({ ok: false, error: 'Bad request.' });
  if (!vid) return json_({ ok: false, error: "That isn't a YouTube video link." });
  if (!underLimit_()) return json_({ ok: false, error: 'Too many links submitted this hour. Try again later.' });
  if (!embeddable_(vid)) return json_({ ok: false, error: "That video is unavailable or can't be played on other sites." });

  const result = withLock_(() => applySubmission_(gid, id, `https://www.youtube.com/watch?v=${vid}`));
  return json_(result || { ok: false, error: 'The sheet is busy. Try again in a moment.' });
}

function applySubmission_(gid, id, url) {
  const tracks = SpreadsheetApp.getActive().getSheetByName(CONFIG.TRACKS);
  const data = rows_(tracks);
  const i = data.findIndex(r => String(r[T.gid]) === gid && String(r[T['Unique ID']]) === id);
  if (i < 0) return { ok: false, error: 'That track no longer exists.' };
  const row = data[i];
  if (isUnknown_(row[T['Song Title']])) return { ok: false, error: "This track hasn't been identified yet." };

  // Update this track, plus the same song at other gigs if it had the same (wrong) link or none.
  const old = String(row[T.YouTube]).trim();
  const k = songKey_(row[T.Artist], row[T['Song Title']]);
  let updated = 0;
  data.forEach(r => {
    const u = String(r[T.YouTube]).trim();
    if (r === row || (songKey_(r[T.Artist], r[T['Song Title']]) === k && (!u || u === old))) {
      r[T.Status] = CONFIG.STATUS.SUBMITTED;
      r[T.YouTube] = url;
      updated++;
    }
  });
  tracks.getRange(2, T.Status + 1, data.length, 2).setValues(data.map(r => [r[T.Status], r[T.YouTube]]));

  const log = sheet_(CONFIG.SUBMISSIONS, ['When', 'Gig', 'Unique ID', 'Artist', 'Song Title', 'Old link', 'New link', 'Tracks updated', 'Undone']);
  log.appendRow([new Date(), row[T.Appearance], id, row[T.Artist], row[T['Song Title']], old, url, updated]);
  return { ok: true, yt: url.split('v=')[1], updated };
}

// Select one or more rows in the Submissions tab, then run this. Each track the submission
// changed goes back to its old link (or to blank, to be searched again), newest first.
// Tracks that have been changed again since are left alone.
function undoSubmissions() {
  const ui = SpreadsheetApp.getUi();
  const log = SpreadsheetApp.getActive().getSheetByName(CONFIG.SUBMISSIONS);
  const sel = log && SpreadsheetApp.getActiveSheet().getName() === CONFIG.SUBMISSIONS &&
    SpreadsheetApp.getActiveRangeList();
  if (!sel) { ui.alert('Open the Submissions tab and select the rows to undo first.'); return; }
  const picked = new Set();
  sel.getRanges().forEach(rg => {
    for (let n = rg.getRow(); n < rg.getRow() + rg.getNumRows(); n++) if (n > 1) picked.add(n);
  });
  if (!picked.size) { ui.alert('Select the rows to undo first (not the header).'); return; }

  const result = withLock_(() => {
    const tracks = SpreadsheetApp.getActive().getSheetByName(CONFIG.TRACKS);
    const data = rows_(tracks);
    let undone = 0, reverted = 0;
    [...picked].sort((a, b) => b - a).forEach(n => {
      const [, , , artist, title, oldUrl, newUrl, , done] =
        log.getRange(n, 1, 1, 9).getValues()[0].map(v => String(v).trim());
      if (!newUrl || done) return;
      const k = songKey_(artist, title);
      data.forEach(r => {
        if (r[T.Status] === CONFIG.STATUS.SUBMITTED && String(r[T.YouTube]).trim() === newUrl &&
            songKey_(r[T.Artist], r[T['Song Title']]) === k) {
          r[T.YouTube] = oldUrl;
          r[T.Status] = oldUrl ? CONFIG.STATUS.FOUND : '';
          reverted++;
        }
      });
      log.getRange(n, 9).setValue(`Undone ${new Date().toLocaleString()}`);
      undone++;
    });
    if (data.length) tracks.getRange(2, T.Status + 1, data.length, 2).setValues(data.map(r => [r[T.Status], r[T.YouTube]]));
    return { undone: undone, reverted: reverted };
  });
  if (!result) return notify_('Busy with another run. Try again in a minute.');
  notify_(`Undid ${result.undone} submissions (${result.reverted} tracks). The site updates at the next hourly build.`);
}

function youTubeId_(url) {
  const m = url.trim().match(/^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : '';
}

// YouTube's oEmbed answers 200 only for public videos that allow embedding. No API quota used.
function embeddable_(vid) {
  const u = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + vid)}`;
  try { return UrlFetchApp.fetch(u, { muteHttpExceptions: true }).getResponseCode() === 200; }
  catch (e) { return false; }
}

function underLimit_() {
  const cache = CacheService.getScriptCache();
  const key = 'subs-' + Math.floor(Date.now() / 3600000);
  const n = Number(cache.get(key) || 0);
  if (n >= CONFIG.MAX_SUBMISSIONS_PER_HOUR) return false;
  cache.put(key, String(n + 1), 3700);
  return true;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- 4. Triggers ---------- */

function setUpTriggers() {
  removeTriggers(true);
  ScriptApp.newTrigger('syncFromSource').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('fillYouTubeLinks').timeBased().everyDays(1).atHour(3).create();
  if (mirrorId_()) ScriptApp.newTrigger('weeklyBackup').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(4).create();
  syncFromSource();
  notify_('Syncing every hour, searching YouTube every night around 3am' +
    (mirrorId_() ? ', and saving a full Drive backup every Monday.' : '.'));
}

function removeTriggers(silent) {
  ScriptApp.getProjectTriggers()
    .filter(t => ['syncFromSource', 'fillYouTubeLinks', 'weeklyBackup'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
  if (silent !== true) notify_('Automatic updates stopped.');
}
