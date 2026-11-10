# Cyberpunk Robots Landing Plan

Date: 2026-05-15

Main reference:

- Design note: `landing/docs/design/cyberpunk-robots-hero-reference.md`
- WebP reference: `landing/assets/images/references/cyberpunk-robots-hero-reference-2026-05-15.webp`
- PNG reference: `landing/assets/images/references/cyberpunk-robots-hero-reference-2026-05-15.png`

## Goal

Turn the current Agent Teams landing hero into a cyberpunk command scene where the core product idea is obvious in the first viewport:

- You are the CTO.
- Many AI agents coordinate as a team.
- The center-right hero frame is the demo video.
- Robots around the video pass messages, review, build, test, and deploy.
- The page feels premium and alive, not like a static poster.

## Locked Decisions

- Use the slogan exactly: `YOU'RE THE CTO, AGENTS ARE YOUR TEAM.`
- Remove the top-left status metrics block from the generated reference.
- Keep the central block as a real video frame.
- Use **message passing option 1 + 2**:
  - SVG neon packets moving along connector lines.
  - Occasional readable message bubbles like `Code ready`, `Review requested`, `Tests passed`.
- Use WebP for production visual assets.
- Do not add animation libraries in the first implementation. Use Vue, CSS transforms, SVG, and existing project tooling.
- Keep SSG compatibility. No runtime-only backend assumptions.

## Quality Bar

This is the practical target. If a change does not support these points, it is probably visual noise.

- First viewport must explain the product before the user scrolls: AI agents coordinate around a real demo.
- The design should feel like a premium developer tool, not a game poster.
- The hero must be usable as a website: readable text, clickable CTAs, playable video, accessible controls.
- The cyberpunk style must come from layout, light, depth, contrast, and motion. Do not rely on random neon decoration.
- Robots must be meaningful: each robot has a role, status, task card, and relation to the central video frame.
- Motion must be subtle and layered. It should communicate activity, not distract from CTA and video.
- Mobile must be intentionally redesigned, not just scaled down.
- Implementation should stay maintainable: data-driven roles, small components, CSS tokens, no giant one-off template.

Quality score target:

- Visual impact: 🎯 9/10
- Reliability across breakpoints: 🛡️ 8/10
- Implementation complexity: 🧠 8/10
- Performance risk after optimization: 🛡️ 8/10

## Recommended Build Strategy

**Hybrid asset + code scene** - 🎯 9   🛡️ 8   🧠 8 - roughly **1200-1900 lines** total.

Why this is the right approach:

- Background and robots need visual richness, so they should be assets.
- HUD, text, video, buttons, connectors, hover states, and responsive layout should be code.
- Animations need separate layers so the scene feels alive and remains maintainable.
- A single full-page image would look good once, but it would be fragile, bad for SEO, hard to localize, and impossible to make interactive.

### Top 3 Build Variants

1. **Balanced production hero** - 🎯 9   🛡️ 8   🧠 8 - **1200-1900 lines**.
   Use WebP background, separate robot assets, code-rendered HUD, real video, SVG packets, message bubbles, and custom parallax. Best balance of visual quality and maintainability.

2. **Fast coded approximation** - 🎯 7   🛡️ 8   🧠 5 - **650-1000 lines**.
   Use one background reference image, fewer robots, simple CSS cards, simple connectors. Good for quick direction validation, but weaker visual depth and less premium.

3. **Maximum cinematic scene** - 🎯 9   🛡️ 6   🧠 10 - **1900-2800 lines**.
   More layered assets, advanced robot cuts, per-robot arm/screen layers, richer parallax and timed sequences. Highest wow effect, but more fragile and slower to tune.

Recommended: option 1. It gives enough wow while keeping the landing page real, responsive, and debuggable.

## Current Landing Context

Current project shape:

- Nuxt 3 + Vue 3 + TypeScript.
- Vuetify is already configured.
- Existing hero lives in `landing/components/sections/HeroSection.vue`.
- Existing demo video component lives in `landing/components/ui/HeroDemoVideo.vue`.
- Existing background/video styling lives inside `HeroSection.vue`.
- Existing parallax helper exists at `landing/composables/useParallaxSections.ts`, but it is section-level and too generic for this hero.

Important guardrails:

- Landing must remain static-generated.
- Content and i18n stay separate:
  - microcopy in `landing/locales/*`
  - section content in `landing/content/*`
- Avoid broad stores. This hero does not need Pinia.
- Do not run broad auto-format commands unless intentionally doing a formatting pass.

## Content, SEO, and i18n Rules

Content score: 🎯 8   🛡️ 9   🧠 5.

The hero can look cinematic, but the content model must stay boring and reliable.

- The `h1` remains real text and must include `Agent Teams`.
- The slogan is locked in English for this design pass: `YOU'RE THE CTO, AGENTS ARE YOUR TEAM.`
- Paragraph copy should still come from the existing content/i18n layer unless the product copy is intentionally changed.
- CTA labels should continue using locale messages.
- Robot role labels can start in `landing/data/heroAgents.ts`, but final user-visible strings should move to locale files if they become part of the stable landing content.
- Do not put SEO-critical claims inside images, SVG-only text, or video.
- Keep `alt=""` for decorative robot images. If a robot becomes meaningful content, expose the meaning in nearby HTML, not in a long image alt.
- The central video frame should have an accessible label like `Watch Agent Teams demo`.
- If the visible hero copy changes, update page meta/OG copy in the existing SEO path.

Copy rules:

- One idea per line/block.
- Avoid generic AI slogans.
- Prefer product-specific language:
  - `Agents coordinate tasks, messages, reviews, and releases.`
  - `You set the goal. They handle the work.`
- Avoid overexplaining the animation in visible text. The animation should demonstrate coordination by itself.

Localization risk:

1. **Keep slogan English-only for style** - 🎯 8   🛡️ 8   🧠 3 - **0-20 lines**.
   Best for this cyberpunk visual because the generated reference and mono strip depend on a short English command phrase.

2. **Translate slogan per locale** - 🎯 7   🛡️ 7   🧠 5 - **30-80 lines**.
   Better localization, but must test text length in every language.

3. **Use a shorter locale-specific eyebrow plus English slogan** - 🎯 8   🛡️ 8   🧠 6 - **50-110 lines**.
   Good compromise if non-English pages feel awkward later.

Recommended now: option 1. Revisit after the hero layout is stable.

## Design System Direction

### Visual Principles

- **Command center, not decoration**: every bright element should imply state, action, routing, focus, or hierarchy.
- **One clear hero action cluster**: the user should see headline, slogan, paragraph, and CTAs before noticing secondary details.
- **Depth through layers**: background city, atmospheric wash, connector network, video frame, robots, message bubbles, foreground scanlines.
- **Readable over flashy**: the headline and CTAs win over robots and neon.
- **Robots explain the product**: robots should frame the video and task flow, not just decorate corners.
- **Cyberpunk restraint**: cyan is the system color, magenta is activity/accent, amber/red are rare warning states.

### Composition Rules

Desktop composition:

- Left 38-42%: brand message and CTAs.
- Center/right 58-62%: video command frame and robot network.
- The video frame should be the largest object after the headline.
- Robots should orbit the video, not compete with the headline.
- Bottom feature strip should peek into the first viewport, about 92-140px visible.
- Keep the upper-left area clean after removing the status block. Use only subtle skyline/HUD detail there.

Hero hierarchy:

1. `Agent Teams` headline.
2. `YOU'RE THE CTO, AGENTS ARE YOUR TEAM.` slogan strip.
3. One short paragraph.
4. CTA row.
5. Demo video frame.
6. Robots and message network.
7. Feature strip.

Spacing:

- Desktop safe content max width: `min(1640px, calc(100vw - 64px))`.
- Hero min height: `min(980px, 100svh)` for large screens, `auto` on mobile.
- Left content max width: `620px`.
- CTA row gap: `12-16px`.
- Minimum gap from headline to video frame: `32px`.
- Minimum gap from robot/card to video controls: `24px`.

### Typography

Use the existing Inter + JetBrains Mono direction, but with stricter roles:

- Headline: Inter, 72-96px desktop, 54-64px laptop, 40-48px tablet, 36-42px mobile.
- Slogan strip: JetBrains Mono, uppercase, 14-17px desktop, 12-14px mobile.
- Paragraph: Inter, 18-21px desktop, 16px mobile, line-height `1.65`.
- Robot role labels: JetBrains Mono, 11-13px, uppercase.
- Task card text: JetBrains Mono or Inter depending readability, 10-12px.
- Buttons: Inter or JetBrains Mono, 14-15px, uppercase only if it matches current nav style.

Rules:

- Do not use viewport-width font scaling.
- No negative letter spacing for compact UI text.
- Avoid text shadows on small text unless they improve contrast.
- Generated image text is not a source of truth. Real product text must be HTML.

### Color and Light

Primary palette:

```text
Background: #02050d, #050814, #09101f
Panel: rgba(3, 10, 22, 0.72)
Panel strong: rgba(5, 14, 31, 0.88)
Cyan: #00eaff
Blue: #2f7dff
Magenta: #ff2bff
Violet: #8b5cff
Amber: #ffb238
Red: #ff4c6a
Text: #f4f7ff
Muted: #9ba8c7
```

Light rules:

- Cyan is structure: borders, primary routes, focus, system state.
- Magenta is activity: packets, live events, active robot accents.
- Amber is caution: ops/build/waiting.
- Red is rare: security or critical state only.
- Do not let the page become purple-only.
- Use dark gradient washes behind text instead of cranking text shadow.

### Design Token Contract

Token contract score: 🎯 9   🛡️ 9   🧠 5.

Create a small cyber hero token layer in `landing/assets/styles/cyberpunk-hero.scss`. Do not scatter raw hex values across components.

Token groups:

