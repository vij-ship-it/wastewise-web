// Shared helpers for every page.
(function () {
  // follow the OS light/dark setting
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const setTheme = () => document.documentElement.setAttribute('data-bs-theme', mq.matches ? 'dark' : 'light');
  setTheme();
  mq.addEventListener('change', setTheme);
})();

const WW = {
  async api(path, opts = {}) {
    const init = { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: {}, credentials: 'same-origin' };
    if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    if (opts.headers) Object.assign(init.headers, opts.headers);
    const res = await fetch(path, init);
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  },
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  toast(msg, type = 'success') {
    let box = document.getElementById('ww-toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'ww-toasts';
      box.className = 'toast-container position-fixed top-0 end-0 p-3';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    const color = { success: 'text-bg-success', error: 'text-bg-danger', info: 'text-bg-primary', warning: 'text-bg-warning' }[type] || 'text-bg-secondary';
    el.className = `toast align-items-center border-0 ${color}`;
    el.innerHTML = `<div class="d-flex"><div class="toast-body">${WW.esc(msg)}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
    box.appendChild(el);
    const t = new bootstrap.Toast(el, { delay: type === 'error' ? 6000 : 3500 });
    t.show();
    el.addEventListener('hidden.bs.toast', () => el.remove());
  },
  today() { return WW.ymd(new Date()); },
  ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; },
  addDays(ymd, n) { const [y, m, d] = ymd.split('-').map(Number); const x = new Date(y, m - 1, d); x.setDate(x.getDate() + n); return WW.ymd(x); },
  days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  prettyDate(ymd, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
  },
  dayLabel(ymd) {
    const t = WW.today();
    if (ymd === t) return 'Today';
    if (ymd === WW.addDays(t, 1)) return 'Tomorrow';
    return WW.prettyDate(ymd);
  },
  async me() { return (await WW.api('/api/me')).user; },
  async requireUser(role) {
    const u = await WW.me();
    if (!u) { location.href = role === 'admin' ? '/login?admin=1' : '/login'; return null; }
    if (role === 'admin' && u.role !== 'admin') { location.href = '/student'; return null; }
    if (role === 'student' && u.role === 'admin') { location.href = '/admin'; return null; }
    return u;
  },
  async logout() { await WW.api('/api/auth/logout', { method: 'POST' }); location.href = '/'; },
  fileToDataUrl(file, maxSize = 1280) {
    // shrink photos before upload so they stay small
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error('Could not read that image'));
      img.src = URL.createObjectURL(file);
    });
  },
  statusBadge(status) {
    const map = { open: 'danger', in_progress: 'warning', resolved: 'success', active: 'success', used: 'secondary', expired: 'secondary', cancelled: 'dark', granted: 'success', denied: 'danger', duplicate: 'warning' };
    const label = { in_progress: 'in progress' }[status] || status;
    return `<span class="badge text-bg-${map[status] || 'secondary'}">${WW.esc(label)}</span>`;
  },
  chartColors: { expected: '#94a3b8', actual: '#1b7a4e', waste: '#d97706', biogas: '#2563eb', noshow: '#dc2626', guests: '#7c3aed', meals: ['#d97706', '#1b7a4e', '#7c3aed', '#2563eb'] },
};
