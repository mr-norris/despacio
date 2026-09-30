# Despacio Tracklists

A setlist site for every Despacio gig, built from the community's
[Despacio Song IDs spreadsheet (TSOT)](https://docs.google.com/spreadsheets/d/13JSLgoeB9lnosv_R2m4ZqYSlqM5A9y8hb4b2v_KaW7U/edit),
assembled by the song ID heroes of discord.gg/despacio and r/despacio. Each gig gets its own
page, with a YouTube player for every identified track.

## How it works

```
Community sheet (TSOT)  →  Links sheet (yours)  →  GitHub build  →  Website
     read only            hourly sync + nightly     hourly            GitHub Pages
                          YouTube search
```

- **Community sheet**: the source of truth for setlists. Never edited by this project.
- **Links sheet**: a Google Sheet you own. Its Apps Script copies every city tab
  (named like `21-Miami`) into a **Tracks** tab every hour, finds YouTube links nightly,
  and receives links that visitors submit on the site. Its **Master Songs** tab is the
  hand-curated song list that supplies links to every residency and fills the All songs page.
- **GitHub Actions**: every hour, `build.mjs` reads the published links sheet and writes
  one page per gig to GitHub Pages.

## Setup

Do these in order. Steps 1–4 happen in Google; steps 5–7 in this repo.

### 1. Create the links sheet

1. Create a new, empty Google Sheet (for example, "DESPACIO links").
2. Go to **Extensions → Apps Script**. Select everything in `Code.gs` (including
   `function myFunction()`) and delete it.
3. In this repo on GitHub, open `apps-script/setlist-tools.gs` and click **Copy raw file**
   (the two-squares icon above the code). Paste the whole file into `Code.gs` and save.
   It should start with `/**` followed by `* Setlist tools — runs in YOUR OWN Google Sheet`.
4. In the Apps Script editor, click the **+** next to **Services**, choose **YouTube Data API v3**,
   and click **Add**. If the dialog won't open (common when signed into several Google
   accounts), use the manifest instead: **Project Settings (gear) → Show "appsscript.json"
   manifest file in editor**. Open `appsscript.json` (not `Code.gs`), replace everything in it
   with the following, and save:
   ```json
   {
     "timeZone": "America/Los_Angeles",
     "dependencies": {
       "enabledAdvancedServices": [
         {
           "userSymbol": "YouTube",
           "serviceId": "youtube",
           "version": "v3"
         }
       ]
     },
     "exceptionLogging": "STACKDRIVER",
     "runtimeVersion": "V8"
   }
   ```
5. In the function dropdown next to **Run**, choose **onOpen** and click **Run**. Approve the
   permissions (**Advanced → Go to … (unsafe) → Allow**; this warning is normal for your own
   script). Switch to the Google Sheet's tab: a **Setlist tools** menu is now in the menu bar.
   From now on it appears automatically whenever the sheet opens.

`SOURCE_ID` at the top of the script already points at the community sheet.

### 2. Run the first sync

1. Choose **Setlist tools → Set up automatic updates**.
2. Approve the permissions Google asks for (reading the community sheet, YouTube, running on a schedule).

This runs the first sync right away and creates two tabs:

- **Appearances**: one row per gig (city, year, event, page address).
- **Tracks**: every track from every city tab, ordered by Unique ID.

