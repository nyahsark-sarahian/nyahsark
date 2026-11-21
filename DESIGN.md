# Nyah's Ark visual system

## Source and capture context

- Reference: https://nyahsark.com/
- Inspected: 2026-11-21 at a 1440 × 900 desktop viewport, plus the repository's responsive CSS and existing phone tests.
- Existing character retained: traditional Georgia-led typography, generous spacing, square public controls, devotional artwork photography, and the original ark-and-dove emblem.
- Existing observed palette before this change: blue-gray `#eaf0f4`, ink `#26353f`, wine `#601c2d`, pale blue `#dbe5ec`.

## Pink-led design direction

The interface is adult, warm, devotional, and distinctly pink-forward. Blush surfaces provide atmosphere; dark rose and plum carry actions and brand emphasis; restrained warm red adds depth. Product photography and the original logo artwork are not recolored.

### Public tokens

| Role | Token | Value |
| --- | --- | --- |
| Page | `--paper` | `#fff7fb` |
| Surface | `--surface` | `#fff0f6` |
| Strong surface | `--surface-strong` | `#f6dbe7` |
| Primary text | `--ink` | `#3a1d2d` |
| Secondary text | `--muted` | `#6f5363` |
| Primary action | `--wine` | `#8b1e52` |
| Brand rose | `--rose` | `#9b1b5a` |
| Brand plum | `--plum` | `#63295f` |
| Warm red | `--red` | `#8e253c` |
| Border | `--line` | `#e4bfd0` |
| Focus | `--focus` | `#8a1d54` |

The name uses nine individually colored letters that move from pink through plum to warm red (`#a51664` through `#63295f` to `#962c47`). Every letter has at least a 6.8:1 contrast ratio against the public page background. Primary buttons use the same three-point progression with solid white labels; secondary and utility buttons use a softer blush version. Forced-colors mode falls back to system link and button colors.

### Administrator tokens

The administrator uses the same semantic palette with softer paper cards and preserved functional colors for success and destructive actions. Controls remain at least 44 px high. Focus rings, error states, status badges, and reduced-motion behavior remain explicit.

## Typography and layout

- Public headings and body: Georgia / Times New Roman / serif.
- Public utility text and controls: Arial / sans-serif.
- Administrator body and controls: system UI; headings remain Georgia.
- Public content width, three/two/one-column gallery breakpoints, sticky header, administrator card layout, and phone breakpoints remain unchanged.

## Components

- Wordmark and visible brand-name instances: nine discrete pink-to-plum-to-warm-red letter shades with a system-color accessibility fallback.
- Primary buttons: matching three-stop pink/plum/warm-red gradient with white text; secondary and utility buttons use a soft blush gradient.
- Cards, filters, item panels, cart panels, and administrator panels: blush paper surfaces with rose borders.
- Quote panel: deep rose-to-plum gradient with pale pink text and a lighter per-letter pink/plum/red brand progression that remains AA-readable.
- Artwork and item-image wells: pale rose-neutral backgrounds that do not tint the images.
- Success and danger states: retain green and red semantic meaning instead of converting every status to pink.

## Image references

- Original emblem: `/public/logo.png`; preserved without generative or pixel edits.
- Catalog photographs: supplied public artwork images and managed WebP derivatives; never recolored by the theme.

## Implementation guidance

- Add future colors as semantic custom properties instead of isolated hex values.
- Keep brand gradients for identity moments, not long passages of copy.
- Preserve AA contrast, keyboard focus, forced-colors fallback, and reduced-motion behavior.
- Test public and administrator surfaces at phone and desktop widths after every palette change.
