# Gamut Toolbox — Roadmap

Feature ideas and specs, oriented around the designer / front-end developer workflow.
Gamut Toolbox's edge is the intersection of **live page + AI agent + design-system awareness** —
the strongest features are the ones that need all three.

---

## 🧹 Small TODOs

- [ ] **Extract has no "Meet the tools" description.** `src/tools.js` gives Extract (`Alt+E`)
      no `desc`, so it's missing from the onboarding tour. Add one along the lines of:
      "Pull or download elements from the working window: their content, images and media."
      *(noted 2026-09-26)*
- [ ] **README tool list is stale.** It still lists Resize (now Move) and bare-key shortcuts
      (they're `Alt+key`), and leaves out Sliders, Design drift and Export. *(noted 2026-09-26)*
- [ ] **Storybook block still says "Gamut Terminal".** The managed `## Design System (Storybook)`
      block that `storybookBlock()` in main.js writes into CLAUDE.md / AGENTS.md / GEMINI.md reads
      "set in your environment by Gamut Terminal". Update the template to "Gamut Toolbox".
      *(noted 2026-09-26)*

---

## 🟢 Speccing now

### 1. Design-drift scanner

**Problem.** Front-end code accretes hard-coded values — a `#3B82F6` that's *almost* the
brand blue, a magic `13px` that's off the spacing scale, a one-off `border-radius`. This is
exactly the "design drift" and "UI consistency" Gamut Toolbox's pitch promises to eliminate. Today
nothing catches it; it's the reviewer's eyeballs.

**What it does.** Scans the live page for CSS values that don't map to the project's design
tokens, groups the drift, and offers one-click "replace with token" via the agent.

**Token source (the crux).** Resolve "approved" tokens in priority order:
1. **Connected Storybook** — extract CSS custom properties / theme from the running instance
   (we already read its `/index.json`; extend to pull the theme's `:root` vars).
2. **Project config** — `tailwind.config.*`, a `design-tokens.json`, or the page's own
   `:root` custom properties.
3. **Fallback** — treat the page's `:root` custom properties as the system and flag literals
   that *should* reference them.

**User flow.**
1. Trigger from the toolbar (new tool alongside Accessibility/Eyedropper).
2. An inject script walks computed styles and collects used colors, spacing
   (margin/padding/gap), font-sizes, radii, shadows.
3. Each value is matched against the token set; near-misses and off-scale values are flagged.
4. A **Drift panel** lists findings grouped by category, each with an element locator, the
   offending value, and the suggested token. Hovering a row highlights the element on the page.
5. Select findings → **Send to agent**, which edits the source to use tokens.

**Reuses (already in the app).**
- **Accessibility tool architecture** (`getA11yScript` → scan → report → highlight → send to
  chat) is the same shape; this is "a11y scanner, but for tokens."
- **Eyedropper** color logic for perceptual color matching (ΔE distance to the nearest token).
- **Storybook integration** (`/index.json`, multi-instance registry) for the token source.
- **On-page highlight** (`CP_HIGHLIGHT_TARGET` / pick highlight) for row→element hover.
- **Extract/a11y panel UI** for the findings list.

**Build phases.**
1. Token-source resolution — page `:root` scan + **connected Storybook** preview `:root` (Storybook wins on name conflict, page fills gaps). ✅ *Built*.
2. Inject scanner for **colors** (highest value, cleanest matching via ΔE). ✅ *Built* (v1.0.27).
3. Drift panel + on-page highlight + send-to-agent fix. ✅ *Built*.
4. Extend to **type / radius / shadow**. ✅ *Built* — font-size + border-radius (px distance, name-gated tokens) and box-shadow (structural distance). Only **spacing** (snap to an inferred scale) remains.

**Open questions.**
- Match threshold: how close is "you meant this token"? (per-category tolerance).
- Intentional one-offs: allow an ignore-list / inline `/* drift-ok */` escape hatch.
- Spacing scale: infer from tokens, or from the modal cluster of used values?

---

### 2. States & responsive inspector

**Problem.** A single desktop render hides most of the UI's surface area: hover/focus/active/
disabled states, dark mode, and every breakpoint. These are where bugs live and where the
agent gets no signal, because the designer can't easily *show* them the broken state.

Two tracks that share one foundation (**Chromium DevTools Protocol via
`webContents.debugger`** — no source changes to the page).

**Track A — Pseudo-state inspector.** ✅ *Built.* Folded into the Box/Lasso panel: each
selected element's drawer has a sticky **States** row (`:hover · :focus · :active · :disabled`)
that forces that element's state live via CDP `CSS.forcePseudoState` (node IDs cached per
selection so toggles clear reliably). Below is the original standalone concept for reference.
- Select an element (reuse the picker), and a small state bar appears:
  `:hover · :focus · :active · :disabled · dark`.
- Toggling a state forces it live via CDP `CSS.forcePseudoState` (and
  `Emulation.setEmulatedMedia` for `prefers-color-scheme` / `prefers-reduced-motion`).
- The element now *renders* in that state, so you can inspect it and tell the agent
  "fix the focus ring" while seeing exactly what they're changing.

**Track B — Multi-viewport.**
- A breakpoint bar (`375 · 768 · 1440 · custom`) drives CDP
  `Emulation.setDeviceMetricsOverride` to render the page at that width.
- "Fix at this breakpoint" hands the agent the current width so its change is scoped.
- Stretch: a responsive linter that flags overflow, clipped text, and sub-44px tap targets
  at each breakpoint (extends the Accessibility scanner).
- Stretch++: true side-by-side frames (multiple `WebContentsView`s) — heavier; defer.

**Reuses (already in the app).**
- **Picker-inject** for element selection.
- **`webContents.debugger`** (Electron) to speak CDP directly — we already run embedded
  DevTools + a remote-debugging port, so the plumbing exists.
- **Resize-inject** patterns and WebContentsView sizing for Track B.
- **Accessibility scanner** for the responsive linter.

**Build phases.**
1. CDP foundation — attach `webContents.debugger`, wire `forcePseudoState`.
2. State bar UI on element select (:hover/:focus/:active/:disabled).
3. `Emulation.setEmulatedMedia` — dark mode + reduced-motion toggles.
4. Track B: breakpoint switcher via `setDeviceMetricsOverride` + "fix at width."
5. Responsive linter (overflow / clipping / tap-target) per breakpoint.

**Open questions.**
- Multiple forced states at once (`:hover:focus`)? CDP supports it — expose as multi-select?
- Restore state cleanly on tool exit / navigation (detach debugger, clear overrides).
- Multi-viewport: emulate-and-resize the one view (simple) vs. real side-by-side (heavy).

---

## 🟡 Backlog (captured, not yet specced)

From hplan:
- **a) Wireframe / sketch tool** — crude sketching to fabricate wireframes fast; the payoff is
  the handoff: *sketch → agent generates real markup, ideally from Storybook components*.
  Builds on the Draw + Box/Lasso inject infra. Pairs with (d). Most on-mission.
