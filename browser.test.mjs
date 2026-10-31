// Run after building: npm run test:browser. Uses synthetic data in SP-like iframes.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const background = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8');
assert.ok(Buffer.byteLength(html) <= 100 * 1024, 'iframe HTML fits Super Productivity’s 100 KiB upload limit');
const artifacts = new URL('./artifacts/', import.meta.url);
const screenshots = new URL('./screenshots/', import.meta.url);
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const executablePath = process.env.DEADLINES_BROWSER || (existsSync(edge) ? edge : undefined);
let browser;

before(async () => {
  browser = await chromium.launch({ executablePath, headless: true });
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(screenshots, { recursive: true });
});
after(async () => { await browser?.close(); });

function installMock({ empty = false, settings = {} } = {}) {
  const today = new Date();
  const localDay = (offset = 0) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  };
  const at = (offset, hour, minute = 0) => new Date(
    today.getFullYear(), today.getMonth(), today.getDate() + offset, hour, minute,
  ).getTime();
  const task = (id, extra = {}) => ({
    id, title: id, projectId: 'study', isDone: false, tagIds: [], subTaskIds: [], ...extra,
  });
  const tasks = empty ? [] : [
    task('dated', { title: 'Write report', deadlineDay: localDay() }),
    task('timed', { title: 'Submit report', deadlineWithTime: at(0, 17, 45), dueDay: localDay(-1) }),
    task('appointment', { title: 'Study meeting', tagIds: ['fixed'], dueWithTime: at(1, 9) }),
    task('past-appointment', { title: 'Previous study meeting', tagIds: ['fixed'], dueWithTime: at(-1, 9) }),
    task('parent', { title: 'Research project', subTaskIds: ['child'] }),
    task('child', { title: 'Read paper', parentId: 'parent', deadlineDay: localDay(3) }),
    task('hostile', { title: '<img src=x onerror="window.__xss=1"> literal title', deadlineDay: localDay(), projectId: 'unsafe' }),
    task('old', { title: 'Old open deadline', deadlineDay: localDay(-180) }),
    task('future', { title: 'Distant deadline', deadlineDay: localDay(400) }),
  ];
  const state = {
    tasks,
    projects: [
      { id: 'study', title: 'Study', theme: { primary: '#4056a1' } },
      { id: 'unsafe', title: '<svg onload="window.__xss=1"> literal project' },
    ],
    settings,
    throwReads: false,
  };
  const calls = { reads: 0, updates: [], opened: [], settings: [] };
  window.__pluginMock = { state, calls, today: localDay(), later: localDay(5), at };
  window.PluginAPI = {
    getTasks: async () => {
      calls.reads += 1;
      if (state.throwReads) throw new Error('Synthetic read failure');
      return structuredClone(state.tasks);
    },
    getAllProjects: async () => structuredClone(state.projects),
    getAllTags: async () => [{ id: 'fixed', title: 'fixed' }, { id: 'meeting', title: 'meeting' }],
    loadSyncedData: async () => JSON.stringify(state.settings),
    persistDataSynced: async (raw, key) => {
      calls.settings.push({ raw, key });
      state.settings = JSON.parse(raw);
    },
    selectTask: async (id) => { calls.opened.push(id); },
    updateTask: async (id, update) => {
      calls.updates.push({ id, update: structuredClone(update) });
      state.tasks = state.tasks.map((entry) => entry.id === id ? { ...entry, ...update } : entry);
    },
  };
}

function installAssetHost({ source, failure }) {
  const iframe = document.querySelector('iframe');
  const host = { handler: null, requests: [], registrations: 0 };
  window.__assetHost = host;
  window.PluginAPI = {
    onMessage(handler) { host.handler = handler; host.registrations += 1; },
  };
  if (failure !== 'missing-background') new Function(source)();
  window.addEventListener('message', async event => {
    if (event.source !== iframe.contentWindow || event.data?.type !== 'PLUGIN_MESSAGE'
        || typeof event.data.messageId !== 'string') return;
    const { messageId, message } = event.data;
    host.requests.push(message);
    try {
      if (!host.handler) throw new Error('The Deadlines background plugin is missing.');
      if (failure === 'host-error') throw new Error('Synthetic library asset failure');
      const result = failure === 'invalid-payload'
        ? { css: 42, js: 'window.__bootstrapPayloadExecuted = true;' }
        : await host.handler(message);
      event.source.postMessage({ type: 'PLUGIN_MESSAGE_RESPONSE', messageId, result }, '*');
    } catch (error) {
      event.source.postMessage({ type: 'PLUGIN_MESSAGE_ERROR', messageId, error: error.message }, '*');
    }
  });
}

