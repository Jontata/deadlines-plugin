// Run with: node --test test.mjs
// Loads the <logic> block from index.html and checks it against fake tasks.
process.env.TZ = 'Europe/Copenhagen';

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const start = html.indexOf('// <logic>');
const end = html.indexOf('// </logic>');
assert.ok(start >= 0 && end > start, 'logic markers missing in index.html');
const L = new Function(html.slice(start, end) + '\nreturn DeadlinesLogic;')();

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 10, 30, 12, 0); // Fri 30 Oct 2026, 12:00

const projects = [
  { id: 'INBOX_PROJECT', title: 'Inbox' },
  { id: 'dl', title: '02456 Deep Learning' },
  { id: 'no', title: '42115 Network Optimization' },
];
const tags = [{ id: 'ev', title: 'fixed' }];

function task(id, fields = {}) {
  return { id, title: id, isDone: false, projectId: 'dl', tagIds: [], subTaskIds: [], ...fields };
}

test('splits tasks into deadline, no deadline and dates', () => {
  const tasks = [
    task('handin', { deadlineWithTime: at(2026, 12, 4, 23, 59), subTaskIds: ['write', 'run'] }),
    task('write', { parentId: 'handin' }),
    task('run', { parentId: 'handin', isDone: true }),
    task('assignment', { projectId: 'no', deadlineWithTime: at(2026, 12, 6, 8, 0) }),
    task('cheatsheet', { projectId: 'no' }),
    task('inbox-item', { projectId: 'INBOX_PROJECT', dueDay: '2026-11-02' }),
    task('exam', { tagIds: ['ev'], dueWithTime: at(2026, 12, 9, 9, 0) }),
    task('done-with-deadline', { isDone: true, deadlineDay: '2026-11-01' }),
  ];
  const v = L.buildView(tasks, projects, tags, NOW);

  assert.deepEqual(v.withDeadline.map((i) => i.id), ['handin', 'assignment']);
  assert.deepEqual(v.noDeadline.map((i) => i.id), ['inbox-item', 'cheatsheet']);
  assert.deepEqual(v.dates.map((i) => i.id), ['exam']);

  const handin = v.withDeadline[0];
  assert.equal(handin.when, 'Fri 4 Dec 23:59');
  assert.equal(handin.relative, 'in 35 days');
  assert.equal(handin.urgency, 'later');
  assert.equal(handin.project, '02456 Deep Learning');
  assert.equal(handin.subtasksDone, 1);
  assert.equal(handin.subtasksTotal, 2);
  assert.equal(v.dates[0].when, 'Wed 9 Dec 09:00');
});

test('planning a task does not move it between deadline sections', () => {
  const planned = task('a', { dueDay: '2026-10-30', deadlineWithTime: at(2026, 12, 6, 8, 0) });
  const v = L.buildView([planned], projects, tags, NOW);
  assert.deepEqual(v.withDeadline.map((i) => i.id), ['a']);
  assert.equal(v.withDeadline[0].when, 'Sun 6 Dec 08:00');
});

test('subtasks with their own deadline show with their parent title', () => {
  const tasks = [
    task('parent', { subTaskIds: ['child'] }),
    task('child', { parentId: 'parent', deadlineDay: '2026-11-03' }),
  ];
  const v = L.buildView(tasks, projects, tags, NOW);
  assert.deepEqual(v.withDeadline.map((i) => [i.id, i.parentTitle]), [['child', 'parent']]);
  assert.deepEqual(v.noDeadline.map((i) => i.id), ['parent']);
});

test('sorts soonest first; date-only deadlines sort after timed ones on the same day', () => {
  const tasks = [
    task('later', { deadlineDay: '2026-12-01' }),
    task('day-only', { deadlineDay: '2026-11-02' }),
    task('timed', { deadlineWithTime: at(2026, 11, 2, 23, 0) }),
    task('overdue', { deadlineDay: '2026-10-28' }),
  ];
  const v = L.buildView(tasks, projects, tags, NOW);
  assert.deepEqual(v.withDeadline.map((i) => i.id), ['overdue', 'timed', 'day-only', 'later']);
});

