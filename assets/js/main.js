/* TaskHive — site interactions
   Vanilla JS, no dependencies. Every enhancement degrades gracefully. */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $  = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

  /* ---------------------------------------------------------------- Header */
  function initHeader() {
    var header = $('.site-header');
    if (!header) return;
    var onScroll = function () {
      header.classList.toggle('is-stuck', window.scrollY > 8);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ------------------------------------------------------- Mobile drawer */
  function initDrawer() {
    var toggle = $('.nav__toggle');
    var drawer = $('.nav__drawer');
    if (!toggle || !drawer) return;

    var setOpen = function (open) {
      toggle.setAttribute('aria-expanded', String(open));
      drawer.classList.toggle('is-open', open);
      document.body.classList.toggle('nav-open', open);
    };

    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });

    drawer.addEventListener('click', function (e) {
      if (e.target.closest('a')) setOpen(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setOpen(false);
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 1024) setOpen(false);
    });
  }

  /* ------------------------------------------------- Active nav highlight */
  function initActiveNav() {
    var path = window.location.pathname.replace(/\/$/, '');
    var page = path.split('/').pop() || 'index.html';

    $$('.nav__link[href]').forEach(function (link) {
      var href = link.getAttribute('href');
      if (!href || href.charAt(0) === '#' || /^https?:/.test(href)) return;
      var target = href.split('/').pop().split('#')[0] || 'index.html';
      if (target === page) link.setAttribute('aria-current', 'page');
    });
  }

  /* ------------------------------------------------------------ Dropdown */
  function initDropdowns() {
    $$('.nav__item--has-menu').forEach(function (item) {
      var trigger = $('.nav__link', item);
      var menu = $('.dropdown', item);
      if (!trigger || !menu) return;

      trigger.setAttribute('aria-expanded', 'false');

      trigger.addEventListener('click', function (e) {
        // On touch/pointer devices the hover state never fires — toggle instead.
        if (window.matchMedia('(hover: hover)').matches) return;
        e.preventDefault();
        var open = menu.classList.toggle('is-open');
        trigger.setAttribute('aria-expanded', String(open));
      });

      item.addEventListener('mouseenter', function () { trigger.setAttribute('aria-expanded', 'true'); });
      item.addEventListener('mouseleave', function () {
        trigger.setAttribute('aria-expanded', 'false');
        menu.classList.remove('is-open');
      });

      document.addEventListener('click', function (e) {
        if (!item.contains(e.target)) {
          menu.classList.remove('is-open');
          trigger.setAttribute('aria-expanded', 'false');
        }
      });
    });
  }

  /* ----------------------------------------------------------- Accordion */
  function initAccordion() {
    $$('.accordion').forEach(function (acc) {
      var single = acc.dataset.single === 'true';

      $$('.acc-trigger', acc).forEach(function (trigger) {
        var item = trigger.closest('.acc-item');
        var panel = $('.acc-panel', item);
        if (!panel) return;

        trigger.setAttribute('aria-expanded', String(item.classList.contains('is-open')));

        trigger.addEventListener('click', function () {
          var willOpen = !item.classList.contains('is-open');

          if (single && willOpen) {
            $$('.acc-item.is-open', acc).forEach(function (other) {
              other.classList.remove('is-open');
              var t = $('.acc-trigger', other);
              if (t) t.setAttribute('aria-expanded', 'false');
            });
          }

          item.classList.toggle('is-open', willOpen);
          trigger.setAttribute('aria-expanded', String(willOpen));
        });
      });
    });
  }

  /* ------------------------------------------------------ Pricing toggle */
  function initBillingToggle() {
    var toggle = $('.billing-toggle');
    if (!toggle) return;

    var buttons = $$('button', toggle);
    var apply = function (mode) {
      buttons.forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.dataset.billing === mode));
      });
      $$('[data-price-monthly]').forEach(function (el) {
        el.textContent = mode === 'annual' ? el.dataset.priceAnnual : el.dataset.priceMonthly;
      });
      $$('[data-period]').forEach(function (el) {
        el.textContent = mode === 'annual' ? 'per month, billed annually' : 'per month, rolling';
      });
    };

    buttons.forEach(function (b) {
      b.addEventListener('click', function () { apply(b.dataset.billing); });
    });
    apply('monthly');
  }

  /* ---------------------------------------------------------------- Tabs */
  function initTabs() {
    $$('.tabs').forEach(function (tabs) {
      var buttons = $$('.tabs__btn', tabs);
      var panels = $$('.tabs__panel', tabs);
      if (!buttons.length) return;

      var select = function (index) {
        buttons.forEach(function (b, i) {
          b.setAttribute('aria-selected', String(i === index));
          b.tabIndex = i === index ? 0 : -1;
        });
        panels.forEach(function (p, i) { p.hidden = i !== index; });
      };

      buttons.forEach(function (b, i) {
        b.addEventListener('click', function () { select(i); });
        b.addEventListener('keydown', function (e) {
          var next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
          if (next === null) return;
          e.preventDefault();
          next = (next + buttons.length) % buttons.length;
          buttons[next].focus();
          select(next);
        });
      });

      select(0);
    });
  }

  /* -------------------------------------------------------- Scroll reveal */
  function initReveal() {
    var items = $$('.reveal');
    if (!items.length) return;

    if (reduceMotion || !('IntersectionObserver' in window)) {
      items.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }

    var show = function (el) {
      el.classList.add('is-visible');
      io.unobserve(el);
    };

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) show(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

    items.forEach(function (el) { io.observe(el); });

    // Safety net: a fast scroll (End key, scrollbar drag, anchor jump) can carry
    // an element from below the viewport to above it between two frames, which
    // never crosses a threshold and so never fires the observer. Sweep anything
    // that is already at or past the fold.
    var ticking = false;
    var sweep = function () {
      ticking = false;
      var fold = window.innerHeight * 0.92;
      items.forEach(function (el) {
        if (!el.classList.contains('is-visible') && el.getBoundingClientRect().top < fold) show(el);
      });
    };
    var onScroll = function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(sweep);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
  }

  /* ------------------------------------------------------ Number counters */
  function initCounters() {
    var counters = $$('[data-count-to]');
    if (!counters.length) return;

    var run = function (el) {
      var to = parseFloat(el.dataset.countTo);
      var decimals = (el.dataset.countTo.split('.')[1] || '').length;
      var prefix = el.dataset.countPrefix || '';
      var suffix = el.dataset.countSuffix || '';

      var fmt = function (n) {
        return n.toLocaleString('en-GB', {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals
        });
      };

      if (reduceMotion) {
        el.textContent = prefix + fmt(to) + suffix;
        return;
      }

      var start = null;
      var duration = 1400;
      var step = function (ts) {
        if (start === null) start = ts;
        var p = Math.min((ts - start) / duration, 1);
        var eased = 1 - Math.pow(1 - p, 3);
        el.textContent = prefix + fmt(to * eased) + suffix;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };

    if (!('IntersectionObserver' in window)) {
      counters.forEach(run);
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        run(entry.target);
        io.unobserve(entry.target);
      });
    }, { threshold: 0.4 });

    counters.forEach(function (el) { io.observe(el); });
  }

  /* --------------------------------------------- Hero task tick animation */
  function initHeroTasks() {
    var tasks = $$('.board .task');
    if (!tasks.length || reduceMotion) return;

    var pending = tasks.filter(function (t) { return !t.classList.contains('is-done'); });
    if (!pending.length) return;

    var i = 0;
    var tick = function () {
      if (i >= pending.length) return;
      pending[i].classList.add('is-done');
      i += 1;
      setTimeout(tick, 1600);
    };
    setTimeout(tick, 2200);
  }

  /* ---------------------------------------------------------------- Forms */
  function initForms() {
    $$('form[data-demo-form]').forEach(function (form) {
      var status = $('.form-status', form);

      form.addEventListener('submit', function (e) {
        e.preventDefault();

        if (!form.checkValidity()) {
          form.reportValidity();
          return;
        }

        var name = (form.elements.firstName && form.elements.firstName.value.trim()) || 'there';
        var submit = $('[type="submit"]', form);

        if (submit) {
          submit.disabled = true;
          submit.dataset.label = submit.textContent;
          submit.textContent = 'Sending…';
        }

        window.setTimeout(function () {
          if (status) {
            status.hidden = false;
            status.textContent = 'Thanks, ' + name + ' — your enquiry is in. A TaskHive matcher will be in touch within one working day.';
            status.setAttribute('role', 'status');
          }
          form.reset();
          if (submit) {
            submit.disabled = false;
            submit.textContent = submit.dataset.label;
          }
          if (status) status.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
        }, 700);
      });
    });
  }

  /* ------------------------------------------------------------ Footer yr */
  function initYear() {
    $$('[data-year]').forEach(function (el) {
      el.textContent = String(new Date().getFullYear());
    });
  }

  /* ----------------------------------------------------------------- Boot */
  function boot() {
    initHeader();
    initDrawer();
    initActiveNav();
    initDropdowns();
    initAccordion();
    initBillingToggle();
    initTabs();
    initReveal();
    initCounters();
    initHeroTasks();
    initForms();
    initYear();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
