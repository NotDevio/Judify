// ===== SUPABASE MIGRATION REQUIRED =====
// Run this SQL in your Supabase SQL Editor (Dashboard → SQL Editor):
//
//   ALTER TABLE songs ADD COLUMN IF NOT EXISTS lyrics TEXT DEFAULT '';
//   ALTER TABLE playlists ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE;
//
// ⚡ PERFORMANCE FIX (for slow loading with 6+ songs):
//   Your songs store MP3 audio as base64 blobs in the DB (~5-10MB each).
//   Fix: Create a Supabase Storage bucket named 'audio' (set to Public),
//   then set SUPABASE_STORAGE_BUCKET = 'audio' below.
//   New songs will upload to Storage and only store a URL — much faster!

const SUPABASE_URL = 'https://household-mobiles-directory-opening.trycloudflare.com';
const SUPABASE_KEY = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

async function sbFetch(path, options = {}) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...options,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Supabase error: ' + err);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

// ===== USER DB (Supabase: users table) =====
async function getUserDB() {
  return await sbFetch('users?select=*');
}

async function saveUserToDB(user) {
  // upsert user row
  await sbFetch('users?on_conflict=id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates',
    body: JSON.stringify({
      id: user.id,
      username: user.username,
      password: user.password,
      is_admin: !!user.isAdmin
    })
  });
}

async function deleteUserFromDB(uid) {
  await sbFetch('users?id=eq.' + uid, { method: 'DELETE', prefer: '' });
  // Also delete their playlists
  await sbFetch('playlists?user_id=eq.' + uid, { method: 'DELETE', prefer: '' });
}

// ===== AUTH STATE =====
let currentUser = null;

async function doLogin() {
  const username = document.getElementById('authUsername').value.trim();
  const password = document.getElementById('authPassword').value;
  const errEl = document.getElementById('authError');
  const btn = document.querySelector('#authOverlay .form-submit-btn');

  errEl.classList.remove('visible');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }

  try {
    const users = await sbFetch('users?username=eq.' + encodeURIComponent(username) + '&password=eq.' + encodeURIComponent(password) + '&select=*');
    if (!users || users.length === 0) {
      errEl.textContent = 'Incorrect username or password.';
      errEl.classList.add('visible');
      document.getElementById('authPassword').value = '';
      if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
      return;
    }
    const user = users[0];
    currentUser = { id: user.id, username: user.username, isAdmin: !!user.is_admin };
    localStorage.setItem('mp_session', JSON.stringify(currentUser));
    document.getElementById('authOverlay').classList.add('hidden');
    if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
    initApp();
  } catch(e) {
    errEl.textContent = 'Connection error. Check your internet.';
    errEl.classList.add('visible');
    if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
  }
}

function doLogout() {
  currentUser = null;
  localStorage.removeItem('mp_session');
  document.title = 'Judify';
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (progressInterval) clearInterval(progressInterval);
  isPlaying = false;
  currentSongIndex = -1;
  currentPlaylistId = null;
  songs = [];
  playlists = [];
  currentQueue = [];
  document.getElementById('spinningAlbum').classList.remove('playing');
  document.getElementById('npSongTitle').textContent = '—';
  document.getElementById('npArtist').textContent = '—';
  document.getElementById('userAvatarInitial').textContent = '?';
  document.getElementById('sidebarPlaylistIcons').innerHTML = '';
  document.getElementById('userMenu').classList.remove('open');
  document.getElementById('authOverlay').classList.remove('hidden');
  document.getElementById('authUsername').value = '';
  document.getElementById('authPassword').value = '';
  document.getElementById('authError').classList.remove('visible');
  document.getElementById('adminPanelMenuItem').style.display = 'none';
  document.getElementById('adminPanelDivider').style.display = 'none';
}

function toggleUserMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById('userMenu');
  const label = document.getElementById('userMenuLabel');
  if (label && currentUser) label.textContent = currentUser.username;
  menu.classList.toggle('open');
}

// ===== ADMIN PANEL =====
let _adminEditingSongId = null;
let _adminEditingUserId = null;

function openAdminPanel() {
  document.getElementById('userMenu').classList.remove('open');
  if (!currentUser?.isAdmin) return;
  document.getElementById('adminOverlay').classList.add('open');
  switchAdminTab('overview', document.querySelector('.admin-tab'));
  renderAdminOverview();
}

function closeAdminPanel() {
  document.getElementById('adminOverlay').classList.remove('open');
  document.getElementById('adminUserFormWrap').innerHTML = '';
  document.getElementById('adminSongFormWrap').innerHTML = '';
  _adminEditingUserId = null;
  _adminEditingSongId = null;
}

function switchAdminTab(tab, el) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
  if (el) el.classList.add('active');
  const section = document.getElementById('adminTab-' + tab);
  if (section) section.classList.add('active');
  if (tab === 'overview') renderAdminOverview();
  if (tab === 'users') renderAdminUsers();
  if (tab === 'songs') renderAdminSongs();
  if (tab === 'lyrics') renderAdminLyrics();
  if (tab === 'playlists') renderAdminPlaylists();
}

// ===== ADMIN PLAYLISTS TAB =====
let _adminEditingPlaylistId = null;

// Registry so admin playlist buttons can find row data without inline JS string escaping issues
const _adminPlaylistRowCache = {};

async function renderAdminPlaylists() {
  const q = (document.getElementById('adminPlaylistSearch')?.value || '').toLowerCase();
  const tbody = document.getElementById('adminPlaylistsTbody');
  tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text3);padding:16px;">Loading…</td></tr>';

  let allRows = [];
  try {
    allRows = await sbFetch('playlists?select=*&order=id.asc');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:#e22134;padding:16px;">Failed to load playlists: ${e.message}</td></tr>`;
    return;
  }

  if (!Array.isArray(allRows)) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:#e22134;padding:16px;">Unexpected response from server</td></tr>`;
    return;
  }

  // Cache rows by id for button handlers
  allRows.forEach(r => { _adminPlaylistRowCache[r.id] = r; });

  // Fetch owner usernames
  const ownerIds = [...new Set(allRows.map(r => r.user_id).filter(Boolean))];
  const usernameMap = {};
  try {
    if (ownerIds.length > 0) {
      const userRows = await sbFetch('users?id=in.(' + ownerIds.join(',') + ')&select=id,username');
      userRows.forEach(u => { usernameMap[u.id] = u.username; });
    }
  } catch(e) {}

  const filtered = allRows.filter(r => {
    if (!q) return true;
    return (r.name || '').toLowerCase().includes(q) || (usernameMap[r.user_id] || '').toLowerCase().includes(q);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="empty-icon">🎵</div>No playlists found</div></td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const raw = (() => { try { return JSON.parse(r.song_ids || '[]'); } catch(e) { return []; } })();
    const songCount = Array.isArray(raw) ? raw.length : 0;
    const owner = usernameMap[r.user_id] || r.user_id || '—';
    const isPublic = !!r.is_public;
    return `<tr>
      <td>
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:36px;height:36px;border-radius:6px;overflow:hidden;flex-shrink:0;background:var(--bg4);display:flex;align-items:center;justify-content:center;font-size:16px;">
            ${r.cover ? `<img src="${r.cover}" style="width:100%;height:100%;object-fit:cover;">` : '🎵'}
          </div>
          <span style="font-weight:600">${r.name || '—'}</span>
        </div>
      </td>
      <td>${owner}</td>
      <td>${songCount}</td>
      <td><span class="admin-pill ${isPublic ? 'pill-admin' : 'pill-user'}">${isPublic ? '🌐 Public' : '🔒 Private'}</span></td>
      <td><div class="action-btns">
        <button class="action-btn action-btn-edit" data-action="goto" data-id="${r.id}">Go To</button>
        <button class="action-btn action-btn-edit" data-action="edit" data-id="${r.id}">Edit</button>
        <button class="action-btn action-btn-del" data-action="delete" data-id="${r.id}">Delete</button>
      </div></td>
    </tr>`;
  }).join('');

  // Use event delegation on tbody — avoids inline onclick issues inside admin overlay
  tbody.onclick = (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    if (action === 'goto') adminGoToPlaylist(id);
    else if (action === 'edit') adminShowEditPlaylistForm(id);
    else if (action === 'delete') adminDeletePlaylist(id);
  };
}

function adminShowEditPlaylistForm(playlistId) {
  const r = _adminPlaylistRowCache[playlistId];
  if (!r) { alert('Playlist data not found. Please reload the tab.'); return; }
  const name = r.name || '';
  const isPublic = !!r.is_public;
  _adminEditingPlaylistId = playlistId;
  const wrap = document.getElementById('adminPlaylistFormWrap');
  wrap.innerHTML = `
    <div class="admin-inline-form">
      <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Edit Playlist: ${name}</div>
      <div class="form-row">
        <div class="form-group"><label>Name</label><input type="text" id="apName" value="${name}"></div>
        <div class="form-group" style="max-width:160px"><label>Visibility</label>
          <select id="apVisibility">
            <option value="private" ${!isPublic ? 'selected' : ''}>🔒 Private</option>
            <option value="public" ${isPublic ? 'selected' : ''}>🌐 Public</option>
          </select>
        </div>
        <div class="form-group"><label>New Cover <span style="font-weight:400;color:var(--text3)">(optional)</span></label>
          <input type="file" id="apCoverFile" accept="image/*">
        </div>
        <div style="display:flex;gap:6px;align-items:flex-end;padding-bottom:1px;">
          <button class="admin-btn admin-btn-primary" onclick="adminSubmitEditPlaylist()">Save</button>
          <button class="admin-btn admin-btn-secondary" onclick="document.getElementById('adminPlaylistFormWrap').innerHTML='';_adminEditingPlaylistId=null;">Cancel</button>
        </div>
      </div>
    </div>`;
}

async function adminSubmitEditPlaylist() {
  if (!_adminEditingPlaylistId) return;
  const name = document.getElementById('apName').value.trim();
  if (!name) { alert('Playlist name is required.'); return; }
  const isPublic = document.getElementById('apVisibility').value === 'public';
  const coverFile = document.getElementById('apCoverFile').files[0];

  const updates = { name, is_public: isPublic };
  if (coverFile) {
    const cover = await new Promise((res, rej) => {
      const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = () => rej(); r.readAsDataURL(coverFile);
    });
    updates.cover = cover;
  }

  try {
    await sbFetch('playlists?id=eq.' + _adminEditingPlaylistId, { method: 'PATCH', body: JSON.stringify(updates) });
    // Update local playlists array if it's the current user's playlist
    const local = playlists.find(p => p.id === _adminEditingPlaylistId);
    if (local) { local.name = name; local.isPublic = isPublic; if (updates.cover) local.cover = updates.cover; }
    document.getElementById('adminPlaylistFormWrap').innerHTML = '';
    _adminEditingPlaylistId = null;
    renderAdminPlaylists();
    renderAdminOverview();
    renderSidebarIcons();
    renderHome();
  } catch(e) { alert('Error saving playlist: ' + e.message); }
}

async function adminDeletePlaylist(playlistId) {
  const r = _adminPlaylistRowCache[playlistId];
  const name = r?.name || playlistId;
  if (!confirm(`Delete playlist "${name}"? This cannot be undone.`)) return;
  try {
    await dbDeletePlaylist(playlistId);
    // Remove from local array if present
    const idx = playlists.findIndex(p => p.id === playlistId);
    if (idx !== -1) playlists.splice(idx, 1);
    if (currentPlaylistId === playlistId) { currentPlaylistId = null; renderHome(); }
    renderAdminPlaylists();
    renderAdminOverview();
    renderSidebarIcons();
  } catch(e) { alert('Error deleting playlist: ' + e.message); }
}

