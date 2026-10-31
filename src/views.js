import { Calendar } from 'fullcalendar';
import dayGridPlugin from 'fullcalendar/daygrid';
import themePlugin from 'fullcalendar/themes/monarch';
import 'fullcalendar/skeleton.css';
import 'fullcalendar/themes/monarch/theme.css';
import 'fullcalendar/themes/monarch/palettes/purple.css';
import { Timeline } from 'vis-timeline/peer';
import { DataSet } from 'vis-data/peer';
import 'vis-timeline/styles/vis-timeline-graph2d.min.css';
import { calendarEvents, timelineData } from './view-data.js';
import { bindCalendarSwipe } from './calendar-swipe.js';

function taskTitle(item) {
  return [item.title, item.parentTitle ? '↳ ' + item.parentTitle : '', item.project,
    (item.kind === 'deadline' ? 'Deadline ' : 'Date ') + item.when + ' · ' + item.relative,
  ].filter(Boolean).join('\n');
}

function taskLabel(item, timeline = false, pinned = false) {
  const label = document.createElement(timeline ? 'button' : 'span');
  label.className = timeline ? 'timeline-task' : 'calendar-task';
  label.dataset.taskId = item.id;
  label.dataset.kind = item.kind;
  label.style.setProperty('--proj', item.projectColor);
  label.title = taskTitle(item);
  if (timeline) label.type = 'button';
  const text = (pinned ? '◀ ' : '') + (item.kind === 'deadline' ? '⚑ ' : '')
    + (item.time ? item.time + ' ' : '') + item.title;
  label.textContent = text;
  return label;
}

function bindTimelineActivation(timeline, container, openTask) {
  let pointer = null;
  let ignoreClickUntil = 0;
  container.addEventListener('pointerdown', event => {
    ignoreClickUntil = 0;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  }, true);
  window.addEventListener('pointermove', event => {
    if (pointer && pointer.id === event.pointerId
        && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 8) pointer.moved = true;
  }, true);
  function end(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    if (pointer.moved) ignoreClickUntil = performance.now() + 400;
    pointer = null;
  }
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
  timeline.on('click', info => {
    if (info.item && (info.event?.detail === 0 || performance.now() >= ignoreClickUntil)) openTask(info.item);
  });
}

