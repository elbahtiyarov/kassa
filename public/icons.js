// Касса — единый набор иконок (линейные SVG, цвет — var(--icon), ярко-фиолетовый).
// В разметке:  <i data-ic="bank"></i>  — заменяется на SVG при загрузке.
// В JS-шаблонах: ${ic("bank")}  или  ${ic("trash", "ic-sm")}.

const ICONS = {
  logo:     '<rect x="3" y="6" width="18" height="14" rx="2.5"/><path d="M3 10h18"/><path d="M7 6V4.5A1.5 1.5 0 0 1 8.5 3h7A1.5 1.5 0 0 1 17 4.5V6"/><circle cx="16" cy="15" r="1.6"/>',
  cash:     '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v.01M18 14.5v.01"/>',
  bank:     '<path d="M3 9.5 12 4l9 5.5"/><path d="M4.5 9.5h15"/><path d="M6 10v7M10 10v7M14 10v7M18 10v7"/><path d="M3.5 20h17"/>',
  orders:   '<rect x="5" y="4.5" width="14" height="16.5" rx="2"/><path d="M9 3h6v3H9z"/><path d="M8.5 11h7M8.5 14.5h7M8.5 18h4"/>',
  report:   '<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7" y="12" width="3" height="5" rx=".6"/><rect x="12" y="8" width="3" height="9" rx=".6"/><rect x="17" y="5" width="3" height="12" rx=".6"/>',
  recon:    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4"/><path d="M14 3v4h4"/><path d="M14 3l4 4v3"/><circle cx="16.5" cy="16.5" r="3"/><path d="m21 21-2.4-2.4"/><path d="M8 9h3M8 12.5h3"/>',
  backup:   '<ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6"/><path d="M5 11.5v4c0 1.1 1.9 2 4.5 2.3"/><path d="M17 15v6M14.5 18.5 17 21l2.5-2.5"/>',
  users:    '<circle cx="9" cy="8" r="3.2"/><path d="M3 19.5c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><circle cx="17" cy="9" r="2.4"/><path d="M16.5 14.6c2.3.2 4 1.7 4.5 4.4"/>',
  edit:     '<path d="M15.5 4.5 19.5 8.5 9 19H5v-4z"/><path d="m13.5 6.5 4 4"/>',
  trash:    '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6.5 7l1 13h9l1-13"/><path d="M10 11v5.5M14 11v5.5"/>',
  download: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4 16.5V19a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-2.5"/>',
  upload:   '<path d="M12 15V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M4 16.5V19a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-2.5"/>',
  transfer: '<path d="M4 8.5h15"/><path d="m15.5 5 3.5 3.5-3.5 3.5"/><path d="M20 15.5H5"/><path d="M8.5 12 5 15.5 8.5 19"/>',
  warn:     '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5"/><path d="M12 17.2v.01"/>',
  bulb:     '<path d="M9 17.5h6"/><path d="M10 20.5h4"/><path d="M12 3.5a5.8 5.8 0 0 0-3.4 10.5c.5.4.9 1 .9 1.7v1.8h5v-1.8c0-.7.4-1.3.9-1.7A5.8 5.8 0 0 0 12 3.5z"/>',
  check:    '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.8 2.8L16.2 9.5"/>',
  close:    '<path d="M6 6l12 12M18 6 6 18"/>',
  menu:     '<path d="M4 7h16M4 12h16M4 17h16"/>',
  sigma:    '<path d="M18 5H6l6 7-6 7h12"/>',
  file:     '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 12.5h7M8.5 16h5"/>',
  spinner:  '<path d="M12 3a9 9 0 1 0 9 9" class="ic-spin-path"/>',
  plus:     '<path d="M12 5v14M5 12h14"/>',
  search:   '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  arrowDown:'<path d="M12 5v14"/><path d="m6.5 13.5 5.5 5.5 5.5-5.5"/>',
  arrowUp:  '<path d="M12 19V5"/><path d="m6.5 10.5 5.5-5.5 5.5 5.5"/>',
  wallet:   '<path d="M19 7.5V6a2 2 0 0 0-2-2H5.5A2.5 2.5 0 0 0 3 6.5v11A2.5 2.5 0 0 0 5.5 20H19a2 2 0 0 0 2-2v-8.5a2 2 0 0 0-2-2H5.5"/><circle cx="16.5" cy="13.75" r="1.3"/>',
};

function ic(name, cls = "") {
  const body = ICONS[name];
  if (!body) return "";
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

// Заменяем <i data-ic="..."> в статической разметке
function hydrateIcons(root = document) {
  root.querySelectorAll("i[data-ic]").forEach(el => {
    el.outerHTML = ic(el.dataset.ic, el.className || "");
  });
}
hydrateIcons();