async function openPlugin(t, { width = 1280, mobile = false, missingApi = false, assetFailure = null, ...options } = {}) {
  const context = await browser.newContext({
    viewport: { width, height: mobile ? 844 : 900 },
    timezoneId: 'Europe/Copenhagen', hasTouch: mobile, isMobile: mobile,
  });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    requests.push(route.request().url());
    await route.abort();
  });
  await page.clock.setFixedTime(new Date('2026-11-15T11:00:00Z'));
  await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><iframe name="plugin" title="Plugin" sandbox="allow-scripts allow-same-origin allow-forms allow-modals" style="display:block;border:0;width:100%;height:100vh"></iframe></body></html>');
  // Execute the archive's actual background entry and install SP's scoped message relay first.
  await page.evaluate(installAssetHost, { source: background, failure: assetFailure });
  const mock = missingApi ? '' : `<script>(${installMock.toString()})(${JSON.stringify(options)});</script>`;
  const theme = '<style>:root{--bg:#191b20;--card-bg:#242730;--text-color:#f0f1f3;--text-color-muted:#b7bbc5;--divider-color:#424651;--c-primary:#8fb1ff;--select-hover-bg:#353b48;--is-dark-theme:1}</style>';
  await page.evaluate((source) => { document.querySelector('iframe').srcdoc = source; }, html.replace('</head>', `${theme}${mock}</head>`));
  const frame = page.frame({ name: 'plugin' });
  await frame.waitForSelector('#tab-list');
  if (assetFailure) await frame.waitForFunction(() => document.getElementById('status').textContent.startsWith('Could not start Deadlines.'));
  else if (missingApi) await frame.waitForFunction(() => document.getElementById('status').textContent.includes('PluginAPI is missing'));
  else await frame.waitForFunction(() => document.getElementById('count-deadline').textContent !== '');
  return { page, frame, errors, requests };
}

async function selectView(frame, name) {
  await frame.locator(`#tab-${name}`).click();
  await frame.locator(`#view-${name}`).waitFor({ state: 'visible' });
  if (name === 'calendar') await frame.locator('#cal [role="table"]').waitFor();
  if (name === 'timeline') await frame.locator('#tl .vis-timeline').waitFor();
}

async function calendarTask(frame, id) {
  const task = frame.locator(`.deadline-event[data-task-id="${id}"]:visible`).first();
  if (!await task.count()) {
    const day = await frame.locator(`#cal [data-task-id="${id}"]`).first()
      .evaluate((node) => node.closest('[data-date]')?.dataset.date);
    await frame.locator(`.calendar-day[data-date="${day}"] .calendar-more`).click();
  }
  await task.waitFor({ state: 'visible' });
  return task;
}

async function refresh(frame, change = false) {
  const reads = await frame.evaluate((addTask) => {
    const mock = window.__pluginMock;
    if (addTask) mock.state.tasks = [...mock.state.tasks, {
      id: 'refresh-task', title: 'Added during refresh', projectId: 'study', isDone: false,
      tagIds: [], subTaskIds: [], deadlineDay: mock.later,
    }];
    const before = mock.calls.reads;
    window.dispatchEvent(new Event('focus'));
    return before;
  }, change);
  await frame.waitForFunction((before) => window.__pluginMock.calls.reads > before, reads);
  if (change) await frame.locator('#list-deadline [data-task-id="refresh-task"]').waitFor({ state: 'attached' });
}

async function healthy({ page, frame, errors, requests }) {
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  assert.deepEqual(requests, [], 'the packaged plugin makes no network requests');
  assert.equal(await frame.evaluate(() => window.__xss), undefined, 'titles are never interpreted as markup');
  assert.equal(await frame.locator('[data-task-id] img, [data-task-id] svg').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.__assetHost.requests), [{ type: 'deadlines-assets-v1' }]);
  assert.equal(await page.evaluate(() => window.__assetHost.registrations), 1, 'actual host plugin registers its asset handler');
}

async function noHorizontalOverflow(frame) {
  const sizes = await frame.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(sizes.document <= sizes.viewport + 1, `document fits: ${JSON.stringify(sizes)}`);
}

