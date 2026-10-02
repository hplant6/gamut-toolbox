# Changelog

All notable changes to Gamut Toolbox are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.17.0] - 2026-10-02

### Added
- **Projects can link extra folders.** A project whose code lives outside its own folder (say, a workspace folder whose work happens in a separate monorepo checkout) can now link that folder. Use **+ Link folder** on its Mission Control card, or answer **Part of <project>** when Gamut asks about a server or a newly cloned repo. Servers running anywhere in a linked folder are tracked under the project, with their start command, and agents are told the folder is in scope. Linking covers the whole repo, not just the one package a server runs from. A **Track…** button in the Running menu asks again about a folder you once marked "Not a project".
- **Docker servers are tracked.** A port published by a Docker container is matched to a project through the folder its compose stack was started from. It starts with `docker start` and stops with `docker stop`. Gamut finds the Docker CLI on the host or inside WSL.
- **The Sliders panel stays pinned to the page until you unpin it.** It no longer disappears when you close the Sliders column or pick another tool. It stays through reloads, in-app route changes and switches between the project page, Storybook and custom URLs, and only shows on the pages the panel is meant for. The page panel now has its own **Send**, Reset, hold-to-compare, Edit (opens the column) and **Unpin** (×) buttons. Unpinning puts the page back to the code's values, asking first if you have unsent changes. One panel is pinned per project; it comes back when you switch to that project and when you restart the app, and the toolbar button shows a ring while one is pinned. A new panel from an agent pins itself.

### Changed
- **The top-left logo is the white Gamut wordmark** with a chromatic-aberration split that eases in after launch and eases away while you hover it.
- **The Changes tab follows the active project**, including its linked folders. When a project spans several repos, each file is prefixed with its repo name and the branch line names each repo's branch.
- **Sliders colour controls accept any CSS colour** (`rgba()`, `hsl()`, `oklch()`, 8-digit hex, `var()`, keywords), kept exactly as the code writes it, and transparency survives picking a new colour. **From Page Vars** picks up those colour variables too.

### Fixed
- **Agent tabs run in their own project's folder.** Tabs reopened at startup, model switches, clears and reconnects used to start in whichever project was active at that moment, so an agent could end up editing the wrong repo.
- **Opening a Sliders panel no longer repaints the page.** It used to push every starting value into the page, and colour values that weren't plain `#rrggbb` were replaced with white, which blanked page backgrounds.
- **Servers start in their own folder** instead of always in the project's main folder.
- **Pausing or switching away from a project can no longer kill Docker Desktop.** Freeing a container's port used to target the process holding it, which for Docker is its own backend.
- **The Changes tab can't be pointed at another folder by the Storybook panel**, which used to repoint it behind the project switcher's back.
- **Restarting a terminal tab reruns its own command** instead of always plain `claude`.

## [1.16.0] - 2026-09-25

