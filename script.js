// Loaded in <head> without defer so the "js" class exists before first paint.
document.documentElement.classList.add('js');

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// Each feature is isolated: if one throws, the rest of the page still works.
const safe = (fn) => {
  try { fn(); } catch (err) { console.error(`[${fn.name}] failed:`, err); }
};

/* Mobile menu: toggle, Escape to close, closes after choosing a link */
function initMobileNav() {
  const btn = $('.nav-toggle');
  const nav = $('#site-nav');
  if (!btn || !nav) return;

  const setOpen = (open) => {
    nav.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  };

  btn.addEventListener('click', () => setOpen(btn.getAttribute('aria-expanded') !== 'true'));
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('is-open')) { setOpen(false); btn.focus(); }
  });
  // Reset state when resizing up to the desktop layout.
  window.matchMedia('(min-width: 900px)').addEventListener('change', (e) => { if (e.matches) setOpen(false); });
}

/* Dropdowns: disclosure pattern (button + panel), not role="menu" */
function initDropdowns() {
  const dropdowns = $$('.dropdown');
  const close = (d) => {
    $('.dropdown__btn', d).setAttribute('aria-expanded', 'false');
    $('.dropdown__panel', d).hidden = true;
  };

  dropdowns.forEach((d) => {
    const btn = $('.dropdown__btn', d);
    const panel = $('.dropdown__panel', d);

    btn.addEventListener('click', () => {
      const wasOpen = btn.getAttribute('aria-expanded') === 'true';
      dropdowns.forEach(close);
      if (!wasOpen) { btn.setAttribute('aria-expanded', 'true'); panel.hidden = false; }
    });
    d.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(d); btn.focus(); } });
    d.addEventListener('focusout', (e) => { if (!d.contains(e.relatedTarget)) close(d); });
    panel.addEventListener('click', (e) => { if (e.target.closest('a')) close(d); });
  });

  document.addEventListener('click', (e) => dropdowns.forEach((d) => { if (!d.contains(e.target)) close(d); }));
}

/* Active nav link: highlights the section currently in the middle of the viewport */
function initScrollSpy() {
  const links = $$('.nav a[href^="#"]:not(.btn)');
  const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      links.forEach((a) => a.removeAttribute('aria-current'));
      const active = byId.get(entry.target.id);
      if (active) active.setAttribute('aria-current', 'true');
    });
  }, { rootMargin: '-45% 0px -50% 0px' });

  byId.forEach((_, id) => {
    const section = document.getElementById(id);
    if (section) observer.observe(section);
  });
}

/* Path filters: two groups combined with AND; results announced politely */
function initPathFilters() {
  const root = $('[data-paths]');
  if (!root) return;
  const cards = $$('.path-card', root);
  const count = $('#path-count');
  const empty = $('#path-empty');
  const state = { level: 'all', role: 'all' };

  const apply = () => {
    let visible = 0;
    cards.forEach((card) => {
      const matchesLevel = state.level === 'all' || card.dataset.level === state.level;
      const matchesRole = state.role === 'all' || card.dataset.roles.split(' ').includes(state.role);
      card.hidden = !(matchesLevel && matchesRole);
      if (!card.hidden) visible += 1;
    });
    count.textContent = `Showing ${visible} of ${cards.length} paths`;
    empty.hidden = visible > 0;
  };

  $$('.chip', root).forEach((chip) => {
    chip.addEventListener('click', () => {
      const { group, value } = chip.dataset;
      state[group] = value;
      $$(`.chip[data-group="${group}"]`, root).forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
      apply();
    });
  });
  apply();
}

/* Tabs: roving tabindex, Arrow/Home/End keys, automatic activation */
function initTabs() {
  const list = $('[role="tablist"]');
  if (!list) return;
  const tabs = $$('[role="tab"]', list);
  const panels = tabs.map((t) => document.getElementById(t.getAttribute('aria-controls')));

  const select = (index, moveFocus = false) => {
    tabs.forEach((tab, i) => {
      const on = i === index;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      panels[i].hidden = !on;
    });
    if (moveFocus) tabs[index].focus();
  };

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => select(i));
    tab.addEventListener('keydown', (e) => {
      const target = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (target === undefined) return;
      e.preventDefault();
      select((target + tabs.length) % tabs.length, true);
    });
  });
  select(0); // Without JS every panel stays visible and the tab buttons are hidden by CSS.
}

/* FAQ: native <details> (works without JS); JS only keeps one item open at a time */
function initFaq() {
  const items = $$('.faq details');
  items.forEach((item) => item.addEventListener('toggle', () => {
    if (item.open) items.forEach((other) => { if (other !== item) other.open = false; });
  }));
}

/* Scroll reveal: runs once per element, then stops observing */
function initReveal() {
  const els = $$('.reveal');
  if (!('IntersectionObserver' in window) || reducedMotion.matches) {
    els.forEach((el) => el.classList.add('is-visible'));
    return;
  }
  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      obs.unobserve(entry.target);
    });
  }, { threshold: 0.15 });
  els.forEach((el) => observer.observe(el));
}

/* Testimonials marquee: clones are hidden from assistive tech; pause control (WCAG 2.2.2) */
function initMarquee() {
  const track = $('.marquee__track');
  const btn = $('.marquee__ctl');
  if (!track) return;

  $$('.t-card', track).forEach((card) => {
    const clone = card.cloneNode(true);
    clone.dataset.clone = '';
    clone.setAttribute('aria-hidden', 'true');
    track.append(clone);
  });

  if (!btn) return;
  btn.addEventListener('click', () => {
    const paused = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(paused));
    btn.textContent = paused ? 'Play' : 'Pause';
    track.classList.toggle('is-paused', paused);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  [initMobileNav, initDropdowns, initScrollSpy, initPathFilters, initTabs, initFaq, initReveal, initMarquee].forEach(safe);
});