async function noVerticalOverflow(frame) {
  const sizes = await frame.evaluate(() => ({ viewport: innerHeight, document: document.documentElement.scrollHeight }));
  assert.ok(sizes.document <= sizes.viewport + 1, `document fits vertically: ${JSON.stringify(sizes)}`);
}

test('captures the default overview with example tasks', async (t) => {
  const { page, frame } = await openPlugin(t, { width: 1200 });
  await frame.evaluate(() => {
    const mock = window.__pluginMock;
    const day = (offset) => {
      const [year, month, date] = mock.today.split('-').map(Number);
      const value = new Date(year, month - 1, date + offset);
      return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
    };
    mock.state.projects = [
      { id: 'product', title: 'Product', theme: { primary: '#6174d1' } },
      { id: 'design', title: 'Design', theme: { primary: '#259c87' } },
      { id: 'operations', title: 'Operations', theme: { primary: '#c68a30' } },
    ];
    mock.state.tasks = [
      { id: 'sprint', title: 'Finalize sprint goals', projectId: 'product', isDone: false, tagIds: [], subTaskIds: [], deadlineDay: day(0) },
      { id: 'launch', title: 'Review launch checklist', projectId: 'operations', isDone: false, tagIds: [], subTaskIds: [], deadlineWithTime: mock.at(2, 11, 30) },
      { id: 'feedback', title: 'Send design feedback', projectId: 'design', isDone: false, tagIds: [], subTaskIds: [], deadlineDay: day(4) },
      { id: 'search', title: 'Refine search filters', projectId: 'product', isDone: false, tagIds: [], subTaskIds: [] },
      { id: 'notes', title: 'Draft release notes', projectId: 'operations', isDone: false, tagIds: [], subTaskIds: [] },
      { id: 'interview', title: 'Customer interview', projectId: 'design', isDone: false, tagIds: ['fixed'], subTaskIds: [], dueWithTime: mock.at(1, 10) },
      { id: 'planning', title: 'Team planning', projectId: 'product', isDone: false, tagIds: ['fixed'], subTaskIds: [], dueWithTime: mock.at(3, 9) },
    ];
  });
  await refresh(frame);
  await frame.locator('#list-deadline li.task').first().waitFor();
  await page.screenshot({
    path: new URL('./screenshots/overview.png', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
    clip: { x: 0, y: 0, width: 1200, height: 320 },
  });
});

async function settledTimelineProjection(frame) {
  await frame.waitForFunction(() => {
    const end = document.getElementById('month-label').textContent.split(' – ')[1];
    const hint = document.getElementById('tl-hint').textContent;
    const task = document.querySelector('#tl .timeline-task[data-task-id="old"]');
    const item = task?.closest('.vis-item');
    const panel = document.querySelector('#tl .vis-panel.vis-center');
    if (!end || !hint.endsWith('after ' + end) || !item?.classList.contains('pinned') || !panel) return false;
    const marker = (item.querySelector('.vis-dot') || item).getBoundingClientRect();
    const bounds = panel.getBoundingClientRect();
    return marker.width > 0 && marker.left >= bounds.left - 3 && marker.right <= bounds.right + 3
      && marker.top >= bounds.top && marker.bottom <= bounds.bottom;
  }, undefined, { timeout: 5000 });
}

test('calendar renders local dates safely and preserves navigation across refreshes', async (t) => {
  const fixture = await openPlugin(t);
  const { page, frame } = fixture;
  assert.equal(await frame.locator('#count-deadline').textContent(), '6');
  await selectView(frame, 'calendar');
  const day = await frame.evaluate(() => window.__pluginMock.today);
  const dated = frame.locator('#cal [data-task-id="dated"]').first();
  assert.equal(await dated.evaluate((node) => node.closest('[data-date]')?.dataset.date), day);
  assert.match(await frame.locator('#cal [data-task-id="timed"]').first().textContent(), /17:45/);
  assert.match(await frame.locator('#cal [data-task-id="hostile"]').first().textContent(), /<img src=x/);
  await (await calendarTask(frame, 'dated')).click();
  assert.deepEqual(await frame.evaluate(() => window.__pluginMock.calls.opened), ['dated']);
  await (await calendarTask(frame, 'dated')).focus();
  await page.keyboard.press('Enter');
  await frame.waitForFunction(() => window.__pluginMock.calls.opened.length >= 2);
  assert.deepEqual(await frame.evaluate(() => window.__pluginMock.calls.opened), ['dated', 'dated']);
  await page.keyboard.press('Space');
  await frame.waitForFunction(() => window.__pluginMock.calls.opened.length >= 3);
  assert.deepEqual(await frame.evaluate(() => window.__pluginMock.calls.opened), ['dated', 'dated', 'dated']);
  const initial = await frame.locator('#month-label').textContent();
  await frame.locator('#next-month').click();
  await frame.waitForFunction((label) => document.getElementById('month-label').textContent !== label, initial);
  const moved = await frame.locator('#month-label').textContent();
  await page.mouse.move((await frame.locator('#cal').boundingBox()).x + 100, (await frame.locator('#cal').boundingBox()).y + 100);
  await page.mouse.wheel(0, 120);
  await frame.waitForFunction((label) => document.getElementById('month-label').textContent !== label, moved);
  const scrolled = await frame.locator('#month-label').textContent();
  await refresh(frame, true);
  assert.equal(await frame.locator('#month-label').textContent(), scrolled);
  await selectView(frame, 'list');
  await selectView(frame, 'calendar');
  assert.equal(await frame.locator('#month-label').textContent(), scrolled);
  await frame.locator('#this-month').click();
  await frame.waitForFunction((label) => document.getElementById('month-label').textContent === label, initial);
  await frame.evaluate(() => {
    window.__pluginMock.state.tasks.find((task) => task.id === 'appointment').tagIds = ['meeting'];
  });
  await refresh(frame);
  assert.equal(await frame.locator('#cal .deadline-event[data-task-id="appointment"]').count(), 0);
  await frame.locator('#settings-btn').click();
  assert.equal(await frame.locator('#opt-event-tags').inputValue(), 'fixed');
  await frame.locator('#opt-event-tags').selectOption('meeting');
  await frame.locator('#cal .deadline-event[data-task-id="appointment"]').waitFor();
  await frame.waitForFunction(() => window.__pluginMock.state.settings.eventTags?.[0] === 'meeting');
  await frame.locator('label:has(input[name="opt-week-start"][value="0"])').click();
  await frame.locator('#settings-done').click();
  await frame.waitForFunction(() => document.querySelector('#cal [role="columnheader"]')?.textContent.startsWith('Sun'));
  await noHorizontalOverflow(frame);
  await page.screenshot({ path: new URL('desktop-calendar.png', artifacts).pathname.replace(/^\/(\w:)/, '$1') });
  await healthy(fixture);
});

test('task menus keep planned days separate from deadlines and support undo', async (t) => {
  const fixture = await openPlugin(t);
  const { frame } = fixture;
  await selectView(frame, 'calendar');
  await (await calendarTask(frame, 'dated')).click({ button: 'right' });
  await frame.locator('.ctx').getByRole('menuitem', { name: 'Tomorrow', exact: true }).click();
  await frame.locator('.toast').getByRole('button', { name: 'Undo' }).waitFor();
  let mock = await frame.evaluate(() => ({ calls: window.__pluginMock.calls, task: window.__pluginMock.state.tasks.find((entry) => entry.id === 'dated'), today: window.__pluginMock.today }));
  assert.equal(mock.calls.updates.at(-1).id, 'dated');
  assert.ok(mock.calls.updates.at(-1).update.dueDay);
  assert.equal(mock.task.deadlineDay, mock.today);
  assert.equal('deadlineDay' in mock.calls.updates.at(-1).update, false);
  await frame.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await frame.waitForFunction(() => window.__pluginMock.calls.updates.length === 2);
  assert.equal(await frame.evaluate(() => window.__pluginMock.state.tasks.find((entry) => entry.id === 'dated').dueDay), null);
  await (await calendarTask(frame, 'timed')).click({ button: 'right' });
  await frame.locator('.ctx').getByRole('menuitem', { name: 'Change deadline…', exact: true }).click();
  const later = await frame.evaluate(() => window.__pluginMock.later);
  await frame.locator('.ctx input[type="date"]').fill(later);
  await frame.locator('.ctx input[type="time"]').fill('10:30');
  await frame.locator('.ctx').getByRole('button', { name: 'Set', exact: true }).click();
  await frame.waitForFunction(() => window.__pluginMock.calls.updates.length === 3);
  const changed = await frame.evaluate(() => ({
    task: window.__pluginMock.state.tasks.find((entry) => entry.id === 'timed'),
    call: window.__pluginMock.calls.updates.at(-1), expected: window.__pluginMock.at(5, 10, 30),
  }));
  assert.equal(changed.task.deadlineWithTime, changed.expected);
  assert.equal('dueDay' in changed.call.update, false);
  await frame.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await frame.waitForFunction(() => window.__pluginMock.calls.updates.length === 4);
  await (await calendarTask(frame, 'appointment')).click({ button: 'right' });
  assert.deepEqual(await frame.locator('.ctx [role="menuitem"]').allTextContents(), ['Open details', 'Mark as done']);
  await healthy(fixture);
});

test('timeline groups safe labels, pans without edits, and retains its window after refresh', async (t) => {
  const fixture = await openPlugin(t);
  const { page, frame } = fixture;
  await selectView(frame, 'timeline');
  await frame.locator('#tl .timeline-task[data-task-id="dated"]').first().waitFor({ state: 'visible' });
  assert.match(await frame.locator('#tl').textContent(), /Study/);
  assert.match(await frame.locator('#tl .timeline-task[data-task-id="hostile"]').first().textContent(), /<img src=x/);
  await frame.locator('#tl .timeline-task[data-task-id="old"]').first().waitFor({ state: 'visible' });
  assert.match(await frame.locator('#tl-hint').textContent(), /1 more after/);
  const initial = await frame.locator('#month-label').textContent();
  const rect = await frame.locator('#tl').boundingBox();
  await page.mouse.move(rect.x + rect.width * 0.8, rect.y + rect.height - 25);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * 0.45, rect.y + rect.height - 25, { steps: 14 });
  await page.mouse.up();
  await frame.waitForFunction((label) => document.getElementById('month-label').textContent !== label, initial);
  await settledTimelineProjection(frame);
  const moved = await frame.locator('#month-label').textContent();
  await refresh(frame, true);
  assert.equal(await frame.locator('#month-label').textContent(), moved);
  assert.deepEqual(await frame.evaluate(() => window.__pluginMock.calls.updates), []);
  await frame.locator('[data-range="6m"]').click();
  assert.equal(await frame.locator('[data-range="6m"]').getAttribute('aria-pressed'), 'true');
  await frame.locator('#this-month').click();
  const reset = await frame.locator('#month-label').textContent();
  await frame.locator('#tl').focus();
  await page.keyboard.press('ArrowRight');
  await frame.waitForFunction((label) => document.getElementById('month-label').textContent !== label, reset);
  await settledTimelineProjection(frame);
  await noHorizontalOverflow(frame);
  await page.screenshot({ path: new URL('desktop-timeline.png', artifacts).pathname.replace(/^\/(\w:)/, '$1') });
  await healthy(fixture);
});

