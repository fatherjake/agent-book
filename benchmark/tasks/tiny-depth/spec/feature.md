# Feature: Depth chart

## Summary

The order book card lists price levels, but it is hard to see at a glance how much liquidity sits
how far from the mid price. A **depth chart** plots it: cumulative bid size stepping down and to
the left of the mid price, cumulative ask size stepping up and to the right. Hovering the chart
reads out the depth at that price.

The chart uses the book data the UI already has for the selected market (the initial
`GET /book/<market>?levels=20` and the `book` frames on `/ws`), so no backend change is needed.

`/spec/depth.png` shows the finished card at desktop size: resting (left) and while hovering on the
bid side (right). Match its look: the existing card styling, the green/red of the order book, thin
lines, the 12px UI font.

Everything below is the contract. "Must" statements are checked.

## 1. The Depth tab

* The order book card's tab bar (`Order Book`, `Trades`, `Funding`, `Blocks`) gets a new tab
  button with the text **`Depth`**, placed directly after `Order Book`.
* `Order Book` stays the default tab, and every existing tab keeps working unchanged.
* Selecting `Depth` replaces the card body with the depth view (§2–§6) for the selected market.

## 2. Layout

From top to bottom, inside the card body:

1. A summary row: **`Mid`** followed by the mid price, and **`Spread`** followed by the spread
   and its percentage, formatted exactly as the order book's spread row does (`usd()` for prices,
   the percentage from `spreadMid()` in `ui/src/lib/series.ts`). When either side of the book is
   empty, mid and spread show `-`.
2. The **plot**, filling the remaining height and the full width of the card. The plot is one
   element with `role="img"` and the accessible name **`Depth chart`** (for example
   `<div role="img" aria-label="Depth chart">` wrapping an SVG or canvas). **The bounding box of
   that element is the plot area**: the x axis runs from its left edge to its right edge and the
   y axis from its bottom edge upwards. Draw any labels outside it or over it, but don't inset the
   axes inside it.
3. A price axis row under the plot showing the price at the left edge, at the centre and at the
   right edge of the x axis (`usd()`).

## 3. Axes and areas

All prices and sizes are the integer scaled values the API sends (`1_000_000` = 1.0, see
`ui/src/lib/scale.ts`). Every level in the book data is plotted (the API sends up to 20 per side).

* **Centre:** `(best bid + best ask) / 2` with integer division. If one side is empty, the centre
  is the best price of the side that is present.
* **X axis:** linear in price and symmetric around the centre. With
  `half = max(centre − lowest bid price, highest ask price − centre)` (ignoring an empty side), the
  left edge of the plot is `centre − half`, the right edge `centre + half`, so the centre is
  exactly in the middle of the plot.
* **Y axis:** linear in cumulative size from 0 at the bottom edge. The larger of the two final
  cumulative sizes reaches at most the top edge (leave a little headroom, as in the image).
* **Bid area:** cumulative bid size as a step area, starting at the best bid and stepping up at
  each lower bid level, continuing flat past the deepest bid to the left edge. Green
  (`#18803a` line, `rgb(27 138 62 / 32%)` fill, like the order book's depth bars).
* **Ask area:** the same for asks, from the best ask stepping up at each higher ask level and
  continuing flat to the right edge. Red (`#c62828` line, `rgb(198 40 40 / 32%)` fill).
* A dashed vertical line marks the centre.

## 4. Hover tooltip

* While the pointer is over the plot, a tooltip with `role="tooltip"` shows the level whose
  cumulative depth applies at the pointer's price (the price at the pointer's x position; the
  vertical position doesn't matter):
  * **Left of the centre (bid side):** the bid with the lowest price that is still `>=` the
    pointer's price. If there is none (the pointer is between the best bid and the centre), the
    best bid.
  * **Right of the centre (ask side):** the ask with the highest price that is still `<=` the
    pointer's price. If there is none (between the centre and the best ask), the best ask.
  * If the pointer is on a side that has no levels, no tooltip is shown.
* The tooltip contains, for that level:
  * the side: **`Bid`** or **`Ask`**
  * **`Price`** and the level's price, formatted with `usd()`
  * **`Total`** and the cumulative size from the best price up to and including this level,
    formatted with `fmt()`
  * **`Value`** and the cumulative notional from the best price up to and including this level,
    formatted with `usd()`. The notional of one level is `price × size / 1_000_000` (integer
    division per level, in the same scaled units); the cumulative value is the sum of those.

  For example, a bid level at `$49,996.00` whose cumulative size is `0.512000` and cumulative value
  `$25,598.12` must show `Bid`, `Price $49,996.00`, `Total 0.512000` and `Value $25,598.12`.
* A vertical crosshair line at the pointer is drawn while hovering (see the image).
* When the pointer leaves the plot, the tooltip and the crosshair disappear.

## 5. Live updates

* The chart always shows the latest book of the selected market: every new `book` frame for that
  market redraws the areas and recomputes the axes (including the centre, the range and the
  summary row) without needing a reload or a tab switch. An open tooltip reflects the new book on
  the next pointer move.
* Switching markets shows the newly selected market's book.

## 6. Empty book

* When the book has no levels on either side (or has not arrived yet), the card body shows the
  text **`No liquidity`** instead of the plot, and no tooltip is ever shown.
* When only one side has levels, the chart is drawn for that side as described in §3 (centred on
  its best price) and the other half of the plot stays empty.

## 7. Quality

* Put the depth computations (cumulative totals and values, the axis range, the level under a
  price) in a small module under `ui/src/lib/` with vitest unit tests, next to the existing ones.
* `npm run build` (type check and production build) must pass, the existing UI and Python tests
  must keep passing, and the page must not throw uncaught errors.
* Follow the repository's Prettier formatting.

## 8. Out of scope

Backend or API changes, zoom and pan, depth for markets other than the selected one, and
aggregating levels into price buckets.
