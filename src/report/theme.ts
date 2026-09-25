/**
 * The visual language shared by the report and the website: Flexoki colour
 * tokens for both themes, and the Lucide icon paths. One copy, so the site
 * cannot drift from the thing it shows.
 */

/* Colour tokens: light on :root, dark by preference or by explicit choice. */
export const THEME_TOKENS = `
:root {
  /*
   * Flexoki, by Steph Ango. An ink-on-paper palette: warm neutrals that hold
   * their character in both themes, and colours picked to sit on them without
   * shouting. Chosen over the cool blue-greys because a page full of code
   * should read like a printed page, not like a control panel.
   */
  --bg: #FFFCF0;          /* paper */
  --panel: #FFFCF0;
  --sunk: #F2F0E5;        /* base-50 */
  --ink: #100F0F;         /* black */
  --ink-soft: #403E3C;    /* base-800 */
  --muted: #6F6E69;       /* base-600 */
  --line: #DAD8CE;        /* base-150 */
  --line-strong: #B7B5AC; /* base-300 */
  --accent: #205EA6;      /* blue-600 */
  --accent-soft: #E1ECF7;
  --high: #AF3029;        /* red-600 */
  --medium: #AD8301;      /* yellow-600 */
  --low: #878580;         /* base-500 */
  --good: #66800B;        /* green-600 */

  /* Three bands, not a gradient: "clean", "some" and "mostly" have to be
     distinguishable at a glance in a map of four hundred boxes. */
  --heat0: #EDEBE0;
  --heat1: #E8C88A;
  --heat2: #C86A56;

  --focus-tint: color-mix(in srgb, var(--accent) 10%, transparent);
  --tok-comment: #878580;  /* base-500 */
  --tok-string: #66800B;   /* green-600 */
  --tok-keyword: #5E409D;  /* purple-600 */
  --tok-number: #BC5215;   /* orange-600 */
  --tok-type: #205EA6;     /* blue-600 */
  --tok-fn: #24837B;       /* cyan-600 */
  --tok-punct: #6F6E69;
  --tint-high: color-mix(in srgb, var(--high) 10%, transparent);
  --tint-medium: color-mix(in srgb, var(--medium) 13%, transparent);
  --tint-low: color-mix(in srgb, var(--low) 9%, transparent);

  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --step--1: 0.78rem;
  --step-0: 0.94rem;
  --step-1: 1.15rem;
  --step-2: 1.6rem;
  --step-3: 2.1rem;
}

/* Flexoki's dark side: the same ink, inverted. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #100F0F;          /* black */
    --panel: #1C1B1A;       /* base-950 */
    --sunk: #282726;        /* base-900 */
    --ink: #CECDC3;         /* base-200 */
    --ink-soft: #B7B5AC;    /* base-300 */
    --muted: #878580;       /* base-500 */
    --line: #343331;        /* base-850 */
    --line-strong: #575653; /* base-700 */
    --accent: #4385BE;      /* blue-400 */
    --accent-soft: #1A2733;
    --high: #D14D41;        /* red-400 */
    --medium: #D0A215;      /* yellow-400 */
    --low: #878580;
    --good: #879A39;        /* green-400 */
    --heat0: #2A2927;
    --heat1: #6E5A1E;
    --heat2: #8C3B31;
    --focus-tint: color-mix(in srgb, var(--accent) 18%, transparent);
    --tok-comment: #6F6E69;  /* base-600 */
    --tok-string: #879A39;   /* green-400 */
    --tok-keyword: #8B7EC8;  /* purple-400 */
    --tok-number: #DA702C;   /* orange-400 */
    --tok-type: #4385BE;     /* blue-400 */
    --tok-fn: #3AA99F;       /* cyan-400 */
    --tok-punct: #878580;
    --tint-high: color-mix(in srgb, var(--high) 14%, transparent);
    --tint-medium: color-mix(in srgb, var(--medium) 16%, transparent);
    --tint-low: color-mix(in srgb, var(--low) 12%, transparent);
  }
}
:root[data-theme="dark"] {
  --bg: #100F0F;
  --panel: #1C1B1A;
  --sunk: #282726;
  --ink: #CECDC3;
  --ink-soft: #B7B5AC;
  --muted: #878580;
  --line: #343331;
  --line-strong: #575653;
  --accent: #4385BE;
  --accent-soft: #1A2733;
  --high: #D14D41;
  --medium: #D0A215;
  --low: #878580;
  --good: #879A39;
  --heat0: #2A2927;
  --heat1: #6E5A1E;
  --heat2: #8C3B31;
  --focus-tint: color-mix(in srgb, var(--accent) 18%, transparent);
  --tok-comment: #6F6E69;
  --tok-string: #879A39;
  --tok-keyword: #8B7EC8;
  --tok-number: #DA702C;
  --tok-type: #4385BE;
  --tok-fn: #3AA99F;
  --tok-punct: #878580;
  --tint-high: color-mix(in srgb, var(--high) 14%, transparent);
  --tint-medium: color-mix(in srgb, var(--medium) 16%, transparent);
  --tint-low: color-mix(in srgb, var(--low) 12%, transparent);
}
`;

/** Lucide icons (ISC licence), inlined: a report is read offline. */
export const ICONS: Record<string, string> = {
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  grid: '<rect width="7" height="7" x="3" y="3"/><rect width="7" height="7" x="14" y="3"/>' +
        '<rect width="7" height="7" x="14" y="14"/><rect width="7" height="7" x="3" y="14"/>',
  network: '<rect x="16" y="16" width="6" height="6"/><rect x="2" y="16" width="6" height="6"/>' +
           '<rect x="9" y="2" width="6" height="6"/>' +
           '<path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/>' +
            '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/>',
  filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  ellipsis: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>' +
         '<path d="M12 9v4"/><path d="M12 17h.01"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
};

/** One icon, sized in ems so it follows the text beside it. */
export function iconSvg(name: string, extraClass = ''): string {
  const path = ICONS[name];
  if (!path) return '';
  return (
    `<svg class="icon${extraClass ? ` ${extraClass}` : ''}" viewBox="0 0 24 24" fill="none" ` +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
    `aria-hidden="true" focusable="false">${path}</svg>`
  );
}
