# Keyboard and accessibility pass

## Problem

The app is dense interactive UI (panels, sliders, timeline, map) with
mouse/touch as the primary path. Keyboard and screen-reader access is
inconsistent.

## Research (current state)

- Timeline: a range input (`timeSet`) — range inputs have baseline
  keyboard support (arrows, home/end), but it's hidden during 2D and
  most users never find it; no space-to-play.
- `say()` writes a transient message div without `aria-live`, so screen
  readers miss the app's main feedback channel.
- Panels are collapsible sections toggled by clicks (chevrons); no
  `aria-expanded`, no Escape-to-close, focus is not moved on open.
- The map itself: Leaflet has built-in keyboard pan/zoom when focused.
- Colour is supported with text classes and patterns in legends; the
  depth/hazard ramps have text keys already.

## Design

1. **Timeline keys**: when the timeline is visible, Arrow
   Left/Right = step, Shift+Arrows = ±5 steps, Space = play/pause
   (Play button exists; reuse it), Home/End = first/last step. Bound on
   the timeline container with `tabindex=0` and a visible focus ring;
   ignore when focus is in an input.
2. **Live region**: `say()`'s element gets `role="status"`
   (implicitly `aria-live="polite"`) and the model-gate card gets
   `role="alertdialog"` semantics with focus moved to it when shown.
3. **Panels**: collapse toggles become real `button`s with
   `aria-expanded` + `aria-controls`; Escape closes the open panel;
   focus returns to the toggle on close.
4. **Map overlays**: tile/impact layer announcements are noise for
   screen readers; mark map panes `aria-hidden` (Leaflet already marks
   most controls) and give the legend text `aria-live=off`.
5. **Contrast/labels**: run axe-core in the smoke pass once and fix
   what it flags on the main panels (labels, duplicates, contrast on
   hint text).

## Test plan

- Extend the playwright smoke: keyboard-only timeline stepping asserts
  the visible step label changes; axe scan asserts no critical
  violations on the main view (threshold, not zero, to stay maintainable).

## Effort

M, mostly mechanical; the axe scan keeps it honest afterwards.