function adminGoToPlaylist(playlistId) {
  closeAdminPanel();
  // Fetch the playlist row directly and open it in a temporary admin view
  sbFetch('playlists?id=eq.' + playlistId + '&select=*').then(rows => {
    if (!rows || rows.length === 0) { alert('Playlist not found.'); return; }
    const pl = rowToPlaylist(rows[0]);
    // If it's the current user's playlist, open normally
    const localPl = playlists.find(p => p.id === playlistId);
    if (localPl) { openPlaylist(playlistId); return; }
    // Otherwise open as admin read/manage view (same as public playlist but with owner perms flag)
    pl.userId = pl.userId; // keep original owner
    openPublicPlaylist({ ...pl, ownerUsername: '(admin view)' });
  }).catch(e => alert('Error loading playlist: ' + e.message));
}


async function renderAdminOverview() {
  let allUsers = [], totalPlaylists = 0;
  try {
    allUsers = await getUserDB();
    const pls = await sbFetch('playlists?select=id');
    totalPlaylists = pls.length;
  } catch(e) {}

  document.getElementById('adminStatsGrid').innerHTML = `
    <div class="admin-stat-card">
      <div class="admin-stat-label">Total Users</div>
      <div class="admin-stat-value">${allUsers.length}</div>
    </div>
    <div class="admin-stat-card">
      <div class="admin-stat-label">Total Songs</div>
      <div class="admin-stat-value">${songs.length}</div>
    </div>
    <div class="admin-stat-card">
      <div class="admin-stat-label">Total Playlists</div>
      <div class="admin-stat-value">${totalPlaylists}</div>
    </div>`;

  const recentTable = document.getElementById('adminRecentSongs');
  const recent = [...songs].reverse().slice(0, 5);
  if (recent.length === 0) {
    recentTable.innerHTML = '<tr><td colspan="4" style="color:var(--text3);padding:20px;text-align:center;">No songs yet</td></tr>';
    return;
  }
  recentTable.innerHTML = `
    <thead><tr><th>Song</th><th>Artist</th><th>Album</th><th>Added By</th></tr></thead>
    <tbody>${recent.map(s => `
      <tr>
        <td>${s.cover ? `<img src="${s.cover}" class="song-thumb-admin">` : `<span class="song-thumb-placeholder">🎵</span>`}${s.name}</td>
        <td>${s.band}</td><td>${s.album}</td><td>${s.addedByUsername || '—'}</td>
      </tr>`).join('')}
    </tbody>`;
}

async function renderAdminUsers() {
  const q = (document.getElementById('adminUserSearch')?.value || '').toLowerCase();
  const tbody = document.getElementById('adminUsersTbody');
  tbody.innerHTML = '<tr><td colspan="4" style="color:var(--text3);padding:16px;">Loading…</td></tr>';
  let db = [];
  try { db = await getUserDB(); } catch(e) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:#e22134;padding:16px;">Failed to load users</td></tr>'; return;
  }
  const filtered = db.filter(u => !q || u.username.toLowerCase().includes(q));
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><div class="empty-icon">👤</div>No users found</div></td></tr>`; return;
  }

  // Get playlist counts per user
  let plCounts = {};
  try {
    const pls = await sbFetch('playlists?select=user_id');
    pls.forEach(p => { plCounts[p.user_id] = (plCounts[p.user_id] || 0) + 1; });
  } catch(e) {}

  tbody.innerHTML = filtered.map(u => {
    const isSelf = currentUser && u.id === currentUser.id;
    return `<tr>
      <td>
        <span class="user-row-avatar" style="background:${u.is_admin ? '#e22134' : 'var(--accent)'}">
          ${u.username[0].toUpperCase()}
        </span>
        <span style="font-weight:600">${u.username}</span>
        ${isSelf ? '<span style="font-size:10px;color:var(--text3);margin-left:6px;">(you)</span>' : ''}
      </td>
      <td><span class="admin-pill ${u.is_admin ? 'pill-admin' : 'pill-user'}">${u.is_admin ? 'Admin' : 'User'}</span></td>
      <td>${plCounts[u.id] || 0}</td>
      <td><div class="action-btns">
        <button class="action-btn action-btn-edit" onclick="showEditUserForm('${u.id}')">Edit</button>
        ${!isSelf ? `<button class="action-btn action-btn-del" onclick="adminDeleteUser('${u.id}')">Delete</button>` : ''}
      </div></td>
    </tr>`;
  }).join('');
}

function showAddUserForm() {
  _adminEditingUserId = null;
  document.getElementById('adminUserFormWrap').innerHTML = `
    <div class="admin-inline-form">
      <div style="font-size:13px;font-weight:700;margin-bottom:12px;">New User</div>
      <div class="form-row">
        <div class="form-group"><label>Username</label><input type="text" id="auUsername" placeholder="username"></div>
        <div class="form-group"><label>Password</label><input type="password" id="auPassword" placeholder="password"></div>
        <div class="form-group" style="max-width:130px"><label>Role</label>
          <select id="auRole"><option value="user">User</option><option value="admin">Admin</option></select>
        </div>
        <div style="display:flex;gap:6px;align-items:flex-end;padding-bottom:1px;">
          <button class="admin-btn admin-btn-primary" onclick="submitAdminUserForm()">Add</button>
          <button class="admin-btn admin-btn-secondary" onclick="document.getElementById('adminUserFormWrap').innerHTML=''">Cancel</button>
        </div>
      </div>
    </div>`;
}

async function showEditUserForm(uid) {
  _adminEditingUserId = uid;
  let db = [];
  try { db = await getUserDB(); } catch(e) { return; }
  const u = db.find(x => x.id === uid);
  if (!u) return;
  document.getElementById('adminUserFormWrap').innerHTML = `
    <div class="admin-inline-form">
      <div style="font-size:13px;font-weight:700;margin-bottom:12px;">Edit User: ${u.username}</div>
      <div class="form-row">
        <div class="form-group"><label>Username</label><input type="text" id="auUsername" value="${u.username}"></div>
        <div class="form-group"><label>New Password <span style="font-weight:400;color:var(--text3)">(blank = keep)</span></label><input type="password" id="auPassword" placeholder="new password"></div>
        <div class="form-group" style="max-width:130px"><label>Role</label>
          <select id="auRole"><option value="user" ${!u.is_admin ? 'selected' : ''}>User</option><option value="admin" ${u.is_admin ? 'selected' : ''}>Admin</option></select>
        </div>
        <div style="display:flex;gap:6px;align-items:flex-end;padding-bottom:1px;">
          <button class="admin-btn admin-btn-primary" onclick="submitAdminUserForm()">Save</button>
          <button class="admin-btn admin-btn-secondary" onclick="document.getElementById('adminUserFormWrap').innerHTML='';_adminEditingUserId=null;">Cancel</button>
        </div>
      </div>
    </div>`;
}

async function submitAdminUserForm() {
  const username = document.getElementById('auUsername').value.trim();
  const password = document.getElementById('auPassword').value;
  const role = document.getElementById('auRole').value;
  if (!username) { alert('Username is required.'); return; }

  try {
    let db = await getUserDB();
    if (_adminEditingUserId) {
      const u = db.find(x => x.id === _adminEditingUserId);
      if (!u) return;
      if (db.some(x => x.username === username && x.id !== _adminEditingUserId)) { alert('Username already taken.'); return; }
      const updates = { username, is_admin: role === 'admin' };
      if (password) updates.password = password;
      await sbFetch('users?id=eq.' + _adminEditingUserId, { method: 'PATCH', body: JSON.stringify(updates) });
      if (currentUser && u.id === currentUser.id) {
        currentUser.username = username;
        currentUser.isAdmin = role === 'admin';
        localStorage.setItem('mp_session', JSON.stringify(currentUser));
        document.getElementById('userAvatarInitial').textContent = username[0].toUpperCase();
        document.getElementById('userBadgeLabel').textContent = username;
      }
      _adminEditingUserId = null;
    } else {
      if (!password) { alert('Password is required.'); return; }
      if (db.some(x => x.username === username)) { alert('Username already taken.'); return; }
      const newId = 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      await sbFetch('users', { method: 'POST', body: JSON.stringify({ id: newId, username, password, is_admin: role === 'admin' }) });
    }
    document.getElementById('adminUserFormWrap').innerHTML = '';
    renderAdminUsers();
    renderAdminOverview();
  } catch(e) { alert('Error saving user: ' + e.message); }
}

async function adminDeleteUser(uid) {
  if (currentUser && uid === currentUser.id) { alert("You can't delete your own account."); return; }
  let db = [];
  try { db = await getUserDB(); } catch(e) { return; }
  const u = db.find(x => x.id === uid);
  if (!u) return;
  if (!confirm(`Delete user "${u.username}"? Their playlists will also be removed.`)) return;
  try {
    await deleteUserFromDB(uid);
    renderAdminUsers();
    renderAdminOverview();
  } catch(e) { alert('Error deleting user: ' + e.message); }
}

function renderAdminSongs() {
  const q = (document.getElementById('adminSongSearch')?.value || '').toLowerCase();
  const filtered = songs.map((s, i) => ({ s, i })).filter(({ s }) =>
    !q || s.name.toLowerCase().includes(q) || s.band.toLowerCase().includes(q) || s.album.toLowerCase().includes(q)
  );
  const tbody = document.getElementById('adminSongsTbody');
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><div class="empty-icon">🎵</div>No songs found</div></td></tr>`; return;
  }
  tbody.innerHTML = filtered.map(({ s, i }) => `
    <tr>
      <td style="color:var(--text3)">${i + 1}</td>
      <td>${s.cover ? `<img src="${s.cover}" class="song-thumb-admin">` : `<span class="song-thumb-placeholder">🎵</span>`}<span style="font-weight:600">${s.name}</span></td>
      <td>${s.band}</td><td>${s.album}</td>
      <td style="color:var(--text3)">${s.addedByUsername || '—'}</td>
      <td style="color:var(--text3)">${s.dateAdded || '—'}</td>
      <td><div class="action-btns">
        <button class="action-btn action-btn-edit" onclick="adminEditSong(${s.id})">Edit</button>
        <button class="action-btn action-btn-del" onclick="adminDeleteSong(${s.id})">Delete</button>
      </div></td>
    </tr>`).join('');
}

function closeAdminEditSongModal() {
  document.getElementById('adminEditSongModal').classList.remove('open');
  _adminEditingSongId = null;
  const btn = document.getElementById('editSongSubmitBtn');
  if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
}

