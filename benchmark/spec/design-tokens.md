# Design tokens

Exact visual specification for the todo app. Together with `design.png` (1280×800) and
`design-mobile.png` (390×844) this is everything needed to reproduce the design pixel for pixel.
Both images show the `design` fixture set from `fixtures.json` with the **All** filter selected.

The design is deliberately plain: no gradients, no shadows, no transitions or animations, no icons
or images, light theme only. Do not add decoration that is not described here.

## Typography

| Token | Value |
|---|---|
| Font family | `'Inter', sans-serif`, loaded from the bundled `@fontsource/inter` package (import `@fontsource/inter/400.css`, `500.css`, `600.css`, `700.css`). No web font requests. |
| Base | 16px / line-height 24px, weight 400 |
| Font smoothing | `-webkit-font-smoothing: antialiased` |
| Heading `Todos` | 32px / 40px, weight 700, letter-spacing −0.5px (mobile: 28px / 36px) |
| Input and todo title text | 16px / 24px, weight 400 |
| Add button | 16px, weight 600 |
| Item buttons (Edit, Delete, Save, Cancel) | 14px / 20px, weight 500 |
| Filter buttons | 14px / 20px, weight 500 |
| Counter (`3 items left`), empty and loading text, alerts | 14px / 20px, weight 400 |

All form controls inherit the font (`font: inherit`). Use `box-sizing: border-box` everywhere and
remove the default `body` margin.

## Colors

| Token | Hex | Used for |
|---|---|---|
| page-bg | `#F3F4F6` | `body` background (fills the whole viewport) |
| surface | `#FFFFFF` | card, inputs, item buttons |
| text | `#111827` | heading, todo titles, input text |
| text-muted | `#6B7280` | counter, empty-state and loading text |
| text-secondary | `#4B5563` | Edit/Cancel button text, inactive filter text |
| placeholder | `#9CA3AF` | input placeholder; title of a completed todo |
| border | `#E5E7EB` | card border, form/footer separators, item button borders |
| border-strong | `#D1D5DB` | text input border |
| divider | `#F3F4F6` | line between todo rows |
| primary | `#2563EB` | Add and Save button background and border, checkbox accent, focus outline |
| primary-hover | `#1D4ED8` | primary button hover |
| on-primary | `#FFFFFF` | Add and Save button text |
| danger | `#DC2626` | Delete button text |
| filter-active-bg | `#EFF6FF` | selected filter background |
| filter-active-border | `#BFDBFE` | selected filter border |
| filter-active-text | `#1D4ED8` | selected filter text |
| alert-bg | `#FEF2F2` | error alert background |
| alert-border | `#FECACA` | error alert border |
| alert-text | `#B91C1C` | error alert text |

## Layout (desktop, viewport width > 480px)

* **Page container** (`main`): `max-width: 592px`, centered with `margin: 0 auto`, padding
  `64px 16px 48px`. Content width is therefore 560px (x = 360 to 920 at 1280px wide).
