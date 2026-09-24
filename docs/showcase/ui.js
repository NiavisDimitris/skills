/* design-qa showcase — UI builders.
   Everything is vector DOM so camera close-ins stay crisp at any zoom.
   Icons: lucide (ISC licence, https://lucide.dev). */
(function () {
  const I = {
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    dashboard: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
    receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    package: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 8.7 5 8.7-5"/>',
    fileText: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
    chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    sliders: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    retry: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
    pr: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
    merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
    circleCheck: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    circleX: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    frame: '<line x1="22" x2="2" y1="6" y2="6"/><line x1="22" x2="2" y1="18" y2="18"/><line x1="6" x2="6" y1="2" y2="22"/><line x1="18" x2="18" y1="2" y2="22"/>',
    ticket: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
    externalLink: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    dot: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  };
  const icon = (name, size = 16, cls = '') =>
    `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name]}</svg>`;

  const ROWS = [
    ['#1048', 'Maya Chen', 'Paid', '$1,284.00', 'Sep 21, 2026', '2 min ago'],
    ['#1047', 'Jonas Weber', 'Pending', '$312.50', 'Sep 21, 2026', '14 min ago'],
    ['#1046', 'Aisha Karim', 'Shipped', '$2,049.90', 'Sep 20, 2026', '1 h ago'],
    ['#1045', "Liam O'Neill", 'Paid', '$89.00', 'Sep 20, 2026', '3 h ago'],
    ['#1044', 'Sofia Rossi', 'Refunded', '$540.00', 'Sep 19, 2026', 'Yesterday'],
    ['#1043', 'Daniel Park', 'Paid', '$1,120.75', 'Sep 19, 2026', 'Yesterday'],
    ['#1042', 'Elena Petrova', 'Shipped', '$76.20', 'Sep 18, 2026', '2 days ago'],
    ['#1041', 'Noah Williams', 'Pending', '$658.00', 'Sep 18, 2026', '2 days ago'],
  ];
  // What shipped renders live data, so names, amounts and dates differ from the Figma sample on purpose.
  const APP_ROWS = [
    ['#2291', 'Lena Ortiz', 'Paid', '$312.40', 'Sep 24, 2026', 'just now'],
    ['#2290', 'Tomás Rivera', 'Shipped', '$1,907.15', 'Sep 24, 2026', '6 min ago'],
    ['#2289', 'Priya Nair', 'Pending', '$58.00', 'Sep 23, 2026', '1 h ago'],
    ['#2288', 'Oskar Lind', 'Paid', '$740.90', 'Sep 23, 2026', '2 h ago'],
    ['#2287', 'Chloé Martin', 'Refunded', '$215.00', 'Sep 23, 2026', 'Yesterday'],
    ['#2286', 'Kenji Watanabe', 'Paid', '$3,480.00', 'Sep 22, 2026', 'Yesterday'],
    ['#2285', 'Amara Okafor', 'Shipped', '$96.75', 'Sep 22, 2026', '2 days ago'],
    ['#2284', 'Jakub Nowak', 'Pending', '$1,120.00', 'Sep 21, 2026', '2 days ago'],
  ];
  const LONG = ['Maximilian Alexander von Hohenberg-Castellane', 'Anna-Katharina Schmidt-Oberländer'];

  const badge = (s) => `<span class="st st-${s.toLowerCase()}">${s}</span>`;
  const checkbox = (on) => `<span class="cb${on ? ' on' : ''}">${on ? icon('check', 11) : ''}</span>`;

  /* The Acme Console "Orders" page at 1440×900.
     variant: 'design' (the Figma frame) | 'app' (what shipped).
     state: with-data | empty | loading | error | hover | focus | selected | bulk | long */
  function acme(opts = {}) {
    const app = opts.variant === 'app';
    const st = opts.state || 'with-data';
    const selectable = st === 'selected' || st === 'bulk';
    const cols = ['Order', 'Customer', 'Status', 'Total', 'Created'].concat(app ? ['Updated'] : []);
    const head = `<tr data-a="thead">${selectable ? `<th class="c-cb">${checkbox(st === 'bulk')}</th>` : ''}${cols
      .map((c, i) => `<th class="${c === 'Total' ? 'r' : ''}"${c === 'Updated' ? ' data-a="col-updated"' : ''}>${c}</th>`)
      .join('')}</tr>`;
    let body = '';
    const colspan = cols.length + (selectable ? 1 : 0);
    if (st === 'empty') {
      body = app
        ? `<tr><td colspan="${colspan}" class="empty-app" data-a="empty-body"></td></tr>`
        : `<tr><td colspan="${colspan}" class="empty-design" data-a="empty-body"><div class="empty-ill">${icon('inbox', 26)}</div><div class="empty-t">No orders yet</div><div class="empty-s">Orders appear here as soon as customers check out.</div><span class="btn sm">${icon('plus', 14)}Create order</span></td></tr>`;
    } else if (st === 'loading') {
      for (let r = 0; r < 6; r++) {
        body += `<tr class="sk-row"${r === 0 ? ' data-a="row-0"' : ''}>${cols
          .map((c, i) => `<td${c === 'Total' ? ' class="r"' : ''}><span class="sk" style="width:${[56, 120, 64, 72, 92, 70][i] || 60}px"></span></td>`)
          .join('')}</tr>`;
      }
    } else if (st === 'error') {
      body = `<tr><td colspan="${colspan}" class="err-cell" data-a="error"><div class="alert">${icon('alert', 18)}<div><div class="alert-t">Orders could not be loaded</div><div class="alert-s">The server returned 500 for /api/orders. Your filters are kept.</div></div><span class="btn outline sm">${icon('retry', 14)}Retry</span></div></td></tr>`;
    } else {
      (app ? APP_ROWS : ROWS).forEach((row, r) => {
        const cls = [];
        if (st === 'hover' && r === 2) cls.push('hover');
        if (st === 'focus' && r === 1) cls.push('focus');
        if ((st === 'selected' && r === 0) || (st === 'bulk' && r < 3)) cls.push('sel');
        const name = st === 'long' && r < 2 ? LONG[r] : row[1];
        const cells = [
          `<td class="mono">${row[0]}</td>`,
          `<td class="name"${r === 0 ? ' data-a="cust-0"' : ''}>${name}</td>`,
          `<td${r === 0 ? ' data-a="status-0"' : ''}>${badge(row[2])}</td>`,
          `<td class="r num"${r === 0 ? ' data-a="total-0"' : ''}>${row[3]}</td>`,
          `<td class="muted">${row[4]}</td>`,
        ].concat(app ? [`<td class="muted">${row[5]}</td>`] : []);
        body += `<tr class="${cls.join(' ')}" data-a="row-${r}">${selectable ? `<td class="c-cb">${checkbox(cls.includes('sel'))}</td>` : ''}${cells.join('')}</tr>`;
      });
    }
    const pager = `<div class="pager" data-a="pager"><span class="muted">${app ? '1–8 of 124' : 'Showing 1–8 of 124 orders'}</span><span class="pg">${icon('chevronLeft', 14)}</span>${app ? '' : '<span class="pg on">1</span><span class="pg">2</span><span class="pg">3</span><span class="pg muted">…</span><span class="pg">16</span>'}<span class="pg">${icon('chevronRight', 14)}</span></div>`;
    const nav = [['dashboard', 'Dashboard'], ['receipt', 'Orders', 1], ['users', 'Customers'], ['package', 'Products'], ['fileText', 'Invoices'], ['chart', 'Reports'], ['sliders', 'Settings']]
      .map(([ic, label, on]) => `<div class="nav${on ? ' on' : ''}">${icon(ic, 17)}<span>${label}</span></div>`)
      .join('');
    return `<div class="acme ${app ? 'is-app' : 'is-design'} st-${st}">
  <div class="a-top"><div class="a-logo"></div><b>Acme Console</b><div class="gsearch">${icon('search', 15)}<span>Search…</span><kbd>⌘K</kbd></div><div class="a-right">${icon('bell', 18)}<div class="avatar">MR</div></div></div>
  <div class="a-side">${nav}</div>
  <div class="a-main">
    <h1 data-a="title">Orders</h1>
    <div class="a-sub">Track, fulfil and refund customer orders.</div>
    <div class="a-toolbar" data-a="toolbar">
      <div class="input" data-a="search">${icon('search', 15)}<span>${app ? 'Search…' : 'Search orders'}</span></div>
      <div class="select">All statuses ${icon('chevronDown', 14)}</div>
      ${app ? pager : ''}
      <span class="btn" data-a="newbtn">${icon('plus', 15)}New order</span>
    </div>
    ${st === 'bulk' ? `<div class="bulkbar" data-a="bulkbar"><b>3 selected</b><span class="sep"></span><span>Export</span><span>Mark as shipped</span><span>Refund</span><span class="bx">${icon('x', 14)}</span></div>` : ''}
    <div class="a-card" data-a="card">
      <table data-a="table"><thead>${head}</thead><tbody>${body}</tbody></table>
      ${app ? '' : pager}
    </div>
  </div>
</div>`;
  }

  window.UI = { icon, acme, ROWS, badge };
})();