function adminEditSong(songId) {
  const song = songs.find(s => s.id === songId);
  if (!song) return;
  _adminEditingSongId = songId;
  document.getElementById('editSongName').value = song.name;
  document.getElementById('editSongBand').value = song.band;
  document.getElementById('editSongAlbum').value = song.album;
  ['editSongCoverFile','editBandCoverFile','editMp3File'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const cvPrev = document.getElementById('editSongCoverPreview');
  cvPrev.innerHTML = song.cover
    ? `<img src="${song.cover}" style="width:60px;height:60px;object-fit:cover;border-radius:6px;border:1px solid var(--border);">`
    : '<span style="font-size:12px;color:var(--text3);">No cover set</span>';
  const bcPrev = document.getElementById('editBandCoverPreview');
  bcPrev.innerHTML = song.bandCover
    ? `<img src="${song.bandCover}" style="width:60px;height:60px;object-fit:cover;border-radius:6px;border:1px solid var(--border);">`
    : '<span style="font-size:12px;color:var(--text3);">No band cover set</span>';
  document.getElementById('editMp3Preview').textContent = song.audioUrl ? '✅ Audio file loaded' : 'No audio file';
  const lyricsField = document.getElementById('editSongLyrics');
  if (lyricsField) lyricsField.value = song.lyrics || '';
  const btn = document.getElementById('editSongSubmitBtn');
  if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
  // Rule 3 & 4: Close admin panel before opening popup — only one UI layer at a time
  document.getElementById('adminOverlay').classList.remove('open');
  document.getElementById('adminEditSongModal').classList.add('open');
}

function previewEditFile(inputId, previewId) {
  const file = document.getElementById(inputId).files[0];
  const prev = document.getElementById(previewId);
  if (!file) { prev.innerHTML = ''; return; }
  prev.innerHTML = `<img src="${URL.createObjectURL(file)}" style="width:60px;height:60px;object-fit:cover;border-radius:6px;border:1px solid var(--accent);">`;
}

function previewEditMp3() {
  const file = document.getElementById('editMp3File').files[0];
  document.getElementById('editMp3Preview').textContent = file ? `🎵 New file: ${file.name}` : '';
}

async function submitEditSong() {
  const song = songs.find(s => s.id === _adminEditingSongId);
  if (!song) return;
  const name = document.getElementById('editSongName').value.trim();
  const band = document.getElementById('editSongBand').value.trim();
  const album = document.getElementById('editSongAlbum').value.trim();
  if (!name || !band || !album) { alert('Name, artist and album are required.'); return; }

  const btn = document.getElementById('editSongSubmitBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  const readFile = f => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result);
    r.onerror = () => rej(new Error('Failed to read file'));
    r.readAsDataURL(f);
  });

  try {
    const coverFile = document.getElementById('editSongCoverFile').files[0];
    const bandFile  = document.getElementById('editBandCoverFile').files[0];
    const mp3File   = document.getElementById('editMp3File').files[0];

    // Store original values so we can rollback on error
    const original = { name: song.name, band: song.band, album: song.album,
      lyrics: song.lyrics, cover: song.cover, bandCover: song.bandCover,
      audioUrl: song.audioUrl, duration: song.duration };

    // Track which fields actually changed so we only PATCH those
    const changed = ['name', 'band', 'album'];
    song.name = name; song.band = band; song.album = album;
    const lyricsField = document.getElementById('editSongLyrics');
    if (lyricsField) song.lyrics = lyricsField.value; // lyrics go via dbSaveLyrics
    if (coverFile) {
      song.cover = await readFile(coverFile);
      changed.push('cover');
    }
    if (bandFile) {
      song.bandCover = await readFile(bandFile);
      changed.push('band_cover');
    }
    if (mp3File) {
      song.audioUrl = await readFile(mp3File);
      changed.push('audio_url');
      await new Promise(res => {
        const a = new Audio();
        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; res(); } };
        a.onloadedmetadata = () => {
          if (a.duration && isFinite(a.duration) && a.duration > 0) { song.duration = a.duration; changed.push('duration'); }
          done();
        };
        a.onerror = done;
        const timer = setTimeout(done, 8000);
        a.addEventListener('loadedmetadata', () => clearTimeout(timer));
        a.src = song.audioUrl;
      });
      if (currentSongIndex >= 0 && songs[currentSongIndex]?.id === song.id && currentAudio) {
        const wasPlaying = isPlaying, t = currentAudio.currentTime;
        currentAudio.pause();
        currentAudio = new Audio(song.audioUrl);
        currentAudio.volume = currentVolume;
        currentAudio.currentTime = t;
        if (wasPlaying) currentAudio.play().catch(() => {});
        currentAudio.addEventListener('ended', () => isLooping ? playSong(currentSongIndex, true) : nextSong());
      }
    }

    await dbPatchSong(song, changed);

    // Rule 1: Close popup after successful confirmation
    closeAdminEditSongModal();

    // Refresh songs from the actual DB to guarantee UI shows real stored data
    songs = await dbGetAllSongs();

    renderAdminSongs(); renderAdminOverview();
    const refreshedSong = songs.find(s => s.id === song.id);
    if (currentSongIndex >= 0 && refreshedSong && songs[currentSongIndex]?.id === refreshedSong.id) updateNowPlayingUI(refreshedSong);
    if (currentPlaylistId === '__added__') showAddedSongs();
    else if (currentPlaylistId) { const pl = playlists.find(p => p.id === currentPlaylistId); if (pl) renderTrackList(pl); }
    renderHome();
  } catch(e) {
    alert('Error saving: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
  }
}

async function adminDeleteSong(songId) {
  const idx = songs.findIndex(s => s.id === songId);
  if (idx === -1) return;
  if (!confirm(`Delete "${songs[idx].name}"? This cannot be undone.`)) return;
  const song = songs[idx];
  playlists.forEach(pl => {
    pl.songs = pl.songs.filter(i => i !== idx).map(i => i > idx ? i - 1 : i);
  });
  songs.splice(idx, 1);
  if (currentSongIndex === idx) {
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    isPlaying = false; currentSongIndex = -1;
    updatePlayBtns();
    document.getElementById('spinningAlbum').classList.remove('playing');
  } else if (currentSongIndex > idx) currentSongIndex--;
  try {
    await dbDeleteSong(song.id);
    await save();
  } catch(e) {}
  renderAdminSongs(); renderAdminOverview(); renderSidebarIcons();
}

// ===== ADMIN LYRICS TAB =====
let _adminLyricsEditingSongId = null;

function renderAdminLyrics() {
  const q = (document.getElementById('adminLyricsSearch')?.value || '').toLowerCase();
  const list = document.getElementById('adminLyricsList');
  const filtered = songs.filter(s =>
    !q || s.name.toLowerCase().includes(q) || s.band.toLowerCase().includes(q)
  );
  list.innerHTML = '';
  if (filtered.length === 0) {
    list.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:12px;">No songs found</div>';
    return;
  }
  filtered.forEach(s => {
    const row = document.createElement('div');
    row.className = 'lyrics-song-row' + (_adminLyricsEditingSongId === s.id ? ' active' : '');
    row.innerHTML = `
      <div class="lyrics-song-row-thumb">${s.cover ? `<img src="${s.cover}">` : '🎵'}</div>
      <div class="lyrics-song-row-info">
        <div class="lyrics-song-row-name">${s.name}</div>
        <div class="lyrics-song-row-artist">${s.band}</div>
      </div>
      ${s.lyrics ? '<span class="lyrics-has-badge">✓ Lyrics</span>' : ''}`;
    row.onclick = () => openAdminLyricsEditor(s.id);
    list.appendChild(row);
  });
}

function openAdminLyricsEditor(songId) {
  const song = songs.find(s => s.id === songId);
  if (!song) return;
  _adminLyricsEditingSongId = songId;

  // Update cover/title
  const coverEl = document.getElementById('adminLyricsEditorCover');
  coverEl.innerHTML = song.cover ? `<img src="${song.cover}" style="width:100%;height:100%;object-fit:cover;">` : '🎵';
  document.getElementById('adminLyricsEditorTitle').textContent = song.name;
  document.getElementById('adminLyricsEditorArtist').textContent = song.band + (song.album ? ' · ' + song.album : '');
  document.getElementById('adminLyricsTextarea').value = song.lyrics || '';
  document.getElementById('adminLyricsStatus').style.display = 'none';

  // Show editor, hide empty state
  document.getElementById('adminLyricsEditor').style.display = 'flex';
  document.getElementById('adminLyricsEmptyState').style.display = 'none';

  // Highlight active row
  document.querySelectorAll('.lyrics-song-row').forEach(r => r.classList.remove('active'));
  event?.currentTarget?.classList.add('active');
  renderAdminLyrics();
}

function closeAdminLyricsEditor() {
  _adminLyricsEditingSongId = null;
  document.getElementById('adminLyricsEditor').style.display = 'none';
  document.getElementById('adminLyricsEmptyState').style.display = 'flex';
  renderAdminLyrics();
}

async function saveAdminLyrics() {
  if (!_adminLyricsEditingSongId) return;
  const song = songs.find(s => s.id === _adminLyricsEditingSongId);
  if (!song) return;
  const newLyrics = document.getElementById('adminLyricsTextarea').value;
  song.lyrics = newLyrics;
  const statusEl = document.getElementById('adminLyricsStatus');
  statusEl.textContent = 'Saving…';
  statusEl.style.display = 'block';
  statusEl.style.color = 'var(--text2)';
  try {
    await dbPatchSong(song);
    statusEl.textContent = '✓ Saved';
    statusEl.style.color = 'var(--accent)';
    // Update the badge in the list
    renderAdminLyrics();
    setTimeout(() => { statusEl.style.display = 'none'; }, 2500);
    // If lyrics column is missing, show a warning in the status area
    if (_lyricsColumnExists === false) {
      statusEl.textContent = '⚠ Lyrics column missing — run SQL migration in Supabase';
      statusEl.style.color = '#e29500';
    }
  } catch(e) {
    statusEl.textContent = '✗ Error: ' + e.message;
    statusEl.style.color = '#e22134';
  }
}



// Handle Enter key on login form
document.getElementById('authPassword').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('authUsername').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('authPassword').focus(); });

// Escape key: close fullscreen / lyrics
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.getElementById('fullscreenOverlay').classList.contains('open')) { closeFullscreen(); return; }
    if (document.getElementById('lyricsOverlay').classList.contains('open')) { closeLyrics(); return; }
  }
});

// ===== STATE =====
let songs = [];
let playlists = [];
let currentSongIndex = -1;
let currentPlaylistId = null;
let isPlaying = false;
let currentAudio = null;
let progressInterval = null;
let sortOrder = 'custom';
let ctxTarget = null;
let isShuffling = false;
let isLooping = false;
let playToggleLock = false;
let currentQueue = [];

// ===== SUPABASE DATA LAYER =====
// Replaces IndexedDB + localStorage entirely.
// Songs, playlists, and users all live in Supabase.

// Track whether the lyrics column exists in Supabase (auto-detected on first use)
let _lyricsColumnExists = null; // null=unknown, true=exists, false=missing

function songToRow(song, includeLyrics = false) {
  const row = {
    id: song.id,
    name: song.name,
    band: song.band,
    album: song.album,
    cover: song.cover || null,
    band_cover: song.bandCover || null,
    audio_url: song.audioUrl || null,
    duration: song.duration || 0,
    added_by_user_id: song.addedByUserId || null,
    added_by_username: song.addedByUsername || null,
    date_added: song.dateAdded || null
  };
  if (includeLyrics) row.lyrics = song.lyrics || null;
  return row;
}

function rowToSong(row) {
  return {
    id: row.id,
    name: row.name,
    band: row.band,
    album: row.album,
    cover: row.cover,
    bandCover: row.band_cover,
    audioUrl: row.audio_url,
    duration: row.duration,
    addedByUserId: row.added_by_user_id,
    addedByUsername: row.added_by_username,
    dateAdded: row.date_added,
    lyrics: row.lyrics || ''
  };
}

// ⚡ PERFORMANCE NOTE: Songs are loaded with all fields including audio_url.
// If audio_url is a base64 string, each song is 5-10MB which causes slow loads.
// Fix: Use Supabase Storage to upload MP3 files and store only the public URL in audio_url.
// To migrate: upload your MP3 files to a Supabase Storage bucket, get the public URL,
// then update each song's audio_url to the public URL string instead of base64.
// The "Add Song" flow below uses base64 as a fallback if no storage bucket is configured.
const SUPABASE_STORAGE_BUCKET = null; // Set to your bucket name e.g. 'audio' to enable Storage uploads

async function uploadToStorage(file, folder) {
  if (!SUPABASE_STORAGE_BUCKET) return null;
  const path = `${folder}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_STORAGE_BUCKET}/${path}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': file.type },
    body: file
  });
  if (!res.ok) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_STORAGE_BUCKET}/${path}`;
}