```scss
:root {
  --cyber-bg-0: #02050d;
  --cyber-bg-1: #050814;
  --cyber-panel-weak: rgba(3, 10, 22, 0.58);
  --cyber-panel: rgba(3, 10, 22, 0.72);
  --cyber-panel-strong: rgba(5, 14, 31, 0.88);

  --cyber-cyan: #00eaff;
  --cyber-blue: #2f7dff;
  --cyber-magenta: #ff2bff;
  --cyber-violet: #8b5cff;
  --cyber-amber: #ffb238;
  --cyber-red: #ff4c6a;

  --cyber-text: #f4f7ff;
  --cyber-muted: #9ba8c7;
  --cyber-border-cyan: rgba(0, 234, 255, 0.42);
  --cyber-border-magenta: rgba(255, 43, 255, 0.42);

  --cyber-radius-xs: 4px;
  --cyber-radius-sm: 6px;
  --cyber-radius-md: 8px;
  --cyber-frame-cut: 18px;
}
```

Rules:

- Raw hex values are allowed in token definitions and nowhere else unless there is a clear reason.
- Use semantic variables for accent states: `--agent-accent`, `--agent-accent-soft`, `--message-accent`.
- Keep opacity in token names when it is stable. Use local opacity only for one-off fine tuning.
- If a color appears 3+ times, it becomes a token.
- Do not import a new design system or utility library for this hero.

Review gate:

- Run `rg "#[0-9a-fA-F]{3,8}" landing/components/hero landing/assets/styles/cyberpunk-hero.scss` and verify raw colors are intentional.

### HUD Geometry

Use one angular language everywhere:

- Frame corners clipped with `clip-path`.
- Decorative corner strokes are pseudo-elements.
- Borders are 1px base, 2px only on active/focused elements.
- Radius should be small: `4px`, `6px`, max `8px`.
- Avoid pill-heavy UI except small badges.
- Prefer corners and edge accents over heavy full-box glow.

Frame pattern:

```scss
.cyber-frame {
  position: relative;
  border: 1px solid rgba(0, 234, 255, 0.42);
  background: linear-gradient(135deg, rgba(3, 10, 22, 0.88), rgba(7, 12, 28, 0.66));
  clip-path: polygon(18px 0, 100% 0, 100% calc(100% - 18px), calc(100% - 18px) 100%, 0 100%, 0 18px);
}
```

Best practice:

- Use `clip-path` on wrapper.
- Use a child element for content padding.
- Do not clip focus rings on interactive children. Add focus rings on inner buttons, not the clipped parent.

## Target File Structure

Recommended new or changed files:

```text
landing/components/sections/HeroSection.vue
landing/components/hero/CyberHeroScene.vue
landing/components/hero/CyberHeroVideoFrame.vue
landing/components/hero/CyberHeroRobot.vue
landing/components/hero/CyberHeroConnectors.vue
landing/components/hero/CyberHeroMessageBubbles.vue
landing/components/hero/CyberHeroFeatureStrip.vue
landing/data/heroAgents.ts
landing/composables/useCyberHeroParallax.ts
landing/assets/styles/cyberpunk-hero.scss
landing/assets/images/hero/cyberpunk-city-bg.webp
landing/assets/images/hero/cyberpunk-floor-glow.webp
landing/assets/images/hero/robots/*.webp
```

Alternative if scope needs to be smaller:

- Keep everything in `HeroSection.vue` first - 🎯 7   🛡️ 6   🧠 5 - **700-1100 lines**.
- Faster, but the file will become too large and harder to tune.
- I do not recommend this unless speed matters more than maintainability.

## Asset Plan

Asset strategy score: 🎯 9   🛡️ 8   🧠 7.

Main rule: assets provide richness, code provides layout and meaning.

- Background can be art-directed and baked.
- Robot bodies can be bitmap assets.
- Text, CTAs, video, role cards, connectors, packets, focus states, and responsive behavior must be HTML/CSS/SVG.

### 1. Background

Create:

```text
landing/assets/images/hero/cyberpunk-city-bg.webp
landing/assets/images/hero/cyberpunk-floor-glow.webp
landing/assets/images/hero/cyberpunk-city-bg-mobile.webp
```

Specs:

- `cyberpunk-city-bg.webp`
  - 2560x1440 or 2880x1620 source.
  - Export target around 350-650KB.
  - Dark city, neon signage, rainy depth, no readable random brand text.
  - Left side must stay clean enough for headline readability.
  - Right/center can be richer behind the video frame.
- `cyberpunk-floor-glow.webp`
  - Transparent WebP if possible.
  - Export target around 120-260KB.
  - Wet reflection, magenta/cyan platform glow under the video frame.
  - Can be hidden on mobile.
- `cyberpunk-city-bg-mobile.webp`
  - 1080x1600 or 1290x1800.
  - Re-cropped for mobile, not automatically squeezed from desktop.
  - Keep top/left text area dark and quiet.

Implementation:

- Use `image-set()` or normal `background-image`.
- Put a dark gradient wash over the background.
- Add scanline/noise via CSS pseudo-elements, not baked into every asset.
- Use `background-position` by breakpoint:
  - desktop: `center top`
  - laptop: `58% top`
  - mobile: `center top`
- Add `content-visibility` only below the hero, not on the hero itself.

### 2. Robot Assets

Create 8-10 separate robot assets:

```text
planner.webp
lead.webp
reviewer.webp
developer.webp
tester.webp
researcher.webp
docs.webp
ops.webp
security.webp
fixer.webp
```

Specs:

- Transparent background.
- WebP with alpha for final use.
- Keep original PNG sources if generation/post-processing needs them.
- Keep a neutral light direction: top/front cyan, side magenta accents.
- Robots should have tablets or small panels when possible.
- Keep silhouettes varied, but keep the same visual family.
- Rough display size:
  - desktop large robots: 150-240px tall.
  - desktop small robots: 90-150px tall.
  - mobile: hide most robots, keep 2-3 symbolic avatars/cards.

Generation workflow:

1. Generate robots on flat chroma-key background.
2. Remove background locally.
3. Convert alpha PNG to WebP.
4. Validate edges against dark and cyan/magenta backgrounds.
5. Create a tiny contact glow in CSS, not in the asset, so it can adapt to layout.
6. Save source prompt and generation notes near assets if final assets are generated.

Do not make the robots look like soldiers. They should feel like compact software-agent assistants.

Robot asset acceptance:

- Edges are clean on `#02050d`.
- No baked text inside the robot asset.
- No weapons or battle armor.
- Face/screen area is clear enough for blink/pulse overlays.
- Each robot can be mirrored only if labels and screen details do not become visibly wrong.

### 2.1 Robot Layering Options

1. **Single image per robot + CSS overlays** - 🎯 8   🛡️ 9   🧠 5 - **80-160 lines**.
   Best first version. Add eye glow, card glow, and hover lift in CSS.

2. **Two-layer robot: body + face/screen layer** - 🎯 9   🛡️ 8   🧠 7 - **160-280 lines**.
   Use for the 2-3 biggest robots. Allows real blinking and screen pulse.

3. **Three-layer robot: body + face + arm/tablet** - 🎯 9   🛡️ 6   🧠 9 - **260-450 lines**.
   Highest animation quality, but only worth it if the hero is already stable.

Recommended: start with option 1 for all robots, then upgrade the Lead, Developer, and Reviewer robots to option 2.

### 3. Video Frame

Reuse the current demo video source from `HeroDemoVideo.vue` unless product wants a new recording.

Frame requirements:

- Angular cyan HUD border.
- Magenta/cyan outer glow.
- Slight perspective transform on desktop.
- Play overlay stays readable.
- Controls still work.
- Fullscreen still works.
- Central frame remains recognizable as video, not fake dashboard art.

Video poster:

- Use a real frame from the demo video or a screenshot from the app.
- Do not use generated UI text as the video poster if the demo video has a better first frame.
- Poster should be dark and readable with the play overlay.
- If the video loads from GitHub user attachments, keep error fallback polished.

### 4. Asset Directory Rules

Recommended directories:

```text
landing/assets/images/hero/backgrounds/
landing/assets/images/hero/robots/
landing/assets/images/hero/overlays/
landing/assets/images/references/
```

Naming:

```text
cyber-city-desktop-v1.webp
cyber-city-mobile-v1.webp
robot-planner-v1.webp
robot-lead-v1.webp
robot-reviewer-v1.webp
```

Do not overwrite generated references. Add `v2`, `v3`, or date suffixes when iterating.

### 5. Compression Targets

Use these as practical budgets:

```text
desktop background: 350-650KB
mobile background: 220-420KB
floor glow overlay: 120-260KB
large robot: 50-110KB
small robot: 25-70KB
full first-viewport image budget: ideally <= 1.4MB
```

If the first version exceeds budget, reduce:

1. background detail
2. robot count on initial load
3. oversized transparent padding around robot assets
4. unnecessary alpha overlays

Use `cwebp -q 82-90` for hero assets and compare visually. Do not blindly set quality to 100.

### 6. Asset QA Checklist

Before an asset is used in the hero:

- [ ] filename follows naming rules
- [ ] dimensions are known
- [ ] visual subject has enough transparent padding but not excessive empty canvas
- [ ] WebP export size is within target or explicitly accepted
- [ ] robot edges look clean on dark background
- [ ] no baked text that should be localized
- [ ] no visible watermark or generation artifacts
- [ ] no accidental weapons/combat styling
- [ ] asset still reads at final rendered size
- [ ] mobile crop is reviewed separately

Asset inspection commands:

```bash
file landing/assets/images/hero/backgrounds/cyber-city-desktop-v1.webp
ls -lh landing/assets/images/hero/backgrounds landing/assets/images/hero/robots
```

If ImageMagick is available:

```bash
magick identify landing/assets/images/hero/robots/robot-lead-v1.webp
```

Do not ship generated assets straight from the generator folder. Copy final selected assets into the landing asset directory and keep references stable.

## Component Design

Component architecture score: 🎯 9   🛡️ 9   🧠 7.

Design rule: the hero is a scene, but it should be built like a product UI. Data and coordinates live in data files, visual primitives live in components, animation timing lives in a small composable, and `HeroSection.vue` stays readable.

### Component Boundaries

- `HeroSection.vue` owns content and links.
- `CyberHeroScene.vue` owns scene composition.
- `CyberHeroVideoFrame.vue` owns video chrome only.
- `CyberHeroRobot.vue` owns one agent visual.
- `CyberHeroConnectors.vue` owns SVG paths and packet animation.
- `CyberHeroMessageBubbles.vue` owns readable message handoff sequence.
- `CyberHeroFeatureStrip.vue` owns the bottom first-viewport feature band.