test('dragging a timeline task pans without opening it, while click and keyboard activation each open once', async (t) => {
  const fixture = await openPlugin(t);
  const { page, frame } = fixture;
  await selectView(frame, 'timeline');
  const task = frame.locator('#tl .timeline-task[data-task-id="dated"]').first();
  await task.waitFor({ state: 'visible' });
  for (const distance of [-140, 100]) {
    await frame.locator('#this-month').click();
    const before = await frame.locator('#month-label').textContent();
    const rect = await task.boundingBox();
    const start = { x: rect.x + 30, y: rect.y + rect.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + distance, start.y, { steps: 12 });
    await page.mouse.up();
    await frame.waitForFunction((label) => document.getElementById('month-label').textContent !== label, before);
    assert.deepEqual(await frame.evaluate(() => window.__pluginMock.calls.opened), [], `${distance}px task drag only pans`);
  }
  await frame.locator('#this-month').click();
  await task.click();
  await frame.waitForFunction(() => window.__pluginMock.calls.opened.length >= 1);
  assert.deepEqual(await frame.evaluate(() => window.__pluginMock.calls.opened), ['dated']);
  await task.focus();
  await page.keyboard.press('Enter');
  await frame.waitForFunction(() => window.__pluginMock.calls.opened.length >= 2);
  assert.deepEqual(await frame.evaluate(() => window.__pluginMock.calls.opened), ['dated', 'dated']);
  await page.keyboard.press('Space');
  await frame.waitForFunction(() => window.__pluginMock.calls.opened.length >= 3);
  assert.deepEqual(await frame.evaluate(() => window.__pluginMock.calls.opened), ['dated', 'dated', 'dated']);
  await healthy(fixture);
});