function playlistToRow(pl) {
  // Persist songs with position metadata for owner/admin ordering
  const songsWithPositions = (pl.songs || []).map((idx, i) => {
    if (typeof idx === 'object' && idx !== null) return idx; // already has position
    return { song_id: idx, position: i + 1 };
  });
  return {
    id: pl.id,
    user_id: pl.userId || currentUser.id,
    name: pl.name,
    cover: pl.cover || null,
    song_ids: JSON.stringify(songsWithPositions),
    is_public: !!pl.isPublic
  };
}

function rowToPlaylist(row) {
  const raw = JSON.parse(row.song_ids || '[]');
  // Support both legacy format (plain indices) and new format (objects with position)
  const songs = raw.map(entry => typeof entry === 'object' && entry !== null ? entry.song_id : entry);
  const songEntries = raw.map((entry, i) =>
    typeof entry === 'object' && entry !== null ? entry : { song_id: entry, position: i + 1 }
  );
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    cover: row.cover,
    songs,           // plain index array for compatibility
    songEntries,     // [{song_id, position}] for position-aware sorting
    isPublic: !!row.is_public
  };
}

// ===== POSITION-AWARE SONG SORTING =====
// Returns songs sorted by position if songEntries exist, otherwise plain order.
// All users see the same stable position order for any playlist.
function getSongsForPlaylist(playlist) {
  if (playlist.songEntries && playlist.songEntries.length > 0) {
    const sorted = [...playlist.songEntries].sort((a, b) => (a.position || 0) - (b.position || 0));
    return sorted.map(e => e.song_id);
  }
  return playlist.songs || [];
}

// Rebuild songEntries positions from the current songs array order
function reorderSongs(playlist) {
  if (playlist.userId !== currentUser?.id && !currentUser?.isAdmin) return;
  playlist.songEntries = playlist.songs.map((idx, i) => ({ song_id: idx, position: i + 1 }));
}

async function dbGetAllSongs() {
  const rows = await sbFetch('songs?select=*&order=id.asc');
  return rows.map(rowToSong);
}

async function dbPutSong(song) {
  // INSERT new song (upsert, for new records only)
  await sbFetch('songs?on_conflict=id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify(songToRow(song, false))
  });
  await dbSaveLyrics(song);
}

// PATCH an existing song — only sends fields that actually changed
// (avoids sending huge base64 cover/audio blobs unnecessarily)
async function dbPatchSong(song, changedFields) {
  // Build the full field map (DB column name → value)
  const allFields = {
    name: song.name,
    band: song.band,
    album: song.album,
    duration: song.duration || 0,
    added_by_user_id: song.addedByUserId || null,
    added_by_username: song.addedByUsername || null,
    date_added: song.dateAdded || null,
    cover: song.cover || null,
    band_cover: song.bandCover || null,
    audio_url: song.audioUrl || null
  };

  let body;
  if (changedFields) {
    // Only send explicitly changed fields — avoids re-uploading unchanged binary blobs
    body = {};
    changedFields.forEach(k => {
      if (k in allFields) body[k] = allFields[k];
    });
  } else {
    // No changedFields hint — send all non-binary fields only (safe default)
    const { cover, band_cover, audio_url, ...nonBinary } = allFields;
    body = nonBinary;
  }

  await sbFetch('songs?id=eq.' + song.id, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: JSON.stringify(body)
  });
  await dbSaveLyrics(song);
}

// Save lyrics via a separate PATCH — gracefully skips if column doesn't exist yet
async function dbSaveLyrics(song) {
  if (_lyricsColumnExists === false) return;
  try {
    await sbFetch('songs?id=eq.' + song.id, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ lyrics: song.lyrics || '' })
    });
    _lyricsColumnExists = true;
  } catch(e) {
    if (e.message && (e.message.includes('lyrics') || e.message.includes('PGRST204'))) {
      _lyricsColumnExists = false;
    } else {
      throw e;
    }
  }
}

async function dbDeleteSong(id) {
  await sbFetch('songs?id=eq.' + id, { method: 'DELETE', prefer: '' });
}

async function dbGetPlaylists(userId) {
  const rows = await sbFetch('playlists?user_id=eq.' + userId + '&select=*&order=id.asc');
  return rows.map(rowToPlaylist);
}

async function dbPutPlaylist(pl) {
  await sbFetch('playlists?on_conflict=id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify(playlistToRow(pl))
  });
}

async function dbDeletePlaylist(id) {
  await sbFetch('playlists?id=eq.' + id, { method: 'DELETE', prefer: '' });
}

async function loadUserData() {
  songs = await dbGetAllSongs();
  playlists = await dbGetPlaylists(currentUser.id);
}

async function save() {
  // Save all playlists for current user back to Supabase
  await Promise.all(playlists.map(pl => dbPutPlaylist(pl)));
}

// ===== EXPORT =====
async function exportData() {
  document.getElementById('userMenu').classList.remove('open');
  const allSongs = await dbGetAllSongs();
  const allPlRows = await sbFetch('playlists?select=*');
  const allPlaylists = {};
  allPlRows.forEach(row => {
    const uid = row.user_id;
    if (!allPlaylists[uid]) allPlaylists[uid] = [];
    allPlaylists[uid].push(rowToPlaylist(row));
  });
  const bundle = { _version: 3, _exportedAt: new Date().toISOString(), _exportedBy: currentUser.username, songs: allSongs, playlists: allPlaylists };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `judify_backup_${new Date().toISOString().slice(0,10)}.json`; a.click();
  URL.revokeObjectURL(url);
}

// ===== IMPORT =====
function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  const reader = new FileReader();
  reader.onload = async ev => {
    let bundle;
    try { bundle = JSON.parse(ev.target.result); } catch(err) { alert('❌ Invalid backup file.'); return; }
    if (!bundle || !bundle.songs || !bundle.playlists) { alert('❌ Not a valid Judify backup.'); return; }
    const songCount = bundle.songs.length;
    const userIds = Object.keys(bundle.playlists);
    const playlistCount = userIds.reduce((n, uid) => n + (bundle.playlists[uid]?.length || 0), 0);
    if (!confirm(`Import?\n\n• ${songCount} songs\n• ${playlistCount} playlists\n\n⚠️ This will REPLACE all current data.`)) return;
    // Clear and re-upload songs
    await sbFetch('songs?id=gt.0', { method: 'DELETE', prefer: '' });
    for (const song of bundle.songs) { await dbPutSong(song); }
    // Clear and re-upload playlists
    await sbFetch('playlists?id=like.*', { method: 'DELETE', prefer: '' });
    for (const uid of userIds) {
      for (const pl of (bundle.playlists[uid] || [])) {
        pl.userId = uid;
        await dbPutPlaylist(pl);
      }
    }
    await loadUserData();
    currentPlaylistId = null;
    renderHome(); renderSidebarIcons();
    alert(`✅ Import complete!\n${songCount} songs and ${playlistCount} playlists restored.`);
  };
  reader.readAsText(file);
}

// ===== INIT APP =====
async function initApp() {
  document.getElementById('userAvatarInitial').textContent = currentUser.username[0].toUpperCase();
  document.getElementById('userBadgeLabel').textContent = currentUser.username;
  const adminItem = document.getElementById('adminPanelMenuItem');
  const adminDiv  = document.getElementById('adminPanelDivider');
  if (adminItem) adminItem.style.display = currentUser.isAdmin ? 'block' : 'none';
  if (adminDiv)  adminDiv.style.display  = currentUser.isAdmin ? 'block' : 'none';
  // Show loading state
  const mainContent = document.getElementById('homeMainContent');
  if (mainContent) mainContent.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:200px;color:var(--text2);font-size:14px;">Loading your library…</div>';
  await loadUserData();
  // Restore main content structure after loading
  if (mainContent) mainContent.innerHTML = `
    <div class="quick-links-grid" id="quickLinksGrid"></div>
    <div id="publicPlaylistsSection" class="public-playlists-section" style="display:none;">
      <div class="section-header"><div class="section-title">🌐 Public Playlists</div></div>
      <div class="cards-row" id="publicPlaylistsRow"></div>
    </div>
    <div class="section-sub">Made For You</div>
    <div class="section-header">
      <div class="section-title" id="usernameTitle"></div>
      <button class="show-all-btn">Show all</button>
    </div>
    <div class="cards-row" id="madeForYouRow"></div>
    <div class="section-header">
      <div class="section-title">Recently played</div>
      <button class="show-all-btn">Show all</button>
    </div>
    <div class="cards-row" id="recentlyPlayedRow"></div>`;
  renderHome();
  renderSidebarIcons();
}

// ===== RENDER HELPERS =====
function imgTag(src, cls) {
  if (src) return `<img src="${src}" alt="">`;
  return `<div class="${cls}">🎵</div>`;
}
function formatTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2,'0')}`;
}
function formatDuration(s) {
  if (!s) return '0 min';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} hr ${m} min` : `${m} min`;
}

// ===== HOME PAGE =====
function renderHome() {
  document.getElementById('homePage').style.display = 'block';
  document.getElementById('playlistPage').classList.remove('active');
  currentPlaylistId = null;
  document.getElementById('homeBtn').classList.add('active');
  document.getElementById('homeSearchInput').value = '';
  document.getElementById('homeSearchResults').style.display = 'none';
  document.getElementById('homeMainContent').style.display = 'block';

  const titleEl = document.getElementById('usernameTitle');
  if (titleEl && currentUser) titleEl.textContent = currentUser.username;

  const grid = document.getElementById('quickLinksGrid');
  grid.innerHTML = '';
  playlists.slice(0, 8).forEach(pl => {
    const div = document.createElement('div');
    div.className = 'quick-link-item';
    div.innerHTML = `<div class="quick-link-img">${pl.cover ? `<img src="${pl.cover}">` : `<div class="no-img-ql">🎵</div>`}</div><span>${pl.name}</span>`;
    div.onclick = () => openPlaylist(pl.id);
    div.oncontextmenu = (e) => showContextMenu(e, {type:'playlist', playlistId: pl.id});
    grid.appendChild(div);
  });

  // Public playlists section
  renderPublicPlaylists();

  const mfy = document.getElementById('madeForYouRow');
  mfy.innerHTML = '';
  const colors = ['#3d8b5e','#5e3d8b','#8b5e3d','#e05252','#5283e0','#8be052','#e0a852','#e052d0'];
  playlists.forEach((pl, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="card-img" style="background:${colors[i%colors.length]}">${pl.cover ? `<img src="${pl.cover}">` : ''}</div><div class="card-title">${pl.name}</div><div class="card-sub">${getPlaylistArtistsSummary(pl)}</div>`;
    card.onclick = () => openPlaylist(pl.id);
    card.oncontextmenu = (e) => showContextMenu(e, {type:'playlist', playlistId: pl.id});
    mfy.appendChild(card);
  });

  const rp = document.getElementById('recentlyPlayedRow');
  rp.innerHTML = '';
  [...songs].reverse().slice(0, 6).forEach(song => {
    const realIdx = songs.indexOf(song);
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="card-img">${song.cover ? `<img src="${song.cover}">` : `<div class="no-img-card">🎵</div>`}</div><div class="card-title">${song.name}</div><div class="card-sub">${song.band}</div>`;
    card.onclick = () => playSong(realIdx);
    card.oncontextmenu = (e) => showContextMenu(e, {type:'song', songIndex: realIdx, inPlaylist: false});
    rp.appendChild(card);
  });
}