test('relative labels and urgency', () => {
  const cases = [
    [{ deadlineDay: '2026-10-28' }, '2 days overdue', 'overdue'],
    [{ deadlineDay: '2026-10-29' }, '1 day overdue', 'overdue'],
    [{ deadlineWithTime: at(2026, 10, 30, 8, 0) }, 'overdue', 'overdue'],
    [{ deadlineDay: '2026-10-30' }, 'today', 'soon'],
    [{ deadlineWithTime: at(2026, 10, 30, 18, 0) }, 'today', 'soon'],
    [{ deadlineDay: '2026-10-31' }, 'tomorrow', 'soon'],
    [{ deadlineDay: '2026-11-06' }, 'in 7 days', 'soon'],
    [{ deadlineDay: '2026-11-07' }, 'in 8 days', 'later'],
  ];
  for (const [fields, rel, urg] of cases) {
    const [item] = L.buildView([task('x', fields)], projects, tags, NOW).withDeadline;
    assert.equal(item.relative, rel, JSON.stringify(fields));
    assert.equal(item.urgency, urg, JSON.stringify(fields));
  }
});

test('past events say ago, not overdue', () => {
  const v = L.buildView(
    [
      task('earlier', { tagIds: ['ev'], dueWithTime: at(2026, 10, 30, 9, 0) }),
      task('yesterday', { tagIds: ['ev'], dueDay: '2026-10-29' }),
    ],
    projects,
    tags,
    NOW,
  );
  assert.deepEqual(v.dates.map((i) => i.relative), ['1 day ago', 'earlier today']);
});

test('day counts survive the DST change (25 Oct 2026)', () => {
  const now = at(2026, 10, 24, 12, 0);
  const [item] = L.buildView([task('x', { deadlineDay: '2026-10-26' })], projects, tags, now).withDeadline;
  assert.equal(item.relative, 'in 2 days');
});

test('shows the year when the date is not in the current year', () => {
  const [item] = L.buildView([task('x', { deadlineDay: '2027-08-01' })], projects, tags, NOW).withDeadline;
  assert.equal(item.when, 'Sun 1 Aug 2027');
});

test('fixed tag is matched by title, case-insensitively, and subtasks of events are hidden', () => {
  const tasks = [
    task('exam', { tagIds: ['EV2'], dueWithTime: at(2026, 12, 16, 9, 0), subTaskIds: ['bring-id'] }),
    task('bring-id', { parentId: 'exam' }),
  ];
  const v = L.buildView(tasks, projects, [{ id: 'EV2', title: ' Fixed ' }], NOW);
  assert.deepEqual(v.dates.map((i) => i.id), ['exam']);
  assert.equal(v.withDeadline.length + v.noDeadline.length, 0);
});

test('rolling calendar: six weeks from a week start, focus month, month starts', () => {
  assert.equal(L.dayKey(L.weekStartOf(NOW, 1)), '2026-10-26'); // Fri 30 Oct -> Mon 26 Oct
  assert.equal(L.dayKey(L.weekStartOf(NOW, 0)), '2026-10-25'); // -> Sun 25 Oct
  const start = L.weekStartOf(new Date(2026, 11, 1).getTime(), 1); // week of 1 Dec
  const g = L.calendarWeeks(start, 6, '2026-12-04');
  assert.equal(g.days.length, 42);
  assert.equal(g.days[0].key, '2026-11-30');
  assert.deepEqual([g.focusYear, g.focusMonth], [2026, 11]); // December
  assert.equal(g.days[0].inFocus, false);
  assert.equal(g.days[1].inFocus, true);
  assert.deepEqual(g.days.filter((d) => d.isMonthStart).map((d) => d.key), ['2026-12-01', '2027-01-01']);
  assert.deepEqual(g.days.filter((d) => d.isToday).map((d) => d.key), ['2026-12-04']);
  assert.equal(g.days[5].isWeekend, true); // Sat 5 Dec

  // Scrolled a week at a time, the name follows whichever month fills most of the view.
  const later = L.calendarWeeks(L.addDays(start, 7 * 3), 6, ''); // starts Mon 21 Dec
  assert.equal(later.days[0].key, '2026-12-21');
  assert.deepEqual([later.focusYear, later.focusMonth], [2027, 0]); // January
});