test('urgency colours belong to deadlines, including when appointments are past or soon', async (t) => {
  const fixture = await openPlugin(t);
  const { frame } = fixture;
  const urgency = /(?:^|\s)(?:soon|overdue)(?:\s|$)/;
  await selectView(frame, 'calendar');
  for (const id of ['appointment', 'past-appointment']) {
    const className = await frame.locator(`#cal .deadline-event[data-task-id="${id}"]`).first().getAttribute('class');
    assert.doesNotMatch(className, urgency, `${id} has no calendar deadline urgency`);
  }
  assert.match(await frame.locator('#cal .deadline-event[data-task-id="dated"]').first().getAttribute('class'), urgency);
  await selectView(frame, 'timeline');
  for (const id of ['appointment', 'past-appointment']) {
    const className = await frame.locator(`#tl .timeline-task[data-task-id="${id}"]`).first()
      .evaluate((node) => node.closest('.vis-item').className);
    assert.doesNotMatch(className, urgency, `${id} has no timeline deadline urgency`);
  }
  const deadlineClass = await frame.locator('#tl .timeline-task[data-task-id="dated"]').first()
    .evaluate((node) => node.closest('.vis-item').className);
  assert.match(deadlineClass, urgency);
  await healthy(fixture);
});

async function touch(client, points) {
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...points[0], id: 1 }] });
  for (const point of points.slice(1)) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, id: 1 }] });
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('phone iframe supports horizontal calendar swipes and task long press', async (t) => {
  const fixture = await openPlugin(t, { width: 390, mobile: true });
  const { page, frame } = fixture;
  const toolbar = await frame.evaluate(() => ({
    tabs: document.querySelector('.tabs').getBoundingClientRect(),
    settings: document.getElementById('settings-btn').getBoundingClientRect().top,
  }));
  assert.ok(Math.abs(toolbar.tabs.top - toolbar.settings) <= 2, 'settings stays on the tabs row on phone');
  await selectView(frame, 'calendar');
  const navWidth = await frame.locator('#cal-nav').evaluate((node) => node.getBoundingClientRect().width);
  assert.ok(navWidth >= 360, `calendar navigation fills the phone width: ${navWidth}px`);
  await noHorizontalOverflow(frame);
  const before = await frame.locator('#month-label').textContent();
  const rect = await frame.locator('#cal').boundingBox();
  const client = await page.context().newCDPSession(page);
  const points = Array.from({ length: 12 }, (_, index) => ({
    x: rect.x + rect.width * (0.85 - 0.65 * index / 11), y: rect.y + rect.height * 0.7,
  }));
  await touch(client, points);
  await frame.waitForFunction((label) => document.getElementById('month-label').textContent !== label, before);
  assert.deepEqual(await frame.evaluate(() => window.__pluginMock.calls.opened), []);
  await frame.locator('#this-month').click();
  const item = await calendarTask(frame, 'dated');
  await item.scrollIntoViewIfNeeded();
  const itemRect = await item.boundingBox();
  const holdStarted = Date.now();
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: itemRect.x + itemRect.width / 2, y: itemRect.y + itemRect.height / 2, id: 1 }],
  });
  await frame.locator('.ctx').waitFor({ state: 'visible', timeout: 2500 });
  // A long hold must still suppress the release click after the menu's timer has elapsed.
  await new Promise(resolve => setTimeout(resolve, Math.max(0, 1800 - (Date.now() - holdStarted))));
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await frame.evaluate(() => window.__pluginMock.calls.opened), []);
  await page.keyboard.press('Escape');
  await frame.locator('#settings-btn').click();
  await frame.locator('#settings').waitFor({ state: 'visible' });
  await noHorizontalOverflow(frame);
  await frame.locator('#settings-done').click();
  await page.screenshot({ path: new URL('phone-calendar.png', artifacts).pathname.replace(/^\/(\w:)/, '$1') });
  await selectView(frame, 'timeline');
  await settledTimelineProjection(frame);
  await noVerticalOverflow(frame);
  await noHorizontalOverflow(frame);
  await page.screenshot({ path: new URL('phone-timeline.png', artifacts).pathname.replace(/^\/(\w:)/, '$1') });
  await healthy(fixture);
});

