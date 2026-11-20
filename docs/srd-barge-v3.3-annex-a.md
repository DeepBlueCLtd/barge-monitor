# Annex A: Visual style
## Canal barge weather demonstrator SRD, Version 3.3

**Status:** Draft for review
**Author:** Doc
**Refines:** NFR-05 (large presentation display) and NFR-06 (light, document-like style)
in the main SRD.

---

## A.1 Intent

The demonstrator looks like a **hand-drawn architecture explainer**: ink on paper,
hand-lettered labels, sketch-edged boxes, coloured zones and labelled flows. The style
invites a stakeholder audience to read the architecture as a story, while the message
popups stay crisp and exact, so the evidence still looks rigorous.

**Status of the reference material.** Two references inform this annex: an externally
supplied hand-drawn system diagram, and the published mockup *Barge architecture
flowchart mockup*. Both are **illustrations of styling only**. Neither is a user
interface design to reproduce. Where either conflicts with the main SRD or this annex,
the SRD and this annex win. In particular:

- the fixed flowchart layout is the committed layout file (FR-51), not the mockup's
  placement;
- the reference diagram's pictures of hardware and characters are **not** part of the
  style (A.4).

---

## A.2 Typography

- **VS-01** A **hand-lettered display face** is used for component names, zone labels,
  panel titles, button labels, the tour and the key. The mockup uses Patrick Hand and
  Patrick Hand SC (small capitals for headings and zone labels); any comparably legible,
  openly licensed hand-lettered face is acceptable.
- **VS-02** A **monospace face** is used for message contents in popups and for code in the
  workspace. Message contents are never shown in the hand-lettered face.
- **VS-03** All fonts are **served from the site itself** (NFR-08), never from a font CDN.
  (The mockup loads Google Fonts for convenience only.)
- **VS-04** Minimum sizes on the target display (NFR-05), measured at its native
  resolution: component names 20 px, other labels and key entries 16 px, message
  letters 17 px, popup message contents 13 px. Where the target display needs larger
  sizes to stay legible from the viewing distance, sizes scale up together; they never
  shrink to fit.

## A.3 Palette

- **VS-05** **Paper and ink.** A warm off-white ground (mockup: `#fbfaf6`) and a near-black
  ink (mockup: `#23262d`) for outlines, arrows and body text.
- **VS-06** **Zones** each have a pale fill and a stronger outline of one hue:

  | Zone | Hue (mockup) | Outline |
  |---|---|---|
  | Simulated | warm grey | dashed, marking it as standing in for the world |
  | Legacy | burnt orange | solid |
  | New build | blue | solid |
  | Third-party | violet | solid |

  A zone may be drawn as more than one region where the flow demands it (the mockup
  places third-party between two new-build regions); each region carries its label.
- **VS-07** **Message letters** each have one colour, shared by the icon, the key and the
  popup header. Mockup values: Q blue `#1d4ed8`, D teal `#0f766e`, O green `#15803d`,
  K purple `#7e22ce`, P navy `#1e3a8a`, H red `#b91c1c`, L brown `#9a3412`,
  I grey `#4b5563`.
- **VS-08** Colour never carries meaning alone: every message icon shows its **letter**,
  every zone shows its **label**, and every status shows **words**.
- **VS-09** Every text and icon colour meets **4.5:1 contrast** against the surface it sits
  on (3:1 for text at 24 px and above).

## A.4 Components on the flowchart

- **VS-10** Each component is a **card**: white fill, ink outline with slightly uneven
  corners, a light offset shadow, its **name** and a **one-line role** of a few words.
  **Cards carry text labels only.** There are no illustrations, photographs or drawn
  pictures of hardware, people or characters anywhere in the demonstrator.
- **VS-11** A component with no message flows of its own (the Pyodide runtime, which only
  hosts others) is drawn with a **dashed outline** in its zone's colour, and its role
  says what it hosts.
- **VS-12** A component that exists only when a scientist creates it (a promoted product)
  is drawn with a **dashed outline** until it is registered, then solid.

## A.5 Flows and message icons