test('rolling calendar has no gaps or repeats across the DST change', () => {
  const keys = L.calendarWeeks(L.weekStartOf(new Date(2026, 9, 19).getTime(), 1), 6, '').days.map((d) => d.key);
  assert.equal(new Set(keys).size, keys.length);
  const i = keys.indexOf('2026-10-25');
  assert.deepEqual(keys.slice(i - 1, i + 2), ['2026-10-24', '2026-10-25', '2026-10-26']);
});

test('calendar groups deadlines and events by day, timed items first', () => {
  const tasks = [
    task('handin', { deadlineWithTime: at(2026, 12, 4, 23, 59) }),
    task('dayonly', { deadlineDay: '2026-12-04' }),
    task('exam', { tagIds: ['ev'], dueWithTime: at(2026, 12, 4, 9, 0) }),
    task('plain', {}),
  ];
  const byDay = L.calendarItems(L.buildView(tasks, projects, tags, NOW));
  assert.deepEqual(Object.keys(byDay), ['2026-12-04']);
  assert.deepEqual(
    byDay['2026-12-04'].map((i) => [i.id, i.kind, i.time]),
    [['exam', 'event', '09:00'], ['handin', 'deadline', '23:59'], ['dayonly', 'deadline', null]],
  );
});

test('month label', () => {
  assert.equal(L.monthLabel(2026, 11), 'December 2026');
});

test('settings: subtasks with their own deadline can be hidden', () => {
  const tasks = [
    task('parent', { subTaskIds: ['child'] }),
    task('child', { parentId: 'parent', deadlineDay: '2026-11-03' }),
  ];
  const on = L.buildView(tasks, projects, tags, NOW);
  const off = L.buildView(tasks, projects, tags, NOW, { subtaskDeadlines: false });
  assert.deepEqual(on.withDeadline.map((i) => i.id), ['child']);
  assert.deepEqual(off.withDeadline.map((i) => i.id), []);
  assert.deepEqual(Object.keys(L.calendarItems(off)), []);
});

test('settings: open subtasks can be listed under their task', () => {
  const tasks = [
    task('handin', { deadlineWithTime: at(2026, 12, 4, 23, 59), subTaskIds: ['run', 'write', 'review'] }),
    task('run', { parentId: 'handin', isDone: true }),
    task('write', { parentId: 'handin', title: 'Write report' }),
    task('review', { parentId: 'handin', title: 'Review', deadlineDay: '2026-12-02' }),
  ];
  const plain = L.buildView(tasks, projects, tags, NOW);
  assert.equal(plain.withDeadline.find((i) => i.id === 'handin').subtasks, undefined);

  const nested = L.buildView(tasks, projects, tags, NOW, { nestSubtasks: true });
  const handin = nested.withDeadline.find((i) => i.id === 'handin');
  assert.deepEqual(handin.subtasks.map((s) => [s.title, s.when]), [['Write report', null], ['Review', 'Wed 2 Dec']]);
});

test('settings: "soon" threshold', () => {
  const t = [task('x', { deadlineDay: '2026-11-04' })]; // in 5 days
  assert.equal(L.buildView(t, projects, tags, NOW).withDeadline[0].urgency, 'soon');
  assert.equal(L.buildView(t, projects, tags, NOW, { soonDays: 3 }).withDeadline[0].urgency, 'later');
});

