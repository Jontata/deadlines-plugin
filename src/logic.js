var DeadlinesLogic = (function () {
  var DAY_MS = 24 * 60 * 60 * 1000;
  // User settings (gear menu). buildView falls back to these.
  var DEFAULT_OPTIONS = {
    subtaskDeadlines: true, // subtasks with their own deadline get a row and a calendar chip
    nestSubtasks: false, // list open subtasks under their task in the List view
    soonDays: 7, // deadlines this many days ahead or fewer count as "soon"
    showEvents: true, // false hides event-tagged tasks and the Dates column
    eventTags: ['fixed'], // titles of the tags that mark events (fixed-time items); empty = no events
    weekStart: 1, // 1 = Monday, 0 = Sunday
    projectColors: 'auto', // 'auto' = distinct palette, 'theme' = each project's SP theme colour
    dateFormat: 'weekday-day-month', // one of DATE_FORMATS
    timelineRange: '3m', // one of TIMELINE_RANGES
  };

  // Examples for Wed 18 Nov 2026. Numeric formats pad with zeros.
  var DATE_FORMATS = [
    'weekday-day-month', // Wed 18 Nov
    'day-month', // 18 Nov
    'weekday-dd/mm', // Wed 18/11
    'dd/mm', // 18/11
    'mm/dd', // 11/18
    'iso', // 2026-11-18
  ];

  // Distinct, readable on light and dark. No orange or red: those mean "soon" and "overdue".
  var PROJECT_PALETTE = ['#4e79a7', '#2a9d8f', '#8e6cc2', '#59a14f', '#d16ba5',
    '#9c755f', '#00a5cf', '#8a9a3b', '#607d8b'];
  var INBOX_COLOR = '#9e9e9e';

  function withDefaults(opts) {
    var o = {};
    Object.keys(DEFAULT_OPTIONS).forEach(function (k) {
      o[k] = opts && opts[k] != null ? opts[k] : DEFAULT_OPTIONS[k];
    });
    o.subtaskDeadlines = !!o.subtaskDeadlines;
    o.nestSubtasks = !!o.nestSubtasks;
    var soon = Math.round(Number(o.soonDays));
    o.soonDays = isFinite(soon) ? Math.min(60, Math.max(0, soon)) : DEFAULT_OPTIONS.soonDays;
    o.showEvents = !!o.showEvents;
    var tagsIn = o.eventTags;
    if (opts && opts.eventTags == null && opts.eventTag != null) {
      // Older settings stored a single eventTag string.
      tagsIn = String(opts.eventTag).trim() ? [opts.eventTag] : DEFAULT_OPTIONS.eventTags;
    }
    if (!Array.isArray(tagsIn)) tagsIn = DEFAULT_OPTIONS.eventTags;
    var seenTags = {};
    o.eventTags = [];
    tagsIn.forEach(function (t) {
      var title = String(t == null ? '' : t).trim();
      if (title && !seenTags[title.toLowerCase()]) {
        seenTags[title.toLowerCase()] = true;
        o.eventTags.push(title);
      }
    });
    o.weekStart = Number(o.weekStart) === 0 ? 0 : 1;
    o.projectColors = o.projectColors === 'theme' ? 'theme' : 'auto';
    if (DATE_FORMATS.indexOf(o.dateFormat) < 0) o.dateFormat = DEFAULT_OPTIONS.dateFormat;
    // The `event` tag was renamed to `fixed` on 2026-10-30 (shared with AutoPlan).
    if (o.eventTags.length === 1 && o.eventTags[0].toLowerCase() === 'event') o.eventTags = ['fixed'];
    if (!TIMELINE_RANGES[o.timelineRange]) o.timelineRange = DEFAULT_OPTIONS.timelineRange;
    return o;
  }

  function startOfDay(ms) {
    var d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  // 'YYYY-MM-DD' in the user's local calendar.
  function parseDay(str) {
    var p = String(str).split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]).getTime();
  }

  function deadlineOf(task) {
    if (task.deadlineWithTime) return { ms: task.deadlineWithTime, hasTime: true };
    if (task.deadlineDay) return { ms: parseDay(task.deadlineDay), hasTime: false };
    return null;
  }

  function plannedOf(task) {
    if (task.dueWithTime) return { ms: task.dueWithTime, hasTime: true };
    if (task.dueDay) return { ms: parseDay(task.dueDay), hasTime: false };
    return null;
  }

  // Math.round absorbs the 23h/25h days around DST changes.
  function daysBetween(fromMs, toMs) {
    return Math.round((startOfDay(toMs) - startOfDay(fromMs)) / DAY_MS);
  }

  // A date-only moment lasts until the end of its day.
  function isPast(moment, now) {
    return moment.hasTime ? moment.ms < now : startOfDay(moment.ms) < startOfDay(now);
  }

  // Sort key: date-only moments sort after timed ones on the same day.
  function sortKey(moment) {
    return moment.hasTime ? moment.ms : startOfDay(moment.ms) + DAY_MS - 1;
  }

  // kind: 'deadline' (past = overdue) or 'event' (past = ago).
  function relative(moment, now, kind) {
    var days = daysBetween(now, moment.ms);
    if (isPast(moment, now)) {
      if (days === 0) return kind === 'event' ? 'earlier today' : 'overdue';
      return -days + (days === -1 ? ' day ' : ' days ') + (kind === 'event' ? 'ago' : 'overdue');
    }
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    return 'in ' + days + ' days';
  }

  function urgency(moment, now, soonDays) {
    if (isPast(moment, now)) return 'overdue';
    return daysBetween(now, moment.ms) <= soonDays ? 'soon' : 'later';
  }

  // Legend text for the "soon" colour, following the setting.
  function soonLabel(soonDays) {
    if (soonDays <= 0) return 'Due today';
    return 'Within ' + soonDays + (soonDays === 1 ? ' day' : ' days');
  }

  // Built by hand so the text doesn't depend on the engine's locale data.
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // The year is added only when it isn't the current one (ISO always has it).
  function formatDate(d, now, format) {
    var y = d.getFullYear();
    var otherYear = y !== new Date(now).getFullYear();
    var weekday = WEEKDAYS[d.getDay()];
    var day = d.getDate();
    var month = d.getMonth() + 1;
    switch (format) {
      case 'day-month':
        return day + ' ' + MONTHS[month - 1] + (otherYear ? ' ' + y : '');
      case 'weekday-dd/mm':
        return weekday + ' ' + pad(day) + '/' + pad(month) + (otherYear ? '/' + y : '');
      case 'dd/mm':
        return pad(day) + '/' + pad(month) + (otherYear ? '/' + y : '');
      case 'mm/dd':
        return pad(month) + '/' + pad(day) + (otherYear ? '/' + y : '');
      case 'iso':
        return y + '-' + pad(month) + '-' + pad(day);
      default: // 'weekday-day-month'
        return weekday + ' ' + day + ' ' + MONTHS[month - 1] + (otherYear ? ' ' + y : '');
    }
  }

  function formatMoment(moment, now, format) {
    var d = new Date(moment.ms);
    var s = formatDate(d, now, format);
    if (moment.hasTime) s += ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    return s;
  }

  var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  // Local calendar day as 'YYYY-MM-DD'.
  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function timeOf(moment) {
    if (!moment.hasTime) return null;
    var d = new Date(moment.ms);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function monthLabel(year, month) {
    return MONTHS_LONG[month] + ' ' + year;
  }

  // Weekday column headers. weekStart: 1 = Monday first, 0 = Sunday first.
  function weekdayNames(weekStart) {
    return WEEKDAYS.slice(weekStart).concat(WEEKDAYS.slice(0, weekStart));
  }

  // Local midnight n days after ms (DST-safe: built from date parts).
  function addDays(ms, n) {
    var d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
  }

  // Start of the week containing ms (weekStart: 1 = Monday, 0 = Sunday).
  function weekStartOf(ms, weekStart) {
    var first = weekStart === 0 ? 0 : 1;
    return addDays(new Date(ms).setHours(0, 0, 0, 0), -((new Date(ms).getDay() - first + 7) % 7));
  }

  // A rolling calendar: `weeks` whole weeks from startMs (a week start). The focus month
  // is the one with the most days on screen; it names the view, and other months' days
  // are dimmed. The 1st of each month is flagged so it can be labelled.
  function calendarWeeks(startMs, weeks, todayKey) {
    var counts = {};
    var days = [];
    for (var i = 0; i < weeks * 7; i++) {
      var d = new Date(addDays(startMs, i));
      var monthIndex = d.getFullYear() * 12 + d.getMonth();
      counts[monthIndex] = (counts[monthIndex] || 0) + 1;
      var key = dayKey(d.getTime());
      days.push({
        key: key,
        date: d.getDate(),
        monthShort: MONTHS[d.getMonth()],
        isMonthStart: d.getDate() === 1,
        isToday: key === todayKey,
        isWeekend: d.getDay() === 0 || d.getDay() === 6,
        _month: monthIndex,
      });
    }
    var focus = null;
    Object.keys(counts).forEach(function (k) {
      if (focus === null || counts[k] > counts[focus]) focus = k; // keys ascend, so ties keep the earlier month
    });
    focus = Number(focus);
    days.forEach(function (day) {
      day.inFocus = day._month === focus;
      delete day._month;
    });
    return { days: days, focusYear: Math.floor(focus / 12), focusMonth: focus % 12 };
  }

  // ---- Right-click menu actions ----
  function isDayStr(str) {
    return typeof str === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(str);
  }

  function dayAfter(nowMs, n) {
    var t = new Date(nowMs);
    return dayKey(new Date(t.getFullYear(), t.getMonth(), t.getDate() + n).getTime());
  }

  // The first day of next week (weekStart: 1 = Monday, 0 = Sunday), never today.
  function nextWeekStart(nowMs, weekStart) {
    var first = weekStart === 0 ? 0 : 1;
    var diff = (first - new Date(nowMs).getDay() + 7) % 7;
    return dayAfter(nowMs, diff || 7);
  }

  // The PluginAPI.updateTask payload for a menu action, the payload that undoes it, and a
  // short message. Returns null when there's nothing to change. Planning sets dueDay and
  // clears a planned time; deadlines are separate and never touched by planning.
  function taskUpdateFor(action, task, nowMs, options, arg) {
    var opts = withDefaults(options);
    var update = {};
    var label = '';
    function plan(day) {
      update.dueDay = day;
      if (task.dueWithTime) update.dueWithTime = null;
      label = 'Planned for ' + (day === dayKey(nowMs) ? 'today' : formatDate(new Date(parseDay(day)), nowMs, opts.dateFormat));
    }
    switch (action) {
      case 'today':
        plan(dayAfter(nowMs, 0));
        break;
      case 'tomorrow':
        plan(dayAfter(nowMs, 1));
        break;
      case 'nextWeek':
        plan(nextWeekStart(nowMs, opts.weekStart));
        break;
      case 'pickDate':
        if (!isDayStr(arg)) return null;
        plan(arg);
        break;
      case 'unplan':
        if (!task.dueDay && !task.dueWithTime) return null;
        if (task.dueDay) update.dueDay = null;
        if (task.dueWithTime) update.dueWithTime = null;
        label = 'No longer planned';
        break;
      case 'done':
        if (task.isDone) return null;
        update.isDone = true;
        update.doneOn = nowMs;
        label = 'Marked as done';
        break;
      case 'setDeadline': {
        if (!arg || !isDayStr(arg.date)) return null;
        var m;
        if (arg.time && /^\d{2}:\d{2}$/.test(arg.time)) {
          var d = arg.date.split('-').map(Number);
          var hm = arg.time.split(':').map(Number);
          update.deadlineWithTime = new Date(d[0], d[1] - 1, d[2], hm[0], hm[1]).getTime();
          if (task.deadlineDay) update.deadlineDay = null;
          m = { ms: update.deadlineWithTime, hasTime: true };
        } else {
          update.deadlineDay = arg.date;
          if (task.deadlineWithTime) update.deadlineWithTime = null;
          m = { ms: parseDay(arg.date), hasTime: false };
        }
        label = 'Deadline ' + formatMoment(m, nowMs, opts.dateFormat);
        break;
      }
      case 'removeDeadline':
        if (!task.deadlineDay && !task.deadlineWithTime) return null;
        if (task.deadlineDay) update.deadlineDay = null;
        if (task.deadlineWithTime) update.deadlineWithTime = null;
        label = 'Deadline removed';
        break;
      default:
        return null;
    }
    var undo = {};
    Object.keys(update).forEach(function (k) {
      undo[k] = task[k] === undefined ? null : task[k];
    });
    if (action === 'done') {
      undo.isDone = false;
      undo.doneOn = undefined; // SP wants a number or undefined here, never null
    }
    return { update: update, undo: undo, label: label };
  }

  // ---- Timeline ----
  // Range lengths in days. The window starts about a twelfth of the range before today,
  // so recently passed deadlines stay in view.
  var TIMELINE_RANGES = { '1m': 30, '3m': 91, '6m': 182 };

  function timelineSpan(nowMs, rangeKey, offsetDays) {
    var days = TIMELINE_RANGES[rangeKey] || TIMELINE_RANGES['3m'];
    var t = new Date(nowMs);
    var first = new Date(t.getFullYear(), t.getMonth(), t.getDate() - Math.round(days / 12) + (offsetDays || 0));
    var end = new Date(first.getFullYear(), first.getMonth(), first.getDate() + days);
    return { start: first.getTime(), end: end.getTime(), days: days };
  }

  // "22 Oct – 21 Jan", with years when the span crosses a year boundary.
  function spanLabel(span) {
    var a = new Date(span.start);
    var b = new Date(span.end - 1);
    var withYear = a.getFullYear() !== b.getFullYear();
    function f(d) {
      return d.getDate() + ' ' + MONTHS[d.getMonth()] + (withYear ? ' ' + d.getFullYear() : '');
    }
    return f(a) + ' – ' + f(b);
  }

  // Position 0..1 in the span. Date-only moments sit mid-day.
  function spanFraction(ms, hasTime, span) {
    var d = new Date(ms);
    var inDay = hasTime ? (d.getHours() * 60 + d.getMinutes()) / 1440 : 0.5;
    return (daysBetween(span.start, ms) + inDay) / span.days;
  }

  // The timeline header as two rows of cells, positions as fractions of the span:
  //   months: one band per (partial) month, labelled;
  //   units:  even cells, days when the span is up to ~6 weeks, else weeks starting on
  //           weekStart (1 = Monday, 0 = Sunday). A partial first week has no label.
  // Grid lines follow the unit cells only, so they're evenly spaced.
  function timelineAxis(span, weekStart, nowMs) {
    var unit = span.days <= 45 ? 'day' : 'week';
    var firstWeekday = weekStart === 0 ? 0 : 1;
    var months = [];
    var units = [];
    for (var i = 0; i < span.days; i++) {
      var d = new Date(addDays(span.start, i));
      var x = i / span.days;
      if (i === 0 || d.getDate() === 1) {
        if (months.length) months[months.length - 1].w = x - months[months.length - 1].x;
        months.push({
          x: x,
          label: MONTHS_LONG[d.getMonth()] + (i === 0 || d.getMonth() === 0 ? ' ' + d.getFullYear() : ''),
          isStart: d.getDate() === 1,
        });
      }
      var startsUnit = unit === 'day' || d.getDay() === firstWeekday;
      if (i === 0 || startsUnit) {
        if (units.length) units[units.length - 1].w = x - units[units.length - 1].x;
        units.push({
          x: x,
          label: !startsUnit ? '' : unit === 'day' ? String(d.getDate()) : d.getDate() + ' ' + MONTHS[d.getMonth()],
          isStart: startsUnit,
          isWeekend: unit === 'day' && (d.getDay() === 0 || d.getDay() === 6),
          isMonthStart: d.getDate() === 1,
        });
      }
    }
    months[months.length - 1].w = 1 - months[months.length - 1].x;
    units[units.length - 1].w = 1 - units[units.length - 1].x;
    var today = spanFraction(nowMs, true, span);
    return { unit: unit, months: months, units: units, today: today >= 0 && today <= 1 ? today : null };
  }

  // One lane per project (in project order), each item placed by date, with labels
  // stacked into rows so they don't overlap. widthPx is the track width; label widths are
  // estimated at ~6.6px per character, capped at maxLabelPx. Open deadlines from before
  // the window are pinned to its left edge; anything after it is only counted.
  function timelineLanes(items, span, widthPx, projects, maxLabelPx) {
    var order = {};
    (projects || []).forEach(function (pr, i) { order[pr.id] = i; });
    var placed = [];
    var later = 0;
    items.forEach(function (it) {
      if (it.at == null) return;
      var x = spanFraction(it.at, !it.allDay, span);
      if (x > 1) {
        later++;
        return;
      }
      var pinned = false;
      if (x < 0) {
        if (it.kind !== 'deadline') return; // past dates outside the window
        x = 0;
        pinned = true;
      }
      placed.push({ it: it, x: x, pinned: pinned });
    });
    placed.sort(function (a, b) { return a.x - b.x || a.it.title.localeCompare(b.it.title); });

    var lanesById = {};
    placed.forEach(function (pl) {
      var it = pl.it;
      var key = it.projectId || '';
      var lane = lanesById[key];
      if (!lane) {
        lane = lanesById[key] = {
          projectId: key,
          project: it.project,
          color: it.projectColor,
          rank: key in order ? order[key] : 1e9,
          rowEnds: [],
          items: [],
        };
      }
      var text = (it.kind === 'deadline' ? '⚑ ' : '') + it.title + (it.date ? ' · ' + it.date : '');
      var w = Math.min(maxLabelPx || 240, 30 + text.length * 6.6);
      var px = pl.x * widthPx;
      var alignRight = px + w > widthPx;
      var left = alignRight ? px - w : px;
      var right = alignRight ? px : px + w;
      var row = 0;
      while (row < lane.rowEnds.length && lane.rowEnds[row] + 6 > left) row++;
      lane.rowEnds[row] = right;
      lane.items.push({ item: it, x: pl.x, row: row, alignRight: alignRight, pinned: pl.pinned });
    });

    var lanes = Object.keys(lanesById).map(function (k) { return lanesById[k]; });
    lanes.sort(function (a, b) { return a.rank - b.rank || String(a.project).localeCompare(String(b.project)); });
    return {
      lanes: lanes.map(function (l) {
        return { projectId: l.projectId, project: l.project, color: l.color, rows: l.rowEnds.length, items: l.items };
      }),
      later: later,
    };
  }

  // Deadlines and events from buildView, grouped by day; timed items first, by time.
  function calendarItems(view) {
    var byDay = {};
    view.withDeadline.concat(view.dates).forEach(function (it) {
      if (!it.day) return;
      (byDay[it.day] = byDay[it.day] || []).push(it);
    });
    Object.keys(byDay).forEach(function (k) {
      byDay[k].sort(function (a, b) {
        var at = a.time || '99:99';
        var bt = b.time || '99:99';
        return at < bt ? -1 : at > bt ? 1 : a.title.localeCompare(b.title);
      });
    });
    return byDay;
  }

  // Project id -> colour. 'auto' gives each project its own palette colour, in project
  // order, so colours stay put; 'theme' uses the project's SP theme colour.
  function projectColorsFor(projects, mode) {
    var colors = { INBOX_PROJECT: INBOX_COLOR };
    var n = 0;
    (projects || []).forEach(function (p) {
      if (p.id === 'INBOX_PROJECT') {
        if (mode === 'theme' && p.theme && p.theme.primary) colors[p.id] = p.theme.primary;
        return;
      }
      var auto = PROJECT_PALETTE[n++ % PROJECT_PALETTE.length];
      colors[p.id] = mode === 'theme' && p.theme && p.theme.primary ? p.theme.primary : auto;
    });
    return colors;
  }

  function buildView(tasks, projects, tags, now, options) {
    var opts = withDefaults(options);
    var projectColors = projectColorsFor(projects, opts.projectColors);
    var projectTitles = { INBOX_PROJECT: 'Inbox' };
    var projectOrder = {};
    (projects || []).forEach(function (p, i) {
      projectTitles[p.id] = p.title;
      projectOrder[p.id] = i;
    });
    var eventTitles = {};
    opts.eventTags.forEach(function (title) { eventTitles[title.toLowerCase()] = true; });
    var eventTagIds = {};
    (tags || []).forEach(function (t) {
      if (eventTitles[String(t.title).trim().toLowerCase()]) eventTagIds[t.id] = true;
    });
    var byId = {};
    var position = {};
    tasks.forEach(function (t, i) {
      byId[t.id] = t;
      position[t.id] = i;
    });

    function parentOf(t) {
      return t.parentId ? byId[t.parentId] || null : null;
    }
    function isEvent(t) {
      return (t.tagIds || []).some(function (id) { return eventTagIds[id]; });
    }
    function subtasksOf(t) {
      return (t.subTaskIds || []).map(function (id) { return byId[id]; }).filter(Boolean);
    }
    function moment(m, kind) {
      return {
        when: m ? formatMoment(m, now, opts.dateFormat) : null,
        relative: m ? relative(m, now, kind) : null,
        urgency: m ? urgency(m, now, opts.soonDays) : null,
        kind: m ? kind : null,
        day: m ? dayKey(m.ms) : null,
        time: m ? timeOf(m) : null,
        date: m ? formatDate(new Date(m.ms), now, opts.dateFormat) : null,
        at: m ? m.ms : null,
        allDay: m ? !m.hasTime : null,
      };
    }
    function toItem(t, m, kind) {
      var parent = parentOf(t);
      var subs = subtasksOf(t);
      var item = {
        id: t.id,
        title: t.title,
        parentTitle: parent ? parent.title : null,
        project: projectTitles[t.projectId] || '',
        projectId: t.projectId || null,
        projectColor: projectColors[t.projectId] || INBOX_COLOR,
        subtasksDone: subs.filter(function (s) { return s.isDone; }).length,
        subtasksTotal: subs.length,
        _key: m ? sortKey(m) : Infinity,
        _projectRank: t.projectId in projectOrder ? projectOrder[t.projectId] : -1,
        _position: position[t.id],
      };
      var info = moment(m, kind);
      Object.keys(info).forEach(function (k) { item[k] = info[k]; });
      if (opts.nestSubtasks && !parent) {
        item.subtasks = subs
          .filter(function (s) { return !s.isDone; })
          .map(function (s) {
            var sub = { id: s.id, title: s.title };
            var info2 = moment(deadlineOf(s), 'deadline');
            Object.keys(info2).forEach(function (k) { sub[k] = info2[k]; });
            return sub;
          });
      }
      return item;
    }

    var withDeadline = [];
    var noDeadline = [];
    var dates = [];
    tasks.forEach(function (t) {
      var parent = parentOf(t);
      if (t.isDone || (parent && parent.isDone)) return;
      var deadline = deadlineOf(t);
      // An event-tagged task with a deadline is pinned work (e.g. AutoPlan's `fixed`),
      // not an appointment, so it stays under Deadlines.
      var isEventTask = isEvent(t) && !deadline;
      var inEventTask = parent && isEvent(parent) && !deadlineOf(parent);
      if (isEventTask || inEventTask) {
        if (opts.showEvents && !parent) dates.push(toItem(t, plannedOf(t), 'event'));
        return;
      }
      if (parent) {
        if (deadline && opts.subtaskDeadlines) withDeadline.push(toItem(t, deadline, 'deadline'));
        return;
      }
      if (deadline) withDeadline.push(toItem(t, deadline, 'deadline'));
      else noDeadline.push(toItem(t, null));
    });

    function byMoment(a, b) {
      return a._key - b._key || a.title.localeCompare(b.title);
    }
    withDeadline.sort(byMoment);
    dates.sort(byMoment);
    noDeadline.sort(function (a, b) {
      return a._projectRank - b._projectRank || a._position - b._position;
    });

    function clean(item) {
      var out = {};
      Object.keys(item).forEach(function (k) {
        if (k.charAt(0) !== '_') out[k] = item[k];
      });
      return out;
    }
    return {
      withDeadline: withDeadline.map(clean),
      noDeadline: noDeadline.map(clean),
      dates: dates.map(clean),
    };
  }

  return {
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    withDefaults: withDefaults,
    buildView: buildView,
    calendarItems: calendarItems,
    dayKey: dayKey,
    calendarWeeks: calendarWeeks,
    weekStartOf: weekStartOf,
    addDays: addDays,
    monthLabel: monthLabel,
    weekdayNames: weekdayNames,
    projectColorsFor: projectColorsFor,
    taskUpdateFor: taskUpdateFor,
    nextWeekStart: nextWeekStart,
    timelineSpan: timelineSpan,
    timelineAxis: timelineAxis,
    timelineLanes: timelineLanes,
    spanLabel: spanLabel,
    soonLabel: soonLabel,
  };
})();
