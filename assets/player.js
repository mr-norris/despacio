// Player: each track plays its own YouTube video. The bar at the top has Previous,
// Play/Pause and Next, plus an Autoplay switch (off by default, remembered per browser).
// With Autoplay on, the next track with a link starts when a video ends, so the set can
// keep playing in a background tab. With it off, playback stops at the end of each video.
// Wrong link? / Add link: sends a new YouTube link to the sheet. Only the link can change.
(() => {
  const SUBMIT = document.body.dataset.submit;
  const bar = document.querySelector('.controls');
  const toggleBtn = bar && bar.querySelector('[data-action="toggle"]');
  const nowEl = bar && bar.querySelector('.now');
  const autoplayBox = bar && bar.querySelector('.autoplay input');
  const shuffleBtn = bar && bar.querySelector('[data-action="shuffle"]'); // All songs page only
  let shuffle = false;

  let api = null;       // YouTube IFrame API, loaded on first play
  let player = null;    // the YT.Player for the current track
  let ready = false;    // true once that player can take play/pause commands
  let current = null;   // the .track element that's loaded
  let playing = false;
  let generation = 0;   // bumps on every track change, so late events from an old player are ignored
  let pendingToggle = false; // Play/Pause pressed before the video was ready

  // Autoplay preference, remembered in this browser only.
  try { if (autoplayBox) autoplayBox.checked = localStorage.getItem('autoplay') === 'on'; } catch (e) {}
  autoplayBox && autoplayBox.addEventListener('change', () => {
    try { localStorage.setItem('autoplay', autoplayBox.checked ? 'on' : 'off'); } catch (e) {}
  });
  const autoplayOn = () => !!(autoplayBox && autoplayBox.checked);

  // Every track with a link, in setlist order (re-read each time, since links can be added).
  // Tracks with a link, skipping any hidden by the filter box.
  const playlist = () => [...document.querySelectorAll('.track:not([hidden])')].filter(t => t.querySelector('.sources .play'));

  function loadApi() {
    if (!api) {
      api = new Promise(resolve => {
        window.onYouTubeIframeAPIReady = resolve;
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        document.head.append(s);
      });
    }
    return api;
  }

  function updateUi() {
    document.querySelectorAll('.sources .play').forEach(b => {
      const isCurrent = current && b.closest('.track') === current;
      b.textContent = isCurrent && playing ? 'Pause' : 'Play';
      b.setAttribute('aria-expanded', String(!!isCurrent));
    });
    document.querySelectorAll('.track.current').forEach(t => t.classList.remove('current'));
    if (current) current.classList.add('current');
    if (!bar) return;
    toggleBtn.dataset.state = playing ? 'playing' : 'paused';
    toggleBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    const list = playlist();
    const i = current ? list.indexOf(current) : -1;
    bar.querySelector('[data-action="prev"]').disabled = !shuffle && i <= 0;
    bar.querySelector('[data-action="next"]').disabled = !shuffle && i >= list.length - 1 && i !== -1;
    const shuffleNote = shuffle ? 'Shuffle on' : '';
    if (current) {
      const posEl = current.querySelector('.pos');
      const pos = posEl ? posEl.textContent.trim() : '';
      const title = current.querySelector('.title').textContent;
      const artist = current.querySelector('.artist');
      const line = `${pos ? pos + '  ' : ''}${title}${artist ? `, ${artist.textContent}` : ''}`;
      nowEl.textContent = shuffleNote ? `${line} · ${shuffleNote}` : line;
    } else {
      nowEl.textContent = shuffleNote;
    }
  }

  function stop() {
    generation++;
    if (player) { const old = player; player = null; try { old.destroy(); } catch (e) {} }
    ready = false;
    pendingToggle = false;
    document.querySelectorAll('.player').forEach(p => { p.replaceChildren(); p.hidden = true; });
    current = null;
    playing = false;
    updateUi();
  }

  function play(track, { follow = false } = {}) {
    stop();
    current = track;
    const btn = track.querySelector('.sources .play');
    const box = track.querySelector('.player');
    const holder = document.createElement('div');
    box.append(holder);
    box.hidden = false;
    updateUi();
    history.replaceState(null, '', `#${track.id}`);
    if (follow && document.visibilityState === 'visible') {
      track.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    const gen = generation;
    loadApi().then(() => {
      if (gen !== generation || !holder.isConnected) return; // another track was chosen while loading
      const p = new YT.Player(holder, {
        videoId: btn.dataset.yt,
        host: 'https://www.youtube-nocookie.com',
        playerVars: { autoplay: 1, playsinline: 1, rel: 0 },
        events: {
          onReady: () => {
            if (gen !== generation) return;
            ready = true;
            if (pendingToggle) { pendingToggle = false; togglePlay(); }
          },
          onStateChange: e => {
            if (gen !== generation) return; // from a player that's already been replaced
            if (e.data === YT.PlayerState.PLAYING) { playing = true; updateUi(); }
            else if (e.data === YT.PlayerState.PAUSED) { playing = false; updateUi(); }
            else if (e.data === YT.PlayerState.ENDED) {
              playing = false;
              updateUi();
              // Start the next track after YouTube has finished handling this event.
              if (autoplayOn()) setTimeout(() => { if (gen === generation) step(1); }, 0);
            }
          },
          // Video removed or can't be embedded: with Autoplay on, skip it.
          onError: () => {
            if (gen !== generation) return;
            playing = false;
            updateUi();
            if (autoplayOn()) setTimeout(() => { if (gen === generation) step(1); }, 0);
          },
        },
      });
      player = p;
    });
  }

  function step(dir) {
    const list = playlist();
    if (!list.length) return;
    const i = current ? list.indexOf(current) : -1;
    if (shuffle) { // any other track with a link
      const pool = list.filter(t => t !== current);
      if (!pool.length) return;
      play(pool[Math.floor(Math.random() * pool.length)], { follow: true });
      return;
    }
    const next = list[i + dir];
    if (next) play(next, { follow: true });
    else if (dir > 0) stop(); // end of the set
  }

  function togglePlay() {
    if (!current) {
      const list = playlist();
      if (!list.length) return;
      play(shuffle ? list[Math.floor(Math.random() * list.length)] : list[0], { follow: true });
      return;
    }
    if (!player || !ready) { pendingToggle = !pendingToggle; return; } // still loading
    try {
      if (playing) player.pauseVideo(); else player.playVideo();
    } catch (e) {
      play(current); // the player got into a bad state: reload this track
    }
  }

  function trackButton(btn) {
    const track = btn.closest('.track');
    if (track === current && player) togglePlay();
    else play(track);
  }

  function setLink(track, yt) {
    let btn = track.querySelector('.sources .play');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'play';
      btn.textContent = 'Play';
      btn.setAttribute('aria-expanded', 'false');
      track.querySelector('.sources').prepend(btn);
    }
    btn.dataset.yt = yt;
    if (track === current) play(track); // reload with the new video
    track.querySelector('.sources .fix').textContent = 'Wrong link?';
    updateUi();
  }

  bar && bar.addEventListener('click', e => {
    const b = e.target.closest('button[data-action]');
    if (!b) return;
    if (b.dataset.action === 'shuffle') {
      shuffle = !shuffle;
      b.setAttribute('aria-pressed', String(shuffle));
      updateUi();
      return;
    }
    if (b.dataset.action === 'toggle') togglePlay();
    if (b.dataset.action === 'prev') step(-1);
    if (b.dataset.action === 'next') step(1);
  });
  updateUi();

  function toggleForm(fixBtn) {
    const track = fixBtn.closest('.track');
    const existing = track.querySelector('.fix-form');
    if (existing) { existing.remove(); return; }

    // When the track already has a link, show it so it's clear what's being replaced.
    const current = track.querySelector('.sources .play')?.dataset.yt;
    const currentUrl = current ? `https://www.youtube.com/watch?v=${current}` : '';

    const form = document.createElement('form');
    form.className = 'fix-form';
    form.innerHTML = `
      ${current ? `<p class="fix-current">Current link: <a href="${currentUrl}" target="_blank" rel="noopener">${currentUrl}</a></p>` : ''}
      <label>${current ? 'Correct YouTube link' : 'YouTube link for this track'}
        <input type="url" name="url" required autocomplete="off" placeholder="https://www.youtube.com/watch?v=...">
      </label>
      <div class="fix-actions"><button type="submit">${current ? 'Replace this link' : 'Save link'}</button><button type="button" class="cancel">Cancel</button></div>
      <p class="fix-msg" role="status"></p>`;
    track.append(form);
    const input = form.elements.url;
    const msg = form.querySelector('.fix-msg');
    const save = form.querySelector('[type="submit"]');
    input.focus();
    form.querySelector('.cancel').addEventListener('click', () => form.remove());

    form.addEventListener('submit', async e => {
      e.preventDefault();
      save.disabled = true;
      msg.textContent = 'Checking the link...';
      try {
        const res = await fetch(SUBMIT, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids a CORS preflight
          body: JSON.stringify({ gid: track.dataset.gid, id: track.dataset.id, url: input.value }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "The link couldn't be saved.");
        setLink(track, data.yt);
        msg.textContent = current ? 'Link replaced. Thanks for fixing it.' : 'Link saved. Thanks for adding it.';
        input.disabled = true;
        setTimeout(() => form.remove(), 2500);
      } catch (err) {
        msg.textContent = err instanceof TypeError ? "Couldn't reach the sheet. Check your connection and try again." : err.message;
        save.disabled = false;
      }
    });
  }

  // Keeps the highlighted day in the left-hand list in step with the part of the
  // setlist on screen. A day becomes current once its heading passes the upper
  // third of the window, scrolling down or up.
  const dayLinks = [...document.querySelectorAll('.cities summary[aria-current="page"] + .dates a')];
  const dayHeads = [...document.querySelectorAll('h2.day')];
  if (dayLinks.length > 1 && dayHeads.length === dayLinks.length) {
    let ticking = false;
    const update = () => {
      ticking = false;
      const line = window.innerHeight / 3;
      let current = 0;
      dayHeads.forEach((h, i) => { if (h.getBoundingClientRect().top <= line) current = i; });
      dayLinks.forEach((a, i) => {
        a.classList.toggle('active', i === current);
        if (i === current) a.setAttribute('aria-current', 'location');
        else a.removeAttribute('aria-current');
      });
    };
    window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    update();
  }

  // All songs page: filter by song or artist. Hidden rows drop out of Next and Shuffle.
  const filterBox = document.getElementById('song-filter');
  if (filterBox) {
    const rows = [...document.querySelectorAll('.track')];
    const countEl = document.querySelector('.filter-count');
    const text = new Map(rows.map(r => [r, r.querySelector('.song').textContent.toLowerCase()]));
    const apply = () => {
      const q = filterBox.value.trim().toLowerCase();
      let shown = 0;
      rows.forEach(r => {
        const match = !q || text.get(r).includes(q);
        r.hidden = !match;
        if (match) shown++;
      });
      countEl.textContent = q ? `${shown} of ${rows.length} songs` : '';
      updateUi();
    };
    filterBox.addEventListener('input', apply);
  }

  // All songs page: sort by Most played (the built order), A–Z by artist, or Random.
  // Reordering the rows also reorders Next/Previous, since they follow the page.
  const sortBar = document.querySelector('.sort');
  if (sortBar) {
    const ol = document.querySelector('.tracks');
    const rows = [...ol.querySelectorAll('.track')];
    const note = document.querySelector('.ranked-note');
    const noThe = v => v.trim().replace(/^the\s+/i, '');
    const title = r => noThe(r.querySelector('.title').textContent);
    const artist = r => noThe((r.querySelector('.artist') || {}).textContent || '');
    const orders = {
      played: () => [...rows].sort((a, b) => a.dataset.rank - b.dataset.rank),
      // By artist, then title within each artist. Rows with no artist go last.
      az: () => [...rows].sort((a, b) =>
        (!artist(a) - !artist(b)) ||
        artist(a).localeCompare(artist(b), undefined, { sensitivity: 'base', numeric: true }) ||
        title(a).localeCompare(title(b), undefined, { sensitivity: 'base', numeric: true })),
      random: () => {
        const r = [...rows];
        for (let i = r.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [r[i], r[j]] = [r[j], r[i]];
        }
        return r;
      },
    };
    sortBar.addEventListener('click', e => {
      const b = e.target.closest('[data-sort]');
      if (!b) return;
      // Clicking Random again reshuffles.
      const frag = document.createDocumentFragment();
      orders[b.dataset.sort]().forEach(r => frag.appendChild(r));
      ol.appendChild(frag);
      sortBar.querySelectorAll('[data-sort]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      if (note) note.hidden = b.dataset.sort !== 'played';
      updateUi();
    });
  }

  document.addEventListener('click', e => {
    const playBtn = e.target.closest('.sources .play');
    if (playBtn) return trackButton(playBtn);
    const fixBtn = e.target.closest('.sources .fix');
    if (fixBtn && SUBMIT) toggleForm(fixBtn);
  });
})();