Avoid:

- importing robot assets directly in many components
- calculating path geometry inside templates
- storing animation state in Pinia
- hardcoding 10 separate robot markup blocks
- making decorative layers intercept pointer events

### CSS Contract

Top-level scene root should expose stable attributes/classes:

```vue
<section class="hero-section cyber-hero" data-cyber-hero>
  ...
</section>
```

CSS variables owned by scene root:

```scss
.cyber-hero {
  --hero-pointer-x: 0;
  --hero-pointer-y: 0;
  --hero-scroll: 0;
  --hero-tilt-x: 0;
  --hero-tilt-y: 0;
  --hero-intensity: 1;
}
```

Layer classes:

```text
cyber-hero__background
cyber-hero__wash
cyber-hero__content
cyber-hero__scene
cyber-hero__connectors
cyber-hero__video
cyber-hero__robots
cyber-hero__messages
cyber-hero__feature-strip
```

Keep BEM-ish class names. Do not mix deep Vuetify selectors into cyber hero styling unless there is no alternative.

### `HeroSection.vue`

Role:

- Own top-level section, content, links, release note, and imports.
- Delegate visual scene to `CyberHeroScene`.

Responsibilities:

- Fetch content with `useLandingContent`.
- Resolve download/docs/github links.
- Render:
  - headline
  - slogan strip
  - paragraph
  - CTA buttons
  - dev note
  - trust row or compact feature hints
  - `CyberHeroScene`

Avoid:

- Large robot data arrays.
- Message animation state.
- SVG path definitions.

Target template shape:

```vue
<section id="hero" ref="heroRef" class="hero-section cyber-hero section anchor-offset">
  <div class="cyber-hero__background" aria-hidden="true" />
  <div class="cyber-hero__wash" aria-hidden="true" />

  <v-container class="cyber-hero__container">
    <div class="cyber-hero__layout">
      <div class="cyber-hero__copy">
        <h1 class="cyber-hero__title">Agent <span>Teams</span></h1>
        <p class="cyber-hero__slogan">YOU'RE THE CTO, AGENTS ARE YOUR TEAM.</p>
        <p class="cyber-hero__description">...</p>
        <div class="cyber-hero__actions">...</div>
        <a class="cyber-hero__terminal-note">...</a>
      </div>

      <CyberHeroScene class="cyber-hero__scene" />
    </div>

    <CyberHeroFeatureStrip />
  </v-container>
</section>
```

Layout CSS:

```scss
.cyber-hero__layout {
  display: grid;
  grid-template-columns: minmax(360px, 0.78fr) minmax(620px, 1.22fr);
  align-items: center;
  gap: clamp(32px, 5vw, 88px);
}
```

Important:

- Keep real text in HTML.
- Use `clamp()` only within bounded ranges, not raw viewport scaling.
- Make title width stable so animated scene does not push it.
- Keep CTA row above robots in stacking order.
- Put feature strip inside hero container but outside the main grid.

### `CyberHeroScene.vue`

Role:

- Own layered visual scene around the video.

Layer order:

```text
0 background atmosphere
1 floor glow
2 connector SVG network
3 video frame
4 robot assets and role cards
5 message bubbles
6 foreground glows and scanlines
```

Props:

```ts
type CyberHeroSceneProps = {
  videoLabel: string;
  reducedMotion?: boolean;
};
```

State:

- Pointer parallax CSS variables.
- Active message cycle.
- Active packet route index.

Target DOM structure:

```vue
<div ref="sceneRef" class="cyber-scene">
  <div class="cyber-scene__floor" aria-hidden="true" />
  <CyberHeroConnectors class="cyber-scene__connectors" />
  <CyberHeroVideoFrame class="cyber-scene__video" />
  <div class="cyber-scene__robots" aria-hidden="true">
    <CyberHeroRobot v-for="agent in agents" :key="agent.id" :agent="agent" />
  </div>
  <CyberHeroMessageBubbles class="cyber-scene__messages" />
  <div class="cyber-scene__foreground" aria-hidden="true" />
</div>
```

Z-index contract:

```text
floor: 0
connectors: 1
video frame: 3
robots: 4
message bubbles: 5
foreground scanlines: 6
```

Best practices:

- Scene root uses `isolation: isolate`.
- Decorative layers use `pointer-events: none`.
- Video frame restores `pointer-events: auto` only for video and controls.
- Use `aspect-ratio: 16 / 10` or a stable min-height so image loading does not cause layout shift.
- All robot positions are percentages in a fixed scene coordinate system.
- Avoid absolute pixel positions except tiny icon/card offsets.

### `CyberHeroVideoFrame.vue`

Role:

- Wrap `HeroDemoVideo` in the cyberpunk frame.

Markup shape:

```vue
<div class="cyber-video-frame">
  <div class="cyber-video-frame__chrome" aria-hidden="true" />
  <HeroDemoVideo />
  <div class="cyber-video-frame__corner cyber-video-frame__corner--tl" />
</div>
```

Important:

- Do not break video controls.
- Do not put pointer-blocking overlays over the video.
- Decorative layers must use `pointer-events: none`.

Frame CSS requirements:

```scss
.cyber-video-frame {
  position: relative;
  aspect-ratio: 16 / 9;
  min-width: 0;
  border: 1px solid rgba(0, 234, 255, 0.62);
  background: rgba(2, 6, 16, 0.72);
  box-shadow:
    0 0 0 1px rgba(47, 125, 255, 0.18) inset,
    0 0 34px rgba(0, 234, 255, 0.2),
    0 0 72px rgba(255, 43, 255, 0.12);
}
```

Video interaction rules:

- The play button must be visually above frame chrome.
- Progress bar must remain easy to click.
- Fullscreen should target the video container, not the whole hero.
- On mobile, remove perspective transforms around the video to avoid blurry text.
- If the video errors, show a cyber-styled fallback that links to GitHub or screenshots.

### `CyberHeroRobot.vue`

Role:

- Render one robot, role label, role card, and local animation state.

Props:

```ts
type HeroAgentRole =
  | "planner"
  | "lead"
  | "reviewer"
  | "developer"
  | "tester"
  | "researcher"
  | "docs"
  | "ops"
  | "security"
  | "fixer";

type HeroAgent = {
  id: HeroAgentRole;
  label: string;
  asset: string;
  accent: "cyan" | "magenta" | "violet" | "amber" | "red";
  desktop: { x: number; y: number; scale: number; depth: number };
  tablet?: { x: number; y: number; scale: number; depth: number };
  mobile?: { visible: boolean; order?: number };
  status: string;
  tasks: string[];
};
```

Animation:

- `idleBob` per robot with staggered duration.
- `eyeBlink` on inner glow layer.
- `screenPulse` on tablet/card.
- Hover: small lift, brighter card, connector pulse.

Positioning:

```scss
.cyber-agent {
  position: absolute;
  left: calc(var(--agent-x) * 1%);
  top: calc(var(--agent-y) * 1%);
  transform:
    translate3d(-50%, -50%, 0)
    translate3d(
      calc(var(--hero-pointer-x) * var(--agent-depth) * 18px),
      calc(var(--hero-pointer-y) * var(--agent-depth) * 14px),
      0
    )
    scale(var(--agent-scale));
}
```

Implementation details:

- Apply idle animation to an inner wrapper, not the positioned root. This prevents animation from overriding parallax transforms.
- Role card can be attached to robot via `data-card-side="left|right|bottom"`.
- On hover, pulse only the robot/card and related connector, not the entire scene.
- Use `loading="eager"` for 2-3 primary robots and `loading="lazy"` for lower-priority robots if they are real `<img>` elements.
- If using CSS background images for robots, provide hidden text elsewhere only if the robot becomes meaningful content.

### `CyberHeroConnectors.vue`

Role:

- Render SVG connector paths and moving message packets.

Data shape:

```ts
type HeroConnection = {
  id: string;
  from: HeroAgentRole;
  to: HeroAgentRole | "video";
  accent: "cyan" | "magenta" | "amber";
  pathDesktop: string;
  pathTablet?: string;
  pathMobile?: string;
  packetDelayMs: number;
  packetDurationMs: number;
};
```

Implementation options:

- First choice: SVG `<path>` plus `<circle>` animated with `<animateMotion>`.
- Fallback if browser behavior is awkward: CSS `offset-path` on absolutely positioned packet dots.

Packet behavior:

- Constant low-intensity packet traffic.
- 4-7 active packets visible at once on desktop.
- 1-2 active packets visible on mobile or disable entirely.
- Active bubble event should temporarily brighten the related connection.

SVG best practices:

- Use one `viewBox`, for example `0 0 1600 900`.
- Store paths in data as `d` strings for desktop/tablet/mobile.
- Keep stroke widths between `1` and `1.5` for base paths.
- Add glow using duplicated paths with lower opacity, not heavy CSS blur on the whole SVG.
- Set `vector-effect="non-scaling-stroke"` so lines do not become thick on resize.
- Use `aria-hidden="true"` because the same information is communicated by visible bubbles and role cards.
- Never put important copy inside SVG paths or generated images.

Fallback strategy:

- If SVG `animateMotion` causes hydration or browser issues, switch packets to absolutely positioned dots with CSS `offset-path`.
- Keep the same connection data shape so the fallback is mechanical.

### `CyberHeroMessageBubbles.vue`

Role:

- Render readable message handoffs between agents.

Message examples:

```ts
const HERO_MESSAGES = [
  { from: "developer", to: "reviewer", text: "Code ready. Request review.", durationMs: 3800 },
  { from: "reviewer", to: "tester", text: "Looks good. Run tests.", durationMs: 3600 },
  { from: "tester", to: "lead", text: "Tests passed.", durationMs: 3400 },
  { from: "researcher", to: "planner", text: "Findings ready.", durationMs: 3600 },
  { from: "security", to: "lead", text: "Dependencies checked.", durationMs: 3600 },
];
```

Animation sequence:

1. Sender robot/card pulses.
2. Bubble appears near sender.
3. Packet travels along related connector.
4. Bubble fades near receiver or central video frame.
5. Receiver robot/card pulses.

Keep bubbles short. Long text will look noisy and break mobile.

### `CyberHeroFeatureStrip.vue`