function spanDays(label) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dates = label.split(' – ').map(part => {
    const [, day, month, year = '2026'] = /^(\d+) (\w+)(?: (\d{4}))?$/.exec(part);
    return Date.UTC(Number(year), months.indexOf(month), Number(day));
  });
  return (dates[1] - dates[0]) / 86400000;
}

test('phone timeline pans and pinch-zooms without opening or changing tasks', async (t) => {
  const fixture = await openPlugin(t, { width: 390, mobile: true });
  const { page, frame } = fixture;
  await selectView(frame, 'timeline');
  const panel = frame.locator('#tl .vis-panel.vis-center').first();
  await panel.scrollIntoViewIfNeeded();
  const client = await page.context().newCDPSession(page);
  let rect = await panel.boundingBox();
  const initial = await frame.locator('#month-label').textContent();
  await touch(client, Array.from({ length: 12 }, (_, index) => ({
    x: rect.x + rect.width * (0.85 - 0.55 * index / 11),
    y: Math.min(rect.y + rect.height * 0.65, 760),
  })));
  await frame.waitForFunction((label) => document.getElementById('month-label').textContent !== label, initial);
  await settledTimelineProjection(frame);
  assert.deepEqual(await frame.evaluate(() => window.__pluginMock.calls.opened), []);
  await frame.locator('#this-month').click();
  const beforeZoom = await frame.locator('#month-label').textContent();
  rect = await panel.boundingBox();
  const center = { x: rect.x + rect.width / 2, y: Math.min(rect.y + rect.height * 0.65, 760) };
  const fingers = (distance) => [
    { x: center.x - distance, y: center.y, id: 1 },
    { x: center.x + distance, y: center.y, id: 2 },
  ];
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers(18) });
  for (let distance = 22; distance <= 66; distance += 4) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: fingers(distance) });
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await frame.waitForFunction((label) => document.getElementById('month-label').textContent !== label, beforeZoom);
  await settledTimelineProjection(frame);
  const afterZoom = await frame.locator('#month-label').textContent();
  assert.ok(spanDays(afterZoom) < spanDays(beforeZoom), `pinch shortens the visible range: ${beforeZoom} -> ${afterZoom}`);
  assert.deepEqual(await frame.evaluate(() => window.__pluginMock.calls.opened), []);
  assert.deepEqual(await frame.evaluate(() => window.__pluginMock.calls.updates), []);
  await noHorizontalOverflow(frame);
  await page.screenshot({ path: new URL('phone-timeline-zoom.png', artifacts).pathname.replace(/^\/(\w:)/, '$1') });
  await healthy(fixture);
});