- **VS-13** Flows are **ink arrows** with filled heads, horizontal or vertical segments
  only, never crossing a card. A two-way exchange is two arrows on the thirds of the
  facing edges.
- **VS-14** Protocol labels on flows (for example "HTTP") are used **sparingly**, only where
  the boundary type is not obvious from the zones, in small grey hand lettering clear of
  every line and icon.
- **VS-15** A message is a **circle bearing its letter**: white fill, a ring and letter in
  the letter's colour. It moves along its arrow from tail to head.
- **VS-16** A **selected** message (its popup open) gains a tinted fill and a soft halo in its
  colour, and a dashed leader line in its colour joins it to its popup.
- **VS-17** A **failed** request (server down, FR-46a) stops at the relay and is shown with
  its ring broken and a cross, in the same letter colour.

## A.6 Sketch rendering

- **VS-18** Card outlines, zone outlines and arrows are drawn with a **sketch renderer**
  (Rough.js, MIT licence, served from the site) to give a hand-drawn line.
- **VS-19** **Every sketched shape is seeded** from a stable identifier (its component, zone
  or flow name), so it draws identically on every render, every pause and every client
  restart. A shape that changes its wobble between renders is a defect: it reads as
  flicker and competes with the moving messages.
- **VS-20** The sketch effect is **gentle**: low roughness, single stroke, no hatching or
  fills drawn by the renderer. Legibility of labels and arrows outranks the effect.
- **VS-21** If the sketch renderer is unavailable, the same shapes fall back to plain CSS
  outlines with uneven corner radii, as in the mockup. The demonstrator is never blocked
  on the effect.

## A.7 Popups, panels and controls

- **VS-22** **Message popups are crisp**: plain rectangle with a coloured outline in the
  message's letter colour, a hand-lettered title, the message contents in monospace on a
  pale panel, and the standard in plain words beneath. The popup is the evidence; it is
  never sketched or decorated.
- **VS-23** **Docked panels** (time series, analysis views, Python workspace) use the same
  card language as the flowchart: white, ink outline, hand-lettered title. Charts inside
  them are drawn plainly by ECharts in the palette's colours, with no sketch effect on
  data.
- **VS-24** **Controls** are real buttons with hand-lettered labels and ink outlines. The
  play/pause button is filled ink when the simulation is off or paused, inviting a press.
  The speed control is a segmented group with the current speed visibly pressed.
- **VS-25** The **guided tour** strip names its steps in order, each with a number, a short
  title and a one-line description, joined by light arrows.

## A.8 Layout regions

The mockup shows one arrangement of these regions; it is illustrative, and the fixed
layout file governs the flowchart itself.

- **VS-26** **Top bar**: the title and a one-line subtitle on the left; the controls on the
  right.
- **VS-27** **Main area**: the flowchart, its zones and its frozen or moving messages.
- **VS-28** **Side column**: the message key, the zone legend and a status summary
  (simulation state, speed, simulated time, server state and instance, client state,
  essential and optional sources).
- **VS-29** **Lower area**: the tour strip and the three docked panels.

## A.9 Motion

- **VS-30** The only motion is **messages travelling along flows**, at the speed the clock
  sets. There is no decorative animation: no bouncing, pulsing, wobbling lines or
  transitions on the diagram.
- **VS-31** When paused, nothing moves (FR-52), including any hover effects that move shapes.

---

## A.10 Acceptance criteria

| ID | Test |
|---|---|
| AT-V1 | Rendering the flowchart twice, and again after a client restart, produces identical outlines for every card, zone and arrow (VS-19) |
| AT-V2 | An automated contrast check passes for every text and icon colour against its surface (VS-09) |
| AT-V3 | On the target display, at its native resolution, every text size meets VS-04 |
| AT-V4 | The built site contains no raster or vector illustrations other than icons for controls (VS-10) |
| AT-V5 | All fonts and the sketch renderer are fetched from the site's own origin (VS-03, VS-18) |
| AT-V6 | With the sketch renderer disabled, the flowchart still renders completely with CSS outlines (VS-21) |