Role:

- Bottom strip peeking into first viewport.

Items:

- Autonomous Agents.
- Kanban at Lightspeed.
- Built for Developers.
- Secure by Default.
- Local First.

Style:

- Angular HUD frame.
- Small icon, title, 1-line text.
- No cards inside cards.
- Hide or compress text on mobile.

## Data Plan

Create `landing/data/heroAgents.ts`:

```ts
export const heroAgents = [
  {
    id: "planner",
    label: "Planner",
    asset: "/assets/images/hero/robots/planner.webp",
    accent: "cyan",
    desktop: { x: 48, y: 12, scale: 0.78, depth: 0.45 },
    status: "Planning",
    tasks: ["Analyze requirements", "Break down tasks", "Create plan"],
  },
  // ...
] as const;
```

Notes:

- If Nuxt asset imports are preferable, import images from `~/assets/images/...` instead of public paths.
- Keep role coordinates in data, not scattered through CSS.
- Keep route/path definitions in one data file so animation and layout can share them.

Add explicit connection and message data:

```ts
export const heroConnections = [
  {
    id: "developer-reviewer",
    from: "developer",
    to: "reviewer",
    accent: "magenta",
    pathDesktop: "M 1280 315 C 1200 340, 1120 340, 1040 385",
    packetDelayMs: 400,
    packetDurationMs: 3400,
  },
] as const;

export const heroMessages = [
  {
    id: "code-review",
    from: "developer",
    to: "reviewer",
    connectionId: "developer-reviewer",
    text: "Code ready. Request review.",
    durationMs: 4200,
  },
] as const;
```

Data rules:

- Keep IDs stable. CSS and tests can target them.
- Use English message strings in data first. Move to locale files only when final copy is stable.
- Keep every visible message under 34 characters when possible.
- Do not encode absolute pixel dimensions in message data unless the path itself needs a fixed coordinate system.
- Keep mobile visibility flags in data, not in many scattered CSS selectors.

### Message State Machine

Use a simple deterministic cycle, not random intervals.

State shape:

```ts
type ActiveHeroMessage = {
  messageId: string;
  phase: "sender" | "packet" | "receiver" | "cooldown";
};
```

Cycle:

```text
0ms      sender robot/card pulse
160ms    sender bubble visible
900ms    active connector brightens
1100ms   packet emphasis begins
2100ms   receiver robot/card pulse
2350ms   receiver bubble visible
3400ms   sender bubble fades
4000ms   receiver bubble fades
4600ms   cooldown ends
```

Implementation:

- Use one timer chain inside `CyberHeroMessageBubbles.vue` or a small `useHeroMessageCycle.ts`.
- Start only when the hero is visible via `IntersectionObserver`.
- Pause when tab is hidden with `document.visibilityState`.
- Stop on unmount and clear all timers.
- Respect reduced motion by showing static short labels instead of animated bubbles.

Why deterministic:

- Easier to debug.
- Easier to screenshot.
- Avoids chaotic overlap.
- Better for performance.

## Styling Plan

Use a dedicated stylesheet:

```text
landing/assets/styles/cyberpunk-hero.scss
```

Import it from `main.scss`:

```scss
@import "./cyberpunk-hero.scss";
```

Core tokens:

```scss
:root {
  --cyber-bg: #02050d;
  --cyber-panel: rgba(3, 10, 22, 0.72);
  --cyber-cyan: #00eaff;
  --cyber-blue: #2f7dff;
  --cyber-magenta: #ff2bff;
  --cyber-violet: #8b5cff;
  --cyber-amber: #ffb238;
  --cyber-red: #ff4c6a;
  --cyber-text: #f4f7ff;
  --cyber-muted: #9ba8c7;
}
```

HUD frame pattern:

- Use `clip-path: polygon(...)` for angular panels.
- Use pseudo-elements for corner strokes.
- Use `box-shadow` sparingly:
  - one inner glow
  - one outer glow
  - no heavy blur on every child

Avoid:

- Huge nested cards.
- Viewport-based font scaling.
- Purple-only palette.
- Text overlap on mobile.
- Decorative blobs/orbs.

### CSS Organization

Best option: keep cyber hero styles in one dedicated file while components remain small.

```text
landing/assets/styles/cyberpunk-hero.scss
```

Structure:

```scss
/* 1. tokens */
/* 2. root hero layout */
/* 3. copy and CTA */
/* 4. scene layers */
/* 5. video frame */
/* 6. robots and cards */
/* 7. connectors and messages */
/* 8. feature strip */
/* 9. animations */
/* 10. breakpoints */
/* 11. reduced motion */
```

Rules:

- Prefer component classes over global element selectors.
- Keep selectors shallow: `.cyber-agent__card`, not `.hero .scene div div .card`.
- Use `@media (prefers-reduced-motion: reduce)` at the end.
- Keep breakpoint overrides grouped by component when possible.
- Do not use `!important` except to override third-party video controls if unavoidable.

### CTA Styling

CTA buttons are part of conversion, so they must stay visually simpler than the scene.

Primary:

- Cyan to magenta gradient background.
- Strong but contained glow.
- Download icon.
- Min height 52px desktop, 48px mobile.

Secondary:

- Transparent dark panel.
- Cyan border.
- Icon + label.
- Hover glow, no layout shift.

Rules:

- All buttons must have stable width or padding so text does not jump.
- Touch target at least 44px.
- Focus ring visible over neon background.
- Do not animate font size or padding on hover.

### Text Readability Layer

Add a local dark wash behind the copy area:

```scss
.cyber-hero__copy::before {
  content: "";
  position: absolute;
  inset: -48px -40px -40px -32px;
  z-index: -1;
  background: radial-gradient(circle at 20% 40%, rgba(2, 5, 13, 0.92), rgba(2, 5, 13, 0.28) 62%, transparent 78%);
  pointer-events: none;
}
```

Use this instead of making text huge or adding heavy shadow.

## Parallax Details

Create `landing/composables/useCyberHeroParallax.ts`.

Inputs:

- `rootRef`
- reduced motion state
- desktop-only threshold

Outputs:

- CSS variables on root:
  - `--hero-pointer-x`
  - `--hero-pointer-y`
  - `--hero-scroll`
  - `--hero-tilt-x`
  - `--hero-tilt-y`

Behavior:

- Pointer movement:
  - background moves 4-8px.
  - video frame moves 8-14px and tilts max 2deg.
  - robots move 10-24px depending on depth.
  - foreground connectors move 4-10px.
- Scroll movement:
  - background shifts slowly upward.
  - floor glow and robots separate slightly.
  - feature strip stays stable.
- Use `requestAnimationFrame`.
- Use passive listeners.
- Disable pointer parallax under 768px.
- Disable all motion if `prefers-reduced-motion: reduce`.

CSS example:

```scss
.cyber-hero__bg {
  transform: translate3d(
    calc(var(--hero-pointer-x) * -6px),
    calc(var(--hero-scroll) * 0.04px + var(--hero-pointer-y) * -4px),
    0
  );
}

.cyber-hero__video {
  transform:
    translate3d(
      calc(var(--hero-pointer-x) * 12px),
      calc(var(--hero-pointer-y) * 8px),
      0
    )
    rotateX(calc(var(--hero-tilt-y) * 1deg))
    rotateY(calc(var(--hero-tilt-x) * -1deg));
}
```

Composable sketch:

```ts
export function useCyberHeroParallax(rootRef: Ref<HTMLElement | null>) {
  let frame = 0;
  let pointerX = 0;
  let pointerY = 0;
  let scroll = 0;

  const update = () => {
    frame = 0;
    const root = rootRef.value;
    if (!root) return;
    root.style.setProperty("--hero-pointer-x", pointerX.toFixed(4));
    root.style.setProperty("--hero-pointer-y", pointerY.toFixed(4));
    root.style.setProperty("--hero-scroll", scroll.toFixed(2));
    root.style.setProperty("--hero-tilt-x", pointerX.toFixed(4));
    root.style.setProperty("--hero-tilt-y", pointerY.toFixed(4));
  };

  const requestUpdate = () => {
    if (frame) return;
    frame = requestAnimationFrame(update);
  };
}
```

Implementation rules:

- Normalize pointer to `-1..1`.
- Clamp values. Do not let huge mouse positions produce extreme transforms.
- Do not attach listeners until mounted.
- Remove listeners on unmount.
- Skip if `(hover: none)` or screen width is under `768px`.
- Use `usePreferredReducedMotion` from VueUse if already available through `@vueuse/nuxt`.
- Avoid reading layout on every pointer event. Read bounds once on enter/resize.

Motion tuning:

- Background: barely moves. It should feel deep, not slippery.
- Robots: move based on depth. Front robots move more than back robots.
- Video frame: slight tilt only, no aggressive 3D rotation.
- Connector SVG: can move with scene but packet paths should still visually connect.
- Feature strip: almost static to preserve readability.

## Robot Animation Details

Animations:

```scss
@keyframes robotIdleBob {
  0%, 100% { transform: translate3d(0, 0, 0); }
  50% { transform: translate3d(0, -6px, 0); }
}

@keyframes robotEyeBlink {
  0%, 88%, 100% { opacity: 1; transform: scaleY(1); }
  91% { opacity: 0.45; transform: scaleY(0.25); }
  94% { opacity: 1; transform: scaleY(1); }
}

@keyframes panelPulse {
  0%, 100% { box-shadow: 0 0 18px rgba(0, 234, 255, 0.18); }
  50% { box-shadow: 0 0 28px rgba(255, 43, 255, 0.32); }
}
```

Rules:

- Stagger robot animation with CSS variables:
  - `--agent-delay`
  - `--agent-duration`
  - `--agent-depth`
- Do not animate layout properties.
- Use `transform` and `opacity`.
- Use hover only for enhancement.
- Ensure focus states still work for interactive elements.

Animation budget:

```text
idle bob: 8-12 robots allowed on desktop
eye blink: 4-6 robots allowed
screen pulse: 4-8 panels allowed
message pulse: only sender and receiver
hover lift: only hovered robot
```

Avoid:

- animating `filter: blur()` on big images
- animating `box-shadow` on many large elements at the same time
- animating `top`, `left`, `width`, or `height`
- putting separate timers in every robot component

