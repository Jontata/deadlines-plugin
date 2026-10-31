// Keep native vertical scrolling and pinch gestures; horizontal drags change month.
export function bindCalendarSwipe(container, navigate) {
  let drag = null;
  let suppressClickUntil = 0;
  const harness = () => container.querySelector('.calendar-view');
  const reset = () => {
    const content = harness();
    if (content) content.style.transform = '';
  };
  container.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse') return;
    if (!event.isPrimary) { drag = null; reset(); return; }
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, started: performance.now(), horizontal: false };
  });
  container.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.horizontal) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 12) return;
      if (Math.abs(dy) >= Math.abs(dx)) { drag = null; return; }
      drag.horizontal = true;
      container.setPointerCapture(event.pointerId);
    }
    const content = harness();
    if (content) content.style.transform = 'translateX(' + Math.max(-120, Math.min(120, dx * 0.6)) + 'px)';
  });
  container.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const gesture = drag;
    drag = null;
    reset();
    if (!gesture.horizontal) return;
    suppressClickUntil = performance.now() + 400;
    const dx = event.clientX - gesture.x;
    const quick = performance.now() - gesture.started < 300 && Math.abs(dx) >= 45;
    if (quick || Math.abs(dx) >= Math.max(60, container.clientWidth * 0.18)) navigate(dx < 0 ? 1 : -1);
  });
  container.addEventListener('pointercancel', () => { drag = null; reset(); });
  container.addEventListener('click', event => {
    if (performance.now() >= suppressClickUntil) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}