async function renderPublicPlaylists() {
  // Fetch all public playlists from all users
  const section = document.getElementById('publicPlaylistsSection');
  const row = document.getElementById('publicPlaylistsRow');
  try {
    const rows = await sbFetch('playlists?is_public=eq.true&select=*');
    const publicPls = rows.map(rowToPlaylist).filter(pl => pl.userId !== currentUser.id);
    if (publicPls.length === 0) { section.style.display = 'none'; return; }

    // Fetch owner usernames for all unique user IDs
    const ownerIds = [...new Set(publicPls.map(pl => pl.userId))];
    const usernameMap = {};
    try {
      const userRows = await sbFetch('users?id=in.(' + ownerIds.join(',') + ')&select=id,username');
      userRows.forEach(u => { usernameMap[u.id] = u.username; });
    } catch(e) {}

    section.style.display = 'block';
    row.innerHTML = '';
    const colors = ['#3d8b5e','#5e3d8b','#8b5e3d','#e05252','#5283e0','#8be052'];
    publicPls.forEach((pl, i) => {
      pl.ownerUsername = usernameMap[pl.userId] || null;
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<div class="card-img" style="background:${colors[i%colors.length]}">${pl.cover ? `<img src="${pl.cover}">` : ''}</div><div class="card-title">${pl.name}</div><div class="card-sub" style="color:var(--accent)">🌐 ${pl.ownerUsername ? pl.ownerUsername : 'Public'}</div>`;
      card.onclick = () => openPublicPlaylist(pl);
      row.appendChild(card);
    });
  } catch(e) { section.style.display = 'none'; }
}

function openPublicPlaylist(pl) {
  // Show a read-only view of a public playlist from another user
  currentPlaylistId = '__public__' + pl.id;
  document.getElementById('homeBtn').classList.remove('active');
  document.getElementById('homePage').style.display = 'none';
  document.getElementById('playlistPage').classList.add('active');
  const coverEl = document.getElementById('playlistCover');
  if (pl.cover) coverEl.innerHTML = `<img src="${pl.cover}">`;
  else coverEl.innerHTML = `<div class="no-img-cover">🎵</div>`;
  document.querySelector('.playlist-cover-wrap').style.cursor = 'default';
  document.getElementById('playlistNameDisplay').textContent = pl.name;
  const privBtn = document.getElementById('privacyToggleBtn');
  privBtn.textContent = '🌐 Public'; privBtn.className = 'privacy-toggle public'; privBtn.style.pointerEvents = 'none';
  document.getElementById('playlistSearchWrap').style.display = 'flex';
  document.getElementById('playlistSearchInput').value = '';
  const usernameEl = document.querySelector('.playlist-meta .username');
  if (usernameEl) usernameEl.textContent = pl.ownerUsername ? pl.ownerUsername : 'Shared playlist';
  // pl.songs stores array indices (same global songs array for all users)
  const songList = pl.songs.filter(i => i >= 0 && i < songs.length);
  const fakePl = { id: '__public__' + pl.id, name: pl.name, songs: songList };
  const totalDur = songList.reduce((sum, idx) => sum + (songs[idx]?.duration || 0), 0);
  document.getElementById('playlistMetaText').textContent = `${songList.length} songs, ${formatDuration(totalDur)}`;
  renderTrackList(fakePl);
  document.getElementById('npBottomPlaylistName').textContent = pl.name;
}

// ===== HOME SEARCH =====
function onHomeSearch() {
  const q = document.getElementById('homeSearchInput').value.trim().toLowerCase();
  const resultsEl = document.getElementById('homeSearchResults');
  const mainEl = document.getElementById('homeMainContent');
  if (!q) {
    resultsEl.style.display = 'none';
    mainEl.style.display = 'block';
    return;
  }
  mainEl.style.display = 'none';
  resultsEl.style.display = 'block';
  const matchedSongs = songs.map((s, i) => ({s, i})).filter(({s}) =>
    s.name.toLowerCase().includes(q) || s.band.toLowerCase().includes(q) || s.album.toLowerCase().includes(q)
  );
  const matchedPls = playlists.filter(pl => pl.name.toLowerCase().includes(q));
  let html = '';
  if (matchedSongs.length === 0 && matchedPls.length === 0) {
    html = `<div style="color:var(--text3);padding:24px 0;text-align:center;">No results for "<strong>${q}</strong>"</div>`;
  }
  if (matchedPls.length > 0) {
    html += `<div class="section-header" style="margin-top:16px;"><div class="section-title" style="font-size:18px;">Playlists</div></div><div class="cards-row">`;
    matchedPls.forEach(pl => {
      html += `<div class="card" onclick="openPlaylist('${pl.id}')">
        <div class="card-img">${pl.cover ? `<img src="${pl.cover}">` : `<div class="no-img-card">🎵</div>`}</div>
        <div class="card-title">${pl.name}</div>
        <div class="card-sub">${pl.songs.length} songs</div>
      </div>`;
    });
    html += `</div>`;
  }
  if (matchedSongs.length > 0) {
    html += `<div class="section-header" style="margin-top:16px;"><div class="section-title" style="font-size:18px;">Songs</div></div>`;
    matchedSongs.forEach(({s, i}) => {
      html += `<div class="track-item" onclick="playSong(${i})" style="border-radius:8px;margin-bottom:2px;">
        <div class="track-num">${i+1}</div>
        <div class="track-info-col">
          <div class="track-thumb">${s.cover ? `<img src="${s.cover}">` : `<div class="no-img-t">🎵</div>`}</div>
          <div class="track-text"><div class="track-title">${s.name}</div><div class="track-artist">${s.band}</div></div>
        </div>
        <div class="track-album">${s.album}</div>
        <div></div>
        <div class="track-add-icon" title="More options" onclick="event.stopPropagation();showContextMenu(event,{type:'song',songIndex:${i},inPlaylist:false,inAdded:false})" style="cursor:pointer;font-size:20px;letter-spacing:1px;padding:0 4px;">···</div>
        <div class="track-duration">${formatTime(s.duration)}</div>
      </div>`;
    });
  }
  resultsEl.innerHTML = html;
}

function getPlaylistArtistsSummary(pl) {
  const artists = [...new Set(pl.songs.map(idx => songs[idx]?.band).filter(Boolean))];
  return artists.slice(0,3).join(', ') + (artists.length > 3 ? ' and more' : '');
}

// ===== SIDEBAR =====
function renderSidebarIcons() {
  const container = document.getElementById('sidebarPlaylistIcons');
  container.innerHTML = '';
  playlists.forEach(pl => {
    const div = document.createElement('div');
    div.className = 'sidebar-playlist-icon';
    div.title = pl.name;
    div.innerHTML = pl.cover ? `<img src="${pl.cover}">` : `<div class="no-img">🎵</div>`;
    div.onclick = () => openPlaylist(pl.id);
    div.oncontextmenu = (e) => showContextMenu(e, {type:'playlist', playlistId: pl.id});
    container.appendChild(div);
  });
}

// ===== LIBRARY =====
function toggleLibrary() {
  const panel = document.getElementById('libraryPanel');
  panel.classList.contains('open') ? closeLibrary() : (panel.classList.add('open'), renderLibraryList());
}
function closeLibrary() { document.getElementById('libraryPanel').classList.remove('open'); }
function renderLibraryList() {
  const q = document.getElementById('libSearch').value.toLowerCase();
  const list = document.getElementById('libraryList');
  list.innerHTML = '';
  if (!q || 'added songs'.includes(q)) {
    const item = document.createElement('div');
    item.className = 'library-item';
    item.innerHTML = `<div class="lib-item-img"><div class="liked-img">♥</div></div><div><div class="lib-item-name">Added Songs</div><div class="lib-item-sub">Playlist • ${songs.length} songs</div></div>`;
    item.onclick = () => { showAddedSongs(); closeLibrary(); };
    list.appendChild(item);
  }
  playlists.filter(pl => !q || pl.name.toLowerCase().includes(q)).forEach(pl => {
    const item = document.createElement('div');
    item.className = 'library-item' + (currentPlaylistId === pl.id ? ' active' : '');
    item.innerHTML = `<div class="lib-item-img">${pl.cover ? `<img src="${pl.cover}">` : `<div class="no-img-lib">🎵</div>`}</div><div><div class="lib-item-name">${pl.name}</div><div class="lib-item-sub">Playlist • ${currentUser?.username || 'You'}</div></div>`;
    item.onclick = () => { openPlaylist(pl.id); closeLibrary(); };
    item.oncontextmenu = (e) => showContextMenu(e, {type:'playlist', playlistId: pl.id});
    list.appendChild(item);
  });
}

// ===== OPEN PLAYLIST =====
function openPlaylist(id) {
  const pl = playlists.find(p => p.id === id);
  if (!pl) return;
  currentPlaylistId = id;
  document.getElementById('homeBtn').classList.remove('active');
  sortOrder = 'custom';
  document.getElementById('sortLabelText').innerText = 'Custom order';
  document.querySelectorAll('.sort-option').forEach(o => {
    o.classList.toggle('active', o.dataset.sort === 'custom');
    const chk = o.querySelector('.sort-check'); if (chk) chk.remove();
    if (o.dataset.sort === 'custom') o.innerHTML += ' <span class="sort-check">✓</span>';
  });
  document.getElementById('homePage').style.display = 'none';
  document.getElementById('playlistPage').classList.add('active');

  // Privacy badge
  const privBtn = document.getElementById('privacyToggleBtn');
  privBtn.style.pointerEvents = '';
  if (pl.isPublic) {
    privBtn.textContent = '🌐 Public'; privBtn.className = 'privacy-toggle public';
  } else {
    privBtn.textContent = '🔒 Private'; privBtn.className = 'privacy-toggle private';
  }

  // Playlist search
  document.getElementById('playlistSearchWrap').style.display = 'flex';
  document.getElementById('playlistSearchInput').value = '';

  const coverEl = document.getElementById('playlistCover');
  const orderedSongs = getSongsForPlaylist(pl);
  const firstSong = orderedSongs.length > 0 ? songs[orderedSongs[0]] : null;
  if (pl.cover) coverEl.innerHTML = `<img src="${pl.cover}">`;
  else if (firstSong?.cover) coverEl.innerHTML = `<img src="${firstSong.cover}">`;
  else coverEl.innerHTML = `<div class="no-img-cover">🎵</div>`;
  document.querySelector('.playlist-cover-wrap').style.cursor = 'pointer';
  document.getElementById('playlistNameDisplay').textContent = pl.name;
  const usernameEl = document.querySelector('.playlist-meta .username');
  if (usernameEl && currentUser) usernameEl.textContent = currentUser.username;
  const totalDur = orderedSongs.reduce((sum, idx) => sum + (songs[idx]?.duration || 0), 0);
  document.getElementById('playlistMetaText').textContent = `${orderedSongs.length} songs, ${formatDuration(totalDur)}`;
  renderTrackList({ ...pl, songs: orderedSongs });
  renderSidebarIcons();
  document.getElementById('npBottomPlaylistName').textContent = pl.name;
}

// ===== SHOW ADDED SONGS =====
function showAddedSongs() {
  currentPlaylistId = '__added__';
  document.getElementById('homeBtn').classList.remove('active');
  document.getElementById('homePage').style.display = 'none';
  document.getElementById('playlistPage').classList.add('active');
  document.getElementById('playlistNameDisplay').textContent = 'Added Songs';
  document.getElementById('playlistCover').innerHTML = `<div class="no-img-cover" style="background:linear-gradient(135deg,#450af5,#c4efd9)">♥</div>`;
  document.querySelector('.playlist-cover-wrap').style.cursor = 'default';
  const privBtn = document.getElementById('privacyToggleBtn');
  privBtn.style.display = 'none';
  document.getElementById('playlistSearchWrap').style.display = 'flex';
  document.getElementById('playlistSearchInput').value = '';
  const usernameEl = document.querySelector('.playlist-meta .username');
  if (usernameEl && currentUser) usernameEl.textContent = currentUser.username;
  document.getElementById('playlistMetaText').textContent = `${songs.length} songs`;
  renderTrackList({ id: '__added__', name: 'Added Songs', songs: songs.map((_, i) => i) });
  document.getElementById('npBottomPlaylistName').textContent = 'Added Songs';
}

// ===== RENDER TRACK LIST =====
function renderTrackList(pl) {
  const container = document.getElementById('trackListContainer');
  container.innerHTML = '';
  const songObjs = [...pl.songs].map((idx, pos) => ({ idx, song: songs[idx], pos })).filter(x => x.song);
  if (sortOrder === 'title') songObjs.sort((a,b) => a.song.name.localeCompare(b.song.name));
  else if (sortOrder === 'artist') songObjs.sort((a,b) => a.song.band.localeCompare(b.song.band));
  else if (sortOrder === 'album') songObjs.sort((a,b) => a.song.album.localeCompare(b.song.album));
  else if (sortOrder === 'duration') songObjs.sort((a,b) => (a.song.duration||0) - (b.song.duration||0));
  else if (sortOrder === 'recent') songObjs.reverse();
  songObjs.forEach(({idx, song}, position) => {
    const div = document.createElement('div');
    div.className = 'track-item' + (currentSongIndex === idx && isPlaying ? ' playing' : '');
    div.dataset.songIdx = idx;
    div.innerHTML = `
      <div class="track-num">${position + 1}</div>
      <div class="track-info-col">
        <div class="track-thumb">${song.cover ? `<img src="${song.cover}">` : `<div class="no-img-t">🎵</div>`}</div>
        <div class="track-text"><div class="track-title">${song.name}</div><div class="track-artist">${song.band}</div></div>
      </div>
      <div class="track-album">${song.album}</div>
      <div class="track-date" title="${song.addedByUsername ? 'Added by ' + song.addedByUsername : ''}">${song.dateAdded || ''}</div>
      <div class="track-add-icon">⊕</div>
      <div class="track-duration">${formatTime(song.duration)}</div>`;
    div.onclick = (e) => { if (!e.target.classList.contains('track-add-icon')) playSong(idx); };
    div.oncontextmenu = (e) => showContextMenu(e, { type:'song', songIndex: idx, inPlaylist: pl.id !== '__added__', inAdded: pl.id === '__added__', playlistId: pl.id });
    container.appendChild(div);
  });
}

// ===== PLAY SONG =====
function playSong(idx, forceRestart) {
  if (!forceRestart && currentSongIndex === idx && isPlaying) return;
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (progressInterval) clearInterval(progressInterval);
  const song = songs[idx];
  if (!song) return;
  currentSongIndex = idx;
  isPlaying = true;
  document.title = `Judify - ${song.name}`;
  updateNowPlayingUI(song);
  updatePlayBtns();
  document.getElementById('spinningAlbum').classList.add('playing');
  if (song.audioUrl) {
    currentAudio = new Audio(song.audioUrl);
    currentAudio.volume = currentVolume;
    currentAudio.play().catch(() => {});
    currentAudio.addEventListener('loadedmetadata', () => { document.getElementById('npDuration').textContent = formatTime(currentAudio.duration); });
    currentAudio.addEventListener('ended', () => isLooping ? playSong(currentSongIndex, true) : nextSong());
    progressInterval = setInterval(updateProgress, 500);
  } else {
    let elapsed = 0; const dur = song.duration || 200;
    document.getElementById('npDuration').textContent = formatTime(dur);
    progressInterval = setInterval(() => {
      elapsed += 0.5;
      if (elapsed >= dur || !isPlaying) { clearInterval(progressInterval); return; }
      document.getElementById('npProgressFill').style.width = (elapsed/dur*100) + '%';
      document.getElementById('npCurrentTime').textContent = formatTime(elapsed);
    }, 500);
  }
  document.querySelectorAll('.track-item').forEach(row => row.classList.toggle('playing', parseInt(row.dataset.songIdx) === idx));
}

function updateNowPlayingUI(song) {
  document.getElementById('spinningAlbum').innerHTML = song.cover ? `<img src="${song.cover}">` : `<div class="no-img-spin">🎵</div>`;
  document.getElementById('npSongTitle').textContent = song.name;
  document.getElementById('npArtist').textContent = song.band;
  const bigAlb = song.bandCover || song.cover;
  document.getElementById('npBigAlbum').innerHTML = bigAlb ? `<img src="${bigAlb}">` : `<div class="no-img-big">🎵</div>`;
  document.getElementById('npBottomTitle').textContent = song.album;
  document.getElementById('npBottomArtist').textContent = song.band;
  // Update fullscreen if open
  if (document.getElementById('fullscreenOverlay').classList.contains('open')) {
    updateFullscreenUI();
  }
  // Update lyrics panel header if open
  if (document.getElementById('lyricsOverlay').classList.contains('open') && !_lyricsEditMode) {
    openLyrics();
  }
}

function updateProgress() {
  if (!currentAudio) return;
  document.getElementById('npProgressFill').style.width = ((currentAudio.currentTime / currentAudio.duration) * 100 || 0) + '%';
  document.getElementById('npCurrentTime').textContent = formatTime(currentAudio.currentTime);
}

function updatePlayBtns() {
  const pauseIcon = `<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
  const playIcon  = `<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><polygon points="5,3 19,12 5,21"/></svg>`;
  document.getElementById('npPlayBtn').innerHTML = isPlaying ? pauseIcon : playIcon;
  const bigBtn = document.querySelector('.play-btn-big');
  if (bigBtn) {
    bigBtn.innerHTML = isPlaying
      ? `<svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><polygon points="5,3 19,12 5,21"/></svg>`;
  }
  // Sync fullscreen
  updateFsPlayBtn();
}

function togglePlay() {
  if (currentSongIndex < 0 || playToggleLock) return;
  playToggleLock = true;
  setTimeout(() => { playToggleLock = false; }, 300);
  if (currentAudio) { isPlaying ? currentAudio.pause() : currentAudio.play().catch(() => {}); }
  isPlaying = !isPlaying;
  document.getElementById('spinningAlbum').classList.toggle('playing', isPlaying);
  updatePlayBtns();
}

function nextSong() {
  if (songs.length === 0) return;
  if (isLooping) { playSong(currentSongIndex, true); return; }
  if (isShuffling && currentQueue.length > 0) {
    const next = currentQueue.shift();
    if (currentQueue.length === 0) buildQueue();
    playSong(next, true);
  } else { playSong((currentSongIndex + 1) % songs.length, true); }
}

function prevSong() {
  if (songs.length === 0) return;
  if (currentAudio && currentAudio.currentTime > 3) { currentAudio.currentTime = 0; return; }
  if (isShuffling && currentQueue.length > 0) { playSong(currentQueue[Math.floor(Math.random() * currentQueue.length)], true); }
  else { playSong((currentSongIndex - 1 + songs.length) % songs.length, true); }
}

function buildQueue() {
  currentQueue = songs.map((_, i) => i).filter(i => i !== currentSongIndex);
  for (let i = currentQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [currentQueue[i], currentQueue[j]] = [currentQueue[j], currentQueue[i]];
  }
}

function toggleShuffle() {
  isShuffling = !isShuffling;
  if (isShuffling) buildQueue();
  document.querySelectorAll('.shuffle-btn').forEach(b => b.classList.toggle('active-ctrl', isShuffling));
}

function toggleLoop() {
  isLooping = !isLooping;
  document.querySelectorAll('.loop-btn').forEach(b => b.classList.toggle('active-ctrl', isLooping));
}

function playAll() {
  let firstIdx;
  if (currentPlaylistId === '__added__') {
    if (songs.length === 0) return; firstIdx = 0;
  } else if (currentPlaylistId && currentPlaylistId.startsWith('__public__')) {
    // Read first song index from the rendered track list
    const firstRow = document.querySelector('#trackListContainer .track-item');
    if (!firstRow) return;
    firstIdx = parseInt(firstRow.dataset.songIdx);
    if (isNaN(firstIdx)) return;
  } else {
    const pl = playlists.find(p => p.id === currentPlaylistId);
    if (!pl || pl.songs.length === 0) return; firstIdx = pl.songs[0];
  }
  if (currentSongIndex === firstIdx && isPlaying) { togglePlay(); return; }
  playSong(firstIdx, true);
}

function seek(pct) {
  pct = Math.max(0, Math.min(1, pct));
  if (currentAudio && currentAudio.duration) { currentAudio.currentTime = pct * currentAudio.duration; updateProgress(); }
}

// Draggable seek bar
(function() {
  let dragging = false;
  function getBar() { return document.getElementById('npProgressBar'); }
  function getPct(e, bar) { const r = bar.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); }
  document.addEventListener('mousedown', e => { const bar = getBar(); if (!bar) return; if (bar.contains(e.target) || e.target === bar) { dragging = true; seek(getPct(e, bar)); e.preventDefault(); } });
  document.addEventListener('mousemove', e => { if (!dragging) return; const bar = getBar(); if (bar) seek(getPct(e, bar)); });
  document.addEventListener('mouseup', () => { dragging = false; });
  document.addEventListener('touchstart', e => { const bar = getBar(); if (!bar) return; if (bar.contains(e.target) || e.target === bar) { dragging = true; seek(getPct(e.touches[0], bar)); } }, { passive: true });
  document.addEventListener('touchmove', e => { if (!dragging) return; const bar = getBar(); if (bar) seek(getPct(e.touches[0], bar)); }, { passive: true });
  document.addEventListener('touchend', () => { dragging = false; });
})();

// ===== SORT =====
function toggleSortDropdown(e) { e.stopPropagation(); document.getElementById('sortDropdown').classList.toggle('open'); }
function setSort(type, el) {
  sortOrder = type;
  document.getElementById('sortLabelText').textContent = el.textContent.replace('✓','').trim();
  document.querySelectorAll('.sort-option').forEach(o => { o.classList.remove('active'); const c = o.querySelector('.sort-check'); if (c) c.remove(); });
  el.classList.add('active'); el.innerHTML += ' <span class="sort-check">✓</span>';
  document.getElementById('sortDropdown').classList.remove('open');
  if (currentPlaylistId && currentPlaylistId !== '__added__') {
    if (currentPlaylistId.startsWith('__public__')) {
      // Public playlist — songs are already rendered in the DOM; re-sort from current track items
      const trackItems = document.querySelectorAll('#trackListContainer .track-item');
      const songIndices = [...trackItems].map(el => parseInt(el.dataset.songIdx)).filter(n => !isNaN(n));
      const fakePl = { id: currentPlaylistId, name: '', songs: songIndices, songEntries: null };
      renderTrackList(fakePl);
    } else {
      const pl = playlists.find(p => p.id === currentPlaylistId);
      if (pl) {
        const orderedSongs = sortOrder === 'custom' ? getSongsForPlaylist(pl) : pl.songs;
        renderTrackList({ ...pl, songs: orderedSongs });
      }
    }
  }
  else if (currentPlaylistId === '__added__') showAddedSongs();
}

// ===== CONTEXT MENU =====
function showContextMenu(e, target) {
  e.preventDefault(); e.stopPropagation();
  ctxTarget = target;
  const menu = document.getElementById('contextMenu');
  menu.innerHTML = '';
  if (target.type === 'song') {
    if (target.inPlaylist) {
      menu.innerHTML = `<div class="ctx-item" onclick="ctxAddToPlaylist()"><span>➕</span> Add to playlist</div><div class="ctx-divider"></div><div class="ctx-item danger" onclick="ctxRemoveFromPlaylist()"><span>➖</span> Remove from this playlist</div>`;
    } else if (target.inAdded) {
      menu.innerHTML = `<div class="ctx-item" onclick="ctxAddToPlaylist()"><span>➕</span> Add to playlist</div><div class="ctx-divider"></div><div class="ctx-item danger" onclick="ctxDeleteSong()"><span>🗑</span> Delete song</div>`;
    } else {
      menu.innerHTML = `<div class="ctx-item" onclick="ctxAddToPlaylist()"><span>➕</span> Add to playlist</div>`;
    }
  } else if (target.type === 'playlist') {
    menu.innerHTML = `<div class="ctx-item" onclick="ctxAddPlaylistToPlaylist()"><span>📋</span> Add to another playlist</div><div class="ctx-divider"></div><div class="ctx-item danger" onclick="ctxDeletePlaylist()"><span>🗑</span> Delete playlist</div>`;
  }
  menu.style.left = Math.min(e.clientX, window.innerWidth - 220) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 150) + 'px';
  menu.classList.add('open');
}

document.addEventListener('click', () => {
  document.getElementById('contextMenu').classList.remove('open');
  document.getElementById('sortDropdown').classList.remove('open');
  document.getElementById('userMenu').classList.remove('open');
});

// Close modals when clicking on the dark backdrop (outside the modal-box)
['plusOptionsModal','createPlaylistModal','playlistPickerModal','addSongModal'].forEach(id => {
  const overlay = document.getElementById(id);
  if (!overlay) return;
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
});

function ctxAddToPlaylist() { document.getElementById('contextMenu').classList.remove('open'); openPlaylistPicker('add_song', 'Add to Playlist'); }

async function ctxRemoveFromPlaylist() {
  document.getElementById('contextMenu').classList.remove('open');
  if (!ctxTarget) return;
  const pl = playlists.find(p => p.id === ctxTarget.playlistId);
  if (!pl) return;
  const pos = pl.songs.indexOf(ctxTarget.songIndex);
  if (pos !== -1) {
    pl.songs.splice(pos, 1);
    // Keep songEntries in sync and recalculate positions
    if (pl.songEntries) {
      pl.songEntries = pl.songEntries.filter(e => e.song_id !== ctxTarget.songIndex);
      pl.songEntries.forEach((e, i) => { e.position = i + 1; });
    }
  }
  await dbPutPlaylist(pl);
  openPlaylist(pl.id); renderSidebarIcons();
}

async function ctxDeletePlaylist() {
  document.getElementById('contextMenu').classList.remove('open');
  if (!ctxTarget) return;
  const idx = playlists.findIndex(p => p.id === ctxTarget.playlistId);
  if (idx === -1) {
    // Not in local array — must be a public playlist from another user.
    // Only admins are allowed to delete it.
    if (!currentUser?.isAdmin) return;
    if (!confirm('Delete this public playlist? This cannot be undone.')) return;
    try {
      // Strip '__public__' prefix to get the real DB id
      const realId = ctxTarget.playlistId.replace(/^__public__/, '');
      await dbDeletePlaylist(realId);
      currentPlaylistId = null; renderHome(); renderSidebarIcons();
    } catch(e) { alert('Error deleting playlist: ' + e.message); }
    return;
  }
  const pl = playlists[idx];
  playlists.splice(idx, 1);
  await dbDeletePlaylist(pl.id);
  currentPlaylistId = null; renderHome(); renderSidebarIcons();
}

function ctxAddPlaylistToPlaylist() { document.getElementById('contextMenu').classList.remove('open'); openPlaylistPicker('merge_playlist', 'Add to Another Playlist'); }

// ===== PLAYLIST PICKER =====
function openPlaylistPicker(action, title) {
  document.getElementById('pickerTitle').textContent = title;
  const list = document.getElementById('playlistPickerList');
  list.innerHTML = '';
  const exclude = action === 'merge_playlist' ? ctxTarget.playlistId : null;
  playlists.filter(pl => pl.id !== exclude).forEach(pl => {
    const item = document.createElement('div');
    item.className = 'playlist-picker-item';
    item.innerHTML = `<div class="picker-img">${pl.cover ? `<img src="${pl.cover}">` : `<div class="no-img-p">🎵</div>`}</div><div class="picker-name">${pl.name}</div>`;
    item.onclick = async () => {
      if (action === 'add_song' && ctxTarget?.type === 'song') {
        if (!pl.songs.includes(ctxTarget.songIndex)) {
          const newPosition = (pl.songEntries || pl.songs).length + 1;
          pl.songs.push(ctxTarget.songIndex);
          // Assign position only when owner/admin adds to their own playlist
          if (pl.userId === currentUser?.id || currentUser?.isAdmin) {
            if (!pl.songEntries) pl.songEntries = pl.songs.slice(0, -1).map((idx, i) => ({ song_id: idx, position: i + 1 }));
            pl.songEntries.push({ song_id: ctxTarget.songIndex, position: newPosition });
          }
        }
      } else if (action === 'merge_playlist') {
        // Source may be a local playlist or a public one viewed as read-only
        const srcId = ctxTarget.playlistId.replace(/^__public__/, '');
        let src = playlists.find(p => p.id === srcId);
        if (!src) {
          // Try to find from rendered track list (public playlist open in view)
          const trackItems = document.querySelectorAll('#trackListContainer .track-item');
          const srcSongIndices = [...trackItems].map(el => parseInt(el.dataset.songIdx)).filter(n => !isNaN(n));
          src = { songs: srcSongIndices, songEntries: null };
        }
        if (src) {
          const isOwnerOrAdmin = pl.userId === currentUser?.id || currentUser?.isAdmin;
          if (!pl.songEntries) {
            pl.songEntries = pl.songs.map((idx, i) => ({ song_id: idx, position: i + 1 }));
          }
          const srcSongs = getSongsForPlaylist(src);
          srcSongs.forEach(idx => {
            if (!pl.songs.includes(idx)) {
              const newPosition = pl.songEntries.length + 1;
              pl.songs.push(idx);
              if (isOwnerOrAdmin) {
                pl.songEntries.push({ song_id: idx, position: newPosition });
              }
            }
          });
        }
      }
      await dbPutPlaylist(pl);
      document.getElementById('playlistPickerModal').classList.remove('open');
    };
    list.appendChild(item);
  });
  document.getElementById('playlistPickerModal').classList.add('open');
}

// ===== ADD SONG =====
function openAddSongModal() {
  // Rule 3 & 4: Close admin panel before opening popup — only one UI layer at a time
  document.getElementById('adminOverlay').classList.remove('open');
  document.getElementById('addSongModal').classList.add('open');
}
function closeAddSongModal() { document.getElementById('addSongModal').classList.remove('open'); }

async function submitAddSong() {
  const name = document.getElementById('inputSongName').value.trim();
  const band = document.getElementById('inputBandName').value.trim();
  const album = document.getElementById('inputAlbumName').value.trim();
  const coverFile = document.getElementById('inputSongCover').files[0];
  const bandCoverFile = document.getElementById('inputBandCover').files[0];
  const mp3File = document.getElementById('inputMp3').files[0];
  if (!name || !band || !album) { alert('Please fill in all text fields.'); return; }
  if (!coverFile) { alert('Please select a song cover image.'); return; }
  if (!mp3File) { alert('Please select an MP3 file.'); return; }

  const submitBtn = document.querySelector('#addSongModal .form-submit-btn');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Adding…'; }

  try {
    const readFile = f => new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = e => res(e.target.result);
      r.onerror = () => rej(new Error('Failed to read file'));
      r.readAsDataURL(f);
    });

    const [cover, bandCover, audioUrl] = await Promise.all([
      readFile(coverFile),
      bandCoverFile ? readFile(bandCoverFile) : Promise.resolve(null),
      SUPABASE_STORAGE_BUCKET
        ? uploadToStorage(mp3File, 'audio').then(url => url || readFile(mp3File))
        : readFile(mp3File)
    ]);

    const lyricsInput = document.getElementById('inputLyrics');
    const song = {
      id: Date.now(), name, band, album, cover, bandCover, audioUrl, duration: 0,
      lyrics: lyricsInput ? lyricsInput.value.trim() : '',
      addedByUserId: currentUser.id, addedByUsername: currentUser.username,
      dateAdded: new Date().toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'})
    };

    // Get duration — give it up to 8 seconds, but always proceed
    await new Promise(res => {
      const a = new Audio();
      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; res(); } };
      a.onloadedmetadata = () => {
        if (a.duration && isFinite(a.duration) && a.duration > 0) song.duration = a.duration;
        done();
      };
      a.onerror = done;
      const timer = setTimeout(done, 8000);
      a.addEventListener('loadedmetadata', () => clearTimeout(timer));
      a.src = audioUrl;
    });

    songs.push(song);
    await dbPutSong(song);
    closeAddSongModal();
    ['inputSongName','inputBandName','inputAlbumName'].forEach(id => document.getElementById(id).value = '');
    ['inputSongCover','inputBandCover','inputMp3'].forEach(id => document.getElementById(id).value = '');
    const lyricsEl = document.getElementById('inputLyrics'); if (lyricsEl) lyricsEl.value = '';
    renderHome(); renderSidebarIcons(); renderLibraryList();
    if (document.getElementById('adminOverlay').classList.contains('open')) {
      renderAdminSongs(); renderAdminOverview();
    }
  } catch(e) {
    alert('Error adding song: ' + e.message);
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Add Song'; }
  }
}