test('settings: several event tags', () => {
  const t = [
    task('exam', { tagIds: ['x1'], dueWithTime: at(2026, 12, 9, 9, 0) }),
    task('talk', { tagIds: ['x2'], dueWithTime: at(2026, 12, 10, 14, 0) }),
    task('other', { tagIds: ['ev'] }),
  ];
  const myTags = [...tags, { id: 'x1', title: 'Exam day' }, { id: 'x2', title: 'meeting' }];
  const v = L.buildView(t, projects, myTags, NOW, { eventTags: ['exam day', 'Meeting'] });
  assert.deepEqual(v.dates.map((i) => i.id), ['exam', 'talk']);
  assert.deepEqual(v.noDeadline.map((i) => i.id), ['other']); // 'fixed' is not in this list of event tags
});

test('settings: events can be switched off', () => {
  const t = [task('exam', { tagIds: ['ev'], dueWithTime: at(2026, 12, 9, 9, 0) }), task('plain')];
  const off = L.buildView(t, projects, tags, NOW, { showEvents: false });
  assert.deepEqual(off.dates, []);
  assert.deepEqual(off.noDeadline.map((i) => i.id), ['plain']); // hidden, not moved to Tasks
  assert.deepEqual(Object.keys(L.calendarItems(off)), []);

  const noTags = L.buildView(t, projects, tags, NOW, { eventTags: [] });
  assert.deepEqual(noTags.dates, []);
  assert.deepEqual(noTags.noDeadline.map((i) => i.id), ['exam', 'plain']); // no event tags: a normal task
});

test('settings: old single eventTag setting still works', () => {
  assert.deepEqual(L.withDefaults({ eventTag: 'Exam day' }).eventTags, ['Exam day']);
  assert.deepEqual(L.withDefaults({ eventTags: ['a', ' A ', '', 'b'] }).eventTags, ['a', 'b']);
  assert.deepEqual(L.withDefaults({ eventTags: [] }).eventTags, []);
});

