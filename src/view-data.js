// Calendar day strings stay local; timed deadlines keep their exact instant.
export function calendarEvents(view) {
  return view.withDeadline.concat(view.dates).filter(item => item.day).map(item => ({
    id: item.id,
    title: item.title,
    start: item.allDay ? item.day : new Date(item.at),
    allDay: item.allDay,
    className: ['deadline-event', item.kind, item.kind === 'deadline' ? item.urgency : ''].filter(Boolean).join(' '),
    extendedProps: { item },
  }));
}

export function timelineData(view, span, projects) {
  const dated = view.withDeadline.concat(view.dates).filter(item => Number.isFinite(item.at));
  const visible = dated.filter(item => item.at < span.end && (item.at >= span.start || item.kind === 'deadline'));
  const order = new Map(projects.map((project, index) => [project.id, index]));
  const groups = Array.from(new Map(visible.map(item => [item.projectId || '__none', {
    id: item.projectId || '__none',
    name: item.project || 'Other tasks',
    color: item.projectColor,
    order: order.get(item.projectId) ?? projects.length,
  }])).values()).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const items = visible.map(item => {
    const pinned = item.at < span.start;
    const time = new Date(item.at);
    if (item.allDay) time.setHours(12, 0, 0, 0);
    return {
      id: item.id,
      group: item.projectId || '__none',
      start: pinned ? new Date(span.start + (span.end - span.start) * 0.015) : time,
      type: 'point',
      className: ['deadline-point', item.kind, item.kind === 'deadline' ? item.urgency : '', pinned ? 'pinned' : ''].filter(Boolean).join(' '),
      item,
      pinned,
    };
  });
  return { items, groups, later: dated.filter(item => item.at >= span.end).length };
}