// ===== CREATE PLAYLIST =====
function openCreatePlaylistModal() { document.getElementById('plusOptionsModal').classList.add('open'); }
function startCreatePlaylist() { document.getElementById('plusOptionsModal').classList.remove('open'); document.getElementById('inputPlaylistName').value = ''; document.getElementById('createPlaylistModal').classList.add('open'); }
async function submitCreatePlaylist() {
  const name = document.getElementById('inputPlaylistName').value.trim();
  if (!name) { alert('Enter a playlist name.'); return; }
  const pl = { id: 'pl_' + Date.now() + '_' + Math.random().toString(36).slice(2), name, songs: [], songEntries: [], cover: null, userId: currentUser.id, isPublic: false };
  playlists.push(pl);
  await dbPutPlaylist(pl);
  document.getElementById('createPlaylistModal').classList.remove('open');
  renderHome(); renderSidebarIcons(); renderLibraryList();
}

// ===== DELETE SONG =====
async function ctxDeleteSong() {
  document.getElementById('contextMenu').classList.remove('open');
  if (!ctxTarget) return;
  const idx = ctxTarget.songIndex;
  const song = songs[idx];
  if (!song) return;
  playlists.forEach(pl => {
    pl.songs = pl.songs.filter(i => i !== idx).map(i => i > idx ? i - 1 : i);
  });
  songs.splice(idx, 1);
  if (currentSongIndex === idx) {
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    isPlaying = false; currentSongIndex = -1;
    updatePlayBtns(); document.getElementById('spinningAlbum').classList.remove('playing');
    document.title = 'Judify';
  } else if (currentSongIndex > idx) currentSongIndex--;
  await save();
  showAddedSongs(); renderSidebarIcons();
}