- **b) Project switcher** — a better file-system interface for hopping between projects
  (recents, favorites, previews). Promotes the existing `SET_PROJECT_DIR` + recents into a
  proper launcher. Connective tissue.
- **c) Animation overhaul** — rework the Animate plugin around popular motion frameworks
  (Framer Motion / GSAP / CSS / Motion One) with a rethought UI + **live preview**. GSAP is
  already bundled and `animation-spec.js` exists, so preview is feasible. Biggest bet.
- **d) Framework-aware Storybook scaffolding** — spin up a Storybook with shadcn / Tailwind /
  MUI / Chakra. Mostly an agent-driven scaffold recipe per framework + registering the result.
  Pairs with (a) and the Design-drift scanner (scaffold with tokens, then enforce them).
- **e) Localhost server scanner** — ✅ *Built* (shipped v1.0.30). **Settings → Localhost Servers…**
  lists listening ports (port → process → pid), filtered to dev-server runtimes by default with a
  "Show all" toggle. Per row: **Open** in the in-app Browser, **Copy** the URL, or **Kill** the
  process (tree-kill, two-step confirm). Platform layer: `listPorts()` (`lsof` on macOS, `ss` on
  Linux, `Get-NetTCPConnection` on Windows) + `killPid()`.
- **f) AI spend management** — a mode / set of tools to see and control model spend. Gamut Toolbox
  already has the raw signals (context-window fill, 5-hour / weekly usage gauges, per-session
  token totals), so this is largely surfacing + acting on them.
  - ✅ *Built:* **AI Spend** dashboard (per-project / per-day / per-model cost, monthly budget bar).
  - ✅ *Built:* **Budget Guard** — a usage-limit threshold slider (% of the 5h/weekly limit) that
    advises at N%, can auto-open when the limit is reached, and does a **limit-aware handoff**: the
    current agent writes a self-contained brief to `HANDOFF.md`/`AGENTS.md`, then a fresh session on
    a budget agent (Hermes/Gemini/Codex) opens primed to read it and continue.
  - Remaining: **token-saving nudges** (auto-`/compact` reminders when context fills, context
    trimming), a true **budget mode** that biases model selection toward cheaper models, and
    surfacing threshold alerts *outside* the modal (Usage-panel chip / sound / OS notification).

From brainstorm (unpicked, parked):
- **Pixel-overlay compare** — overlay a Figma frame / reference image on the live page at
  adjustable opacity + onion-skin, to match designs pixel-for-pixel.
- **Before/after ghost diff** — slider-wipe between pre- and post-edit renders.
- **Componentization map** — highlight which page elements are real Storybook components vs
  one-off markup.
- **Visual regression snapshots** — baseline a page/component, diff on the next run.
- **Session review export** — package Draw annotations + before/after shots + the agent's
  file changes into a shareable review artifact.

---

## Synergies worth remembering
- **a + d** — sketch a wireframe → agent builds it *from your chosen component framework*: a
  full idea → real design-system UI pipeline.
- **e + b** — the localhost scanner feeds the project switcher ("3 servers running — open this").
- **Design-drift scanner + d** — scaffold with tokens, then enforce them. Mission-complete loop.