Better pattern:

- CSS handles continuous idle animation.
- One message-cycle component toggles active IDs.
- Robot receives `isActiveSender` / `isActiveReceiver` props or active IDs from parent.
- Robot CSS reacts with classes like `.cyber-agent--sending`.

## Message Passing Details

Chosen combo: **SVG packets + message bubbles** - 🎯 9   🛡️ 9   🧠 7 - **220-380 lines**.

### SVG Packets

Visual:

- Thin cyan/magenta connector lines.
- Small bright packet dots travel from robot to robot or robot to video.
- Lines pulse when related message is active.

Markup shape:

```vue
<svg class="cyber-connectors" viewBox="0 0 1600 900" aria-hidden="true">
  <path
    v-for="connection in connections"
    :id="`path-${connection.id}`"
    :key="connection.id"
    class="cyber-connectors__path"
    :class="`cyber-connectors__path--${connection.accent}`"
    :d="connection.pathDesktop"
  />

  <g v-for="packet in packets" :key="packet.id" class="cyber-connectors__packet">
    <circle r="4">
      <animateMotion
        :dur="`${packet.durationMs}ms`"
        repeatCount="indefinite"
        :begin="`${packet.delayMs}ms`"
      >
        <mpath :href="`#path-${packet.connectionId}`" />
      </animateMotion>
    </circle>
  </g>