// ===== VOLUME =====
let currentVolume = 1, isMuted = false, premuteVolume = 1;

function setVolume(val, sourceSlider) {
  currentVolume = Math.max(0, Math.min(1, val)); isMuted = currentVolume === 0;
  if (currentAudio) currentAudio.volume = currentVolume;
  const pct = Math.round(currentVolume * 100);
  const slider = document.getElementById('npVolSlider');
  if (slider && slider !== sourceSlider) slider.value = pct;
  if (slider) slider.style.setProperty('--vol-pct', pct + '%');
  const pctEl = document.getElementById('npVolPct'); if (pctEl) pctEl.textContent = pct + '%';
  updateVolIcon();
}
function toggleMute() { isMuted ? setVolume(premuteVolume || 1, null) : (premuteVolume = currentVolume, setVolume(0, null)); }
function updateVolIcon() {
  const muteIcon = `<polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><line x1="23" y1="9" x2="17" y2="15" stroke="currentColor" stroke-width="2"/><line x1="17" y1="9" x2="23" y2="15" stroke="currentColor" stroke-width="2"/>`;
  const volIcon  = `<polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><path d="M19.07,4.93a10,10,0,0,1,0,14.14"/><path d="M15.54,8.46a5,5,0,0,1,0,7.07"/>`;
  const el = document.getElementById('npVolIcon'); if (el) el.innerHTML = isMuted ? muteIcon : volIcon;
}

