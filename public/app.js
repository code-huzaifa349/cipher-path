(() => {
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls = '', text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text; // textContent, never innerHTML: user data stays inert
  return node;
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { status: res.status, field: data.field });
  return data;
}

/* Wires a form to an async handler; shows errors in the form's .form-status (role="alert") */
function bindForm(id, onSubmit) {
  const form = document.getElementById(id);
  if (!form) return;
  const status = $('.form-status', form);
  const say = (text, state = '') => { status.textContent = text; status.dataset.state = state; };

  form.addEventListener('input', (e) => e.target.removeAttribute('aria-invalid'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    say('');
    const button = $('button[type="submit"]', form);
    button.disabled = true;
    try {
      const message = await onSubmit(Object.fromEntries(new FormData(form)), form);
      if (message) say(message, 'ok');
    } catch (err) {
      const field = err.field && form.elements[err.field];
      if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
      say(err.status ? err.message : 'Cannot reach the server. Check that it is running.', 'error');
    } finally {
      button.disabled = false;
    }
  });
}

/* Landing page and shared header: swap sign-up links for Dashboard when logged in */
async function syncNav() {
  const links = document.querySelectorAll('[data-auth-link]');
  const login = $('[data-auth-login]');
  if (!links.length && !login) return;
  try {
    await api('/me');
    links.forEach((a) => { a.href = '/dashboard.html'; a.textContent = 'Dashboard'; });
    if (login) login.closest('li').remove();
  } catch { /* not logged in: keep sign-up links */ }
}

function bindLogout() {
  document.querySelectorAll('[data-logout]').forEach((btn) => btn.addEventListener('click', async () => {
    try { await api('/logout', { method: 'POST' }); } finally { location.assign('/'); }
  }));
}

function renderPath(p, status) {
  const card = el('li', 'path-card');
  const bar = el('progress');
  bar.max = p.steps;
  bar.setAttribute('aria-label', `${p.title} progress`);
  const meta = el('p', 'path-card__meta');
  const btn = el('button', 'btn btn--ghost btn--sm');
  btn.type = 'button';

  const paint = () => {
    bar.value = p.done;
    meta.textContent = `${p.done} of ${p.steps} steps done`;
    btn.textContent = p.done >= p.steps ? 'Completed' : 'Mark next step done';
    btn.disabled = p.done >= p.steps;
  };
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      p.done = (await api('/progress', { method: 'POST', body: { pathId: p.id } })).done;
      status.textContent = `${p.title}: ${p.done} of ${p.steps} steps saved.`;
    } catch (err) {
      status.textContent = err.message;
    }
    paint();
  });

  paint();
  card.append(el('span', `badge badge--${p.level.toLowerCase()}`, p.level), el('h3', '', p.title), bar, meta, btn);
  return card;
}

const pages = {
  login() {
    bindForm('login-form', async (data) => { await api('/login', { method: 'POST', body: data }); location.assign('/dashboard.html'); });
  },
  signup() {
    bindForm('signup-form', async (data) => { await api('/signup', { method: 'POST', body: data }); location.assign('/dashboard.html'); });
  },
  async dashboard() {
    const status = $('#dash-status');
    try {
      const [{ user }, { paths }] = await Promise.all([api('/me'), api('/paths')]);
      $('[data-username]').textContent = user.username;
      $('#dash-paths').append(...paths.map((p) => renderPath(p, status)));
    } catch (err) {
      if (err.status === 401) return location.assign('/login.html');
      status.textContent = err.message;
    }
  },
  async settings() {
    let user;
    try { ({ user } = await api('/me')); } catch { return location.assign('/login.html'); }
    const profile = document.getElementById('profile-form');
    profile.elements.username.value = user.username;
    profile.elements.email.value = user.email;

    bindForm('profile-form', async (data, form) => {
      await api('/me', { method: 'PATCH', body: data });
      form.elements.password.value = '';
      return 'Profile saved.';
    });
    bindForm('password-form', async (data, form) => {
      await api('/me/password', { method: 'POST', body: data });
      form.reset();
      return 'Password changed. Your other devices were logged out.';
    });
    bindForm('delete-form', async (data) => {
      await api('/me', { method: 'DELETE', body: { password: data.password } });
      location.assign('/');
    });
  },
};

document.addEventListener('DOMContentLoaded', () => {
  syncNav();
  bindLogout();
  const init = pages[document.body.dataset.page];
  if (init) init();
});
})();