export function createViews({ logic, openTask, projectTag, setLabel }) {
  let calendar = null;
  let timeline = null;
  let active = 'list';
  let view = null;
  let settings = null;
  let projects = [];
  let range = null;
  let timelineDay = null;
  let calendarKey = '';
  let timelineKey = '';
  const items = new DataSet();
  const groups = new DataSet();
  const calendarEl = document.getElementById('cal');
  const timelineEl = document.getElementById('tl');

  function calendarLegend() {
    if (!calendar || !view) return;
    const start = calendar.view.activeStart.getTime();
    const end = calendar.view.activeEnd.getTime();
    const visible = view.withDeadline.concat(view.dates).filter(item => item.at >= start && item.at < end);
    const byProject = new Map(visible.filter(item => item.project).map(item => [item.projectId, item]));
    document.getElementById('legend-projects').replaceChildren(...Array.from(byProject.values(),
      item => projectTag(item.project, item.projectColor)));
    document.getElementById('legend-sep').hidden = !byProject.size;
    setLabel(calendar.view.title);
  }

  function makeCalendar() {
    const root = document.createElement('div');
    root.className = 'calendar-root';
    calendarEl.appendChild(root);
    calendar = new Calendar(root, {
      plugins: [themePlugin, dayGridPlugin],
      initialView: 'dayGridMonth',
      headerToolbar: false,
      firstDay: settings.weekStart,
      fixedWeekCount: true,
      height: '100%',
      dayMaxEvents: true,
      displayEventTime: false,
      eventDisplay: 'block',
      editable: false,
      eventOrder: 'start,title',
      viewClass: 'calendar-view',
      dayCellClass: info => 'calendar-day' + (info.isToday ? ' calendar-today' : ''),
      dayHeaderClass: 'calendar-weekday',
      moreLinkClass: 'calendar-more',
      dayCellDidMount: info => { info.el.dataset.date = logic.dayKey(info.date.getTime()); },
      eventContent: info => ({ domNodes: [taskLabel(info.event.extendedProps.item)] }),
      eventDidMount: info => {
        const item = info.event.extendedProps.item;
        info.el.dataset.taskId = item.id;
        info.el.dataset.kind = item.kind;
        info.el.style.setProperty('--proj', item.projectColor);
        info.el.title = taskTitle(item);
        info.el.setAttribute('aria-label', taskTitle(item));
        info.el.setAttribute('tabindex', '0');
        info.el.setAttribute('role', 'button');
      },
      eventClick: info => { info.jsEvent.preventDefault(); openTask(info.event.id); },
      datesSet: () => { if (active === 'calendar') calendarLegend(); },
    });
    calendar.render();
  }

  function renderCalendar(nextView, nextSettings) {
    active = 'calendar';
    view = nextView;
    settings = nextSettings;
    if (!calendar) makeCalendar();
    const key = JSON.stringify([view.withDeadline, view.dates, settings.weekStart]);
    if (key !== calendarKey) {
      calendar.batchRendering(() => {
        calendar.setOption('firstDay', settings.weekStart);
        calendar.removeAllEventSources();
        calendar.addEventSource(calendarEvents(view));
      });
      calendarKey = key;
    }
    calendar.render();
    calendarLegend();
  }

  function timelineWindow() {
    const window = timeline.getWindow();
    return { start: window.start.getTime(), end: window.end.getTime() };
  }

  function syncTimeline() {
    if (!timeline || !view) return;
    const span = timelineWindow();
    const data = timelineData(view, span, projects);
    const nextItems = data.items.map(entry => ({ ...entry, content: '',
      style: '--proj: ' + safeColor(entry.item.projectColor),
    }));
    const nextGroups = data.groups.map(group => ({ ...group,
      content: projectTag(group.name, group.color),
    }));
    groups.update(nextGroups);
    groups.remove(groups.getIds().filter(id => !nextGroups.some(group => group.id === id)));
    items.update(nextItems);
    items.remove(items.getIds().filter(id => !nextItems.some(item => item.id === id)));
    document.getElementById('tl-empty').hidden = data.items.length > 0;
    document.getElementById('tl-hint').textContent = data.later
      ? data.later + ' more after ' + logic.spanLabel(span).split(' – ')[1] : '';
    if (active === 'timeline') setLabel(logic.spanLabel(span));
  }

  function makeTimeline() {
    const span = logic.timelineSpan(Date.now(), settings.timelineRange, 0);
    timeline = new Timeline(timelineEl, items, groups, {
      start: new Date(span.start), end: new Date(span.end),
      height: '100%',
      orientation: 'top',
      stack: true,
      groupOrder: 'order',
      groupHeightMode: 'auto',
      margin: { item: { horizontal: 14, vertical: 12 }, axis: 18 },
      showCurrentTime: true,
      editable: false,
      selectable: false,
      moveable: true,
      zoomable: true,
      zoomKey: 'ctrlKey',
      horizontalScroll: true,
      verticalScroll: true,
      zoomMin: 7 * 86400000,
      zoomMax: 2 * 366 * 86400000,
      template: entry => taskLabel(entry.item, true, entry.pinned),
      tooltip: { followMouse: false },
    });
    timeline.on('rangechange', () => {
      if (active === 'timeline') setLabel(logic.spanLabel(timelineWindow()));
    });
    timeline.on('rangechanged', syncTimeline);
    bindTimelineActivation(timeline, timelineEl, openTask);
  }

  function renderTimeline(nextView, nextSettings, nextProjects) {
    active = 'timeline';
    view = nextView;
    settings = nextSettings;
    projects = nextProjects;
    document.querySelectorAll('[data-range]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.range === settings.timelineRange));
    });
    document.getElementById('tl-legend-event').hidden = !settings.showEvents || !settings.eventTags.length;
    if (!timeline) makeTimeline();
    const day = logic.dayKey(Date.now());
    const key = JSON.stringify([view.withDeadline, view.dates, projects]);
    if (range !== settings.timelineRange) {
      range = settings.timelineRange;
      resetTimeline();
    } else if (key !== timelineKey || day !== timelineDay) {
      syncTimeline();
    }
    timelineKey = key;
    timelineDay = day;
    timeline.redraw();
    setLabel(logic.spanLabel(timelineWindow()));
  }

  function resetTimeline() {
    const span = logic.timelineSpan(Date.now(), settings.timelineRange, 0);
    timeline.setWindow(new Date(span.start), new Date(span.end), { animation: false });
    syncTimeline();
  }

  function shift(name, direction, jump) {
    if (name === 'calendar' && calendar) {
      if (direction < 0) calendar.prev(); else calendar.next();
      calendarLegend();
    } else if (name === 'timeline' && timeline) {
      const span = timelineWindow();
      const distance = jump ? (span.end - span.start) / 2 : 86400000;
      timeline.setWindow(new Date(span.start + direction * distance), new Date(span.end + direction * distance),
        { animation: false });
      syncTimeline();
    }
  }

  function today(name) {
    if (name === 'calendar' && calendar) { calendar.today(); calendarLegend(); }
    if (name === 'timeline' && timeline) resetTimeline();
  }

  bindCalendarSwipe(calendarEl, direction => shift('calendar', direction, true));
  let lastCalendarWheel = 0;
  calendarEl.addEventListener('wheel', event => {
    if (event.ctrlKey || Math.abs(event.deltaY) < Math.abs(event.deltaX) || Math.abs(event.deltaY) < 20) return;
    event.preventDefault();
    if (performance.now() - lastCalendarWheel < 250) return;
    lastCalendarWheel = performance.now();
    shift('calendar', event.deltaY > 0 ? 1 : -1, true);
  }, { passive: false });
  return { calendar: renderCalendar, timeline: renderTimeline, shift, today };
}

function safeColor(value) {
  return /^#[\da-f]{3,8}$/i.test(value || '') ? value : '#888888';
}