test('empty data and API failures have visible states', async (t) => {
  const fixture = await openPlugin(t, { empty: true });
  await selectView(fixture.frame, 'calendar');
  assert.equal(await fixture.frame.locator('#cal [data-task-id]').count(), 0);
  await selectView(fixture.frame, 'timeline');
  await fixture.frame.locator('#tl-empty').waitFor({ state: 'visible' });
  await fixture.frame.evaluate(() => {
    window.__pluginMock.state.throwReads = true;
    window.dispatchEvent(new Event('focus'));
  });
  await fixture.frame.waitForFunction(() => document.getElementById('status').textContent.includes('Synthetic read failure'));
  await healthy(fixture);
  const missing = await openPlugin(t, { missingApi: true });
  assert.match(await missing.frame.locator('#status').textContent(), /PluginAPI is missing/);
  assert.deepEqual(missing.errors, []);
});

test('bootstrap asset errors remain visible and never start task loading', async (t) => {
  for (const assetFailure of ['missing-background', 'host-error', 'invalid-payload']) {
    const { page, frame, errors, requests } = await openPlugin(t, { assetFailure });
    assert.match(await frame.locator('#status').textContent(), /^Could not start Deadlines\. Re-upload the plugin ZIP\./);
    assert.equal(await frame.evaluate(() => window.__pluginMock.calls.reads), 0, assetFailure);
    assert.equal(await frame.evaluate(() => window.__bootstrapPayloadExecuted), undefined, 'invalid assets never execute');
    assert.equal(await frame.locator('style[data-deadlines-libraries]').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__assetHost.requests), [{ type: 'deadlines-assets-v1' }]);
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
  }
});