* **Heading** `Todos`: top at y = 64, height 40, `margin: 0 0 24px`.
* **Card**: starts at y = 128. White, `1px solid #E5E7EB` border, `border-radius: 12px`,
  `overflow: hidden`, no shadow. Its sections are stacked vertically in this order:
  1. **New-todo form**: `display: flex; gap: 8px; padding: 16px`, bottom border `1px solid #E5E7EB`.
     * Text input: flexible width, height 44px, padding `0 12px`, border `1px solid #D1D5DB`,
       radius 8px, placeholder text `What needs to be done?`.
     * `Add` button: height 44px, padding `0 20px`, background and border `#2563EB`, white text,
       radius 8px (about 73px wide).
  2. **Error alert** (only when there is an error; absent in the reference images):
     `margin: 12px 16px; padding: 10px 12px`, background `#FEF2F2`, border `1px solid #FECACA`,
     radius 8px, text `#B91C1C`.
  3. **Todo list**: `ul` with no bullets, margin or padding. Each row:
     * `display: flex; align-items: center; gap: 12px; padding: 12px 16px; min-height: 56px`.
     * Rows after the first have a top border `1px solid #F3F4F6` (rows are 56px + 1px divider).
     * Checkbox: native `input type="checkbox"`, 20×20px, `margin: 0`, `accent-color: #2563EB`.
     * Title: `flex: 1; min-width: 0`, wraps long words (`overflow-wrap: anywhere`).
       Completed: color `#9CA3AF` and `text-decoration: line-through`.
     * Actions on the right: `display: flex; gap: 8px`. Buttons `Edit` and `Delete`: height 32px,
       padding `0 10px`, border `1px solid #E5E7EB`, radius 6px, white background; Edit text
       `#4B5563`, Delete text `#DC2626`. They are always visible (not only on hover).
     * Edit mode replaces the row content with: a text input (flexible width, height 32px, padding
       `0 8px`, radius 6px, same border/colors as the main input), then `Save` (primary colors) and
       `Cancel` (like Edit) buttons, in the same 32px button style.
  4. **Empty or loading message** (instead of rows): centered text, padding `32px 16px`, 14px,
     `#6B7280`.
  5. **Footer**: `display: flex; justify-content: space-between; align-items: center;
     padding: 12px 16px`, top border `1px solid #E5E7EB`.
     * Left: counter text (`3 items left`), 14px, `#6B7280`.
     * Right: filter buttons `All`, `Active`, `Completed` with `gap: 4px`. Each: height 32px,
       padding `0 12px`, radius 6px, `1px solid transparent` border, transparent background,
       text `#4B5563`. The selected filter has background `#EFF6FF`, border `#BFDBFE` and text
       `#1D4ED8`.

### Measured boxes in `design.png` (1280×800, x,y width×height in CSS px)

| Element | Box |
|---|---|
| `h1` | 360,64 560×40 |
| Card | 360,128 560×420 |
| New-todo form | 361,129 558×77 |
| New-todo input | 377,145 445×44 |
| Add button | 830,145 73×44 |
| Rows | y = 206 (56 high), 262, 319, 376, 433 (57 high incl. divider) |
| First checkbox | 377,224 20×20 |
| First row Edit / Delete | 783,218 47×32 / 838,218 65×32 |
| Footer | 361,490 558×57 |
| Counter text | 377,509 |
| Filters All / Active / Completed | 685,503 43×32 / 732,503 68×32 / 804,503 99×32 |

## Layout (mobile, viewport width ≤ 480px; reference 390×844)

Same structure with these overrides:

* Page container padding `32px 16px 32px`, so the card spans x = 16 to 374 (358px wide).
* Heading 28px / 36px with `margin-bottom: 16px` (heading at y = 32, card at y = 84).
* Form padding `12px`; todo row padding `12px`; footer padding `12px`.
* Filter buttons padding `0 10px`.

### Measured boxes in `design-mobile.png` (390×844)

| Element | Box |
|---|---|
| `h1` | 16,32 358×36 |
| Card | 16,84 358×412 |
| New-todo input | 29,97 251×44 |
| Add button | 288,97 73×44 |
| Rows | y = 154 (56 high), 210, 267, 324, 381 (57 high) |
| First row Edit / Delete | 241,166 47×32 / 296,166 65×32 |
| Footer | 17,438 356×57 |
| Filters All / Active / Completed | 155,451 39×32 / 198,451 64×32 / 266,451 95×32 |

## States and interaction styling

* Focus: visible `2px solid #2563EB` outline (text inputs: `outline-offset: -1px` and border
  `#2563EB`; buttons and checkboxes: `outline-offset: 2px`, on `:focus-visible`).
* Hover (not visible in the reference images): primary buttons `#1D4ED8`; item buttons `#F9FAFB`
  background; filters `#F3F4F6` background.
* No transitions, animations, transforms, shadows or gradients anywhere.
* The page has no other visible elements: no header bar, footer text, logos or icons.
