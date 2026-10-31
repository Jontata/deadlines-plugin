import { createViews } from './views.js';

(function () {
  var REFRESH_MS = 10000;
  var lastSignature = '';

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function setStatus(msg) {
    document.getElementById('status').textContent = msg;
  }

  function openTask(id) {
    var api = window.PluginAPI;
    if (api && typeof api.selectTask === 'function') {
      Promise.resolve(api.selectTask(id)).catch(function (e) {
        setStatus('Could not open the task: ' + ((e && e.message) || e));
      });
    }
  }

  function renderList(key, items, emptyText) {
    document.getElementById('count-' + key).textContent = String(items.length);
    var nodes = items.map(function (it) {
      var li = el('li', 'task' + (it.urgency ? ' ' + it.urgency : ''));
      li.dataset.taskId = it.id;
      li.dataset.kind = it.kind || '';
      var main = el('div', 'main');
      var title = el('button', 'title', it.title);
      title.type = 'button';
      title.title = 'Open task details';
      title.addEventListener('click', function () { openTask(it.id); });
      main.appendChild(title);
      var meta = el('div', 'meta');
      if (it.project) meta.appendChild(projectTag(it.project, it.projectColor));
      var bits = [];
      if (it.parentTitle) bits.push('↳ ' + it.parentTitle);
      if (it.subtasksTotal) bits.push(it.subtasksDone + '/' + it.subtasksTotal + ' subtasks');
      if (bits.length) meta.appendChild(document.createTextNode((it.project ? ' · ' : '') + bits.join(' · ')));
      if (meta.childNodes.length) main.appendChild(meta);
      if (it.subtasks && it.subtasks.length) main.appendChild(renderSubtasks(it.subtasks));
      li.appendChild(main);
      if (it.when) {
        var when = el('div', 'when');
        when.appendChild(el('span', 'date', it.when));
        when.appendChild(el('span', 'rel', it.relative));
        li.appendChild(when);
      }
      return li;
    });
    if (!nodes.length) nodes = [el('li', 'empty', emptyText)];
    var list = document.getElementById('list-' + key);
    list.replaceChildren.apply(list, nodes);
  }

  function projectTag(name, color) {
    var tag = el('span', 'proj');
    var dot = el('span', 'dot');
    dot.style.setProperty('--proj', color);
    tag.appendChild(dot);
    tag.appendChild(document.createTextNode(name));
    return tag;
  }

  function renderSubtasks(subtasks) {
    var ul = el('ul', 'subs');
    subtasks.forEach(function (s) {
      var row = el('li', s.urgency || '');
      row.dataset.taskId = s.id;
      row.dataset.kind = '';
      var title = el('button', 'sub-title', s.title);
      title.type = 'button';
      title.title = 'Open task details';
      title.addEventListener('click', function () { openTask(s.id); });
      row.appendChild(title);
      if (s.when) row.appendChild(el('span', 'rel', s.when + ' · ' + s.relative));
      ul.appendChild(row);
    });
    return ul;
  }

  function eventsVisible() {
    return settings.showEvents && settings.eventTags.length > 0;
  }

  function render(view) {
    document.getElementById('section-dates').hidden = !eventsVisible();
    document.getElementById('legend-event').hidden = !eventsVisible();
    Array.prototype.forEach.call(document.querySelectorAll('[data-soon-label]'), function (node) {
      node.textContent = DeadlinesLogic.soonLabel(settings.soonDays);
    });
    renderList('deadline', view.withDeadline, 'No open tasks with a deadline.');
    renderList('none', view.noDeadline, 'No open tasks without a deadline.');
    renderList('dates', view.dates, 'No upcoming events.');
    renderCalendar();
    renderTimeline();
  }

  // Libraries retain their DOM and navigation state between data refreshes.
  var VIEW_KEY = 'deadlines-plugin.view';
  var lastView = null;
  var displays = createViews({
    logic: DeadlinesLogic,
    openTask: function (id) {
      if (performance.now() >= ignoreTaskClickUntil) openTask(id);
    },
    projectTag: projectTag,
    setLabel: function (label) { document.getElementById('month-label').textContent = label; },
  });

  function renderCalendar() {
    if (lastView && currentView === 'calendar') displays.calendar(lastView, settings);
  }

  function renderTimeline() {
    if (lastView && currentView === 'timeline') displays.timeline(lastView, settings, lastData[1]);
  }

  Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (btn) {
    btn.addEventListener('click', function () {
      changeSetting('timelineRange', btn.getAttribute('data-range'));
    });
  });

  // ---- Views ----
  var VIEWS = ['list', 'calendar', 'timeline'];
  var currentView = 'list';

  function setView(name) {
    if (VIEWS.indexOf(name) < 0) name = 'list';
    currentView = name;
    document.getElementById('view-list').hidden = name !== 'list';
    document.getElementById('view-calendar').hidden = name !== 'calendar';
    document.getElementById('view-timeline').hidden = name !== 'timeline';
    document.getElementById('cal-nav').hidden = name === 'list';
    VIEWS.forEach(function (v) {
      document.getElementById('tab-' + v).setAttribute('aria-selected', String(v === name));
    });
    try { localStorage.setItem(VIEW_KEY, name); } catch (e) { /* storage blocked */ }
    if (name === 'calendar') renderCalendar();
    if (name === 'timeline') renderTimeline();
  }

  function shiftPeriod(n, jump) {
    displays.shift(currentView, n, jump);
  }

  function resetPeriod() {
    displays.today(currentView);
  }

  VIEWS.forEach(function (v) {
    document.getElementById('tab-' + v).addEventListener('click', function () { setView(v); });
  });
  document.getElementById('prev-month').addEventListener('click', function () { shiftPeriod(-1, true); });
  document.getElementById('next-month').addEventListener('click', function () { shiftPeriod(1, true); });
  document.getElementById('this-month').addEventListener('click', resetPeriod);
  var savedView = null;
  try { savedView = localStorage.getItem(VIEW_KEY); } catch (e) { /* storage blocked */ }


  // ---- Settings (gear menu) ----
  // Saved with SP's plugin storage so they sync; localStorage is the fallback.
  var SETTINGS_KEY = 'settings';
  var LOCAL_SETTINGS_KEY = 'deadlines-plugin.settings';
  var settings = DeadlinesLogic.withDefaults(null);
  var lastData = null; // [tasks, projects, tags] from the last load
  var saveTimer = null;
  var tagOptionsKey = null;

  var form = {
    subtaskDeadlines: document.getElementById('opt-subtask-deadlines'),
    nestSubtasks: document.getElementById('opt-nest-subtasks'),
    soonDays: document.getElementById('opt-soon-days'),
    showEvents: document.getElementById('opt-show-events'),
    eventTags: document.getElementById('opt-event-tags'),
    weekStart: document.querySelectorAll('input[name="opt-week-start"]'),
    projectColors: document.querySelectorAll('input[name="opt-project-colors"]'),
    dateFormat: document.getElementById('opt-date-format'),
  };
  var gear = document.getElementById('settings-btn');
  var panel = document.getElementById('settings');

  async function loadSettings() {
    var raw = null;
    var api = window.PluginAPI;
    try {
      if (api && typeof api.loadSyncedData === 'function') raw = await api.loadSyncedData(SETTINGS_KEY);
    } catch (e) { /* fall back to localStorage */ }
    if (!raw) {
      try { raw = localStorage.getItem(LOCAL_SETTINGS_KEY); } catch (e) { /* storage blocked */ }
    }
    try {
      settings = DeadlinesLogic.withDefaults(raw ? JSON.parse(raw) : null);
    } catch (e) {
      settings = DeadlinesLogic.withDefaults(null);
    }
  }

  // Debounced: SP rate-limits plugin data writes.
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var raw = JSON.stringify(settings);
      try { localStorage.setItem(LOCAL_SETTINGS_KEY, raw); } catch (e) { /* storage blocked */ }
      var api = window.PluginAPI;
      if (api && typeof api.persistDataSynced === 'function') {
        Promise.resolve(api.persistDataSynced(raw, SETTINGS_KEY)).catch(function (e) {
          setStatus('Could not save settings: ' + ((e && e.message) || e));
        });
      }
    }, 400);
  }

  // Keep saved tags available if they are no longer in the project.
  function fillEventTags() {
    var seen = {};
    var titles = [];
    (lastData ? lastData[2] : []).forEach(function (t) {
      var title = String(t.title || '').trim();
      if (!title || t.id === 'TODAY' || seen[title.toLowerCase()]) return;
      seen[title.toLowerCase()] = true;
      titles.push(title);
    });
    titles.sort(function (a, b) { return a.localeCompare(b); });
    var missing = settings.eventTags.filter(function (t) { return !seen[t.toLowerCase()]; });
    var key = titles.join('|') + '#' + missing.join('|');
    if (key !== tagOptionsKey) {
      tagOptionsKey = key;
      var options = [el('option', null, 'No tag')];
      options[0].value = '';
      missing.concat(titles).forEach(function (title) {
        var option = el('option', null, title + (missing.indexOf(title) >= 0 ? ' (no such tag)' : ''));
        option.value = title;
        options.push(option);
      });
      form.eventTags.replaceChildren.apply(form.eventTags, options);
    }
    form.eventTags.value = settings.eventTags[0] || '';
  }

  function onEventTagsChange() {
    changeSetting('eventTags', form.eventTags.value ? [form.eventTags.value] : []);
  }

  function fillForm() {
    form.subtaskDeadlines.checked = settings.subtaskDeadlines;
    form.nestSubtasks.checked = settings.nestSubtasks;
    form.soonDays.value = String(settings.soonDays);
    setRadio(form.weekStart, String(settings.weekStart));
    setRadio(form.projectColors, settings.projectColors);
    form.dateFormat.value = settings.dateFormat;
    form.showEvents.checked = settings.showEvents;
    fillEventTags();
  }

  function changeSetting(key, value) {
    var next = {};
    Object.keys(settings).forEach(function (k) { next[k] = settings[k]; });
    next[key] = value;
    settings = DeadlinesLogic.withDefaults(next);
    saveSettings();
    recompute();
  }

  function setRadio(radios, value) {
    Array.prototype.forEach.call(radios, function (r) { r.checked = r.value === value; });
  }

  form.subtaskDeadlines.addEventListener('change', function () {
    changeSetting('subtaskDeadlines', form.subtaskDeadlines.checked);
  });
  form.nestSubtasks.addEventListener('change', function () {
    changeSetting('nestSubtasks', form.nestSubtasks.checked);
  });
  form.soonDays.addEventListener('input', function () {
    if (form.soonDays.value !== '') changeSetting('soonDays', form.soonDays.value);
  });
  form.soonDays.addEventListener('change', function () {
    form.soonDays.value = String(settings.soonDays); // show the clamped value
  });
  function stepSoonDays(delta) {
    changeSetting('soonDays', settings.soonDays + delta);
    form.soonDays.value = String(settings.soonDays);
  }
  document.getElementById('opt-soon-minus').addEventListener('click', function () { stepSoonDays(-1); });
  document.getElementById('opt-soon-plus').addEventListener('click', function () { stepSoonDays(1); });
  form.showEvents.addEventListener('change', function () { changeSetting('showEvents', form.showEvents.checked); });
  form.eventTags.addEventListener('change', onEventTagsChange);
  Array.prototype.forEach.call(form.weekStart, function (r) {
    r.addEventListener('change', function () { if (r.checked) changeSetting('weekStart', Number(r.value)); });
  });
  Array.prototype.forEach.call(form.projectColors, function (r) {
    r.addEventListener('change', function () { if (r.checked) changeSetting('projectColors', r.value); });
  });
  form.dateFormat.addEventListener('change', function () { changeSetting('dateFormat', form.dateFormat.value); });
  document.getElementById('opt-reset').addEventListener('click', function () {
    settings = DeadlinesLogic.withDefaults(null);
    fillForm();
    saveSettings();
    recompute();
  });

  // The settings pop-out is a native <dialog>: Esc closes it, and so does a click on the
  // dimmed backdrop (the click then targets the dialog element itself).
  function setSettingsOpen(open) {
    if (open && !panel.open) {
      fillForm();
      panel.showModal();
    } else if (!open && panel.open) {
      panel.close();
    }
    gear.setAttribute('aria-expanded', String(panel.open));
  }
  gear.addEventListener('click', function () { setSettingsOpen(!panel.open); });
  document.getElementById('settings-close').addEventListener('click', function () { setSettingsOpen(false); });
  document.getElementById('settings-done').addEventListener('click', function () { setSettingsOpen(false); });
  panel.addEventListener('click', function (e) { if (e.target === panel) setSettingsOpen(false); });
  panel.addEventListener('close', function () {
    gear.setAttribute('aria-expanded', 'false');
    gear.focus();
  });

  // Native controls (selects, number input) follow SP's dark theme, and floating surfaces
  // get a solid base under the (possibly translucent) card colour.
  try {
    var dark = getComputedStyle(document.body).getPropertyValue('--is-dark-theme').trim() === '1';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    document.documentElement.style.setProperty('--surface-base', dark ? '#202124' : '#ffffff');
  } catch (e) { /* keep default */ }

  // Keyboard navigation supplements the libraries’ pointer and touch navigation.
  document.addEventListener('keydown', function (e) {
    if (currentView === 'list' || panel.open || menuEl || e.altKey || e.ctrlKey || e.metaKey) return;
    var tag = e.target && e.target.tagName;
    if (e.defaultPrevented || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.target.closest('.fc-popover') || (tag === 'BUTTON' && !e.target.closest('[data-task-id]'))) return;
    var moves = { ArrowRight: [1, false], ArrowLeft: [-1, false], PageDown: [1, true], PageUp: [-1, true] };
    var m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    shiftPeriod(m[0], m[1]);
  });

  // ---- Right-click menu (a lookalike of SP's task menu) ----
  // SP has no API for opening its own task menu from a plugin, so this one is built here.
  // Changes go through PluginAPI.updateTask, and each one can be undone from the toast.
  var ICONS = {
    today: 'M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z',
    tomorrow: 'M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z',
    nextWeek: 'M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z',
    pick: 'M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z',
    open: 'M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z',
    done: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    flag: 'M14.4 6 14 4H5v17h2v-7h5.6l.4 2h7V6z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z'
  };
  var menuEl = null;
  var toastTimer = null;

  function svgIcon(name) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.appendChild(path);
    return svg;
  }

  function findTask(id) {
    return lastData ? lastData[0].filter(function (t) { return t.id === id; })[0] || null : null;
  }

  function closeMenu() {
    if (menuEl) menuEl.remove();
    menuEl = null;
  }

  function showToast(text, onUndo) {
    var old = document.querySelector('.toast');
    if (old) old.remove();
    clearTimeout(toastTimer);
    var toast = el('div', 'toast');
    toast.setAttribute('role', 'status');
    toast.appendChild(el('span', null, text));
    if (onUndo) {
      var undo = el('button', null, 'Undo');
      undo.type = 'button';
      undo.addEventListener('click', function () {
        toast.remove();
        onUndo();
      });
      toast.appendChild(undo);
    }
    document.body.appendChild(toast);
    toastTimer = setTimeout(function () { toast.remove(); }, 8000);
  }

  function runAction(taskId, action, arg) {
    var task = findTask(taskId);
    var api = window.PluginAPI;
    closeMenu();
    if (!task || !api || typeof api.updateTask !== 'function') return;
    var change = DeadlinesLogic.taskUpdateFor(action, task, Date.now(), settings, arg);
    if (!change) return;
    Promise.resolve(api.updateTask(taskId, change.update)).then(function () {
      load();
      showToast(change.label, function () {
        Promise.resolve(api.updateTask(taskId, change.undo)).then(load).catch(function (e) {
          setStatus('Could not undo: ' + ((e && e.message) || e));
        });
      });
    }).catch(function (e) {
      setStatus('Could not update the task: ' + ((e && e.message) || e));
    });
  }

  function menuItem(icon, text, onClick) {
    var b = el('button', 'ctx-item');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.appendChild(svgIcon(icon));
    b.appendChild(el('span', null, text));
    b.addEventListener('click', onClick);
    return b;
  }

  // A small inline form under a menu item (pick a planned day, or a deadline and time).
  function menuForm(fields, onSubmit) {
    var form = el('form', 'ctx-form');
    var inputs = fields.map(function (f) {
      var input = document.createElement('input');
      input.type = f.type;
      input.value = f.value || '';
      input.setAttribute('aria-label', f.label);
      form.appendChild(input);
      return input;
    });
    var ok = el('button', 'primary-btn', 'Set');
    ok.type = 'submit';
    form.appendChild(ok);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      onSubmit(inputs.map(function (i) { return i.value; }));
    });
    setTimeout(function () {
      inputs[0].focus();
      try { if (inputs[0].showPicker) inputs[0].showPicker(); } catch (err) { /* needs a gesture */ }
    }, 0);
    return form;
  }

  function openMenu(taskId, kind, x, y) {
    var task = findTask(taskId);
    if (!task) return;
    closeMenu();
    var isEvent = kind === 'event';
    var today = DeadlinesLogic.dayKey(Date.now());
    var menu = el('div', 'ctx');
    menu.setAttribute('role', 'menu');
    menu.appendChild(el('div', 'ctx-title', task.title));

    if (!isEvent) {
      var quick = el('div', 'ctx-quick');
      [
        ['today', 'Today', 'today'],
        ['tomorrow', 'Tomorrow', 'tomorrow'],
        ['nextWeek', 'Next week', 'nextWeek'],
        ['pick', 'Pick date', null],
      ].forEach(function (q) {
        var b = el('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        if (q[0] === 'today' && task.dueDay === today) b.className = 'active';
        b.appendChild(svgIcon(q[0]));
        b.appendChild(el('span', null, q[1]));
        b.addEventListener('click', function () {
          if (q[2]) return runAction(taskId, q[2]);
          var existing = menu.querySelector('.ctx-form.plan');
          if (existing) return existing.remove();
          var f = menuForm([{ type: 'date', value: task.dueDay || today, label: 'Planned day' }], function (v) {
            runAction(taskId, 'pickDate', v[0]);
          });
          f.classList.add('plan');
          quick.after(f);
        });
        quick.appendChild(b);
      });
      menu.appendChild(quick);
    }

    menu.appendChild(menuItem('open', 'Open details', function () {
      closeMenu();
      openTask(taskId);
    }));
    menu.appendChild(menuItem('done', 'Mark as done', function () { runAction(taskId, 'done'); }));

    if (!isEvent) {
      menu.appendChild(el('div', 'ctx-sep'));
      var hasDeadline = task.deadlineDay || task.deadlineWithTime;
      var deadlineItem = menuItem('flag', hasDeadline ? 'Change deadline…' : 'Set deadline…', function () {
        var existing = menu.querySelector('.ctx-form.deadline');
        if (existing) return existing.remove();
        var d = task.deadlineWithTime ? new Date(task.deadlineWithTime) : null;
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        var f = menuForm([
          { type: 'date', label: 'Deadline day',
            value: d ? DeadlinesLogic.dayKey(d.getTime()) : (task.deadlineDay || '') },
          { type: 'time', label: 'Deadline time (optional)',
            value: d ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : '' },
        ], function (v) { runAction(taskId, 'setDeadline', { date: v[0], time: v[1] }); });
        f.classList.add('deadline');
        deadlineItem.after(f);
      });
      menu.appendChild(deadlineItem);
      if (hasDeadline) {
        menu.appendChild(menuItem('close', 'Remove deadline', function () { runAction(taskId, 'removeDeadline'); }));
      }
      if (task.dueDay || task.dueWithTime) {
        menu.appendChild(menuItem('close', 'Remove planned day', function () { runAction(taskId, 'unplan'); }));
      }
    }

    document.body.appendChild(menu);
    menuEl = menu;
    // Keep it on screen: flip left/up near the edges.
    var w = menu.offsetWidth;
    var h = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + 'px';
    menu.style.top = Math.max(8, y + h > window.innerHeight - 8 ? y - h : y) + 'px';
    var first = menu.querySelector('button');
    if (first) first.focus();
  }

  document.addEventListener('contextmenu', function (e) {
    var target = e.target.closest && e.target.closest('[data-task-id]');
    if (!target) return;
    e.preventDefault();
    openMenu(target.dataset.taskId, target.dataset.kind, e.clientX, e.clientY);
  });
  // A deliberate hold opens actions; moving the finger cancels it so views can pan.
  var press = null;
  var heldPointer = null;
  var ignoreTaskClickUntil = 0;
  function cancelPress() {
    if (press) clearTimeout(press.timer);
    press = null;
  }
  document.addEventListener('pointerdown', function (e) {
    cancelPress();
    if (heldPointer == null) ignoreTaskClickUntil = 0;
    if (e.pointerType === 'mouse' || !e.isPrimary) return;
    var target = e.target.closest('[data-task-id]');
    if (!target) return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY };
    press.timer = setTimeout(function () {
      heldPointer = e.pointerId;
      ignoreTaskClickUntil = Infinity;
      openMenu(target.dataset.taskId, target.dataset.kind, e.clientX, e.clientY);
      cancelPress();
    }, 550);
  });
  document.addEventListener('pointermove', function (e) {
    if (press && (e.pointerId !== press.id || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10)) cancelPress();
  });
  function endPress(e) {
    cancelPress();
    if (e.pointerId === heldPointer) {
      heldPointer = null;
      ignoreTaskClickUntil = performance.now() + 600;
    }
  }
  document.addEventListener('pointerup', endPress);
  document.addEventListener('pointercancel', endPress);
  document.addEventListener('click', function (e) {
    if (performance.now() >= ignoreTaskClickUntil || !e.target.closest('[data-task-id]')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  document.addEventListener('pointerdown', function (e) {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (menuEl && e.key === 'Escape') {
      closeMenu();
      return;
    }
    // Keyboard users: the menu key or Shift+F10 on a focused task.
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      var target = document.activeElement && document.activeElement.closest('[data-task-id]');
      if (!target) return;
      e.preventDefault();
      var r = target.getBoundingClientRect();
      openMenu(target.dataset.taskId, target.dataset.kind, r.left + 12, r.bottom);
    }
  });
  // No close on window blur: the native date picker can blur the page while it's open.
  // Only width changes close it, so a phone keyboard (height only) doesn't.
  var menuWidth = window.innerWidth;
  window.addEventListener('resize', function () {
    if (window.innerWidth !== menuWidth) closeMenu();
    menuWidth = window.innerWidth;
  });
  window.addEventListener('scroll', closeMenu, true);

  // ---- Data ----
  function recompute() {
    if (!lastData) return;
    var now = Date.now();
    var view = DeadlinesLogic.buildView(lastData[0], lastData[1], lastData[2], now, settings);
    // Today's date is included so the today marker moves at midnight even when nothing else changes.
    var signature = DeadlinesLogic.dayKey(now) + JSON.stringify(settings) + JSON.stringify(view);
    if (signature === lastSignature) return;
    lastSignature = signature;
    lastView = view;
    render(view);
  }

  async function load() {
    try {
      var api = window.PluginAPI;
      if (!api || typeof api.getTasks !== 'function') {
        throw new Error('PluginAPI is missing. Open this view from inside Super Productivity.');
      }
      var data = await Promise.all([api.getTasks(), api.getAllProjects(), api.getAllTags()]);
      lastData = [data[0] || [], data[1] || [], data[2] || []];
      fillEventTags();
      recompute();
      setStatus('');
    } catch (e) {
      setStatus('Could not load tasks: ' + ((e && e.message) || e));
    }
  }

  loadSettings().then(function () {
    fillForm();
    setView(savedView);
    load();
    setInterval(load, REFRESH_MS);
    window.addEventListener('focus', load);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) load();
    });
  });
})();