// ===== PLAYLIST SEARCH =====
function onPlaylistSearch() {
  const q = document.getElementById('playlistSearchInput').value.trim().toLowerCase();

  // Helper: get current song indices from DOM for public playlists
  const getPublicSongIndices = () => [...document.querySelectorAll('#trackListContainer .track-item')]
    .map(el => parseInt(el.dataset.songIdx)).filter(n => !isNaN(n));

  if (!q) {
    if (currentPlaylistId === '__added__') {
      renderTrackList({ id: '__added__', name: 'Added Songs', songs: songs.map((_, i) => i) });
    } else if (currentPlaylistId?.startsWith('__public__')) {
      const songIndices = getPublicSongIndices();
      renderTrackList({ id: currentPlaylistId, name: '', songs: songIndices, songEntries: null });
    } else {
      const pl = playlists.find(p => p.id === currentPlaylistId);
      if (pl) renderTrackList({ ...pl, songs: getSongsForPlaylist(pl) });
    }
    return;
  }

  let songIndices;
  if (currentPlaylistId === '__added__') {
    songIndices = songs.map((_, i) => i);
  } else if (currentPlaylistId?.startsWith('__public__')) {
    songIndices = getPublicSongIndices();
  } else {
    const pl = playlists.find(p => p.id === currentPlaylistId);
    songIndices = pl ? getSongsForPlaylist(pl) : [];
  }

  const filtered = songIndices.filter(idx => {
    const s = songs[idx];
    return s && (s.name.toLowerCase().includes(q) || s.band.toLowerCase().includes(q) || s.album.toLowerCase().includes(q));
  });
  renderTrackList({ id: currentPlaylistId, name: '', songs: filtered });
}

// ===== PRIVACY TOGGLE =====
async function togglePlaylistPrivacy() {
  if (!currentPlaylistId || currentPlaylistId === '__added__' || currentPlaylistId.startsWith('__public__')) return;
  const pl = playlists.find(p => p.id === currentPlaylistId);
  if (!pl) return;
  pl.isPublic = !pl.isPublic;
  await dbPutPlaylist(pl);
  const privBtn = document.getElementById('privacyToggleBtn');
  if (pl.isPublic) {
    privBtn.textContent = '🌐 Public'; privBtn.className = 'privacy-toggle public';
  } else {
    privBtn.textContent = '🔒 Private'; privBtn.className = 'privacy-toggle private';
  }
}

// ===== FULLSCREEN =====
let fsProgressInterval = null;
function openFullscreen() {
  const overlay = document.getElementById('fullscreenOverlay');
  overlay.classList.add('open');
  updateFullscreenUI();
  if (fsProgressInterval) clearInterval(fsProgressInterval);
  fsProgressInterval = setInterval(updateFsProgress, 500);
}
function closeFullscreen() {
  document.getElementById('fullscreenOverlay').classList.remove('open');
  if (fsProgressInterval) { clearInterval(fsProgressInterval); fsProgressInterval = null; }
}
function updateFullscreenUI() {
  if (currentSongIndex < 0) return;
  const song = songs[currentSongIndex];
  if (!song) return;
  const fsAlbum = document.getElementById('fsAlbum');
  fsAlbum.innerHTML = song.cover ? `<img src="${song.cover}">` : `<div class="no-img-fs">🎵</div>`;
  fsAlbum.classList.toggle('playing', isPlaying);
  document.getElementById('fsSongName').textContent = song.name;
  document.getElementById('fsArtist').textContent = song.band;
  updateFsPlayBtn();
}
function updateFsPlayBtn() {
  const pauseIcon = `<svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
  const playIcon  = `<svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><polygon points="5,3 19,12 5,21"/></svg>`;
  const btn = document.getElementById('fsPlayBtn');
  if (btn) btn.innerHTML = isPlaying ? pauseIcon : playIcon;
  const fsAlbum = document.getElementById('fsAlbum');
  if (fsAlbum) fsAlbum.classList.toggle('playing', isPlaying);
}
function updateFsProgress() {
  if (!currentAudio) return;
  const pct = (currentAudio.currentTime / currentAudio.duration) * 100 || 0;
  const fill = document.getElementById('fsProgressFill');
  if (fill) fill.style.width = pct + '%';
  const cur = document.getElementById('fsCurrentTime');
  if (cur) cur.textContent = formatTime(currentAudio.currentTime);
  const dur = document.getElementById('fsDuration');
  if (dur) dur.textContent = formatTime(currentAudio.duration);
}
function seekFromFS(e) {
  const bar = document.getElementById('fsProgressBar');
  const r = bar.getBoundingClientRect();
  seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
}
function seekFromNP(e) {
  const bar = document.getElementById('npProgressBar');
  const r = bar.getBoundingClientRect();
  seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
}

// ===== LYRICS =====
let _lyricsEditMode = false;
function openLyrics() {
  if (currentSongIndex < 0) return;
  const song = songs[currentSongIndex];
  if (!song) return;
  document.getElementById('lyricsSongName').textContent = song.name;
  document.getElementById('lyricsArtistName').textContent = song.band;
  const lyricsText = document.getElementById('lyricsText');
  const lyrics = song.lyrics || '';
  if (lyrics) {
    lyricsText.innerHTML = lyrics.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
    lyricsText.className = 'lyrics-text has-lyrics';
  } else {
    lyricsText.innerHTML = 'No lyrics available for this song. Click "Edit Lyrics" to add them.';
    lyricsText.className = 'lyrics-text';
  }
  lyricsText.style.display = 'block';
  document.getElementById('lyricsEditArea').style.display = 'none';
  document.getElementById('lyricsEditArea').value = lyrics;
  document.getElementById('lyricsEditBtn').style.display = '';
  document.getElementById('lyricsSaveBtn').style.display = 'none';
  document.getElementById('lyricsCancelBtn').style.display = 'none';
  _lyricsEditMode = false;
  document.getElementById('lyricsOverlay').classList.add('open');
}
function closeLyrics() {
  document.getElementById('lyricsOverlay').classList.remove('open');
  _lyricsEditMode = false;
}
function toggleLyricsEdit() {
  _lyricsEditMode = true;
  const song = currentSongIndex >= 0 ? songs[currentSongIndex] : null;
  document.getElementById('lyricsEditArea').value = song?.lyrics || '';
  document.getElementById('lyricsText').style.display = 'none';
  document.getElementById('lyricsEditArea').style.display = 'block';
  document.getElementById('lyricsEditBtn').style.display = 'none';
  document.getElementById('lyricsSaveBtn').style.display = '';
  document.getElementById('lyricsCancelBtn').style.display = '';
  document.getElementById('lyricsEditArea').focus();
}
async function saveLyrics() {
  if (currentSongIndex < 0) return;
  const song = songs[currentSongIndex];
  if (!song) return;
  song.lyrics = document.getElementById('lyricsEditArea').value;
  await dbPutSong(song);
  const lyricsText = document.getElementById('lyricsText');
  if (song.lyrics) {
    lyricsText.innerHTML = song.lyrics.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
    lyricsText.className = 'lyrics-text has-lyrics';
  } else {
    lyricsText.innerHTML = 'No lyrics available for this song. Click "Edit Lyrics" to add them.';
    lyricsText.className = 'lyrics-text';
  }
  lyricsText.style.display = 'block';
  document.getElementById('lyricsEditArea').style.display = 'none';
  document.getElementById('lyricsEditBtn').style.display = '';
  document.getElementById('lyricsSaveBtn').style.display = 'none';
  document.getElementById('lyricsCancelBtn').style.display = 'none';
  _lyricsEditMode = false;
}
function cancelLyricsEdit() {
  _lyricsEditMode = false;
  document.getElementById('lyricsText').style.display = 'block';
  document.getElementById('lyricsEditArea').style.display = 'none';
  document.getElementById('lyricsEditBtn').style.display = '';
  document.getElementById('lyricsSaveBtn').style.display = 'none';
  document.getElementById('lyricsCancelBtn').style.display = 'none';
}

// ===== PLAYLIST PRIVACY SHOW/HIDE =====
function resetPrivacyBtn() {
  const btn = document.getElementById('privacyToggleBtn');
  btn.style.display = '';
  btn.style.pointerEvents = '';
}
function triggerCoverChange() { if (!currentPlaylistId || currentPlaylistId === '__added__') return; document.getElementById('coverFileInput').click(); }
function handleCoverChange(e) {
  const file = e.target.files[0]; if (!file) return;
  const pid = currentPlaylistId; e.target.value = '';
  if (!pid || pid === '__added__') return;
  const reader = new FileReader();
  reader.onload = async ev => {
    const pl = playlists.find(p => p.id === pid); if (!pl) return;
    pl.cover = ev.target.result;
    await dbPutPlaylist(pl);
    document.getElementById('playlistCover').innerHTML = `<img src="${pl.cover}" style="width:100%;height:100%;object-fit:cover;">`;
    renderSidebarIcons(); renderLibraryList(); renderHome();
    document.getElementById('homePage').style.display = 'none';
    document.getElementById('playlistPage').classList.add('active');
  };
  reader.readAsDataURL(file);
}

// ===== PLAYLIST NAME EDIT =====
let _editingPlaylistId = null;
function startEditPlaylistName() {
  if (!currentPlaylistId || currentPlaylistId === '__added__') return;
  const pl = playlists.find(p => p.id === currentPlaylistId); if (!pl) return;
  _editingPlaylistId = currentPlaylistId;
  const nameEl = document.getElementById('playlistNameDisplay'); if (!nameEl) return;
  nameEl.style.display = 'none';
  let input = document.getElementById('playlistNameEditInput');
  if (!input) { input = document.createElement('input'); input.id = 'playlistNameEditInput'; input.className = 'playlist-name-input'; nameEl.parentNode.insertBefore(input, nameEl); }
  input.value = pl.name; input.style.display = 'block'; input.focus(); input.select();
  let _finished = false;
  const finish = async (doSave) => {
    if (_finished) return;
    _finished = true;
    input.onblur = null;
    input.onkeydown = null;
    const val = input.value.trim();
    if (doSave && val) {
      const target = playlists.find(p => p.id === _editingPlaylistId);
      if (target) { target.name = val; await dbPutPlaylist(target); nameEl.textContent = val; document.getElementById('npBottomPlaylistName').textContent = val; renderSidebarIcons(); renderLibraryList(); renderHome(); }
    }
    input.style.display = 'none'; nameEl.style.display = 'block'; _editingPlaylistId = null;
  };
  input.onblur = () => finish(true);
  input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') finish(false); };
}

// ===== PLAYLIST 3-DOTS MENU =====
function showPlaylistDotsMenu(e) {
  e.stopPropagation();
  if (!currentPlaylistId || currentPlaylistId === '__added__') return;
  showContextMenu(e, { type: 'playlist', playlistId: currentPlaylistId });
}

// ===== INIT =====
(async function() {
  const saved = localStorage.getItem('mp_session');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      // Re-validate session against Supabase
      const users = await sbFetch('users?id=eq.' + parsed.id + '&username=eq.' + encodeURIComponent(parsed.username) + '&select=*');
      if (users && users.length > 0) {
        const u = users[0];
        currentUser = { id: u.id, username: u.username, isAdmin: !!u.is_admin };
        document.getElementById('authOverlay').classList.add('hidden');
        initApp();
        return;
      }
    } catch(e) {}
    localStorage.removeItem('mp_session');
  }
})();
