'use strict';
/* 惯性滚动：Windows 桌面浏览器的滚轮是步进式无惯性，这里给应用内的滚动容器
   补一段速度衰减的滑行。触摸板自带惯性、prefers-reduced-motion、Ctrl 缩放均不接管。 */
(function () {
  try { if (matchMedia('(prefers-reduced-motion: reduce)').matches) return; } catch { return; }

  const CONTAINERS = '.session-list, .entries, .relay-src-list, .rail, .relay-wrap, .activity-wrap, .settings-wrap, .diag-wrap, .modal-card, .dir-list, .pv-list';

  let box = null;      // 当前滑行的容器
  let vel = 0;         // px / frame
  let raf = null;

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null; vel = 0; box = null;
  }

  function glide() {
    if (!box) return stop();
    box.scrollTop += vel;
    vel *= 0.94;
    const max = box.scrollHeight - box.clientHeight;
    const hitEdge = (box.scrollTop <= 0 && vel < 0) || (box.scrollTop >= max && vel > 0);
    if (Math.abs(vel) < 0.35 || hitEdge) return stop();
    raf = requestAnimationFrame(glide);
  }

  document.addEventListener('wheel', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.deltaMode !== 0) return;
    if (Math.abs(e.deltaY) >= Math.abs(e.deltaX) * 2 && e.deltaX !== 0) return; // 斜向/横向滚动手势
    const el = e.target && e.target.closest ? e.target.closest(CONTAINERS) : null;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    // 已在边界时交给原生（滚动链、overscroll 效果）
    if ((el.scrollTop <= 0 && e.deltaY < 0) || (el.scrollTop >= max && e.deltaY > 0)) { stop(); return; }
    // 小步长高频事件 = 触摸板（自带惯性），不接管
    if (Math.abs(e.deltaY) < 25) return;

    e.preventDefault();
    const sameBox = el === box;
    stop();
    box = el;
    // 立即响应完整滚距，另给一段滑行尾速；同方向连滚时叠加（封顶）
    el.scrollTop += e.deltaY;
    vel = Math.max(-64, Math.min(64, (sameBox ? vel : 0) * 0.5 + e.deltaY * 0.32));
    if (!raf) raf = requestAnimationFrame(glide);
  }, { passive: false });

  // 用户按下（拖滚动条/选中文字）立即停住滑行
  document.addEventListener('pointerdown', stop, { capture: true });
})();