### Added
- **A Sliders tool (Alt+T): a live tuning panel for animations, effects and three.js scenes.** Instead of asking an agent to hand-build a throwaway slider modal in your project, the agent writes a small panel file to `.cathode/sliders/<id>.json`. Gamut opens it next to the page as soon as it appears. Controls can drive a CSS custom property with no code change, a `window` path (calling `.set()` on three.js vectors and colours), or a `gamut:slider` event. Types: range, int, colour, toggle, select, vec2/vec3 and button. Changed rows turn accent; double-click a label to reset it; Shift-drag fine-tunes. Ranges can snap to design tokens, and the bake message then names the token. Presets are saved into the panel file. Hold Compare (or `\`) to see the code's values; Copy/Paste move values as JSON. The sliders float over the page in the browser; pick the corner (top/bottom, left/right) and the panel's transparency in the tool column. With no panel yet, a sample panel with random values shows how it will look. **Send** hands the agent only the changed values, with their `file:line` hints, to write into the code. **From Page Vars** builds a starter panel from the page's `:root` CSS variables. Values survive reloads and HMR. Agents learn the file format from the project block in CLAUDE.md/AGENTS.md.
- **Export the page as PNG, JPG or PDF** from the new Export button beside the address bar (Ctrl+Shift+E). Choose the full page or the visible screen, 1×/2×/3×, transparency, JPG quality, a max height, a delay, clean-up switches and a filename pattern. Shift+click repeats your last export straight to the last folder. Full-page captures go one screen at a time and let each settle first, so scroll-reveal content isn't blank; "One pass" stays available as the fast option.
- **Attached files sit inline as chips** in the composer and every tool's instruction box, like Box/Lasso selection chips, and are sent as paths right where you placed them. Chat bubbles show them as chips too.
- **Retro**, a mid-gray theme with a cyan accent.
- **The Usage header shows the model Hermes is running** (e.g. `gpt-oss:20b`), the way it already did for Claude Code, and updates when you switch models. The chat banner names it too.

### Changed
- **Gamut Terminal is now Gamut Toolbox.** The display name, npm package name, window title, dialogs, onboarding and Storybook copy, and the update-check User-Agent all changed, and the GitHub repo moved to `hplant6/gamut-toolbox`. Old repo URLs redirect, so installed builds still find updates. Profiles created under the "Gamut Terminal" name are picked up in place, the same way "Cathode Terminal" ones already were. The appId and the `.cathode` file format are unchanged.
- **New empty-state background: "golden rings."** The Storybook-offline and Browser "Boot up a server" screens now show rotating golden-ratio rings with RGB-split trails instead of the iridescent cellophane sheets. A dark oval stays behind the title and buttons so they read cleanly. It renders at full display resolution, still only while the empty state is on screen.
- **The theme editor is a floating window** over the browser area: no dimmed background, draggable, and the rest of the app stays usable while it's open.
- **Graph 1 is its own theme colour**; it no longer follows Accent 1.
- **Briefcase** has deeper Accent 1 and Accent 2 colours.
- **Tool-panel header icons are one shade lighter**, so they stand out from the header.

### Fixed
- **The app no longer fails to start when a generated theme is active.** In 1.15.0 the theme was applied before its colour tables existed, which left the window unwired.

## [1.15.0] - 2026-09-25

### Added
- **A Move tool (Alt+V), in the slot the Resize tool used to hold.** Select an element, drag an arrow to where it should live, repeat for as many elements as you like, then send one numbered request. Each move carries the element's selector and HTML snippet, where it came from and where it goes, an optional note, and optionally a screenshot of the page with the arrows drawn on it. A **Snap | Drag** switch sits under the selection. Snap resolves a drop to before/after/inside an element, marked with insertion lines. Drag points the arrow at any spot and hands the agent the offset plus the element under it. **S** flips the switch. Shift+click selects several elements to move together; Shift while dragging snaps to the parent; Ctrl/⌘ on release records a pixel nudge instead. Click an arrow's number or arrowhead to delete it, or Ctrl+Z to undo. With something selected, a drag *anywhere* moves it and a click selects something else, so a press just outside the element no longer grabs its neighbour. The selection fills while it's grabbed. The panel lists each move as the element and how far it travels.
- **Resize handles in Box and Lasso.** Open one element's drawer and its outline becomes the old Resize tool's bounding box: 8 handles and a live W × H label. Dragging updates the element on the page and ticks the drawer's Width and Height rows, so the change goes out with Send like any other edit. Shift keeps the aspect ratio. The drag is applied to the element's computed CSS size, so padded `content-box` elements come out the right size, which the old Resize tool got wrong.
- **A Selection colour in the theme settings** (Page Tools → Selection). It sets the colour of everything the page tools draw on the page: Box/Lasso outlines, hover boxes and name tags, resize handles, Move arrows and badges, and the Screenshot, Eyedropper, Accessibility, Design-drift and Animate overlays. Those used to be a fixed orange whatever the theme. It's a separate value, set to each built-in theme's accent for now. Themes saved before it existed fall back to their accent.
- **Glacier**, a navy theme with a purple accent, and **Generate** in Custom Themes, which builds all 18 theme colours from a background and an accent. A generated theme follows the same lightness curve the built-in themes share, picking dark or light mode from the background. Status colours aren't generated, so red still means danger.
- **Agent tabs show a coloured dot when a background tab raises a notification**: green for a reply, orange when it's waiting on an approval, red for an error or usage limit. It clears when you open the tab.

### Changed
- **New agent tabs open in the permission mode you last picked** for that agent (e.g. Auto) instead of always starting in Ask. Plan and Bypass Permissions aren't remembered: Plan is usually a one-task detour, and Bypass asks for confirmation every time.
- **Switching Claude accounts now works reliably, and you can sign in from the Authentication modal.** A Claude login lives in two files, and switching used to write only the tokens, not the identity. The CLI then reported one account while using another's tokens, which is where "OAuth access token has been revoked" came from. Both files are now switched together. The live tokens are saved back first, since the CLI rotates them. The switch is verified with a real network check, and a refused switch rolls back. Running Claude sessions restart onto the new account. Sign-in happens in the modal, with Open/Copy buttons for the authorize link and a field for the code, instead of a terminal tab. The modal's account cards are visible again, too: they had been the same colour as the modal behind them.

### Removed
- **The Resize tool.** Its handles now live in Box and Lasso (see above), and the Move tool took its toolbar slot, icon and cursor. Alt+R is free.

### Fixed
- **The browser address bar's suggestions dropdown now closes when you click away.** It waits on a scan for running localhost servers, and if you clicked away before the scan finished, the dropdown opened after the close had already run. Nothing was left to close it after that.

## [1.14.0] - 2026-09-22

### Changed
- **Cathode Terminal is now Gamut Terminal.** The display name, npm package name, window title, About/quit/update dialogs, onboarding copy, project-bundle labels, and the update-check User-Agent header all changed; the top-left app-bar logo was swapped for the new mark. The appId, the `.cathode` file format, and the GitHub repo URL were deliberately left as-is so existing installs, releases, and project files keep working — the legacy-profile pin still finds a pre-rename userData folder either way.
- **Every tool panel's header now shares one layout.** Icon, title, and header buttons (New Selection, Add Selection, the Box/Lasso eye toggle) sit on one row; the subtitle drops to its own full-width row underneath rather than stacking inside that row. Header buttons picked up real secondary/primary chrome to match — the same recipe the design system's Button component uses (`.modal-btn-cancel`/`.modal-btn-confirm`) — instead of the flat, hover-dead styling they had before. Add Selection moved out of the composer toolbar and into the header next to New Selection, styled as the one primary (filled-accent) action in the row, with a pulsing ring while it's armed and waiting on the next pick.
- **Box/Lasso's "Show/Hide Selection" is an eye icon now**, not an underlined text link — open eye while hidden (click to reveal), eye-slash once shown (click to hide), the same convention as a password-visibility toggle.
- **Mission Control's "Running on localhost" card no longer eats a project-card slot.** It used to get prepended into the grid, pushing a real project out of the layout whenever a stray dev server was detected. It's now a "Running" dropdown in the screen's bottom-left corner (same height as the Import/Create/Open buttons, same chevron glyph as every other dropdown in the app), hidden entirely when nothing untracked is running.

### Added
- **Add Selection for Extract and Animation**, joining Box/Lasso: pick another element and it's added to the working set instead of replacing it. Extract's element list already supported multiple entries; Animation now tracks a list of targets that one spec previews and sends against together.
- **A lot more control over animations.** Direction widened from 4-way to 8-way (added diagonals) and now applies to Bounce and Shake, not just Slide/Flip. A new **Move** type gives explicit Start/End position fields instead of a fixed distance+direction preset. **Pivot** (transform-origin) controls where a scale/rotate/skew effect pivots from. **Playback** (normal/reverse/alternate/alternate-reverse) and **fill mode** are now user-adjustable instead of hardcoded. **Stagger** — which the animate-children engine already supported end-to-end — finally has a UI slider. All of it flows through the live preview and every code emitter (CSS, WAAPI, GSAP, Framer Motion, Motion One).
- **A Screenshot toggle in the Box/Lasso composer.** Each selection used to always ship a captured PNG of the outlined elements; the toggle skips that capture (and the image tokens it costs) when the CSS/DOM detail is enough on its own.
- **A Storybook Linkage toggle.** Connecting a Storybook used to unconditionally write a "check it before UI changes" block into CLAUDE.md/AGENTS.md, and — the bigger cost — prepend that same instruction to *every message sent to every agent*, which some non-Claude agents took as license to re-check or repeatedly try to relaunch a Storybook every turn. The toggle (in the Storybook instance bar, labelled "Storybook Linkage") suppresses both, and the Storybook tab gets a small dot indicator when it's off.
- **Chat images over ~1568px get downscaled before they're attached**, whether dropped or picked via the file dialog. Claude's vision pipeline resizes anything larger than that server-side anyway, so a 4K screenshot was only ever paying to upload and encode pixels the model never used. The original file on disk is untouched — a resized copy in a temp cache is what gets attached and sent.
- **Saved Claude accounts in the Authentication modal.** Re-authenticating used to mean dropping into a terminal and running `claude auth login` by hand (it now runs in an in-app terminal tab instead) — and there was no way to switch between two logins (e.g. personal and work) without redoing that OAuth round-trip each time. A "+ Save current login as…" capture lets you name the account currently signed in; each saved account gets a "Use" button that writes it straight back into `~/.claude/.credentials.json`, no browser required. Credentials are sealed at rest the same way API keys already are.

## [1.13.1] - 2026-09-13

### Fixed
- **macOS builds are back.** Neither 1.12.0 nor 1.13.0 shipped for the Mac: the build stopped while setting up code signing, with `SecKeychainUnlock: The user name or passphrase you entered is not correct`. electron-builder 26.15.3 unlocked its temporary signing keychain with the certificate's import password instead of the password it had generated for that keychain, so signing failed however the certificate was configured. The fix landed in electron-builder 26.16.1, which the build now uses, and the Mac installers are published again alongside Windows and Linux.

## [1.13.0] - 2026-09-13

### Added
- **A What's New modal after every update.** An update used to land silently: the app restarted on a new version and the only way to find out what had changed was to go and read the changelog on GitHub. The first launch after an update now opens a modal topped like About — the logo, the version it updated to — with the update's changes listed beneath as bullets, grouped into Added, Changed, Fixed and Removed. Skipping several versions at once lists each of them under its own version heading. The notes are read from the changelog bundled with the build, so they work offline and always describe the version actually running, and a fresh install doesn't get one — there's nothing it was updated from. The same list is a link away in About, for going back to it later.
- **Several selections in one Box/Lasso message, written into the instruction as chips.** A selection used to be all-or-nothing: New Selection replaced the list, so two areas of a page could never be edited and sent together, and there was no way to point at one element as the thing to match when changing another. The instruction box now holds selections the way a sentence does — each one is a chip where you put it, labelled Selection 1, Selection 2… in the order they read, so you can write "make Selection 2 match the padding of Selection 1". Add Selection, in the toolbar beside the persona dropdown, (which reads Adding Selection while you draw) draws another selection and drops its chip at the cursor, leaving everything already staged as it was. Clicking a chip shows that selection's elements in the list above; removing one, with its ✕ or by backspacing over it, takes its elements out of the message and its outline off the page. The agent gets your sentence with each chip as [Selection 1], [Selection 2]…, numbered in the order they read, and each selection's elements listed under that heading, tagged 1.1, 1.2, 2.1… to match the screenshot. A selection you didn't change is sent with the styles it actually has, so there is something to match against.
- **The active project in Your Projects is two cards tall and shows its screenshot.** Every other project card led with a screenshot of the project, and the one you were actually working in was the only card without one — so the project you knew best was the hardest to spot. The active card now carries its screenshot, at 16:9, directly under its title bar, above the server table, and spans two rows of the grid so the servers keep the room they had. It holds that height in a single-column window too, where there are no cards beside it to set the row height.
- **Nous credits in the usage panel for Hermes sessions.** Hermes runs on Nous Portal credits, and the only way to see what was left was to leave the chat and run `/credits`. The usage panel now shows the plan's monthly credits as a bar that fills as they are spent — the same reading as the Claude limit bars, so fuller is always worse — with what is left, the monthly allowance and when it renews, plus a line for the total usable balance, purchased credits included. The balance is read through Hermes itself, using its own account helper in its own environment, so the portal token Hermes keeps refreshed is never copied or handled by Cathode. It is cached for a minute, since the panel refreshes after every reply, and the last good figures stay up through a failed fetch rather than the bar vanishing.
- **The top strip lights up over anywhere that moves the window.** The title bar is mostly structural shapes — the logo seat, the view tabs, the window controls — and the gaps between them that actually drag the window look exactly like the parts that don't, so finding a grab spot meant trying. An unbroken 8px shade-2 line now runs across the whole top edge of the window while the pointer is over a drag area, in the app bar, the terminal header or the browser tab bar. This can't be a plain hover: a drag region hands the pointer to the operating system, and the page receives no mouse events over one at all. So when the pointer drops out of the page beside a bar, the main process reports where the cursor is — only until it leaves the window or the page starts receiving events again — and each point is checked against the elements' real drag settings.
- **A Page row at the top of the Box/Lasso panel.** The page itself was the one thing the tool could not reach: a drag returns the elements inside the box, and full-viewport elements are deliberately skipped as candidates — otherwise every drag would come back holding the body — so there was no way to get at the page background, its text colour, or the font it inherits from. Every selection now arrives with a Page Properties drawer above the picked elements, carrying the properties you actually set on a page, and it edits live and rides along in the message like any other row. It is aimed at whichever element is really painting the page, because that is the only place an edit shows: body's background reaches the canvas only while the root has none, and the moment the root has one, body's own box paints over it. A page with nothing painting it reports the browser's default rather than `transparent`, since a transparent starting value hands the colour picker alpha 0 and every colour you then pick stays invisible. The row has no ✕ and no pseudo-state chips — it is not part of what you selected and `:hover` on a page means nothing — and it stays out of the message entirely until you actually change something on it.

- **A "Show all elements" switch under the Box/Lasso panel's property filters.** A drag returns everything inside the box, ranks it, and keeps the strongest 24 paint-y elements and 24 layout containers — so an element that was genuinely in the selection could simply not be in the list, with nothing to say it had been dropped or that anything had been decided at all. The ranking still orders the list, but what it cuts is now flagged rather than discarded: the switch reveals it, with a count of how many are being held back, and no re-drawing of the selection. Anything you have already edited stays in the list when the switch goes back off, so turning it off can't take an edit out of the message behind your back. The list is capped past the cut (72 elements, 48 containers) because the property filter expands every row on screen and each row is some forty controls.

### Fixed
- **The Box/Lasso panel's "New Selection" button no longer goes dead after you use a colour swatch.** The colour picker is fixed-position and paints above the panel, so whatever it covers stops taking clicks — and it was landing on the panel's own head. Growing up-and-left from the swatch, a property near the top of the list clamped it against the top of the window, square over the button; a narrow chat column flipped it to the right of the swatch, which is the same corner. Clicking the button then landed on the picker, which is also why the picker never dismissed itself: it only closes on a mousedown somewhere else. The button looked broken and stayed broken for as long as the picker was open. The head is a keep-out zone now, and with no room to the left the picker drops below the swatch instead of flipping — past the panel edge it would be under the native browser view and invisible anyway. A picker left open is also dismissed when a new selection arrives, and it forgets the field it was editing when it closes, so it can no longer write a colour into whatever row has since taken that slot.

### Changed
- **Send is a split button now, and "Send as Intent" is what it can be set to.** The intent send was a third full-width button in the row, so a tool panel in a narrow column offered two sends of equal weight and no hint that one of them was the ordinary one; before that it was a switch, which had the opposite problem — sticky state you could leave on and forget. It is now a mode on Send itself: a caret beside the button opens a two-item menu (Send, Send as Intent, each with a line on what it does), and the button then reads whichever you picked, so what the next send will do is written on the thing you press. The Box/Lasso panel's property count rides along with the label rather than overwriting it, and the mode is read when the message is built rather than when the button is clicked, so pressing Enter in the instruction box does the same thing the button is advertising.

### Removed
- **Gemini CLI is no longer a supported agent.** It is gone from the install list and the onboarding checklist, from the ACP launch table, the model catalogue, the MCP integration, the per-agent memory targets and the handoff agent picker. Removing it from the catalogue would not have helped anyone who had already added it — that profile lives in local storage and would have gone on trying to launch a binary the app no longer knows about — so a saved Gemini profile is dropped on load, matched on its launch command rather than its name, which is editable. A handoff target set to Gemini falls back to the default instead of leaving the picker showing nothing while still trying to spawn it.
- **`GEMINI.md` is no longer written.** The Storybook, project and Digger blocks go to `CLAUDE.md` and `AGENTS.md` only. Existing `GEMINI.md` files are left alone rather than deleted — their managed blocks simply stop being updated.

## [1.12.0] - 2026-09-06

### Added
- **A Back button in the browser toolbar**, left of the address bar. The browser view has always kept a history — the right-click menu could walk it, and nothing else could. It greys out when there is nothing behind the current page rather than offering a click that does nothing, and it follows in-page route changes, so Back works on a single-page app and not just on full page loads.

### Fixed
- **The capture tool no longer has a dead band at the edges and corners.** The drag was bound to the capture overlay, so a pointer that wandered off it never delivered its mouseup: the drag stayed open and the capture was dropped without a word. That reads as a region you cannot start or finish a drag in, worst at the corners, where you can leave the overlay in both axes at once — and the window's own resize border owns the outermost pixels there, so it is the easiest place to slip out of. It now uses pointer capture, which routes the rest of the drag back to the overlay wherever the pointer actually goes, and clamps coordinates to the viewport instead of letting a stray one poison the rectangle. A broken capture (a system gesture, the window losing focus) settles with what was drawn rather than hanging. The minimum size came down from 10px to 3px in each axis as well: the old floor quietly refused anything thin — a divider, a line of text, a narrow icon strip — and refused it by cancelling, so the tool looked broken rather than fussy.
- **A property added from the Box/Lasso panel's picker actually appears.** The User Added section is a `.pp-section`, and the filter pass that runs at the end of every render hides any section with no visible fields in it — so before you had added anything, that section was already `display:none`. Every property you added went into a hidden container and vanished. Typing in the filter box was what brought them back, because that re-ran the pass and the section now had a field in it; from then on adding felt fine, which is what made this look like a scrolling problem. The section and the new field are now shown explicitly on add, whatever the filter is currently doing — you asked for that property, so it appears. On top of that the drawer scrolls the new field clear of the picker: "Add a CSS property" is a sticky footer with an opaque background that properties scroll underneath, and a field appended to the end of the section lands directly behind it. The row flashes once when it arrives, and it is focused with `preventScroll` so the browser's own focus scrolling doesn't drag it straight back under the footer.
- **The same fix in the in-page element popup's User Added picker**, where a new row landed below the fold of the 300px element list. Its rows are also ordered by when you added them now, so the newest is always directly above the picker — re-adding an already-detected property used to send it back to its original position part-way up the list.

### Changed
- **"Send as Intent" is a button between Cancel and Send, not a switch.** As a toggle it was sticky state living on a bar you weren't looking at: you set it once for one message and it stayed on, or you meant it and found it off. It is a second send now, decided at the moment of sending, which is the only moment the choice means anything — same message, same panel, with the intent framing in front of it. It follows Send's enabled state, so it isn't offered where a plain send isn't. The directive it prepends is shorter and more direct: snap raw values to the nearest existing tokens, variables or utility classes; change things at the component or stylesheet level rather than inline; keep the result visually equivalent, and explain it when doing it properly doesn't look the same.
- **Send as Intent only appears on the tools that send measured values** — Box Select and Lasso, the Eyedropper, and the Animation tool. "Treat these as approximate" says nothing useful next to an accessibility report, a screenshot or a drift scan, so those footers have the button removed rather than carrying one that does nothing for them.
- **Send as Intent is the same size as Send.** The two are a pair of sends, so they get the same box — equal width, same fill, same type — with the rounded corners left on the outer two buttons, where the row's ends are.
- **The Animation tool asks for the project's own motion standard.** Prefer-a-token is the wrong instruction for motion: what matters is that a project animates with CSS transitions, or keyframes, or a library it already depends on, and that a new animation uses that rather than adding another approach. Its directive now asks for whichever of those the project already uses, and for durations, delays and easings to land on its existing motion steps where it has them.
- **The Digger handoff now tells agents when to actually reach for it.** The block was written around triggers that never fired. It asked agents to run `digger` "before reading any file over ~500 lines" — but an agent looking for something in a large file greps or reads a slice of it, so that moment never arrived; and it named build logs and test output without saying how to catch them, which is the whole difficulty, since by the time a command's output exists it is already in the conversation and there is nothing left to offload. Across the transcripts on this machine the feature had been used twice. The block now leads with the idiom that makes it possible — redirect the command to a file, then triage the file — with worked examples for builds, test runs and dependency trees, and it draws the line for reading files where it actually falls: grep for a part of a file, digger for the whole of it. The wording also refreshes itself on project activation, so a project that switched the handoff on months ago picks up the current text instead of keeping the version it was given.
- **Name the project when an agent proposes one.** The prompt an agent raises by dropping a `new-project` signal stated a name and gave you two buttons, neither of which was "call it something else" — the name came from the folder or from the agent's guess at what you were doing, and correcting it meant creating the project first and renaming it in Mission Control afterwards. The name is now a field on the prompt, prefilled with the suggestion and editable before you accept. Clearing it falls back to the suggestion rather than creating something unnamed, Enter accepts from inside the field, and Escape hands the keyboard back to the 1/2 shortcuts.

## [1.11.0] - 2026-08-27

### Added
- **Edit an element's hover, focus, active and disabled styles — not just look at them.** The state chips forced the state on the page and stopped there: your edit still went to inline style, which applies in *every* state; the property rows still showed the resting values; and the agent was never told which state you meant, so a hover change arrived as a bare declaration it had to guess at. Picking a state now re-reads the element and shows what that state actually resolves to, edits are written as a rule for that state, and the message carries a `&:hover { … }` block per state you touched. **What the state changes is pinned to the top of the drawer**, so the two or three properties that differ aren't buried among forty that don't.
- **A real editor for shadows.** A box-shadow is a list of layers, each with an offset, blur, spread, colour and an optional `inset` — previously all of it crammed into one 135px text box. Each layer now gets its own card: a colour swatch, an inset toggle, and drag-scrubbable X / Y / Blur / Spread. Multi-layer shadows are editable rather than mangled, and each value keeps its own unit, so `0.5rem` stays in rem.
- **Send as Intent**, a switch on every tool panel's bar. Direct manipulation produces exact numbers — a hex the eyedropper sampled, a px value a slider happened to land on. Sent literally they bypass the project's own tokens and scales. With this on, the agent is told to treat them as intent and reproduce the effect the project's way: prefer existing tokens and scale steps, apply the change at the level that owns the element rather than as an inline style, and say so if doing it properly looks noticeably different.
- **Drop files onto a tool panel** — anywhere on its footer, not just the text box — and they attach exactly as the paperclip would.
- **Alpha in the colour picker.** Shadows and overlays are almost always `rgba`, and the picker could only produce opaque colours. Opaque picks still come out as plain hex; `rgba()` appears only when there's real transparency, and swatches show it over a checkerboard so 40% doesn't just read as a slightly different panel background.

### Changed
- **Every property gets the control it deserves.** `max-width`, `max-height`, the insets and the margin sides rest on `none` or `auto` — which isn't a length, so they used to fall through to a bare text box while `min-width: 0px` beside them got a slider. The keyword now lives in the unit dropdown and they all behave alike. The slider also works from zero, which it never did: its scrub was multiplicative, and nothing multiplied by zero leaves zero.
- **The Defaults drawer is gone.** A property sitting at its default value is exactly the one you came to change — `border-radius: 0` is not a thing to hide behind a collapsed strip labelled "Defaults". Everything renders in its own section now, with the untouched ones dimmed rather than tucked away.
- **Padding, Position and Margin sit together at the top**, with Margin sharing Padding's four-sided control.
- **Adding a CSS property is a proper dropdown**: a trigger whose label doesn't change as you type, and a menu with its own search box and category filters at the top of the list. Results are ranked so standard properties lead — it used to open on `-webkit-box-ordinal-group`, because `-` sorts first. It's pinned to the bottom of the drawer and opens upward.
- **The reload button in an agent chat clears the session.** It previously did nothing at all there — it bailed before touching anything and only ever restarted terminal sessions.

## [1.10.1] - 2026-08-26

### Fixed
- **Closing the handoff modal now actually calls the handoff off.** Auto handoff opened the modal and started the work in the same moment, and closing the modal only hid it — the brief kept being written and the budget agent still launched behind a dialog you had just dismissed, spending usage you had declined. **Don't Hand Off** sits beside *Perform Handoff Now*, and refusing is real: it stops the countdown, cancels the brief mid-write, and lands before the target agent is spawned. Closing by ✕, backdrop or Escape does the same thing.
- **The chat keeps following new output unless you actually scroll away.** Whether to follow was re-read from scroll position on every sample, so any reflow that briefly left the view short of the bottom latched following off — and it never recovered, because the growing reply only pushed the bottom further away. A tool card expanding, a code block getting its syntax colours, an image finishing its load, or a reply that started streaming while the view was still animating could each do it, none of which involve scrolling. Position now only ever resumes following; stopping it takes a real gesture. Content that grows *after* it was posted re-pins on its own.
- **Links in chat are clickable as soon as they appear**, rather than once a later message happened to re-render the bubble. URLs are turned into links as the reply streams, and a reply whose last chunks arrive after the turn has already resolved — which some agents do — is now closed out on its own instead of sitting there as raw text with dead links and unformatted code.
- **The context gauge reads this session, not the newest one anywhere.** It looked up the transcript from a Windows path while the agent had recorded a WSL one, so the lookup silently missed and it fell back to the most recently touched conversation on the machine — a brand-new session could open reading 36% full, borrowed from unrelated work. It now resolves the transcript by the live session's own id, and shows nothing rather than someone else's numbers.

## [1.10.0] - 2026-08-16

### Added
- **Run a model on your own GPU.** *Local (Ollama)* joins the agent list — private, offline, no API key. The models it offers are read from the running daemon rather than hard-coded, so anything you have pulled shows up, and one pulled since launch appears the next time you open the menu.
- **Switch models without losing the conversation.** Agents can advertise a model selector when a session starts; Cathode was reading the permission modes that arrive alongside it and throwing the model list away. It now builds the Model submenu from that list and switches in place — no restart, no reconnect, the chat stays where it was. This is protocol-level, so any agent that advertises models gets a picker, not only the one it was tested against.
- **Digger handoff**, in a new kebab beside the bell in the session status bar. It writes a block into the project's `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` telling agents to hand bulk text work — log triage, summarising, extraction — to a local model instead of reading the file themselves, so a large log never enters the agent's context and never costs API tokens. Off by default: it spends prompt budget in every project and only earns that back where an agent actually meets large files. The switch reads its state back from the file rather than remembering it separately, so it cannot tell you one thing while agents are told another, and it stays hidden unless a local model is genuinely installed and running.
- **The status bar names the lenses that are on** — *Digger active*, *Caveman active* — after a hairline divider, and reads exactly as before when neither is.

### Changed
- **A provider's model list is no longer taken at face value.** One with a live models endpoint can advertise several hundred entries, most of which cannot hold a conversation. The submenu groups them by vendor once there are more than a dozen, and hides embeddings, rerankers, speech, image generation and `:batch` endpoints. That filter reads names, so it can be wrong: the model you are on is never hidden, and *Show all models* is always one click away.
- **Caveman mode moved** out of the composer toolbar into the status-bar kebab, alongside Digger handoff.

### Fixed
- **An agent that dies mid-handshake now says why.** It usually prints the reason and exits — but the stdio bridge runs it inside a pipeline, so the shell outlives it and the exit is never noticed. A one-line fatal like `Profile 'x' does not exist` was swallowed for the full two-minute connect timeout and then reported as *did not respond — is its ACP mode available?*, which sent you looking in entirely the wrong place. The error is surfaced the moment it arrives.
- **A local session no longer routes to the chat front end.** Codex speaks the agent protocol only against its cloud backend, so a local run was reaching a dead path; it now opens as a terminal, and is offered local models rather than the cloud lineup.

## [1.9.0] - 2026-08-13

### Changed
- **One dropdown everywhere.** The Storybook framework picker and the Browser project picker were each their own control; every dropdown in the app now routes through the canonical one — the same component the Box Select tool uses — including the eyedropper, MCP service and tab-type pickers, which had been left as raw browser selects. Its Storybook entry was redrawn to match what actually ships.
- **The Browser empty state leads with what's running.** Instead of one button that hid what it knew behind a click, the hero states it: **Running servers**, a dropdown of each one, and **Open** — laid out on the build rows' own grid so the columns line up down the page. With nothing running the row is removed and a line says so. Retitled *Boot up a Server*.
- **Detect-running is a radar button** beside Run in the Storybook hero: it spins while scanning, rings itself when it finds something, and shows an error glyph for a beat when a scan you asked for comes up empty.
- **Themes are grouped into Dark and Light**, each collapsible and remembered, split by the measured luminance of the theme's own panel fill — so the grouping can't disagree with how a theme actually renders. Custom themes get a group too.
- **Naming a new project happens in a modal** rather than a card anchored to the corner of the window.
- **`storybook-demo` is now `design-system`** — it holds `cathode-design-system`, the reference for the app's UI, and the old name read as throwaway sample content.

### Removed
- The **Green CRT, Blue CRT, Midnight and Nord** themes. An install already set to one falls back to Default rather than asking for a preset that no longer exists.
- The remaining **dead CSS** (122 rules, ~22 KB) — mostly the component picker's original standalone window, which became a panel and left its layout behind.

### Fixed
- **The design system no longer pretends to be available in installed builds.** It is deliberately not shipped (111 MB of dependencies), but the fallback still pointed at it, so a run with no folder chosen failed against a path that was never there. It now stands in only when running from source, and a packaged build says to choose a folder.
- The hero button's type was half again the size of everything around it, and the framework picker rendered its default as an unset placeholder — both read as a different design language rather than the same one.

## [1.8.0] - 2026-08-12

### Added
- **Your agent can flag new project work.** The block Cathode writes into `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` used to point one way — it told the agent which project it was in and nothing came back. Now the agent watches for work that doesn't belong to the current project (building something new from scratch, a different repo, a PR checkout, another folder on your machine, or simply a request unrelated to the project) and signals Cathode, which asks you: **Create project ① / Continue here ②**, as a numbered card in the same approval stack as permission prompts. Whichever you pick is echoed back to the agent, so it knows where to work. Signalling is a plain file, so every agent can use it with no extra setup.
- **Projects show what they're working on.** A label — the branch, or the PR title when `gh` can supply one — appears in the project switcher, on the Mission Control card and in the chip tooltip. It's stored beside the project rather than as its name, so a project keeps its repo identity while the label tracks the work.
- **Cathode notices repos cloned beside a project**, not only inside it. `git clone` almost always lands next to a project, which is how new work could end up filed under an old project.
- **Deep Ocean theme** — teal-tinted slate darks with a `#1DBFA1` accent.
- **A new-project button** in the views bar, so a project can be created without opening Mission Control first.
- **The Storybook tab detects a Storybook you started yourself.** It scans on opening the offline state, and a link under the folder chooser re-runs it on demand; connecting adopts it and writes `STORYBOOK_URL` for agent sessions.

### Changed
- **Light themes are properly legible.** Chat text, tool actions, Mission Control and Usage Assistance all hardcoded white on surfaces that turn cream in tan/sky. Modals also scrimmed the page with black, hiding dark-on-light chrome — the close button was effectively invisible. Themes are now classified by the measured luminance of their panel fill, so custom light themes are corrected too, and the running/paused indicators, toggle tracks and empty-state build rows all follow suit.
- **The running/active greens are theme tokens** ("Running" / "Running Field"), with a pair in all ten presets.
- **Mission Control tidying** — `Start all servers` moved onto the RAM line, and the kabob button is one colour on both card types instead of a hardcoded grey on one.

### Fixed
- **The update banner appeared with no update available and couldn't be dismissed** (#6). An author `display: flex` on the id overrode the browser's `[hidden]` rule, so the `hidden` attribute never did anything — it rendered from launch on every platform and the ✕ did nothing.
- **The Storybook folder chooser did nothing when clicked** (#7). A class rename rewrote the element's id as well, so the renderer's lookup returned null and no click handler was ever attached.
- **Tooltips drifted far from their button inside modals.** A guard that keeps tips clear of the native browser view fired inside Mission Control, where every native view is already parked.

### Removed
- Dead CSS orphaned by the empty-state rewrites (67 rules), a function with no callers, and an IPC channel with a handler but no sender.

## [1.7.1] - 2026-08-11

### Fixed
- **Project previews showed the wrong page.** A card's screenshot was whatever the Browser happened to be displaying, so projects ended up picturing an unrelated site. A capture now only counts if the pane is serving one of that project's own ports, and is taken while its server is still up. A card also can't show a stale image from a previous session — the preview flag is only set once a capture actually lands.
- **Blank previews recorded as valid.** The browser view parks at 1×1 offscreen whenever a modal is open or the pane is hidden; `capturePage()` returns that frame quite happily (it isn't empty), so it was upscaled into a solid colour block and saved. Capture is now refused while the pane is parked.
- **Mission Control cards no longer squash their server table.** The grid packed in as many 440px columns as fit, so a tall window gave four cramped cards with the Autostart header colliding with Start All. Columns are capped at three and fall back to two before a card drops under the width its table needs.

### Changed
- **Card actions moved into an overflow menu.** Export and Remove now live behind a **⋮** button on each Mission Control card instead of a bare ✕, and the menu escapes the card's rounding and the grid's scroll box.

## [1.7.0] - 2026-08-10

### Added
- **Projects start and stop their own servers.** Switching projects now tears the old one down and brings the new one up as a single sequence: the project you leave is fully stopped, then the project you enter restores whatever was running when you left — or, on a cold start, starts the servers you've marked **Autostart**. The Browser then follows, waiting until the port actually answers before navigating, so it never lands on a refused connection.
- **Autostart column in Mission Control.** Each server has a toggle for "start this when I switch to this project", stored in the project manifest so it travels with a `.cathode` export.
- **Servers Cathode didn't start are adopted on switch.** A dev server the agent launched inside the project folder is attributed to it by working directory and stopped with the project, so "power down" is actually complete.
- **A switch banner** covers the views bar while servers stop and start — it reports progress and blocks changing project mid-switch.
- **Project memory total** on the Mission Control card, replacing per-server RAM with the number that answers "what is this project costing me?".

### Changed
- **The Browser empty state is a flat "Add a server" screen**, matching the Storybook empty state — the same hero and animated backdrop over four rows: run a saved project's server, or build from a folder, a Figma link, or a repo. Build-from-folder is now its own row and "from a prompt" is gone. Both empty states share one set of styles, so they can't drift apart.
- **The running/active greens are themeable.** `--mc-green` / `--mc-green-dark` were fixed values; they're now theme tokens ("Running" / "Running Field") with a pair in all nine presets, so the switch banner and every Mission Control running indicator follow the active theme.

### Fixed
- **Build scripts are no longer detected as servers.** A script counted as a server if its command merely mentioned a framework, so `"build": "astro build"` was captured via *astro* and `build-storybook` via *storybook* — both one-shot tasks, handed guessed ports that collided with the real dev server's.
- **Servers no longer survive a project switch.** Teardown skipped any server without a recorded port, and started the new project's servers without waiting for the old ones to die — so they raced for ports and were silently relocated.
- **Update notifications were never clickable.** The toast stack is `pointer-events: none`, which every toast inherited; toasts also rendered behind modal overlays, so anything fired from Mission Control was invisible.

## [1.6.0] - 2026-08-10

### Added
- **The Storybook now follows the active project.** Switching projects switches the Storybook with it: the previous project's managed Storybook is stopped, and the project you land on either reconnects to its live Storybook or — if it has one that isn't running — **starts it automatically**. Projects without a Storybook show their own offline setup, so the panel never sits on another project's Storybook.
- **Storybook folder chooser in the offline hero.** A folder input beneath the Run button picks which project's Storybook to run, so you can change folders (and escape a "no Storybook here" state) without digging into the build rows. It shares one source with **Build from Project**, and choosing a folder clears a stale error.
- **Quit confirmation while a Storybook / dev server is running under Cathode.** Closing the window when the app is hosting a managed Storybook or dev server now asks first (it would otherwise stop them silently). Anything launched in an external terminal is unaffected and the dialog says so.

### Changed
- **Storybook runs silently on Windows — no console window.** The managed Storybook was spawned `detached`, which forces its own terminal window on Windows (and overrides `windowsHide`); closing that window killed the Storybook. It now runs hidden as a background child of the app, fully under Cathode's lifecycle.
- **The Run button is the Storybook's status surface.** Its label reflects the run state — *Starting Storybook… / Storybook is running / the error* — instead of a separate status line. It's inactive while starting and once running (accent at 50% alpha, solid white text, no hover), and stays active on an error so it doubles as **Retry**.
- **The offline hero title reflects reality** — "Storybook **Online**" when one is live (e.g. opening *New Storybook* while another runs), "Offline" only when nothing is.
- **Update notifications are now a persistent band above the composer** instead of a timed toast: full width, in the Accent 2 color, click to update, with an **✕** to dismiss. It no longer disappears on a timer.

### Fixed
- **"Run existing storybook" no longer fails with `spawn EINVAL` on Windows.** The managed server spawned the `storybook.cmd` launcher directly, which modern Node rejects (the CVE-2024-27980 fix); it now launches through `cmd.exe`, matching every other Windows command in the app. Detection already found the Storybook — only the launch was broken.
- **Stopping a Storybook on Windows now kills the whole process tree** (`taskkill /T`) instead of only the `cmd.exe` wrapper, so the underlying node/storybook process is no longer orphaned.
- **Update notifications were never clickable.** The toast stack is `pointer-events: none`, which every toast inherited — so "click to update" couldn't be clicked and showed no pointer cursor.
- **A stray "Clear" ✕ floated in the Storybook offline hero.** The clearable-input wiring still targeted `#sb-url`, which the redesign turned into a hidden field holding the localhost URL.
- **The offline hero title is centered.** Its `max-width: 8ch` was narrower than the word "STORYBOOK", so the word overflowed its own centered box and pulled the title off-center.
- **A failed Storybook launch reads clearly** — the raw "No Storybook found in `<path>` — build one with your agent first." error is now a plain **"No Storybook found, try again?"** on the button.

## [1.5.1] - 2026-07-29

### Fixed
- **Storybook offline hero no longer sits off-center.** The hero couldn't shrink (`min-height:auto`), forcing a right-side scrollbar that pushed the centered title/button left; it now fits without scrolling and stays centered.

## [1.5.0] - 2026-07-29

### Changed
- **Storybook "offline" empty state redesigned.** The tabbed setup is now a single screen: a "Storybook Offline" hero with a **Run existing storybook** button, three inline build rows (**Build from Project** = auto-detect scaffold, **Build from Figma** = Figma URL, **Build from Framework** = framework picker), and the "reminder before each message" toggle pinned to the footer.

### Added
- **Animated WebGL backdrop** behind the Storybook offline hero — two slowly undulating translucent iridescent "cellophane" sheets with chromatic dispersion on the folds and a drifting warm glow, composited over black. Dependency-free (a raw fragment shader), resolution-capped, and only renders while the state is on screen.

## [1.4.0] - 2026-07-29

### Added
- **Projects are now self-contained, portable, and auto-detected.** A per-project manifest (`.cathode/manifest.json`, kept out of git) is the source of truth for a project's identity and its servers' launch recipes:
  - **Automatic detection.** When you switch to a new branch, an agent clones a repo into a subfolder, or a dev server starts in an untracked folder, Cathode asks — right in the app — whether it's a new project or part of an existing one, with persistent "don't ask again" memory.
  - **Servers matched by working directory, not port.** A server the agent started in a project's folder is attributed to that project (its launch command captured) instead of showing as untracked.
  - **Portable `.cathode` export / import.** Export a project to a single file (manifest + `.env` + notes); import re-clones it from its git remote and offers **Start All**. Double-clicking a `.cathode` file opens Cathode straight into that project (installed builds).
  - **Agents always know the project.** An app-managed block in `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` tells every agent session which project it's in and how to launch its servers, regenerated each session.
- **Create New Project** — a blank-slate project (new folder + `git init` + manifest) from Mission Control, alongside Open Project and Import Project.
- **Rename projects inline** — double-click a project's title on its Mission Control card.
- **Address-bar suggestions.** Typing (or focusing) the browser address bar drops down your visited-URL history and **running localhost dev servers** (including WSL-hosted ones), so `localhost:3000` is a keystroke away, and the browser view slides down so the list isn't hidden behind it.

### Changed
- **Usage Assistance styling** — the Auto Handoff panel uses shade-4 / shade-3 nesting, and the usage chip drops its border for a unified accent bar with a solid accent dismiss button.
- **Mission Control's untracked-servers panel** is now a real card in the grid's first slot (same width as project cards) with a scrollable list.
- **Box Select** — the "add a CSS property" control is pinned to the bottom of each element's drawer.

### Fixed
- **Auto-handoff no longer loops and burns usage credits.** The re-fire guard was in-memory only, so every launch re-triggered a handoff while usage stayed over threshold. It now fires at most once per limit window (persisted across restarts) and never merely because you launched already over the threshold.

## [1.3.0] - 2026-07-28

### Added
- **Mission Control surfaces running localhost servers that aren't in a project.** If a dev server is up but its folder isn't a tracked project (e.g. one the agent just cloned + started), it now appears in a "Running on localhost — not in a project" section with **Open** (in the browser) and **Open as project** (adopt the folder, registering the live port so its card shows ACTIVE). Detection combines the localhost port scanner with a probe of common dev ports, so it catches WSL-hosted servers too.

### Changed
- **Budget Guard is now "Usage Assistance," reworked.** Two live dial gauges (session + weekly), an **Auto Handoff** toggle that collapses the threshold + handoff config when off, and a single **Perform Handoff Now** button that fuses the old two steps into one seamless action — write the brief, wait for it to actually land, then start the target agent and switch. With Auto Handoff on, that whole flow runs automatically when the session **or** weekly limit crosses the threshold, behind a cancelable countdown.
- **Settings menu grouped into sections** — Core Engine & Configurations, Appearance & Workflow Preferences, and System & Support.
- Mission Control's active-card glow now follows the theme accent instead of a fixed orange.

### Removed
- **AI Spend dashboard** — consolidated onto Usage Assistance (the shared budget threshold/handoff lived in both).

## [1.2.0] - 2026-07-27

### Added
- **Permission modes (Claude Code's Shift+Tab) in the chat.** A mode control at the bottom of the chat switches the Claude Code session's permission mode — **Ask** (default), **Auto-edit** (`acceptEdits`), and **Plan** (read-only) — and **Shift+Tab** cycles them just like the CLI. Driven by the agent's native ACP session modes, so Plan mode genuinely prevents edits/commands. **Bypass Permissions** is available behind a confirmation (kept out of the Shift+Tab cycle). Modes where the agent stops asking permission are highlighted — a reminder that in those modes neither the in-app prompt nor the Watch Approval notification will fire. Shown only for agents that advertise modes.

## [1.1.1] - 2026-07-27

### Fixed
- **Per-server RAM on macOS.** The RAM readout used `xargs -r`, a GNU-only flag that BSD/macOS `xargs` rejects, so memory silently showed `—` on Mac. Rewritten to be shell-portable (works on macOS and Linux).

## [1.1.0] - 2026-07-27

### Added
- **Multi-project workspaces.** Cathode now juggles many projects instead of revolving around one. A **project switcher pill** in the Views bar swaps the active project — its folder, its chat/agent tabs, and its servers — with a dropdown of your projects plus **Open project…**. Each chat/terminal session is tagged to a project and the tab strip filters to the active one, so switching brings back exactly the tabs you left, persisted across launches.
- **Mission Control** — a full-screen *Your Projects* command center (the grid button beside the pill). Every project is a card: the active one expands into a live **server table** (status · port · RAM · start / reload / pause / remove, plus *Start all*), and idle projects show a **preview card** (screenshot · server count · Storybook detection · *Switch to project*).
- **Per-project dev servers.** Auto-detected from each project's `package.json`, with per-server **start / stop / restart / pause**, live status (running · paused · inactive · starting), a real **per-process RAM** readout, and a manual **Add server** form for anything not in `package.json`. Each server runs in the correct environment automatically — Windows-native vs WSL is detected from the project's installed `node_modules`.
- **Pause / resume that follows you.** Servers can be paused individually, and switching projects **auto-pauses** the one you leave and **auto-resumes** the one you return to — so each project's dev environment frees its resources when idle and comes back up on its own.
- **Project preview screenshots.** Starting a server snapshots that project's running app for its Mission Control card; projects without a started server show a branded placeholder.
- **Address-bar loading / error indicator.** A spinner while the browser loads a page and a pulsing red dot when a load fails.

### Changed
- The **project switcher and Mission Control** live in the Views bar; the **VIEWS** label and the **Terminal** view toggle were removed to declutter it, and the left panel can no longer be dragged narrower than its controls.
- **DevTools** now opens as a detached popout via the browser pane's right-click → **Inspect Element** (the Views-bar DevTools toggle is gone).

## [1.0.39] - 2026-07-22

### Added
- **Watch Approval — approve tool calls from your phone or Apple Watch.** When an agent asks to run a risky tool (execute, edit, delete, move, fetch), Cathode can push the prompt to your phone with **Approve / Deny** buttons, in parallel with the in-app permission card — whichever you answer first wins, and the other is dismissed. Turn it on in **Settings → Watch Approval** (off by default): point it at a small approval relay you run and enter its URL. Everything is best-effort — if the feature is off or the relay is unreachable, Cathode falls back to the in-app prompt with no change in behavior, and read-only tools still auto-approve. See `docs/watch-approval.md` and the companion app + relay in the [watch-approval](https://github.com/hplant6/watch-approval) repo.

## [1.0.38] - 2026-07-16

### Added
- **Changes tab updates live, like Cursor.** The tab now refreshes in place as the agent edits instead of only when you switch to it. Three signals drive it: every code change the agent writes (the view follows that file), the end of a turn (a final, accurate refresh), and a light 2-second poll while the tab is visible (so terminal commands, formatters, and git operations get picked up too). Refreshes are non-destructive — your selected file, scroll position, and cursor are preserved, and the diff editor is only rebuilt when the selected file's diff actually changed, so nothing flickers while other files update.
- **Changes tab: live change-count badge.** The tab shows how many files have changed, updating even while you're on another tab, and pulses while a turn is running. A file's row flashes when its diff changes.
- **Changes tab: auto-follow.** The tab jumps to the file the agent is currently editing. Each new turn re-enables following; clicking a file to inspect it pins the view so you don't get yanked away mid-read, until the next turn starts.
- **Box/Lasso: a screenshot of your selection goes to the agent.** On send, each selected element is outlined and numbered in the live page, the region is captured, and the image is handed to the agent alongside the text — with the numbers matching the `[n]` markers in the element list, so the agent can see what each element actually looks like and how they relate on the page.
- **Box/Lasso: far stronger element identification.** Selected elements previously carried only `tag#id.class` — rarely unique, which left the agent hunting through source. Each element now also passes any **test id** (`data-testid`, `data-test-id`, `data-test`, `data-cy`, `data-qa`, `data-automation-id`, `data-pw`), its **verbatim opening tag** with every attribute (greppable as a literal string), a **unique DOM path**, all other `data-*` and semantic attributes (`role`, `aria-label`, `name`, `type`, `href`, `alt`, `placeholder`, `title`, `for`), and the **enclosing React component chain** (e.g. `LoginForm › Button`) rather than just the nearest component.
- **Console: send errors with your own message.** "Send errors to agent" no longer fires a canned "Investigate and fix these." — it opens a message bar (over the console toolbar) pre-filled with that default and pre-selected, so you can say what you actually want done. Enter sends, Shift+Enter adds a newline, Esc cancels. The per-row send buttons work the same way.

### Fixed
- **Color picker no longer gets clipped in the Box/Lasso and Lasso tools.** The picker opened to the *right* of the swatch, which pushed it out over the native browser view — and native views always paint above the app's HTML, so the picker was silently cut off. It now anchors its bottom-right corner at the swatch and grows up-and-left, staying inside the tool panel, and flips back only when there's genuinely no room. Its size is measured rather than assumed, so it re-places correctly once the picker loads and when switching HEX/RGB/HSL.
- **Color picker's focused input uses shade 1** instead of orange.

## [1.0.37] - 2026-07-16

### Added
- **Collapsible tool cards.** Every tool/terminal card now has a chevron in its header and **starts collapsed** — a terminal command shows just its `TERMINAL … DONE` bar until you click to expand the full output, so a busy turn no longer buries the chat in command output. **Code-change (diff) cards open by default** instead, since the diff is usually what you want to see. The chevron points left when closed and rotates down when open; a card you manually collapse stays collapsed even as later output streams in.
- **Scroll-to-bottom button.** A down-arrow button appears in the chat whenever you're scrolled up (or a turn is streaming below the fold); click it to jump back to the latest message. It stays clear of the tool rail — sliding left only when it would otherwise sit behind the toolbar — and remains visible while the agent is working.
- **Chat scrollbar fades in on hover.** The chat scrollbar is hidden until your pointer is over the chat, then fades in (and back out), keeping the reading surface clean.

### Changed
- **Sticky question header shows up to 3 lines.** The pinned current-turn question now displays at least three lines before truncating (was one), so longer questions stay readable.

### Fixed
- **Close (✕) button restored on the last/only agent tab.** The button was gated on there being more than one tab; closing the final tab now starts a fresh session instead of leaving you with none, and the ✕ always renders.
- **Links in chat now open in the browser.** Clicking a URL in an agent message navigates the in-app browser (switching to the project view if needed) instead of doing nothing.
- **Budget warning no longer false-triggers at session reset**, and gained a dismiss **✕**. It was reading the usage utilization as a fraction and multiplying by 100 (turning a fresh 1% into 100%); it now uses the real 0–100 value, and you can dismiss the chip for the current limit window.

## [1.0.36] - 2026-07-15

### Added
- **Caveman mode** — a toggle on the composer toolbar (next to the persona menu) that asks the agent for terse, stripped-down output to save tokens (no filler/pleasantries/preamble; bullets over prose; code, commands, and paths kept exact). It's independent of the persona lens, so it **stacks on top of** whichever persona you have selected, and it persists across sessions.
- **Separate notification sound for permission requests.** A permission ask (run a command, edit a file, etc.) now plays its own mellow cue, distinct from the agent-message sound (and no longer doubles up with it). Both respect the master notification-sounds toggle.
- **Box/Lasso tool: "User Added" CSS properties.** Each selected element's drawer now has a **User Added** section with a searchable property picker, so you can add *any* CSS property — even ones the detected list omits (e.g. `padding`/`margin` on an element that currently has none, which were filtered out). Pick a property, type a value (applies live, arrow-keys to nudge numbers), and it's included in the edits sent to the agent.
- **Box/Lasso tool: always-present Padding controls.** Every element's drawer now has a **Padding** section (Top/Right/Bottom/Left) styled exactly like the Width/Height properties, shown even when padding is 0 (it was omitted from the detected list before).
- **Sticky user-message header in chat.** The current turn's question pins to the top of the chat as a header and switches as you scroll between turns — click it to jump back to that message. Keeps the question visible when a turn buries the chat in tool cards and diffs.

### Changed
- **Permission prompts are now an anchored modal, not chat scroll.** Approval prompts float just above the working-status bar (clear of the tool rail) instead of scrolling away in the chat, fade/slide in, and stack (one shown at a time) so they can't get buried under terminal commands and code changes.

### Fixed
- **Right-click on a misspelled word now offers spelling suggestions.** The composer (and every spellchecked input) underlined misspellings but its context menu only had Cut/Copy/Paste — now it lists the dictionary suggestions (click to replace) plus "Add to Dictionary", above the edit actions.
- **Screenshot tool now preserves the `:hover` state.** Launching the tool moved the pointer off the page (to the toolbar button), so the element's hover cleared before you could capture it. A lightweight per-page tracker remembers the last-hovered element, and on capture Cathode force-holds its `:hover` (and its ancestors') via CDP through the region selection and snapshot — so you can actually screenshot a hover interaction. (CSS `:hover` styles; JS-driven hover menus still can't be frozen. No effect when DevTools is open, since it holds the debugger.)

### Added
- **Clear session** in the agent-tab kebab menu — starts a fresh conversation while **keeping the current model**. Previously the only way to reset an ACP session was to switch models; now you can clear without changing anything. Restarts the adapter with the same model and wipes the chat (the banner re-renders on reconnect); for terminal sessions it restarts the command.

## [1.0.35] - 2026-07-14

### Changed
- **AI Spend modal: monthly dollar budget → session budget.** The "Monthly budget" dollar field is now a **Session budget** slider (share of your 5-hour session limit) with a live bar showing current usage against it — the same setting Budget Guard uses, editable from either place. The modal also gained a **Write handoff brief** button so you can export a handoff brief any time, not only at the limit.
- **Design system gained a Slider** — added a `Slider` component to the Storybook (filled track à la `ProgressBar`, accent thumb à la `Switch`), and the Budget Guard / AI Spend sliders now use a matching reusable `.ds-slider` style built on the design tokens (replacing bare `accent-color` range inputs).

### Added
- **Budget Guard** (Settings → Budget Guard) — watches your Claude usage limit and helps you keep working when it runs low. Set a threshold (a slider, % of your 5-hour session limit; optionally also watch the weekly limit) at which it advises handing off. When you cross it, the guard can pop up automatically (once per limit window). The hand-off is agent-driven: the **current agent writes a self-contained brief** (goal, state, decisions, files changed, next steps, gotchas) to `HANDOFF.md` (or `AGENTS.md`), then **"Continue on Hermes"** (which stays locked until the brief has actually been written for the current project) opens a fresh session on your chosen budget agent (Hermes/Gemini/Codex) with its composer primed to read the brief and pick up — minimal re-explanation from you. Keys off the real subscription-limit signal (`/api/oauth/usage`), not dollar estimates. Once you're over the threshold, a passive **"hand off" chip** also appears at the top of the Usage panel (click to open the guard), so the nudge is visible even if you've turned off the auto-popup.
- **Design-drift scanner now covers type, radius, and shadow** (was colors-only). It discovers font-size, border-radius, and box-shadow tokens from `:root` custom properties and flags element values that are a near-miss — a `13px` that should be your `--font-size-sm`, a `5px` corner that should be `--radius-sm`, a hand-rolled `box-shadow` that should be `--shadow-md`. Length tokens are matched by name so a radius token is never suggested for a font-size (and vice-versa); shadows match structurally (offset/blur/spread + color), tolerant of the computed-vs-authored form. Findings are grouped by category in the panel, each with a live on-page preview of the fix.
- **Design-drift scanner reads tokens from a connected Storybook.** When a Storybook is connected, the scanner pulls its preview `:root` design tokens and matches drift against *those* first — so a page's stale local copy of a token snaps to the canonical design-system value, not itself. Storybook tokens win over page `:root` tokens on name conflicts; the page's own tokens still fill any gaps. The panel notes when Storybook tokens are in play, and the agent hand-off says to treat them as the source of truth.

### Fixed
- **"Start Storybook" now finds a Storybook nested in your project** — detection was only looking one level deep, so a repo/monorepo whose Storybook lives in a subfolder read as "no Storybook." It now searches down to 4 levels (skipping `node_modules`, build/output dirs, etc.), and resolves the `storybook` bin by walking up from the config dir so a hoisted workspace `node_modules` still works.

### Changed
- **Storybook setup tabs reordered** to Connect Existing → Run a storybook → Build with figma → Use a framework, with Connect first and its URL prefilled to `http://localhost:6006` (clearable).
- **First-run defaults** — a fresh install now opens with the system-performance panel hidden and the usage panel in its compact dial view (only seeded on first run; a returning user's toggles are untouched).

## [1.0.29] - 2026-07-08

### Fixed
- **Restart button no longer hides behind the AUDIT dropdown.** The vertical tool rail's "dodge" was shoving the audit button alone onto the restart button; now the whole `+ · restart · AUDIT` cluster shifts as a unit, so nothing overlaps.

### Added
- **Animation tool — motion-framework output.** The Animate panel now emits idiomatic code for **CSS, Web Animations, GSAP, Framer Motion, and Motion One** from one spec, chosen via a sliding-thumb toggle. Includes a framework-adaptive **Spring** easing (real springs for Framer/Motion One, physics-ease approximation elsewhere) with stiffness/damping/mass.
- **Ctrl/Cmd+Shift+I toggles the app's DevTools** (Windows/Linux have no menu bar, so there was no built-in binding).

### Changed
- macOS notarization is now resilient — a stalled Apple notary can't hang the release; the build ships signed and notarizes when the service is healthy.

## [1.0.28] - 2026-07-08

### Added
- **Signed & notarized macOS builds** — the DMG/zip are now signed with a Developer ID certificate and notarized by Apple, so macOS opens them without the "damaged / unidentified developer" warning and no more `xattr -cr` dance. (Windows/Linux builds unchanged.)
- **Report a Performance Issue** (Settings menu) — captures diagnostics (per-process CPU/memory via `getAppMetrics`, GPU hardware-acceleration status, OS/CPU/RAM, live load, open sessions, recent console errors), with an optional 5-second sustained-CPU capture, and opens a pre-filled GitHub issue you review before submitting.

## [1.0.27] - 2026-07-07

### Added
- **Design-drift scanner** (new toolbar tool, Alt+D) — scans the page for hard-coded colors that are a near-miss to one of your design tokens (discovered from `:root` CSS custom properties) and should really use `var(--token)`. Lists each finding with a current-color → suggested-token swatch, previews the token live on the page when you check "Fix," flashes the element on hover, and sends the selected fixes to the agent. Phase 1 covers colors; spacing/type/radius and Storybook token sources come next.

## [1.0.26] - 2026-07-07

### Added
- **States inspector** — inside the Box/Lasso panel, each selected element's drawer has a sticky **States** row (`:hover · :focus · :active · :disabled`) that forces that element's pseudo-state live in the Browser (or a Storybook instance) via CDP, so you can inspect and edit states that are invisible in a static render. Per-element and independent; node IDs are cached per selection so a toggle reliably turns the state back off.

## [1.0.25] - 2026-07-06

### Fixed
- **New chat messages no longer dimmed by the bottom fade** — the bottom edge-fade now only appears once you've scrolled up past it, so the newest messages stay crisp regardless of split size, fullscreen, or the System/Usage panels reflowing the chat height.
- **Status banner reflects trailing agent activity** — if the agent keeps emitting after a turn resolves (seen on macOS), the banner re-lights "Working…" and auto-settles back to "Ready" so it can't get stuck.
- **Storybook URL clear (✕) button** was rendering as a full-size pill (a broad `.wf-panel-form button` rule outranked it) — scoped so it stays a small inline button.
- **Inline `code` chips were unreadable in light themes** — pinned their text color to the token matched to the chip's own background.

### Added
- **Slash-command acknowledgement** — a command that returns no chat output (e.g. `/usage`, which only refreshes the usage gauges) now leaves a small "✓ Ran /usage — no text response" note instead of appearing to do nothing.

## [1.0.24] - 2026-07-06

### Fixed
- **macOS: dark grays rendering too dark** — forced the sRGB color profile on macOS so the near-black shades (selected toggles/thumbs, panel backgrounds) render as authored, matching Windows. macOS was color-managing through the display's wide-gamut profile and crushing them toward black.
- **Chat messages landing inside the bottom fade** — new messages now scroll to the true bottom with clearance equal to the edge-fade height, so they sit fully visible above the fade instead of dimming out.
- **Uneven gap** between the restart button and the AUDIT dropdown — removed a stray margin so the header row is evenly spaced.

### Changed
- **"Working File" renamed to "Browser"** throughout the UI (empty states, onboarding, tool tour, agent prompts) to match the tab name.
- **Status bar is now stateful** — the whole bar turns green while the agent is working (success palette) and red on hover (the click-to-stop target).

## [1.0.23] - 2026-07-06

### Added
- **Syntax-highlighted code in chat** — fenced ` ``` ` code blocks in agent replies now render as styled blocks with Monaco syntax colors (the same vs-dark palette as the Code viewer, no new dependency), and `inline code` gets a chip. Streaming stays plain-text; highlighting is applied when the message completes.
- **Number-key shortcuts on permission prompts** — Allow/Always/Deny now show keycaps (Allow `1`, Always `2`, Deny `3`) and respond to pressing `1`/`2`/`3`.

### Changed
- **Save-prompt (bookmark) button** is now always visible next to Send — dimmed when the input is empty instead of disappearing entirely.

## [1.0.22] - 2026-07-06

### Fixed
- **Terminal view no longer hangs on "trust this folder?"** — switching a Claude session to the terminal view spawns interactive `claude`, which blocked forever on Claude Code's first-run workspace-trust prompt. Cathode now pre-accepts trust for the session's folder in `~/.claude.json` before launching (the chat/ACP path already bypasses this).

## [1.0.21] - 2026-07-06

### Fixed
- **Slash commands now execute** instead of being described by the model. The menu was a hardcoded list of Claude Code *CLI* commands (`/help`, `/login`, `/doctor`, `/cost`…) that do nothing in a headless ACP session, so sending them just prompted the model to explain them. The menu is now driven by the session's real `available_commands_update` (verified: the adapter advertises 27 genuinely-dispatchable commands like `/compact`, `/context`, `/usage`, `/review`, `/verify`), and picking one runs it.

## [1.0.20] - 2026-07-06

### Added
- **macOS logo curve** — restored the concave corner-curve on the left edge of the logo/settings seat, which now spans the window corner and contains the traffic lights.

### Changed
- **Agent tabs** — the kebab menu now leads the title (⋮ · name · ✕), tabs size to their content so full names like "Claude Code" are never clipped, and left padding is removed so the kebab hugs the edge.
- **Removed Aider and LLM CLI** — the agent lineup is now the four ACP-capable agents: Claude Code, OpenAI Codex CLI, Gemini CLI, and Hermes.
- **Onboarding** — "Meet the tools" cards regained their recessed card background, and the Setup / Meet-the-tools switch now uses the design-system sliding-thumb toggle.
- **About modal** — attribution updated to "by Hplant6".

### Fixed
- **Duplicate dropdown** — the Edit Tabs and MCP Connections modals no longer show a raw `<select>` stacked behind the styled custom dropdown.
- **Restart / new-session buttons** no longer bleed through the tool panels (Eyedropper, etc.); kept the spacing from the AUDIT cluster.

## [1.0.19] - 2026-07-06

### Changed
- **macOS chrome: logo/settings back on the left**, inside a structural container that now spans the window corner and *contains* the traffic lights (extra left padding clears them), so the lights read as part of the same seat. The bottom-right blob and the concave corner-curve on the right edge are back, matching the Windows chrome.

## [1.0.18] - 2026-07-05

### Added
- **macOS: real update flow** — "Check for Updates…" now queries the GitHub Releases API, compares versions, and (when newer) offers a Download button that opens the matching `.dmg` for your Mac's architecture (arm64 / x64). A dismissible "update available" toast also surfaces on launch. Replaces the broken "not a git checkout" dialog, since Squirrel.Mac auto-update needs code-signing.

### Fixed
- **macOS chrome: restored the concave curve** on the left edge of the right-hand logo/settings seat, so it meets the bar with the signature fillet instead of a hard angle.

## [1.0.17] - 2026-07-05

### Changed
- **macOS window chrome** — the logo + settings button now sit on the right side (the native traffic lights own the top-left), and the decorative corner-curve fillets around the window controls are dropped on macOS. Windows chrome is unchanged.

## [1.0.16] - 2026-07-05

### Fixed
- **macOS: nav tabs still overlapping** — a firmer fix for the tab bar. The width calculation now measures in viewport coordinates and falls back to natural tab width whenever the bar has room, so a collapsed boundary measurement can no longer squish the tabs into an overlapping sliver.

### Changed
- Removed the redundant native "Downloading update" dialog — the in-app progress modal covers it now.

## [1.0.15] - 2026-07-05

### Fixed
- **macOS: overlapping nav tabs** — the view-tab bar measured its right boundary from the window controls, which are hidden on macOS (native traffic lights), collapsing the width calculation and squishing every tab so their labels overlapped. It now falls back to the sysperf toggle when the controls are hidden.

## [1.0.14] - 2026-07-05

### Fixed
- **Auto-update now downloads and installs** — the Windows installer's filename contained spaces, which GitHub rewrites to dots on upload; electron-updater then requested a non-matching (hyphenated) URL and got a **404 on every download**, so updates never installed. The installer is now named `cathode-terminal-Setup-<version>.exe` (no spaces), so the download resolves. (This — not code-signing — was why auto-update never worked.)

## [1.0.13] - 2026-07-05

### Added
- **About Cathode** — Settings menu → *About Cathode* opens a modal with the Cathode logo, the current version, and author.

## [1.0.12] - 2026-07-05

### Fixed
- **Claude "Claude Code native binary … exists but failed to launch"** — a follow-up to the v1.0.11 WSL move: the ACP session was still handed a Windows `C:\…` working directory, which the Linux Claude Code can't `chdir` into, so it failed to launch. The session directory is now translated to its WSL `/mnt/…` path (confirmed end-to-end). Applies to every WSL-side agent.

## [1.0.11] - 2026-07-05

### Fixed
- **Claude "Internal error … Claude Code process exited with code 3" in the installed app** — the Windows-side ACP adapter bundles Claude Code as a Bun-compiled `claude.exe`, and that binary **segfaults** on some machines the moment it does real work (a plain prompt → "panic: Segmentation fault", exit 3). Cathode now runs the Claude adapter **inside WSL** — like Gemini/Codex/Hermes — using Claude Code's native `~/.claude` subscription, so it no longer touches the crashing Windows binary. (The earlier empty-key change was a red herring; the real cause was the crashing bundled executable.)

## [1.0.10] - 2026-07-05

### Changed
- Agent (ACP) errors now show the underlying error **code and detail** instead of a bare "Internal error," across the connect, spawn, and prompt paths — so agent failures can actually be diagnosed.

## [1.0.9] - 2026-07-05

### Added
- **Update progress modal** — auto-updates now show an in-app modal with a live download **progress bar** (transferred / total + speed) and a **Restart & Install** button, instead of downloading silently. Dismiss it and the download continues in the background; you'll get a clickable "ready to install" prompt when it finishes. (Packaged Windows/Linux only.)

## [1.0.8] - 2026-07-05

### Fixed
- **Claude "Internal error" in the installed app** — the packaged app (launched from the Start menu, so no `ANTHROPIC_API_KEY` in its environment) started the Claude ACP adapter with an **empty** API key, which overrode the signed-in subscription and made every prompt fail with "Internal error." The key is now only forwarded when it's actually set, so subscription/OAuth auth (`CLAUDE_CONFIG_DIR`) is used. Clearing an API key now removes it rather than setting an empty string. (Dev builds were unaffected because the shell already had a key.)
- Onboarding setup steps now render as visible cards — they had collapsed to the same shade as the modal, so each step's container was invisible.

## [1.0.7] - 2026-07-04

### Added
- **Scaffold a Storybook for a static HTML site** — the Storybook setup's "Use a framework" tab now has an **HTML / static site** option, so a plain HTML/CSS/JS project (e.g. a WordPress export) can be set up: the agent runs `storybook init --type html` and writes stories for the site's reusable UI blocks/sections.

### Changed
- The **Project folder** picker moved out of the Settings drawer to a persistent field under the Storybook setup tabs, so generating a Storybook from a folder is discoverable (still shared by the Run and Figma flows).

## [1.0.6] - 2026-07-04

Feature release: the Animation tool.

### Added
- **Animation tool** — target any element on a browsed page and build an animation request for the agent, with a **live preview** on the real element (Web Animations API):
  - **31 animation types** grouped as Entrance / Exit / Emphasis / Property (Fade, Slide, Zoom, Rotate, Flip, Bounce, Blur, Pulse, Shake, Wobble, Jello, Tada, Color, Size, Skew, and more).
  - **Easing** presets plus a **draggable cubic-bézier curve editor**; duration, delay, and contextual direction / distance / amount / target-color; repeat; and trigger (on load / scroll into view / hover / click).
  - **Loop the preview** (design-system checkbox) to tune an animation while it plays, without changing the Repeat value sent to chat.
  - **Send** drops a summary, the selector, and ready-to-adapt **CSS `@keyframes` and JS (Web Animations API)** starter code into the composer.
  - Styled to match the element (lasso) panel, with the app's iro color picker for the target color.

### Fixed
- Custom `<select>` dropdowns: options render readable on the menu surface, `<optgroup>` labels show as group headers, the menu caps to the viewport, and long lists scroll instead of clipping or squishing rows.

## [1.0.5] - 2026-07-04

Reliability & polish release: a full reliability audit, a clear-input control, a new app icon, dependency hardening, and a dead-code sweep.

### Added
- **Clear (X) button inside inputs** — the chat composer, address bar, Storybook URL, modal text fields, and the audit-prompt Label/Prompt now show an X to clear them (white on hover, no background change).
- Global crash backstops (`uncaughtException` / `unhandledRejection`) so one malformed IPC payload can't tear down the main process and kill every open session.

### Changed
- **New app icon** across Windows, macOS, and Linux (and the README).
- Dependencies: Electron 41.7.1 → 41.9.2 (Chromium security patch), the `undici` advisory cleared (`npm audit` → 0 vulnerabilities), and the unused `@xterm/addon-canvas` removed.
- The in-page color picker is now **inlined** into the injected script instead of loaded from a CDN, so it works on CSP-locked and offline pages.
- Agent detection on macOS probes through the **login shell agents actually run under**, so Homebrew/nvm-installed agents aren't falsely reported "not installed."
- Remaining raw-string IPC channels routed through the shared registry.

### Fixed
- **Reliability audit**: guarded sync IPC handlers against malformed payloads; kill-before-spawn so a double PTY spawn can't orphan a process; Monaco loaders no longer hang forever if their assets fail to load; wrapped Storybook/Code-Viewer IPC calls so a rejected handler can't leave the UI stuck; ACP early-failure no longer double-reports (a spawn error / early exit now clears the connect timeout); the `topProcs` buffer was raised so a large process table can't blank the CPU/RAM widget; inject overlays guard `document.body` for frameset / pre-body pages.
- The **eyedropper reticle** no longer vanishes on dark sites — page CSS was overriding its fill; it's now forced white with a thicker stroke and a drop-shadow so it reads on any background.
- **Tools reset on full page navigation** — a stale result panel from the previous page is now dismissed.
- Storybook demo detection tolerates a Unix-only `storybook` bin (node_modules installed from WSL).

### Removed
- ~470 lines of dead code — two abandoned inject files (standalone popup, screenshot popup), unused functions/exports/imports, and redundant boilerplate.

## [1.0.4] - 2026-07-03

Hardening release: four full audits (correctness, security, performance, maintainability) plus a new agent-safety gate.

### Added
- **Fable** in the Claude model menu.
- **Risky-tool confirmation** — the agent now asks before running shell / edit / delete / write / fetch tools (Allow / Always / Deny), instead of auto-approving everything. Read-only tools still run automatically. This is the safeguard against a prompt-injected page steering the agent into destructive actions.

### Fixed
- **Correctness** (~45 fixes across three tiers): model-switching via the tab menu (was blanking the pane and not switching), two boot-bricking corrupt-localStorage paths, an ArrowDown that erased an unsent draft, cancelled installs reporting success, a crash when closing the window mid-animation, duplicate tab ids, PTY-Enter racing a tab switch, stuck modal buttons on IPC failure, and more.
- **Security**: closed an auth-modal XSS→RCE path, validated the Storybook port (command-injection sink) and sanitized the agent-env probe, and made the plaintext-secret fallback warn instead of downgrade silently.
- **Performance**: fixed a custom-`<select>` document-listener leak plus two smaller resolver/command-map leaks; throttled per-chunk and per-frame reflows in chat streaming and tool output; paused background PowerShell process-polling when unfocused.

### Changed
- Internal maintainability: routed raw channel + localStorage string literals through their registries, unified the split-divider gutter into one constant (fixes a 1px popup-alignment drift), and corrected the box-select overlay-skip guard.

## [1.0.3] - 2026-07-03

### Fixed
- **Terminal output was silently dropped** — the PTY output coalescing buffer stringified session ids, so every terminal (agent TUIs, the chat/terminal toggle) rendered blank. All terminals work again.
- Replaced the deprecated canvas terminal renderer (silent blank-text failure mode) with xterm's DOM renderer.
- Usage meters are now agent-aware: non-Claude agents show their own context-window dial and a session-token count instead of Claude's context/limits/cost; a lone dial no longer renders oversized.

### Added
- **Hermes now runs as a chat agent (ACP)** with its own CLI-style banner — via a bidirectional stdio bridge and authenticate-first connection.
- Session tabs are restored on launch (which tabs were open + which was active).
- Multi-project Storybook resolution: `.cathode/storybook.json` manifest per project + `STORYBOOK_URL` injected into agent sessions.
- Chat font size slider (Settings → Chat Font Size…), styled after the design-system slider.
- F12 toggles DevTools for the app window itself.

### Changed
- Status-bar loader animates while connecting/installing, not just while working.
- Small UI polish: square logo-chevron hover (3px radius), no fill on agent-tab close-button hover.

## [1.0.2] - 2026-07-03

### Fixed
- macOS builds are now ad-hoc signed so they launch on Apple Silicon — clear the download quarantine once with `xattr -cr` (no manual `codesign` needed).

## [1.0.1] - 2026-07-03

### Added
- Automatic updates on Windows and Linux (electron-updater) — installed apps check GitHub Releases on launch, download in the background, and install on restart. macOS auto-update awaits code signing.

## [1.0.0] - 2026-07-03

### Added
- Multi-platform release builds — Windows, macOS, and Linux — via a GitHub Actions workflow triggered on `v*` tags.
- Hermes (Nous Research) as a terminal agent, with an in-session "connect a model" setup card.
- Dropdown of known agents in **Manage LLMs → Add Profile** (re-add without retyping) and a juggler install spinner.
- Project documentation: README, MIT license, CONTRIBUTING, architecture guide, and security policy.

### Changed
- macOS builds are signing- and notarization-ready (hardened runtime + entitlements, gated behind CI secrets).
- The System panel's per-process breakdown (`topProcs`) now works on Linux.

<!-- On release: rename this section to `## [X.Y.Z] - YYYY-MM-DD` and start a fresh
     `## [Unreleased]` above it. -->

[Unreleased]: https://github.com/hplant6/gamut-toolbox/compare/v1.11.0...HEAD
[1.11.0]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.11.0
[1.10.1]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.10.1
[1.0.17]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.0.17
[1.0.16]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.0.16
[1.0.15]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.0.15
[1.0.14]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.0.14
[1.0.13]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.0.13
[1.0.12]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.0.12
[1.0.11]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.0.11
[1.0.10]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.0.10
[1.0.9]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.0.9
[1.0.8]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.0.8
[1.0.7]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.0.7
[1.0.6]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.0.6
[1.0.5]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.0.5
[1.0.4]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.0.4
[1.0.3]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.0.3
[1.0.2]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.0.2
[1.0.1]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.0.1
[1.0.0]: https://github.com/hplant6/gamut-toolbox/releases/tag/v1.0.0
