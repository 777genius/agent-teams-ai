# Cyberpunk Robots Hero Reference

Date: 2026-05-15

Primary visual reference:

- PNG: `landing/assets/images/references/cyberpunk-robots-hero-reference-2026-05-15.png`
- WebP: `landing/assets/images/references/cyberpunk-robots-hero-reference-2026-05-15.webp`

## Locked Direction

- Style: black cyberpunk HUD, cyan and magenta neon, angular frames, rainy city depth, wet reflections, subtle scanlines.
- Hero slogan: `YOU'RE THE CTO, AGENTS ARE YOUR TEAM.`
- Remove the top-left status metrics block from the reference. No `Agents Online`, `Tasks Running`, `Reviews`, `12/12`, or similar hero status strip.
- The large center-right framed block is a video/demo frame, not a static dashboard.
- Robots must make the product concept obvious: many autonomous AI agents coordinate, message, review, build, test, document, and deploy together.
- Target robot roles: Planner, Lead, Reviewer, Developer, Tester, Researcher, Docs, Ops, Security, Fixer.
- Keep the page usable as a real landing page: readable nav, clear CTA buttons, responsive hierarchy, and a visible next-section hint.

## Implementation Shape

- Use WebP assets for the city/background atmosphere and robot art.
- Render HUD frames, buttons, feature strip, text, video frame, neon glows, and connector lines in Vue/CSS/SVG.
- Use the existing demo video inside the central neon frame.
- Keep robots as separate positioned layers so they can animate independently.
- Add `prefers-reduced-motion` support and reduce all movement to static glow states when requested.

## Parallax Plan

- Background city layer: slow pointer movement and slow scroll offset.
- Mid HUD/video layer: medium movement with slight perspective tilt.
- Robot layer: stronger pointer response, small independent idle movement.
- Foreground neon connector layer: tiny offset plus pulsing path strokes.
- Feature strip: minimal movement so it stays stable and readable.

## Robot Life Animations

- Idle bob: 3-6px vertical movement with staggered durations.
- Eye blink: short opacity/scale pulse on robot face screens.
- Screen pulse: soft cyan/magenta glow on tablets and role cards.
- Micro turn: small rotate/translate on hover or when a message passes nearby.
- Status glow: role cards pulse based on activity state.
- Optional layered assets: separate face/screen/arm layers only for the 2-3 most visible robots.

## Message Passing Options

1. SVG packet travel along connector paths - 🎯 9   🛡️ 9   🧠 6 - about 120-220 lines.
   Best default. Draw stable SVG paths between robots and video frame, animate small glowing packets with `offset-path` or SVG `animateMotion`. Looks like real coordination and stays responsive.

2. Chat bubble handoff between robots - 🎯 8   🛡️ 8   🧠 5 - about 90-160 lines.
   Short messages appear near one robot, fade, then appear near the receiver. Easier and very readable, but less visually premium if overused.

3. Data shard relay through hub nodes - 🎯 8   🛡️ 7   🧠 7 - about 180-300 lines.
   Small neon diamonds jump between intermediate nodes around the video frame. More cyberpunk, but more tuning needed to avoid clutter.

Default choice: combine option 1 for constant background coordination and option 2 for occasional readable moments like `Code ready`, `Review requested`, `Tests passed`.

## Performance Guardrails

- Prefer CSS transforms and opacity for animation.
- Keep animated SVG path count limited on mobile.
- Use compressed WebP for hero background and robots.
- Lazy-load lower hero/detail assets when possible.
- Avoid canvas unless SVG/CSS becomes too expensive.