</svg>
```

### Message Bubbles

Visual:

- Small HUD bubbles near robots.
- Short messages only.
- Bubble appears at sender, then receiver pulses.

Timing:

```text
0ms      sender pulse starts
150ms    sender bubble appears
800ms    packet highlight starts
1800ms   receiver bubble appears
3200ms   fade both
4200ms   next message can start
```

Do not show every role talking at once. It will become noise.

### Message Copy Rules

Good:

- `Code ready. Request review.`
- `Tests passed. Looks good.`
- `Findings ready.`
- `Deploying to staging.`
- `Docs updated.`

Avoid:

- long sentences
- vague AI copy like `Processing...`
- too many simultaneous messages
- random terminal gibberish
- messages that duplicate the paragraph exactly

### Message Layout Rules

- Bubbles should sit near the sender/receiver, not over the video controls.
- Use max width around `190px`.
- Use 1-2 lines maximum.
- Use angular frame with small tail or connector dot.
- On mobile, show one bubble below the compact agent row instead of absolute overlays.

### Packet Visual Rules

- Base connector opacity: `0.22-0.38`.
- Active connector opacity: `0.7-0.9`.
- Packet dot size: `3-5px`.
- Packet trail can be a short `linearGradient` stroke, but keep it subtle.
- Packet speed should feel deliberate: `2800-4600ms`, not twitchy.

## Responsive Plan

Responsive strategy score: 🎯 8   🛡️ 9   🧠 8.

Do not scale the desktop poster down. Recompose the hero by breakpoint.

### Desktop >= 1200px

- Full scene.
- 8-10 robots visible.
- Video frame on center-right.
- Message packets and bubbles enabled.
- Feature strip visible at bottom.

Layout:

```scss
.cyber-hero__layout {
  grid-template-columns: minmax(420px, 0.82fr) minmax(720px, 1.18fr);
}
```

Rules:

- Scene can overlap background area but not copy area.
- Video frame should sit between 48% and 78% of viewport width.
- Keep at least 56px safe margin from nav/header.
- Feature strip should not cover CTA row at 900px height.

### Tablet 768-1199px

- 4-6 robots visible.
- Video frame moves below or slightly right of headline depending width.
- Keep packet lines only around video.
- Reduce card labels.
- Hide bottom-only decorative robots.

Layout:

```scss
.cyber-hero__layout {
  grid-template-columns: 1fr;
}
```

Rules:

- Copy first, scene second.
- Video frame width: `min(880px, 100%)`.
- Robots should become a halo around the video, not scattered across the page.
- Hide role cards for less important robots.
- Keep message bubbles close to the video.

### Mobile < 768px

- Hero becomes vertical.
- Keep headline, slogan, paragraph, buttons, video.
- Show 2-3 robot avatars/cards as a compact "agent relay" row.
- Disable pointer parallax.
- Disable most packet lines.
- Keep one simple message bubble sequence if it does not overlap.

Mobile priority:

1. Text readable.
2. CTA reachable.
3. Video playable.
4. No horizontal overflow.
5. No text inside buttons clipped.

Mobile layout:

```text
1. headline
2. slogan strip
3. paragraph
4. CTA row, stacked or 2-column depending width
5. compact agent relay row
6. video frame
7. feature strip or first 2 feature chips
```

Rules:

- Hide city floor glow.
- Use mobile background crop.
- Keep only 2-3 robots or convert them into small role avatars.
- Disable pointer parallax.
- Disable complex connector SVG or reduce to one simple line.
- Keep video free of absolute overlays except play controls.
- Use `svh` carefully. Do not force a 100svh hero if content needs more height.

Breakpoint checklist:

```text
1536x960: full cinematic scene
1440x900: full scene, no CTA overlap
1280x800: robots still clear, feature strip may compress
1024x768: copy stacked above scene or reduced scene
768x1024: tablet portrait works without horizontal scroll
430x932: mobile hero readable
390x844: no clipped buttons/text
360x800: minimum practical mobile width
```

## Accessibility Plan

- Decorative robots use `aria-hidden="true"` unless they become meaningful UI.
- Video keeps controls and labels.
- CTA buttons remain keyboard-focusable.
- Use visible focus ring with cyan outline.
- Respect `prefers-reduced-motion`.
- Avoid important text only inside generated assets.
- Keep contrast high over the background.

Detailed rules:

- Main `h1` appears once.
- Slogan strip can be a paragraph or `div`, not another heading.
- Message bubbles are decorative if they duplicate the concept. Use `aria-hidden="true"` to avoid screen reader noise.
- If message bubbles become meaningful content, expose one static sentence near the hero instead of announcing every animation.
- Do not auto-play video with sound.
- Video click targets must be reachable by keyboard controls.
- Focus ring should be visible on:
  - download CTA
  - watch demo button
  - documentation button
  - video controls
  - language/github/nav controls
- Avoid flashing faster than safe accessibility thresholds. Packet pulses should be soft and slow.

Reduced motion behavior:

```scss
@media (prefers-reduced-motion: reduce) {
  .cyber-hero *,
  .cyber-hero *::before,
  .cyber-hero *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
  }
}
```

Better than only killing animation:

- Keep static connector lines visible.
- Keep robots visible.
- Show one static bubble like `Agents coordinate work automatically.`
- Disable pointer and scroll parallax.

## Performance Plan

Budget:

- LCP should be the hero headline or video poster, not a giant late image.
- Hero background WebP target: <= 450KB if possible.
- Each robot WebP target: 20-90KB.
- Total above-the-fold image budget: ideally <= 1.2MB.

Tactics:

- Use compressed WebP.
- Preload hero background only if it materially improves LCP.
- Lazy-load robots below fold or low-priority decorative robots.
- Avoid animating filters on large layers.
- Use `contain: paint` where useful.
- Use `will-change` only on actively animated layers, not globally.

Loading strategy:

- Use WebP as the primary format. No fallback is needed for normal modern desktop/mobile browser targets unless analytics proves legacy traffic matters.
- Preload only the desktop/mobile hero background selected by media query if testing shows it improves LCP.
- Do not preload every robot.
- Eager-load:
  - hero background
  - video poster
  - 2-3 most visible robots
- Lazy-load:
  - lower robots
  - floor glow if it is not needed for LCP
  - decorative overlays below the first viewport

Example preload:

```ts
useHead({
  link: [
    {
      rel: "preload",
      as: "image",
      href: "/_nuxt/assets/images/hero/backgrounds/cyber-city-desktop-v1.webp",
      type: "image/webp",
      media: "(min-width: 768px)",
    },
  ],
});
```

Check actual Nuxt asset output before hardcoding generated `_nuxt` paths. If asset URLs are fingerprinted by imports, use imported URLs instead.

Runtime performance:

- Use one `requestAnimationFrame` loop for parallax.
- Use one message cycle timer.
- Avoid per-robot `setInterval`.
- Avoid reactive updates on every animation frame if CSS variables can handle it.
- Stop animation when hero is outside viewport.
- Pause message cycle on hidden tab.

Visual performance checks:

- Chrome Performance: no long purple paint blocks during idle hero.
- Layers panel: animated layers are promoted reasonably, not every tiny child.
- CPU throttling: hero still feels acceptable at 4x slowdown.
- Mobile Safari/Chrome smoke: no scroll jank.

### CLS and LCP Rules

Layout stability score: 🎯 9   🛡️ 9   🧠 6.

CLS prevention:

- Reserve hero height with `min-height` and stable grid tracks.
- Reserve video space with `aspect-ratio: 16 / 9`.
- Reserve robot image boxes with explicit width/height or CSS dimensions.
- Do not let late-loading robot assets push text, CTAs, or video.
- Do not swap font sizes after load.
- Do not show a new status strip above the headline after hydration.

LCP strategy:

- The headline should render immediately.
- Background can load as enhancement, but the dark base background must look acceptable before image load.
- Video should have a stable poster or skeleton.
- Avoid making a massive background image the LCP element if it delays first impression.
- If the background becomes LCP and is slow, either preload it or reduce size.

CSS fallback before image load:

```scss
.cyber-hero {
  background:
    radial-gradient(circle at 70% 20%, rgba(0, 234, 255, 0.12), transparent 34%),
    linear-gradient(180deg, #02050d, #050814 58%, #02050d);
}
```

Hard stop:

- If the first implementation creates visible layout shift when robots/video load, fix layout reservations before adding more animation.

## Production Implementation Blueprint

This section is the direct coding plan. Follow it in order to avoid turning the hero into a fragile visual experiment.

### Step 1 - Freeze the Visual Contract

Create a short constant file before touching the Vue layout:

```text
landing/data/heroScene.ts
```

It should export:

```ts
export const HERO_SCENE_VIEWBOX = {
  width: 1600,
  height: 900,
} as const;

export const HERO_SCENE_BREAKPOINTS = {
  desktop: 1200,
  tablet: 768,
} as const;
```

Why:

- SVG paths, robot positions, and message bubbles need one coordinate system.
- Breakpoints should not be guessed differently in every component.
- Viewbox-based thinking makes the layout easier to debug.

Acceptance:

- Every robot position can be described as a percent or viewbox coordinate.
- Connector paths do not depend on current DOM measurements.
- Mobile can intentionally use a simplified coordinate map.

### Step 2 - Build the Static Shell First

Do not add robots, packets, or parallax until this is done:

- background layer
- dark wash layer
- headline
- slogan strip
- paragraph
- CTA row
- terminal note
- video frame placeholder
- bottom feature strip placeholder

Best practice:

- Use a real `<h1>`.
- Keep text in DOM.
- Keep buttons as normal links/buttons.
- Use CSS backgrounds for atmosphere only.
- Avoid absolute positioning for the left copy.
- Use CSS grid for the main hero split.

Acceptance:

- If all decorative layers are hidden, the hero still works as a landing page.
- If JS fails, the hero still has copy, CTAs, and video fallback.
- First viewport is understandable without animation.

### Step 3 - Add Video Frame Without Scene Complexity

Before adding robots:

- wrap current video in `CyberHeroVideoFrame`
- add frame chrome
- verify click, seek, mute, fullscreen
- verify fallback state
- verify mobile behavior

Best practice:

- Keep the video component unchanged as much as possible.
- Put frame visuals outside the video control layer.
- Use `pointer-events: none` on decorative chrome.
- Keep transform on wrapper, not on the video element itself when text readability matters.

Acceptance:

- User can play/pause without fighting overlays.
- Fullscreen does not include irrelevant hero decorations.
- Video controls are not clipped by `clip-path`.

### Step 4 - Add Robots as Data

Do not manually place 10 robots in template markup.

Add:

```text
landing/data/heroAgents.ts
```

Example production shape:

```ts
export const heroAgents = [
  {
    id: "lead",
    label: "Lead",
    accent: "cyan",
    asset: robotLead,
    desktop: {
      x: 52,
      y: 14,
      scale: 0.86,
      depth: 0.45,
      card: "right",
    },
    tablet: {
      x: 60,
      y: 10,
      scale: 0.72,
      depth: 0.35,
      card: "bottom",
    },
    mobile: {
      visible: true,
      order: 1,
      compactLabel: "Lead",
    },
    status: "Leading",
    tasks: ["Set priorities", "Coordinate team", "Review progress"],
  },
] as const;
```

Best practice:

- Import robot image URLs in the data file if Nuxt/Vite supports it cleanly.
- Keep display coordinates in data.
- Keep role copy in data until localization is needed.
- Keep CSS generic and driven by `style` variables from data.

Acceptance:

- Adding or removing a robot does not require new template structure.
- A designer/developer can tune robot placement in one data file.
- CSS stays generic.

### Step 5 - Add Connectors After Robot Positions Stabilize

Do not draw connector paths until robot locations are roughly final.

Connector path workflow:

1. Use the `1600x900` viewbox.
2. Draw paths from role card edge to video frame or another role.
3. Keep paths away from headline and CTA safe zones.
4. Add base paths first.
5. Add active path class second.
6. Add packet animation last.

Safe zones:

```text
desktop copy safe zone: x 0-620, y 120-640
desktop CTA safe zone: x 0-620, y 500-700
video safe zone: x 690-1370, y 250-680
feature strip safe zone: y 740-900
```

Acceptance:

- Path lines visually connect meaningful objects.
- No packet crosses headline or CTA cluster.
- Lines are still understandable when packets are disabled.

### Step 6 - Add Message Bubbles as a Controlled System

Use one active readable bubble sequence at a time.

Implementation:

- Parent owns active message ID.
- Robots receive active sender/receiver IDs.
- Connectors receive active connection ID.
- Bubbles render from the same message data.

Do not:

- let each robot decide when to talk
- use random timers
- show more than one readable bubble sequence at once
- put long copy in bubbles

Acceptance:

- A viewer can understand a handoff in 3-4 seconds.
- Animation can be paused safely.
- Reduced motion mode shows a static explanation.

### Step 7 - Add Parallax Last

Parallax is polish. It should never fix layout.

Add parallax only after:

- static layout works
- video frame works
- robots do not overlap key UI
- connectors are stable
- mobile composition is decided

Acceptance:

- With parallax disabled, the hero still looks good.
- With parallax enabled, it feels deeper but not unstable.
- No text becomes blurry due to aggressive transforms.

## File-by-File Implementation Notes

### `landing/components/sections/HeroSection.vue`

Keep:

- release download logic
- docs link logic
- locale behavior
- release badge if still useful

Change:

- replace current video background with `cyber-hero__background`
- replace old hero layout with cyber grid
- render `CyberHeroScene`
- render `CyberHeroFeatureStrip`
- keep CTA hrefs exactly functional

Avoid:

- moving download logic into visual components
- adding animation timers here
- adding robot arrays here

### `landing/components/hero/CyberHeroScene.vue`

Responsibilities:

- scene root
- robot list render
- connector component
- video frame component
- message bubble component
- pass active message state between children

Should not:

- know release/download links
- contain hero copy
- contain nav/header behavior

### `landing/components/hero/CyberHeroVideoFrame.vue`

Responsibilities:

- decorative frame
- platform glow
- corner accents
- wrap existing `HeroDemoVideo`

Should not:

- own video playback state unless unavoidable
- duplicate `HeroDemoVideo` logic
- intercept pointer events

### `landing/components/hero/CyberHeroRobot.vue`

Responsibilities:

- one robot image
- one role card
- active sender/receiver visual state
- idle CSS animation classes

Should not:

- start timers
- compute global message sequence
- draw SVG connectors

### `landing/components/hero/CyberHeroConnectors.vue`

Responsibilities:

- render SVG paths
- render animated packets
- highlight active connection

Should not:

- use DOM measurements for core path layout
- put user-visible text in SVG
- block clicks

### `landing/components/hero/CyberHeroMessageBubbles.vue`

Responsibilities:

- readable short bubble text
- sender/receiver bubble timing
- static reduced-motion fallback

Should not:

- own robot layout
- animate every message at once
- announce animated messages to screen readers

### `landing/composables/useCyberHeroParallax.ts`

Responsibilities:

- pointer normalization
- scroll normalization
- CSS variable updates
- listener setup and cleanup
- reduced-motion and touch checks

Should not:

- know robot IDs
- mutate component reactive state per frame
- run when hero is offscreen

## Layout Coordinate System

Use two coordinate layers:

1. **CSS layout grid** for the actual page.
2. **Scene viewbox** for robots, connectors, and messages.

CSS grid:

```text
copy column: semantic HTML, normal flow
scene column: positioned scene with stable aspect-ratio
feature strip: normal flow below grid
```

Scene viewbox:

```text
width: 1600
height: 900
video frame approximate box: x 520-1320, y 260-680
top robots zone: y 60-240
side robots zone: x 340-520 and x 1320-1540
bottom robots zone: y 660-820
```

Robot coordinate examples:

```text
Planner: x 48, y 10, scale 0.78
Lead: x 62, y 10, scale 0.82
Reviewer: x 82, y 14, scale 0.78
Researcher: x 42, y 40, scale 0.68
Developer: x 92, y 35, scale 0.72
Tester: x 86, y 58, scale 0.70
Ops: x 48, y 80, scale 0.76
Security: x 66, y 82, scale 0.74
Fixer: x 84, y 82, scale 0.72
Docs: x 42, y 62, scale 0.66
```

These are starting positions, not final values. Tune visually with screenshots.

Layout best practices:

- Scene root uses `aspect-ratio`.
- Robots use percent positioning inside scene root.
- Connectors use SVG viewbox.
- Mobile does not use the full desktop robot map.
- Do not calculate robot positions from element measurements during render.

## UI Polish Details

### Headline

Implementation:

```html
<h1 class="cyber-hero__title">
  <span>Agent</span>
  <span class="cyber-hero__title-accent">Teams</span>
</h1>
```

Rules:

- Keep `Agent` and `Teams` able to wrap on mobile.
- Use gradient only on `Teams` or a controlled span.
- Do not apply `text-shadow` so strongly that letters blur.
- Add dark wash behind copy instead.

### Slogan Strip

Implementation:

```html
<p class="cyber-hero__slogan">
  YOU'RE THE CTO, AGENTS ARE YOUR TEAM.
</p>
```

Rules:

- Use real text.
- Use mono font.
- Keep one line on desktop.
- Allow wrap on mobile if needed.
- Add angular frame corners with pseudo-elements.

### Terminal Note

The dev branch note can become a cyber terminal strip.

Rules:

- Keep it clickable if it links to dev branch.
- Use `>` prompt style.
- Keep release version as small right-aligned text on desktop.
- On mobile, stack release version under the terminal line.

### Feature Strip

Rules:

- Feature strip should not look like five separate floating cards.
- Use one full-width angular rail with internal separators.
- Icons can glow, but text should stay calm.
- On mobile, show 2-3 compact chips or move full strip below hero.

## CSS Implementation Recipes

These are the preferred low-level patterns. Use them before inventing one-off effects.

### Angular Panel

Use one reusable primitive for HUD panels:

```scss
.cyber-panel {
  position: relative;
  background:
    linear-gradient(135deg, rgba(5, 14, 31, 0.92), rgba(3, 10, 22, 0.68));
  border: 1px solid rgba(0, 234, 255, 0.42);
  clip-path: polygon(18px 0, 100% 0, 100% calc(100% - 18px), calc(100% - 18px) 100%, 0 100%, 0 18px);
  box-shadow:
    0 0 0 1px rgba(47, 125, 255, 0.12) inset,
    0 0 24px rgba(0, 234, 255, 0.12);
}

.cyber-panel::before,
.cyber-panel::after {
  content: "";
  position: absolute;
  pointer-events: none;
  border-color: rgba(0, 234, 255, 0.78);
}
```

Rules:

- Use `cyber-panel` for slogan, terminal note, robot role cards, and feature rail variants.
- Do not duplicate a new panel style for every component.
- Use accent classes for color changes: `.cyber-panel--magenta`, `.cyber-panel--amber`.

### Neon Border Without Heavy Blur

Good:

```scss
.cyber-frame {
  border: 1px solid rgba(0, 234, 255, 0.58);
  box-shadow:
    0 0 0 1px rgba(0, 234, 255, 0.16) inset,
    0 0 20px rgba(0, 234, 255, 0.16),
    0 0 48px rgba(255, 43, 255, 0.08);
}
```

Avoid:

```scss
/* Too expensive and visually mushy */
box-shadow: 0 0 80px #00eaff, 0 0 160px #ff2bff;
filter: drop-shadow(0 0 60px #00eaff);
```

### Scanline Layer

Use a very subtle overlay:

```scss
.cyber-hero__scanlines {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.12;
  background-image: repeating-linear-gradient(
    to bottom,
    rgba(255, 255, 255, 0.08) 0,
    rgba(255, 255, 255, 0.08) 1px,
    transparent 1px,
    transparent 4px
  );
  mix-blend-mode: overlay;
}
```

Rules:

- Keep opacity low.
- Do not animate scanlines unless a tiny movement actually improves the scene.
- Disable or reduce on mobile if text looks noisy.

### SVG Connector Style

```scss
.cyber-connectors__path {
  fill: none;
  stroke: rgba(0, 234, 255, 0.36);
  stroke-width: 1.2;
  vector-effect: non-scaling-stroke;
}

.cyber-connectors__path-glow {
  fill: none;
  stroke: rgba(0, 234, 255, 0.18);
  stroke-width: 5;
  vector-effect: non-scaling-stroke;
}

.cyber-connectors__path--active {
  stroke: rgba(255, 43, 255, 0.86);
}
```

Rules:

- Render glow as separate wider low-opacity path.
- Keep the base line crisp.
- Use active class only for current message route.

### Responsive Typography Tokens

Use bounded `clamp()`:

```scss
.cyber-hero__title {
  font-size: clamp(2.35rem, 5.2vw, 5.8rem);
  line-height: 0.96;
}

.cyber-hero__description {
  font-size: clamp(1rem, 1.15vw, 1.22rem);
  line-height: 1.65;
}
```

Rules:

- Never use unbounded `vw` font sizes.
- Check longest translated string before locking button widths.
- Keep line length around 48-68 characters for paragraph copy.

### Stable Button Layout

```scss
.cyber-hero__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.cyber-hero__action {
  min-height: 52px;
  min-width: 172px;
  padding: 0 22px;
}

@media (max-width: 480px) {
  .cyber-hero__action {
    flex: 1 1 100%;
    min-width: 0;
  }
}
```

Rules:

- Use fixed min heights.
- Do not make button width depend on hover state.
- Ensure icon and text stay aligned when labels localize.

## Component Definition of Done

### `HeroSection.vue`

Done when:

- hero copy is semantic HTML
- CTA links work
- release/dev note behavior still works
- no scene-specific animation state exists here
- layout works with JS disabled except advanced animation

### `CyberHeroScene.vue`

Done when:

- all layers follow z-index contract
- decorative layers do not intercept pointer events
- scene has stable aspect ratio
- mobile does not render a broken desktop composition
- reduced motion class/prop is respected

### `CyberHeroVideoFrame.vue`

Done when:

- video plays, pauses, seeks, mutes, and fullscreen works
- frame chrome does not clip controls
- loading and error states are styled
- mobile removes perspective transforms if they blur the video

### `CyberHeroRobot.vue`

Done when:

- robot is positioned via data-driven CSS variables
- active sender/receiver states work
- role card is readable
- idle animation does not override parallax transform
- image has width/height or reserved layout space

### `CyberHeroConnectors.vue`

Done when:

- paths use a shared viewbox
- paths do not cross copy/CTA safe zones
- active route is visually obvious
- packets can be disabled without losing all meaning
- SVG is `aria-hidden`

### `CyberHeroMessageBubbles.vue`

Done when:

- one message sequence is active at a time
- timers clear on unmount
- hidden tab pauses sequence
- reduced motion shows static copy
- bubbles never cover CTA or video controls

### `useCyberHeroParallax.ts`

Done when:

- listeners attach only on client
- listeners are cleaned up
- pointer values are clamped
- RAF is used
- touch/mobile and reduced motion disable it
- no Vue reactive state updates every frame

## Nuxt and Vue Best Practices

- Use `ClientOnly` only where browser APIs or video behavior require it.
- Keep SSG-safe content rendered on server where possible.
- Do not gate the whole hero behind `ClientOnly`.
- Use `onMounted` only for pointer/parallax/IntersectionObserver logic.
- Clear timers and observers on unmount.
- Do not put random `Math.random()` values in SSR-rendered markup. Use deterministic delays from data.
- Prefer typed `as const` data arrays for roles, connections, and messages.
- Keep imports path-stable and avoid magic relative paths when aliases are available.
- Keep local visual components under `landing/components/hero/` because this is a landing-only visual system.

Hydration safety:

- Initial rendered message state should be deterministic.
- Do not render different robot counts on server and client based on `window.innerWidth`.
- Use CSS media queries to hide/show by breakpoint, or compute client-only variants after mount with stable fallback.

## PR Slicing Strategy

PR slicing score: 🎯 9   🛡️ 9   🧠 5.

Do not ship the full cinematic hero as one giant unreviewable diff.

### PR 1 - Static Shell and Video Frame

Scope:

- new cyber hero layout
- background layer
- copy/CTA layout
- video frame wrapper
- no final robots
- no parallax

Expected size: **450-750 lines**.

Acceptance:

- page builds
- hero is readable
- video works
- no status metrics block
- screenshot review passes static composition

### PR 2 - Robot Data and Static Robots

Scope:

- `heroAgents.ts`
- `CyberHeroRobot`
- 4-6 robot assets or placeholders
- role cards
- basic idle CSS

Expected size: **350-650 lines**.

Acceptance:

- robots communicate product meaning
- no overlap with CTA/video
- mobile hides/simplifies robots correctly

### PR 3 - Connectors and Message Bubbles

Scope:

- `heroConnections`
- `CyberHeroConnectors`
- `CyberHeroMessageBubbles`
- one deterministic message cycle
- reduced motion fallback

Expected size: **350-650 lines**.

Acceptance:

- one readable handoff sequence
- packets route around safe zones
- timers clean up
- no animation chaos

### PR 4 - Parallax and Polish

Scope:

- `useCyberHeroParallax`
- depth variables
- final responsive tuning
- final asset compression
- screenshot and performance pass

Expected size: **250-500 lines**.

Acceptance:

- parallax enhances but does not carry layout
- reduced motion is polished
- screenshot set passes
- `pnpm --dir landing generate` passes

Recommended path: PR 1 -> PR 2 -> PR 3 -> PR 4. This keeps review quality high and avoids hiding layout bugs under animation.

## Visual QA Workflow

Use screenshot-based review, because this hero is visual and small CSS changes can break composition.

Minimum screenshot set:

```text
1440x900 desktop
1920x1080 wide desktop
1280x800 laptop
1024x768 tablet landscape
768x1024 tablet portrait
430x932 mobile
390x844 mobile
360x800 narrow mobile
```

For every screenshot, check:

- headline readable
- slogan readable
- CTA visible without scrolling on common desktop heights
- video frame visible and not covered
- robots do not cover important UI
- connectors do not cross CTA/headline
- feature strip either peeks cleanly or moves below content
- no horizontal scroll
- no text clipped inside buttons

Motion QA:

- 30 seconds idle with no obvious jank.
- Move pointer slowly across desktop hero.
- Scroll hero partially out of view and back.
- Switch tab away and back.
- Toggle reduced motion.
- Try video play/pause while animations run.

Performance QA:

- Check image transfer size.
- Check LCP element.
- Check if any animated layer repaints the whole viewport.
- Check CPU usage during idle.
- Check mobile scroll smoothness.

## Review Gates

These gates decide whether the implementation is ready to continue.

### Gate 1 - Static Design Gate

Pass when:

- headline, slogan, paragraph, CTAs, video frame, and feature strip are readable at `1440x900`
- mobile layout works at `390x844`
- no status metrics block exists
- screenshot looks like the selected reference in composition and mood

Fail when:

- video looks secondary
- CTA is buried
- background makes text hard to read
- layout only works at one viewport size

### Gate 2 - Interaction Gate

Pass when:

- video controls work
- CTA links work
- keyboard focus is visible
- reduced motion keeps a polished static scene
- animations pause offscreen or hidden tab

Fail when:

- frame overlays block video controls
- focus ring is clipped
- animation keeps running aggressively offscreen
- reduced motion leaves broken empty elements

### Gate 3 - Visual Density Gate

Pass when:

- active elements are visually prioritized
- inactive robots/cards are quieter
- packet lines are visible but not dominant
- only one readable bubble sequence is active

Fail when:

- everything glows equally
- robots compete with headline
- connector lines cover CTAs
- message bubbles feel like spam

### Gate 4 - Performance Gate

Pass when:

- first viewport image budget is near target
- no obvious CLS
- no obvious scroll jank
- animation CPU cost is acceptable
- mobile remains usable

Fail when:

- background or robots cause visible late layout shifts
- idle animation repaints huge layers
- mobile scroll feels heavy
- video interaction lags

## Manual Test Script

Use this exact human smoke test before calling the hero ready:

1. Open landing page fresh with cache disabled.
2. Wait 2 seconds.
3. Confirm first impression: headline, slogan, CTA, video, robots.
4. Move mouse slowly left to right.
5. Confirm parallax is subtle.
6. Click `Watch Demo` or video play.
7. Seek video.
8. Try fullscreen and exit fullscreen.
9. Scroll down until hero is half hidden.
10. Confirm animation calms down or stops.
11. Resize to `390x844`.
12. Confirm no horizontal scroll.
13. Enable reduced motion.
14. Reload and confirm static scene still looks designed.

If any step fails, fix before tuning small visuals.

## Implementation Phases

### Phase 0 - Asset and layout proof

Score: 🎯 9   🛡️ 9   🧠 4 - **80-160 lines**

Tasks:

- Confirm final desktop background crop.
- Confirm mobile background crop.
- Prepare 2-3 temporary robot assets or placeholders.
- Create a rough CSS grid in a throwaway branch or component state.
- Verify that headline, CTA, video, and 3 robots fit at 1440x900 and 390x844.

Acceptance:

- No full implementation starts before the composition works.
- The left copy area remains readable over the background.
- The video frame area has enough space for controls.
- Robot placement does not depend on lucky viewport dimensions.

### Phase 1 - Static cyberpunk hero shell

Score: 🎯 9   🛡️ 9   🧠 5 - **250-400 lines**

Tasks:

- Replace current background video hero with WebP city background layer.
- Add dark gradient wash and scanline layer.
- Build headline layout matching reference.
- Add exact slogan strip.
- Remove any status metrics block.
- Keep existing CTA links and release note behavior.

Acceptance:

- Desktop first viewport resembles the reference composition.
- Text is readable.
- No animation yet.
- Top-left status metrics block is absent.
- The slogan is exact.
- No horizontal scroll at desktop/tablet/mobile test widths.

### Phase 2 - Video frame

Score: 🎯 9   🛡️ 8   🧠 6 - **180-300 lines**

Tasks:

- Wrap existing `HeroDemoVideo` in cyberpunk video frame.
- Add angular border, glow, corner accents, and platform reflection.
- Ensure video controls still work.
- Verify fullscreen still works.

Acceptance:

- Central/right block is clearly a video.
- Decorative layers do not block clicks.
- Video play/pause works.
- Fullscreen works.
- Error fallback looks intentional.

### Phase 3 - Robot layer

Score: 🎯 8   🛡️ 8   🧠 7 - **280-500 lines**

Tasks:

- Add `heroAgents.ts`.
- Add robot assets.
- Render robots through `CyberHeroRobot`.
- Add role cards and short task lists.
- Add idle bob, eye blink, screen pulse.

Acceptance:

- 8-10 robots visible on desktop.
- Product meaning is obvious without reading paragraph.
- No robots overlap headline, CTA, or video controls.
- At least 4 roles are visually distinct.
- At least 2 primary robots have active glow/eye/screen states.

### Phase 4 - Message passing 1 + 2

Score: 🎯 9   🛡️ 9   🧠 7 - **220-380 lines**

Tasks:

- Add SVG connector network.
- Animate packet dots along paths.
- Add timed message bubbles.
- Tie bubble events to sender/receiver pulse classes.
- Reduce message density on smaller screens.

Acceptance:

- It is clear that robots pass work between each other.
- Animation feels alive, not chaotic.
- Messages stay readable and short.
- Only one readable message sequence is active at a time.
- Packets do not visually cross the headline or CTA area.

### Phase 5 - Parallax

Score: 🎯 8   🛡️ 8   🧠 7 - **150-260 lines**

Tasks:

- Add `useCyberHeroParallax`.
- Track pointer and scroll with `requestAnimationFrame`.
- Set CSS variables on hero root.
- Apply depth-based movement to background, video, robots, connectors.
- Disable on mobile and reduced motion.

Acceptance:

- Scene reacts subtly to pointer.
- Scroll creates layer separation.
- No jank on desktop.
- Parallax is disabled on touch/mobile.
- Reduced motion mode is static and still polished.

### Phase 6 - Responsive polish

Score: 🎯 8   🛡️ 9   🧠 8 - **220-420 lines**

Tasks:

- Desktop, tablet, mobile layouts.
- Hide or simplify robots by breakpoint.
- Reduce connector complexity on mobile.
- Ensure CTA and video are still first-class.
- Tune feature strip.

Acceptance:

- No horizontal scroll.
- No text overlap.
- Buttons fit.
- Video is usable on mobile.
- Tablet does not look like a broken desktop crop.
- Mobile still communicates robots/agent coordination.

### Phase 7 - Quality pass

Score: 🎯 9   🛡️ 9   🧠 5 - **80-160 lines**

Tasks:

- Run `pnpm --dir landing lint`.
- Run `pnpm --dir landing generate`.
- Browser smoke in desktop and mobile widths.
- Screenshot compare against reference.
- Check reduced motion mode.
- Check video controls.

Acceptance:

- Static generation succeeds.
- No major visual regressions.
- Hero is close to reference and still usable.
- Screenshot review passes at the target viewport sizes.
- Performance is acceptable with animations running.

## Verification Checklist

Visual review process:

1. Start the landing dev server with `pnpm --dir landing dev`.
2. Capture desktop, tablet, and mobile screenshots.
3. Compare against the reference for composition, not pixel perfection.
4. Check hero with motion enabled.
5. Check hero with reduced motion.
6. Check video interaction.
7. Check with slow network or cached disabled once.

Design acceptance rubric:

- First impression - 🎯 target 9/10: product feels premium and distinctive.
- Clarity - 🎯 target 9/10: user understands multi-agent coordination.
- Readability - 🛡️ target 9/10: text and CTAs stay clear over background.
- Responsiveness - 🛡️ target 8/10: tablet/mobile are intentionally composed.
- Motion taste - 🎯 target 8/10: animated but not chaotic.
- Performance - 🛡️ target 8/10: no obvious jank.
- Maintainability - 🛡️ target 8/10: components/data are not tangled.

- [ ] `pnpm --dir landing lint`
- [ ] `pnpm --dir landing generate`
- [ ] Desktop screenshot: 1440x900
- [ ] Wide desktop screenshot: 1920x1080
- [ ] Tablet screenshot: 1024x768
- [ ] Mobile screenshot: 390x844
- [ ] Video play/pause works
- [ ] Video fullscreen works
- [ ] CTA links work
- [ ] Docs link respects locale
- [ ] Reduced motion disables parallax and packet movement
- [ ] No status metrics block in hero
- [ ] Slogan text is exact
- [ ] Robots do not cover important UI
- [ ] Message bubbles do not overlap CTA/video controls

## Design and Layout Do/Don't

Do:

- Use real HTML for headline, CTA, nav, and slogan.
- Treat video as the hero product surface.
- Let robots support the video instead of fighting it.
- Use strong dark washes behind readable text.
- Use fewer, better neon accents.
- Keep all animations transform/opacity-based.
- Make mobile a different composition.
- Test with screenshots before polishing tiny details.

Don't:

- Put the whole hero into one image.
- Add random neon panels with no information purpose.
- Put text inside generated assets.
- Use giant glowing blur on every panel.
- Animate every robot and every connector equally.
- Let packets cross the CTA cluster.
- Use purple/magenta everywhere.
- Hide video controls under chrome overlays.
- Depend on desktop absolute positions for mobile.

## Common Failure Cases

### Failure 1 - Looks like a poster, not a product page

Symptoms:

- video frame feels decorative
- CTAs are visually weak
- text is hard to read
- robots dominate the page

Fix:

- darken copy area with a local wash
- reduce robot opacity/scale near headline
- make video frame larger and cleaner
- simplify background behind text
- keep only one active message bubble

### Failure 2 - Cyberpunk style becomes noisy

Symptoms:

- too many glows
- every border is bright
- packets everywhere
- role cards fight with the video

Fix:

- reduce base connector opacity
- keep magenta only for activity
- keep cyan for structure
- remove secondary HUD panels that do not explain the product
- make inactive role cards quieter

### Failure 3 - Mobile is just a broken desktop crop

Symptoms:

- horizontal scroll
- video too small
- buttons wrap badly
- robots cover text
- connectors become random lines

Fix:

- switch to vertical composition
- hide most robots
- replace full connector network with compact agent relay row
- use mobile background crop
- move feature strip below hero content

### Failure 4 - Animations feel cheap

Symptoms:

- all robots move in sync
- parallax is too strong
- packets move too fast
- message bubbles spam the scene

Fix:

- stagger durations and delays
- cut parallax values by 30-50%
- use one readable bubble sequence
- slow packets to `2800-4600ms`
- keep idle motion under 6px for most robots

### Failure 5 - Performance drops

Symptoms:

- scroll jank
- CPU stays high while idle
- mobile browser gets hot
- frames drop during parallax

Fix:

- reduce animated shadows
- remove animated filters
- reduce visible packet count
- disable complex animation on mobile
- stop message cycle when offscreen
- check if a large layer repaints every frame

## Risks

### Risk 1 - Generated assets do not match the reference

Score: 🎯 7   🛡️ 6   🧠 6

Mitigation:

- Generate background and robot assets separately.
- Keep the current full mockup as visual reference only.
- Iterate assets before deep CSS tuning.

### Risk 2 - Scene becomes too cluttered

Score: 🎯 8   🛡️ 7   🧠 5

Mitigation:

- Limit active message bubbles to one sequence.
- Limit visible packet count.
- Hide lower-priority robots on tablet/mobile.
- Keep left hero area visually clean.

### Risk 3 - Animation hurts performance

Score: 🎯 8   🛡️ 8   🧠 6

Mitigation:

- Transform/opacity only.
- No animated blur filters on large layers.
- Disable heavy motion on mobile.
- Respect reduced motion.

### Risk 4 - Video controls get blocked

Score: 🎯 9   🛡️ 8   🧠 4

Mitigation:

- All decorative frame overlays use `pointer-events: none`.
- Only video controls receive pointer events inside the frame.

## Suggested First PR Scope

Best first implementation slice:

1. Phase 0 layout proof with final-ish background crop and 2-3 robot placeholders.
2. Static cyberpunk hero shell.
3. Video frame with existing demo.
4. 4 placeholder robot layers with CSS animation.
5. Connector SVG with simple packets.
6. One readable message bubble sequence.
7. Keep final 8-10 robot asset pass for the next slice.

Score: 🎯 9   🛡️ 8   🧠 6 - **850-1200 lines**.

Reason:

- Gets the visual direction into code quickly.
- Keeps risk manageable.
- Lets us verify layout and parallax before spending too much time on final robot assets.

## Final Target

The final hero should feel like this:

- The city is alive in the background.
- The demo video is the central command console.
- Robots are active teammates around the console.
- Neon packets show work moving through the team.
- Message bubbles explain the coordination in human-readable moments.
- The user immediately understands: this product is an AI engineering team dashboard.

## Summary

📌 Build the hero as a layered scene: WebP background, real video frame, separate robot assets, SVG connector packets, readable message bubbles, and CSS/Vue parallax. The chosen implementation is visually strong, maintainable, SSG-safe, and realistic for the existing Nuxt landing app.
