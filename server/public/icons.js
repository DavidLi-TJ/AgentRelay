'use strict';
/* AgentRelay 内联图标库 —— 细线（1.5 stroke）、currentColor、无第三方依赖 */
(function () {
  const I = (paths, viewBox = '0 0 24 24') =>
    `<svg class="ic" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

  window.ICONS = {
    logo: I('<rect x="3" y="3" width="8" height="8" rx="2.2"/><rect x="13" y="13" width="8" height="8" rx="2.2"/><path d="M13 7h4a4 4 0 0 1 4 4v0M11 17H7a4 4 0 0 1-4-4v0"/>'),
    relay: I('<path d="M4 7h9"/><path d="M4 17h13"/><path d="M16 4l4 3-4 3"/><path d="M13 14l4 3-4 3"/>'),
    search: I('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
    wrench: I('<path d="M14.7 6.3a4.5 4.5 0 0 0-6.03 5.4L3 17.4V21h3.6l5.7-5.67a4.5 4.5 0 0 0 5.4-6.03L14.4 12.6l-3-3 3.3-3.3z"/>'),
    brain: I('<path d="M9.5 3.5A2.5 2.5 0 0 0 7 6v.3A3 3 0 0 0 4.5 9.2a3 3 0 0 0 .8 2A3 3 0 0 0 4 14a3 3 0 0 0 2.6 3c.2 1.7 1.6 3 3.4 3 1 0 1.9-.4 2.5-1.1V4.9c-.6-.9-1.7-1.4-3-1.4z"/><path d="M14.5 3.5A2.5 2.5 0 0 1 17 6v.3a3 3 0 0 1 2.5 2.9 3 3 0 0 1-.8 2 3 3 0 0 1 1.3 2.8 3 3 0 0 1-2.6 3c-.2 1.7-1.6 3-3.4 3-1 0-1.9-.4-2.5-1.1"/>'),
    gear: I('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2L5.5 5.5"/>'),
    image: I('<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-4.5-4.5L9 19"/>'),
    star: I('<path d="M12 3.2l2.6 5.4 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.4l5.9-.8z"/>'),
    heart: I('<path d="M12 20.5s-7.5-4.7-9.3-9.2C1.5 8.2 3.6 5 6.8 5c2 0 3.6 1.1 4.4 2.7.8-1.6 2.4-2.7 4.4-2.7 3.2 0 5.3 3.2 4.1 6.3-1.8 4.5-7.7 9.2-7.7 9.2z"/>'),
    coffee: I('<path d="M4 9h12v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M16 10h2.5a2.5 2.5 0 0 1 0 5H16"/><path d="M7.5 5.5v-2M11 5.5v-2"/>'),
    info: I('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 7.8v.4"/>'),
    up: I('<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>'),
    sun: I('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4M18.7 18.7l-1.4-1.4M6.7 6.7L5.3 5.3"/>'),
    moon: I('<path d="M20 13.5A8 8 0 0 1 10.5 4 8 8 0 1 0 20 13.5z"/>'),
    monitor: I('<rect x="3" y="4.5" width="18" height="12.5" rx="2"/><path d="M9 21h6M12 17.5V21"/>'),
    check: I('<path d="M4.5 12.5l5 5L19.5 7"/>'),
    x: I('<path d="M6 6l12 12M18 6L6 18"/>'),
    folder: I('<path d="M3 7a2 2 0 0 1 2-2h4l2.2 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    db: I('<ellipse cx="12" cy="5.5" rx="8" ry="2.8"/><path d="M4 5.5v6c0 1.6 3.6 2.8 8 2.8s8-1.2 8-2.8v-6"/><path d="M4 11.5v6c0 1.6 3.6 2.8 8 2.8s8-1.2 8-2.8v-6"/>'),
    alert: I('<path d="M12 3.5L2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.4"/>'),
    arrow: I('<path d="M6 18L18 6"/><path d="M9 6h9v9"/>'),
    refresh: I('<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4h-4"/>'),
    empty: I('<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/><path d="M13 7.5h3.5M7.5 13v3.5" stroke-dasharray="2.5 2.5"/>'),
  };
  window.icon = function icon(name, cls = '') {
    const svg = window.ICONS[name] || '';
    return cls ? svg.replace('class="ic"', `class="ic ${cls}"`) : svg;
  };
})();