test('settings: week can start on Sunday', () => {
  const g = L.calendarWeeks(L.weekStartOf(new Date(2026, 11, 1).getTime(), 0), 6, '');
  assert.equal(g.days[0].key, '2026-11-29');
  assert.deepEqual(L.weekdayNames(0), ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  assert.deepEqual(L.weekdayNames(1), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
});

test('settings: bad stored values fall back to defaults', () => {
  assert.deepEqual(L.withDefaults({ soonDays: 'abc', weekStart: 7, eventTag: '  ' }), L.DEFAULT_OPTIONS);
  assert.equal(L.withDefaults({ soonDays: 500 }).soonDays, 60);
  assert.equal(L.withDefaults({ soonDays: -2 }).soonDays, 0);
});

test('projects get distinct automatic colours, or their theme colour', () => {
  const ps = [
    { id: 'INBOX_PROJECT', title: 'Inbox', theme: { primary: 'rgb(1, 2, 3)' } },
    { id: 'a', title: 'A', theme: { primary: '#29a1aa' } },
    { id: 'b', title: 'B', theme: { primary: '#29a1aa' } },
  ];
  const auto = L.projectColorsFor(ps, 'auto');
  assert.equal(auto.INBOX_PROJECT, '#9e9e9e');
  assert.notEqual(auto.a, auto.b);
  const theme = L.projectColorsFor(ps, 'theme');
  assert.deepEqual([theme.INBOX_PROJECT, theme.a, theme.b], ['rgb(1, 2, 3)', '#29a1aa', '#29a1aa']);

  const v = L.buildView([task('x', { projectId: 'b', deadlineDay: '2026-11-03' })], ps, tags, NOW);
  assert.equal(v.withDeadline[0].projectColor, auto.b);
  assert.equal(L.withDefaults({ projectColors: 'nonsense' }).projectColors, 'auto');
});

test('settings: date formats', () => {
  const t = [
    task('nov', { deadlineWithTime: at(2026, 11, 18, 8, 0) }), // Wed 18 Nov 2026
    task('feb', { deadlineDay: '2026-02-01' }), // overdue, same year
    task('aug', { deadlineDay: '2027-08-01' }), // next year
  ];
  const cases = {
    'weekday-day-month': ['Sun 1 Feb', 'Wed 18 Nov 08:00', 'Sun 1 Aug 2027'],
    'day-month': ['1 Feb', '18 Nov 08:00', '1 Aug 2027'],
    'weekday-dd/mm': ['Sun 01/02', 'Wed 18/11 08:00', 'Sun 01/08/2027'],
    'dd/mm': ['01/02', '18/11 08:00', '01/08/2027'],
    'mm/dd': ['02/01', '11/18 08:00', '08/01/2027'],
    iso: ['2026-02-01', '2026-11-18 08:00', '2027-08-01'],
  };
  for (const [format, expected] of Object.entries(cases)) {
    const v = L.buildView(t, projects, tags, NOW, { dateFormat: format });
    assert.deepEqual(v.withDeadline.map((i) => i.when), expected, format);
  }
  assert.equal(L.withDefaults({ dateFormat: 'yyyy' }).dateFormat, 'weekday-day-month');
});

test('the old event tag setting becomes fixed; a fixed task with a deadline stays a deadline', () => {
  assert.deepEqual(L.withDefaults({ eventTags: ['event'] }).eventTags, ['fixed']);
  assert.deepEqual(L.withDefaults({ eventTags: ['event', 'meeting'] }).eventTags, ['event', 'meeting']);
  assert.deepEqual(L.DEFAULT_OPTIONS.eventTags, ['fixed']);

  const t = [
    task('exam', { tagIds: ['ev'], dueWithTime: at(2026, 12, 9, 9, 0) }),
    task('pinned', { tagIds: ['ev'], dueWithTime: at(2026, 11, 3, 10, 0), deadlineWithTime: at(2026, 12, 6, 8, 0), subTaskIds: ['s'] }),
    task('s', { parentId: 'pinned', deadlineDay: '2026-11-20' }),
  ];
  const v = L.buildView(t, projects, tags, NOW);
  assert.deepEqual(v.dates.map((i) => i.id), ['exam']);
  assert.deepEqual(v.withDeadline.map((i) => i.id), ['s', 'pinned']); // subtask not hidden either
  const off = L.buildView(t, projects, tags, NOW, { showEvents: false });
  assert.deepEqual(off.withDeadline.map((i) => i.id), ['s', 'pinned']);
});

test('timeline window: starts a bit before today and spans the chosen range', () => {
  const span = L.timelineSpan(NOW, '3m', 0); // Fri 30 Oct
  assert.equal(span.days, 91);
  assert.equal(L.dayKey(span.start), '2026-10-22');
  assert.equal(L.dayKey(span.end), '2027-01-21');
  assert.equal(L.spanLabel(span), '22 Oct 2026 – 20 Jan 2027');
  assert.equal(L.dayKey(L.timelineSpan(NOW, '1m', 0).start), '2026-10-27'); // 30/12 rounds to 3 days back
  assert.equal(L.dayKey(L.timelineSpan(NOW, '3m', 46).start), '2026-12-07');
  assert.equal(L.spanLabel(L.timelineSpan(NOW, '1m', 0)), '27 Oct – 25 Nov');
});

test('timeline header: month bands and even week cells (3 months)', () => {
  const span = L.timelineSpan(NOW, '3m', 0); // 22 Oct 2026 – 20 Jan 2027
  const axis = L.timelineAxis(span, 1, NOW);
  assert.equal(axis.unit, 'week');
  assert.deepEqual(axis.months.map((m) => m.label), ['October 2026', 'November', 'December', 'January 2027']);
  const sum = (arr) => arr.reduce((t, x) => t + x.w, 0);
  assert.ok(Math.abs(sum(axis.months) - 1) < 1e-9);
  assert.ok(Math.abs(sum(axis.units) - 1) < 1e-9);
  // First cell is the partial week 22–25 Oct (no label); then whole weeks from Mondays.
  assert.equal(axis.units[0].label, '');
  assert.ok(Math.abs(axis.units[0].w - 4 / 91) < 1e-9);
  assert.equal(axis.units[1].label, '26 Oct');
  const whole = axis.units.slice(1, -1);
  assert.ok(whole.every((u) => Math.abs(u.w - 7 / 91) < 1e-9)); // evenly spaced
  assert.ok(Math.abs(axis.today - (8 + 0.5) / 91) < 1e-9); // Fri 30 Oct 12:00
  assert.equal(L.timelineAxis(span, 0, NOW).units[1].label, '25 Oct'); // Sunday-first
  assert.equal(L.timelineAxis(L.timelineSpan(NOW, '3m', 200), 1, NOW).today, null);
});

test('timeline header: day cells with weekends for 1 month', () => {
  const span = L.timelineSpan(NOW, '1m', 0); // 27 Oct – 25 Nov
  const axis = L.timelineAxis(span, 1, NOW);
  assert.equal(axis.unit, 'day');
  assert.equal(axis.units.length, 30);
  assert.ok(axis.units.every((u) => Math.abs(u.w - 1 / 30) < 1e-9));
  assert.deepEqual(axis.units.slice(0, 7).map((u) => u.label), ['27', '28', '29', '30', '31', '1', '2']);
  assert.deepEqual(axis.units.slice(0, 7).map((u) => u.isWeekend), [false, false, false, false, true, true, false]);
  assert.equal(axis.units[5].isMonthStart, true); // 1 Nov
  assert.deepEqual(axis.months.map((m) => m.label), ['October 2026', 'November']);
});

test('timeline lanes: per project, stacked labels, pinned overdue, later count', () => {
  const t = [
    task('a', { projectId: 'dl', deadlineDay: '2026-12-04' }),
    task('b', { projectId: 'dl', deadlineDay: '2026-12-05' }), // collides with a: second row
    task('c', { projectId: 'no', deadlineDay: '2026-11-10' }),
    task('old', { projectId: 'no', deadlineDay: '2026-10-01' }), // overdue before the window
    task('far', { projectId: 'no', deadlineDay: '2027-06-01' }), // after the window
    task('exam', { projectId: 'dl', tagIds: ['ev'], dueWithTime: at(2026, 12, 9, 9, 0) }),
    task('pastEvent', { projectId: 'dl', tagIds: ['ev'], dueWithTime: at(2026, 10, 1, 9, 0) }),
  ];
  const v = L.buildView(t, projects, tags, NOW);
  const span = L.timelineSpan(NOW, '3m', 0);
  const out = L.timelineLanes(v.withDeadline.concat(v.dates), span, 900, projects, 240);
  assert.equal(out.later, 1);
  assert.deepEqual(out.lanes.map((l) => l.project), ['02456 Deep Learning', '42115 Network Optimization']);
  const dl = out.lanes[0];
  const row = (id) => dl.items.find((p) => p.item.id === id).row;
  assert.equal(row('a'), 0);
  assert.equal(row('b'), 1);
  assert.equal(dl.rows >= 2, true);
  assert.equal(dl.items.some((p) => p.item.id === 'pastEvent'), false);
  const no = out.lanes[1];
  const old = no.items.find((p) => p.item.id === 'old');
  assert.equal(old.x, 0);
  assert.equal(old.pinned, true);
  const xA = dl.items.find((p) => p.item.id === 'a').x;
  assert.ok(Math.abs(xA - (43 + 0.5) / 91) < 1e-9); // 4 Dec is day 43 from 22 Oct

  // Near the right edge the label flips to the left of its marker.
  const edge = L.timelineLanes(
    L.buildView([task('e', { deadlineDay: '2027-01-19' })], projects, tags, NOW).withDeadline, span, 900, projects, 240);
  assert.equal(edge.lanes[0].items[0].alignRight, true);
});

test('settings: timeline range is validated', () => {
  assert.equal(L.withDefaults({ timelineRange: '6m' }).timelineRange, '6m');
  assert.equal(L.withDefaults({ timelineRange: '2y' }).timelineRange, '3m');
});

test('menu actions: planning sets the planned day only, never the deadline', () => {
  const t = task('a', { deadlineWithTime: at(2026, 12, 6, 8, 0) });
  const today = L.taskUpdateFor('today', t, NOW);
  assert.deepEqual(today.update, { dueDay: '2026-10-30' });
  assert.deepEqual(today.undo, { dueDay: null });
  assert.equal(today.label, 'Planned for today');
  assert.deepEqual(L.taskUpdateFor('tomorrow', t, NOW).update, { dueDay: '2026-10-31' });
  assert.deepEqual(L.taskUpdateFor('nextWeek', t, NOW).update, { dueDay: '2026-11-02' }); // next Monday
  assert.deepEqual(L.taskUpdateFor('nextWeek', t, NOW, { weekStart: 0 }).update, { dueDay: '2026-11-01' }); // next Sunday
  assert.equal(L.nextWeekStart(at(2026, 11, 2, 9, 0), 1), '2026-11-09'); // on a Monday: the following one
  const picked = L.taskUpdateFor('pickDate', t, NOW, { dateFormat: 'dd/mm' }, '2026-11-18');
  assert.deepEqual(picked.update, { dueDay: '2026-11-18' });
  assert.equal(picked.label, 'Planned for 18/11');
  assert.equal(L.taskUpdateFor('pickDate', t, NOW, {}, 'nope'), null);

  // A planned time is cleared so day and time don't conflict; undo restores it.
  const timed = task('b', { dueWithTime: at(2026, 11, 3, 10, 0) });
  const r = L.taskUpdateFor('today', timed, NOW);
  assert.deepEqual(r.update, { dueDay: '2026-10-30', dueWithTime: null });
  assert.deepEqual(r.undo, { dueDay: null, dueWithTime: at(2026, 11, 3, 10, 0) });
});

test('menu actions: unplan, done, deadlines', () => {
  assert.equal(L.taskUpdateFor('unplan', task('x'), NOW), null);
  assert.deepEqual(L.taskUpdateFor('unplan', task('x', { dueDay: '2026-11-02' }), NOW).update, { dueDay: null });

  const done = L.taskUpdateFor('done', task('x'), NOW);
  assert.deepEqual(done.update, { isDone: true, doneOn: NOW });
  assert.equal(done.undo.isDone, false);
  assert.ok('doneOn' in done.undo && done.undo.doneOn === undefined);
  assert.equal(L.taskUpdateFor('done', task('x', { isDone: true }), NOW), null);

  const withTime = L.taskUpdateFor('setDeadline', task('x', { deadlineDay: '2026-11-01' }), NOW, {}, { date: '2026-12-06', time: '08:00' });
  assert.deepEqual(withTime.update, { deadlineWithTime: at(2026, 12, 6, 8, 0), deadlineDay: null });
  assert.deepEqual(withTime.undo, { deadlineWithTime: null, deadlineDay: '2026-11-01' });
  assert.equal(withTime.label, 'Deadline Sun 6 Dec 08:00');
  const dayOnly = L.taskUpdateFor('setDeadline', task('x', { deadlineWithTime: 5 }), NOW, {}, { date: '2026-12-06', time: '' });
  assert.deepEqual(dayOnly.update, { deadlineDay: '2026-12-06', deadlineWithTime: null });
  assert.equal(L.taskUpdateFor('setDeadline', task('x'), NOW, {}, { date: '' }), null);

  assert.equal(L.taskUpdateFor('removeDeadline', task('x'), NOW), null);
  assert.deepEqual(L.taskUpdateFor('removeDeadline', task('x', { deadlineDay: '2026-12-06' }), NOW).update, { deadlineDay: null });
  assert.equal(L.taskUpdateFor('explode', task('x'), NOW), null);
});

test('legend: the "soon" label follows the setting', () => {
  assert.equal(L.soonLabel(7), 'Within 7 days');
  assert.equal(L.soonLabel(1), 'Within 1 day');
  assert.equal(L.soonLabel(0), 'Due today');
});