From then on, it syncs every hour and searches YouTube every night around 3am.
To get links sooner, choose **Setlist tools → Find YouTube links now**
(about 90 tracks per run, because of YouTube's free daily quota).

### 3. Publish the links sheet

1. Go to **File → Share → Publish to web**.
2. Choose **Entire document** and **Comma-separated values (.csv)**, then click **Publish**.
3. From the link it shows, copy the long ID between `/d/e/` and `/pub`. This is your `pubId`.
4. Open the **Appearances** tab and copy the number after `gid=` in the browser's address bar.
   Do the same for the **Tracks** tab. These are `appearancesGid` and `tracksGid`.

### 4. Turn on link submissions

1. In the Apps Script editor, click **Deploy → New deployment**.
2. Click the gear icon, choose **Web app**, and set:
   - **Execute as:** Me
   - **Who has access:** Anyone
3. Click **Deploy** and approve the permissions.
4. Copy the **Web app URL** (starts with `https://script.google.com/macros/s/`). This is your `submitUrl`.

### 5. Fill in `config.json`

```json
{
  "pubId": "from step 3",
  "appearancesGid": "from step 3",
  "tracksGid": "from step 3",
  "submitUrl": "from step 4",
  "siteTitle": "Despacio Tracklists",
  "minTracks": 25,
  "allSongsTab": "Master Songs",
  "mergeVersions": false
}
```

Commit and push.

### 6. Turn on GitHub Pages

1. In this repo, go to **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.

### 7. Run the first build

1. Go to the **Actions** tab, choose **Build setlist pages**, and click **Run workflow**.
2. When it finishes (about a minute), the site is live at
   `https://<your-username>.github.io/<repo-name>/`.

After this, the site rebuilds every hour and on every push.

## Day-to-day

Most things happen on their own:

- **New tracks or corrections in the community sheet** reach the site within about two hours
  (hourly sync, then hourly build).
- **New residencies** appear automatically when the community adds a tab named like `22-City`,
  once it has 25 identified tracks. The year comes from the tab's Date column. To add the
  event name and dates under the heading, add the gig to `GIGS` at the top of the Apps Script
  (by tab number), or to `GIGS_BY_DATE` if the tab doesn't exist yet.
- **New songs get links overnight**, newest residency first, then the megalist.
- **Visitors fix wrong links** with **Wrong link? → Replace this link** on the site.
  A visitor's link goes live at the next build, and every change is logged in the
  **Submissions** tab of the links sheet. To undo some, select their rows in Submissions and
  choose **Setlist tools → Undo selected submissions**. Each track goes back to its old link
  (or to blank, to be searched again), and the row is marked Undone.

### The master song list (Master Songs tab)

One row per song: Artist, Title, YouTube, Residencies, Notes. It is yours — the hourly sync
never overwrites it — and it does two jobs:

1. **Supplies links everywhere.** A master link beats the automatic search and links fans add
   in the community sheet. Matched tracks show **Master** in Tracks. A link a visitor submits
   later wins over it, so a broken master link can be fixed from the site. If you then change
   that song's link in Master Songs, your newer edit wins again.
2. **Fills the All songs page**, when `config.json` has `"allSongsTab": "Master Songs"`.

Matching ignores case, punctuation, brackets, "feat. …", a bracketed year, and these tags:
2manydjs Edit, Despacio Edit, Unknown Version, Remaster, Single/Album Version, Original Mix,
Radio Edit, Vocal Mix, Extended Mix, 12"/7" Version. So one row for "Young Americans" covers
"(Despacio Edit)", "- Gouster; 2016 Remaster" and "[1975]" wherever they appear.

A remix, live take, instrumental, dub, acappella, demo, bootleg, rework, VIP, re-edit, a named
edit by someone else, or Part 1 / Part 2 is a different recording: give it its own row.

**When curating:** keep the row whose link you want before deleting its duplicates, or paste
that link into the row you keep. Delete the wrong row and the song is searched again and may
come back with a different video.

### Keeping the master list in step with the community sheet

Every few weeks, or after a new residency is identified:

1. **Setlist tools → Sync from community sheet now** — pulls in anything new.
2. **Setlist tools → Copy megalist into master list (as written)** — appends megalist entries
   that aren't in Master Songs yet, at the bottom, exactly as the community wrote them.
   Nothing already in the tab is touched.
3. **Clean the new rows** at the bottom: delete duplicates, fix titles and artists, paste links.
4. **Setlist tools → Find YouTube links now** — searches master songs that still have no link
   (about 90 a day; the nightly run does the rest).
5. **Setlist tools → Report shared links** — lists songs that ended up on the same video, with a
   verdict on whether they look like the same song. Nothing is merged; it's for review.

### Menu reference (Setlist tools)

| Item | What it does |
|---|---|
| Sync from community sheet now | Rebuilds Tracks and Appearances; applies master links; fixes swapped artist/title rows |
| Show last sync result | Track and city counts, skipped tabs, swapped rows fixed |
| Report megalist duplicates | Writes **Megalist Report**: version-tag counts and every group that would merge |
| Report shared links | Writes **Shared Links Report**: songs sharing one video, with a verdict |
| Add new songs to Master Songs | Appends songs it has never offered before to the bottom of Master Songs, tagged in Notes with the date and gig. Rows you delete or rename don't come back |
| Report setlist songs not in Master Songs | Lists songs played at a residency that match no Master Songs row, with the closest row when it looks like a spelling difference |
| Copy megalist into master list (as written) | Appends missing megalist entries verbatim, for hand-cleaning |
| Find YouTube links now | Runs the search immediately, within the day's quota |
| Undo selected submissions | Reverts the visitor links in the selected Submissions rows |
| Set up automatic updates | Hourly sync + nightly search |
| Stop automatic updates | Removes both schedules |

### Editing the links sheet by hand

- **Tracks tab:** a **YouTube** link you paste stays until the next community change to that
  track. Set its **Status** to `Submitted` to make it permanent, or to `No match` to leave the
  track blank and stop it being searched. Everything else in Tracks is rebuilt each hour.
- **Appearances tab:** rebuilt from `GIGS` in the Apps Script; edit there, not in the sheet.
- **Master Songs, Submissions and any tab you create:** never touched by the sync.

### config.json

| Setting | What it does |
|---|---|
| `pubId`, `appearancesGid`, `tracksGid` | Where the site reads the published links sheet |
| `submitUrl` | The Apps Script web app that receives link submissions |
| `siteTitle` | Name shown on every page |
| `minTracks` | Residencies with fewer tracks don't appear (25) |
| `allSongsTab` | Which tab feeds the All songs page (`Master Songs`) |
| `mergeVersions` | `false` shows that tab as written; `true` merges versions of a song |

## Rules the site follows

- Only tabs named `number-city` (like `21-Miami`) become pages. All other tabs are ignored.
- Gigs with fewer than 25 tracks don't appear (`minTracks` in `config.json`).
- Tracks titled as a 2manydjs Edit, Despacio Edit, Unknown Version or Unknown Edit are searched as the original song.
- Gigs appear newest first. Each city expands to show its dates (MM/DD/YYYY).
- Tracks are ordered by Unique ID. Rows without a Unique ID, and notes rows, are left out.
- Tracks marked Unknown for both artist and title show as "Unknown - Unknown" and are never searched.
- The nightly search works newest gig first, down each setlist in order.
- Each setlist has a player bar (Previous, Play/Pause, Next). With **Autoplay** on, the next
  track with a link starts when a video ends; it's off by default and remembered per browser.
- Once a track has a YouTube link, it is never searched again.
- A song played at several gigs shares one link.
- Link priority: whichever is newer of a visitor's submitted link and your **Master Songs**
  link, then a link fans added in the community sheet, then the automatic search.
- Links stay with their track when a tab is renamed or the Mirror is rebuilt: tracks are
  matched by gig number (the `21` in `21-Miami`) and Unique ID.
- Rows in the megalist with artist and title in the wrong columns are corrected during the
  sync, using the residency tabs as the reference.

## Troubleshooting

- **Build fails with "Fill in pubId…"**: `config.json` still has placeholders (step 5).
- **Build fails with "returned a web page, not CSV"**: the links sheet isn't published,
  or a gid is wrong (step 3).
- **The site stopped updating**: GitHub pauses scheduled builds after 60 days with no
  commits. Click **Run workflow** or push any change.
- **Link submissions stopped working after a script change**: in Apps Script, go to
  **Deploy → Manage deployments → Edit**, choose **New version**, and click **Deploy**.
- **A city tab is missing from the site**: the sync message lists tabs it skipped for
  missing Unique ID, Artist or Title columns.

## Preview locally

```bash
node build.mjs --serve
```

Then open http://localhost:8080. Requires Node 20 or later; nothing to install.

## Files

| File | What it does |
|---|---|
| `apps-script/setlist-tools.gs` | Runs in the links sheet: sync, YouTube search, link submissions |
| `build.mjs` | Builds the site from the published links sheet |
| `config.json` | Sheet IDs, submission URL, site title |
| `assets/site.css` | Page styles |
| `assets/player.js` | YouTube player and the link replacement form |
| `.github/workflows/build.yml` | Hourly build and deploy to GitHub Pages |
