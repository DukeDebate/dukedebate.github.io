/* =========================================================================
   Duke Debate -- page enhancement layer (vanilla JS, no deps)
   -------------------------------------------------------------------------
   Every page now arrives from the server already rendered (see build.mjs), so
   this file no longer BUILDS anything. It makes the header's two controls work
   and nothing else:

     1. Theme toggle (dark / light) -- including relocating the SINGLE toggle
        button between the header and the hamburger menu across the 1180px
        nav breakpoint;
     2. Hamburger nav -- open/close, the backdrop scrim, Escape and
        click-outside dismissal, with focus handed back to the button that
        owns the menu's state.

   WHAT USED TO BE HERE, AND WHERE IT WENT. This file was the hash-router SPA:
   "#/<page>" -> fetch content/<page>.md -> innerHTML into #app. The router,
   the fetch helper, the error/404 cards and the runtime footer-socials fetch
   are gone, because the work they did now happens before the page ships:
     - the Markdown grammar lives in js/render.mjs and runs at BUILD time, so
       every page is real HTML off the wire;
     - the active nav link, the footer socials and the photo grid are baked
       into each page by build.mjs;
     - navigation is a plain full-page load again, so there is no
       scroll-to-top and no focus-move code left here -- the browser does both,
       and history.scrollRestoration is back to the browser's default because
       nothing of ours is fighting it any more.

   The load-bearing consequence: NOTHING in this file writes markup. That is
   exactly what makes it safe to load on a prerendered page -- it can no longer
   overwrite the content it lands on, which is why the <script> tag could go
   back into the shell (see renderShell in build.mjs).
   ========================================================================= */

(function () {
  "use strict";

  // Deliberately NOT null-guarded, unlike navScrim below: the shell in
  // build.mjs renders one header for every page, and these two nodes ARE the
  // feature this file exists to run. A page missing them is a build bug, and a
  // throw at boot names it on the first load; guards would instead ship a
  // silently dead menu that nobody notices until a keyboard user finds it.
  var navEl = document.getElementById("primary-nav");
  var navToggle = document.getElementById("nav-toggle");
  var themeToggle = document.getElementById("theme-toggle");
  // Backdrop scrim for the open hamburger menu. Optional on purpose: every use
  // is null-guarded so the page still works if the element is ever removed.
  var navScrim = document.getElementById("nav-scrim");

  /* =======================================================================
     SECTION 1 -- Gallery bridge (Escape precedence, and nothing else)
     -----------------------------------------------------------------------
     The gallery's behavior lives in js/gallery.mjs, and the prerendered
     /photos/ page loads that module itself. This file does NOT hydrate the
     gallery; it reaches the module for exactly one reason -- the Escape
     handler at the bottom must not collapse the mobile menu out from under an
     open lightbox. isLightboxOpen() is that read-only probe, and asking the
     module (rather than querying for a .lightbox element) keeps the viewer's
     node private to the one file that owns it.

     WHY THE IMPORT IS CONDITIONAL: gallery.mjs imports escapeHtml from
     render.mjs, so asking for it pulls the whole 600-line renderer down with
     it. A page with no grid can never open a lightbox, so on those pages the
     honest answer to "is the lightbox open?" is a permanent no -- and the
     handler already treats an unresolved module as exactly that. Gating on
     the grid therefore changes no behavior and keeps ten of the eleven pages
     from downloading a renderer they would never run.

     Same specifier as the /photos/ page's own <script type="module">, so the
     browser hands that tag and this import the SAME module instance: one
     lightbox, one hydration pass, and a probe that cannot desync from the
     viewer it describes.

     WHY A DYNAMIC import() FROM A CLASSIC SCRIPT: the shell loads this file
     as one plain <script src>, no type="module", so boot order and first
     paint are untouched. import() is the one loader a classic script has, and
     it resolves its specifier against THIS script's URL (/js/) rather than
     against the document -- confirmed in a browser from a subpath -- so the
     bridge behaves identically at / and at /photos/.
     ======================================================================= */
  var gallery = null;

  if (document.querySelector(".content-gallery, #photo-grid")) {
    import("./gallery.mjs").then(function (mod) {
      gallery = mod;
    }).catch(function (err) {
      /* Non-fatal by design: the grid is prerendered, so it stays on screen
         and readable, and the menu simply keeps owning Escape. */
      console.info("[gallery] lightbox probe unavailable, menu keeps Escape: " +
        (err && err.message || err));
    });
  }

  /* =======================================================================
     SECTION 2 -- Hamburger nav
     ======================================================================= */

  /* Single entry point for the mobile menu's open/closed state. Three things
     must move together -- the panel's .open class, the hamburger's
     aria-expanded, and the backdrop scrim's .open class -- and routing every
     caller through here is what stops them from drifting apart (e.g. a scrim
     left visible over a collapsed panel).
     NOTE -- deliberately NO background scroll lock, and that survives the
     router's removal. It was originally ruled out because the menu closed
     during afterRender(), which immediately called window.scrollTo(), and
     toggling overflow on <html>/<body> around that was what produced the old
     "route doesn't start at the top" bug. afterRender() is gone, so that
     specific collision is too -- but the reason to leave the behavior alone
     hasn't changed: the scrim already blocks pointer interaction with the page
     behind it, so the only thing given up is preventing a scroll gesture over
     the backdrop. (The lightbox can pin body overflow because it is a modal
     dialog that owns the whole viewport; this menu is not.) */
  function setMobileNav(open) {
    navEl.classList.toggle("open", open);
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (navScrim) { navScrim.classList.toggle("open", open); }
  }

  /* Close the menu WITHOUT touching focus. Exactly one caller: the
     breakpoint-widening handler in initThemeToggle(), which reconciles the menu
     in the middle of a re-home and must leave focus to the rescueFocus() call
     that runs after it -- that is the only place with both the before and the
     after picture, so it is the only place that can decide correctly.
     Every USER dismissal goes through dismissMobileNav() instead. */
  function closeMobileNav() {
    setMobileNav(false);
  }

  /* Close in response to a user DISMISSAL -- a scrim click or Escape.
     ACCESSIBILITY: both gestures leave focus somewhere that is about to become
     unreachable (inside the collapsing panel, or on <body> after a click on the
     non-focusable scrim), so focus must return to the hamburger, the control
     that owns the menu's state.
     preventScroll:true for the same reason as every other focus() call in this
     file: the header is sticky, so the button is already on screen, and a
     scrolling focus() would move the page out from under the reader. */
  function dismissMobileNav() {
    if (!navEl.classList.contains("open")) { return; }
    closeMobileNav();
    navToggle.focus({ preventScroll: true });
  }

  /* =======================================================================
     SECTION 3 -- Theme toggle (dark / light)
     -----------------------------------------------------------------------
     The inline <head> bootstrap already set the initial data-theme (saved
     choice, else the OS prefers-color-scheme); build.mjs inlines it into
     EVERY page, so each full-page load gets its own first frame right with no
     flash of the wrong theme. This section owns RUNTIME behavior only:
       - clicking the button flips data-theme and PERSISTS the choice;
       - the button's aria-label / aria-pressed are kept in sync;
       - with NO explicit saved choice, the OS preference is followed LIVE
         via a matchMedia change listener.
     We intentionally do NOT re-read/duplicate the bootstrap's initial logic;
     we just sync the button to whatever <html> already shows.
     ======================================================================= */
  var THEME_KEY = "theme";
  var rootEl = document.documentElement;
  var lightMediaQuery = window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: light)")
    : null;

  function currentTheme() {
    return rootEl.getAttribute("data-theme") === "light" ? "light" : "dark";
  }

  // Reflect the active theme on the toggle button. The visible icon (via CSS)
  // shows what you'd switch TO, so the label must describe that same action.
  // This is the SINGLE source of truth for the button's accessible state; both
  // header and in-menu placements use the same node, so they can never disagree.
  function syncThemeButton() {
    if (!themeToggle) { return; }
    var isLight = currentTheme() === "light";
    themeToggle.setAttribute("aria-label", isLight ? "Switch to dark theme" : "Switch to light theme");
    // aria-pressed reflects whether the "light" state is engaged.
    themeToggle.setAttribute("aria-pressed", isLight ? "true" : "false");
    // Visible text shown only when the button sits inside the hamburger menu.
    var label = themeToggle.querySelector(".theme-toggle-label");
    if (label) { label.textContent = isLight ? "Switch to dark theme" : "Switch to light theme"; }
  }

  function applyTheme(theme) {
    rootEl.setAttribute("data-theme", theme);
    syncThemeButton();
  }

  // Explicit user choice: persist it and stop following the OS preference.
  function setThemeChoice(theme) {
    try { localStorage.setItem(THEME_KEY, theme); }
    catch (err) { /* storage may be unavailable (private mode) -- non-fatal */ }
    applyTheme(theme);
    console.info("[theme] user selected " + theme + " theme");
  }

  /* Relocate the SINGLE theme-toggle node between two homes based on width:
       - wide (inline nav): back in .header-controls, before the hamburger;
       - narrow (hamburger): inside #primary-nav, after the links, as a row.
     Moving one node (rather than duplicating) means the button's aria state,
     click handler, and icon are shared automatically -- nothing to keep in sync.
     A matchMedia listener re-homes it on breakpoint crossings (incl. rotation).
     The 1180px threshold MUST match the CSS nav breakpoint. */
  var headerControls = document.querySelector(".header-controls");
  var navToggleMedia = window.matchMedia
    ? window.matchMedia("(max-width: 1180px)")
    : null;

  /* Re-home the toggle node. Focus is deliberately NOT this function's problem
     any more -- see the rescueFocus() block below for why it moved out. */
  function placeThemeToggle(isNarrow) {
    if (!themeToggle) { return; }

    if (isNarrow) {
      // Into the menu: append after the nav list so tab order is links -> toggle.
      if (themeToggle.parentElement !== navEl) { navEl.appendChild(themeToggle); }
    } else {
      // Back into the header, before the hamburger (its natural first slot).
      if (headerControls && themeToggle.parentElement !== headerControls) {
        headerControls.insertBefore(themeToggle, headerControls.firstChild);
      }
    }
  }

  /* =====================================================================
     Focus rescue across the 1180px nav breakpoint
     ---------------------------------------------------------------------
     WHY THIS EXISTS. Crossing the breakpoint swaps which header controls are
     reachable, and a focused element that becomes hidden has its focus dropped
     to <body> by the browser -- the reader silently loses their place in the
     page and the next Tab restarts from the top. This used to be handled for
     exactly ONE node, the theme toggle, because that is the node
     placeThemeToggle() moves; the other two ways to lose focus here were both
     reproduced:

       1. 1280px -> Tab to a nav link -> narrow to 800px. The inline row becomes
          visibility:hidden (style.css:875) and the link's focus went to <body>.
       2. 800px -> focus #nav-toggle -> widen to 1280px. The hamburger becomes
          display:none (style.css:333, 845) and its focus went to <body>.

     Both are the SAME bug as the toggle's, so they get the same answer rather
     than two more special cases: remember what had focus before the re-home,
     ask afterwards whether it is still reachable, and if it is not, hand focus
     to the surviving equivalent control -- the hamburger when narrow (it is what
     reveals the collapsed links and the toggle's new home, and where the
     Escape/scrim dismissals already park focus), the header theme toggle when
     wide (the only header control that survives the hamburger going away).
     ===================================================================== */

  /* The element whose focus this module is responsible for, or null. Restricted
     to the header's own nav controls on purpose: anything else -- a link in the
     article, or <body> when nothing is focused -- is left strictly alone, so the
     rescue can never STEAL focus the way an unconditional focus() would. */
  function isNavControl(el) {
    if (!el || el === document.body) { return false; }

    return el === navToggle || el === themeToggle || navEl.contains(el);
  }

  function focusedNavControl() {
    return isNavControl(document.activeElement) ? document.activeElement : null;
  }

  /* A nav control the BROWSER already took focus from, kept until the matchMedia
     handler can act on it.

     WHY THIS BUFFER IS NEEDED AT ALL -- measured, not assumed. Only ONE of the
     three ways focus is lost here is visible to the matchMedia handler:
       - the theme toggle loses focus because WE move the node, inside that
         handler, so activeElement is still correct on entry;
       - a nav link or the hamburger loses focus because CSS hid it, and the
         browser fires focusout on the resize reflow -- which lands BEFORE the
         matchMedia "change" callback. By the time the handler runs,
         activeElement is already <body> and the victim's identity is gone.
     So the focusout listener below records it, and the handler consumes it. */
  var droppedNavControl = null;

  /* Capture-phase because focusout does not bubble past its target in every
     engine; capture sees it on the document either way. */
  document.addEventListener("focusout", function (evt) {
    /* relatedTarget names where focus WENT. A non-null value means the user (or
       our own focus() call) moved it somewhere real, which is never something to
       undo. Only a null relatedTarget is focus being DROPPED on the floor. */
    if (evt.relatedTarget || !isNavControl(evt.target)) { return; }

    /* The discriminator that keeps this from stealing focus: a drop only counts
       as breakpoint damage if the element it was dropped FROM is now unreachable.
       Click a blank margin while a nav link is focused and focus also lands on
       <body> with a null relatedTarget -- but that link is still perfectly
       visible, so nothing is recorded and a later resize rescues nothing. */
    if (navToggleMedia && isOutOfReach(evt.target, navToggleMedia.matches)) {
      droppedNavControl = evt.target;
    }
  }, true);

  /* Any focus landing anywhere means the page has a real focus owner again, so a
     victim still buffered from earlier is stale and must not be resurrected on
     some unrelated resize minutes later. */
  document.addEventListener("focusin", function () {
    droppedNavControl = null;
  }, true);

  /* "Is this element out of reach in the layout we just switched to?" -- asked in
     the one way that survives CSS transitions.

     Two hiding mechanisms are in play across the breakpoint and they must be
     probed differently:
       - .nav-toggle's display:none above 1180px lands on the same reflow, so a
         computed style is an honest answer for it;
       - the collapsed panel's visibility TRANSITIONS over 0.3s (style.css:876),
         so for those 300ms a just-collapsed .primary-nav still computes as
         `visible`. A computed-style check now would wrongly conclude focus had
         stuck, and would then silently lose it when the transition landed.
     So the panel's subtree is judged by the menu's .open CLASS, which flips
     instantly, and everything else by computed style. */
  function isOutOfReach(el, isNarrow) {
    if (!el || !el.isConnected) { return true; }
    // The collapsed, CLOSED panel takes its whole subtree out of reach at once --
    // the links and the relocated theme toggle alike. Class, not style: above.
    if (navEl.contains(el)) { return isNarrow && !navEl.classList.contains("open"); }

    var style = window.getComputedStyle(el);

    return style.display === "none" || style.visibility === "hidden";
  }

  /* Put focus back where the reader left it, or on the nearest control that
     still exists. Call AFTER the re-home and the menu reconcile, with the
     element focusedNavControl() returned BEFORE them.
     preventScroll:true matches every other focus() call in this file: each
     candidate lives in the sticky header and is already on screen, so a
     scrolling focus() would only drag the page out from under the reader. */
  function rescueFocus(victim, isNarrow) {
    if (!victim) { return; }

    if (!isOutOfReach(victim, isNarrow)) {
      /* Still reachable -- but moving a node in the DOM detaches it, and the
         browser drops focus to <body> when the FOCUSED element is the one being
         moved. That is the relocated theme toggle's case, so re-assert focus on
         the victim rather than assuming it survived the move. */
      if (document.activeElement !== victim) { victim.focus({ preventScroll: true }); }

      return;
    }

    var survivor = isNarrow ? navToggle : themeToggle;

    if (!survivor || isOutOfReach(survivor, isNarrow)) { return; }

    survivor.focus({ preventScroll: true });
    console.info("[nav] breakpoint hid the focused control -- focus moved to #" +
      (survivor.id || "the surviving header control"));
  }

  function initThemeToggle() {
    // Sync the button to the theme the bootstrap already applied on <html>.
    syncThemeButton();

    if (themeToggle) {
      themeToggle.addEventListener("click", function () {
        setThemeChoice(currentTheme() === "light" ? "dark" : "light");
      });
    }

    // Position the toggle for the current width, then re-home on any change.
    if (navToggleMedia) {
      // No rescue on the initial placement: nothing is focused yet at boot, and
      // focusedNavControl() would return null anyway.
      placeThemeToggle(navToggleMedia.matches);
      var onNavWidthChange = function (evt) {
        /* Snapshot the focus victim BEFORE anything moves or collapses. Two
           sources because focus is lost at two different moments (see
           droppedNavControl): if it is still ours, activeElement has it; if the
           resize reflow already dropped it, the focusout buffer does. Live focus
           wins -- the buffer can only ever hold something already lost. */
        var victim = focusedNavControl() || droppedNavControl;
        droppedNavControl = null;

        // Re-home FIRST, then reconcile the menu. Order matters: above the
        // breakpoint the collapsed panel and its scrim are gone from the layout,
        // so a menu left "open" would strand the .open class and a scrim that
        // CSS no longer renders -- and the hamburger that would clear it is
        // display:none. Moving the toggle out before closing also keeps focus
        // alive: closing first would hide the panel while the (focused) toggle
        // was still inside it, and a focused element turned invisible drops
        // focus to <body>.
        placeThemeToggle(evt.matches);

        if (!evt.matches) {
          console.info("[nav] widened past the nav breakpoint -- closing the mobile menu");
          closeMobileNav();
        }

        // LAST, so it reads the settled layout: the toggle is in its new home
        // and the menu's .open class is final, which is what isOutOfReach()
        // judges the collapsed panel by.
        rescueFocus(victim, evt.matches);
      };
      if (navToggleMedia.addEventListener) { navToggleMedia.addEventListener("change", onNavWidthChange); }
      else if (navToggleMedia.addListener) { navToggleMedia.addListener(onNavWidthChange); }
    }

    // Live-follow the OS preference ONLY while the user hasn't chosen manually.
    if (lightMediaQuery) {
      var onSchemeChange = function (evt) {
        var saved;
        try { saved = localStorage.getItem(THEME_KEY); }
        catch (err) { saved = null; }
        if (saved === "light" || saved === "dark") { return; } // respect choice
        applyTheme(evt.matches ? "light" : "dark");
        console.info("[theme] following system preference: " + currentTheme());
      };
      // addEventListener is the modern API; addListener is the Safari fallback.
      if (lightMediaQuery.addEventListener) { lightMediaQuery.addEventListener("change", onSchemeChange); }
      else if (lightMediaQuery.addListener) { lightMediaQuery.addListener(onSchemeChange); }
    }
  }

  /* =======================================================================
     SECTION 4 -- Wire up events + boot
     -----------------------------------------------------------------------
     No boot handshake is needed any more. The shell loads this file with a
     plain <script src> at the END of <body>, so every element looked up above
     is already parsed, and there is nothing to route: the page the browser is
     showing is the page the server sent. The old hashchange /
     DOMContentLoaded / readyState dance existed only to drive the router.
     ======================================================================= */

  // Hamburger toggle. setMobileNav keeps the panel, aria-expanded and the
  // backdrop scrim in one consistent state (see setMobileNav).
  navToggle.addEventListener("click", function () {
    setMobileNav(!navEl.classList.contains("open"));
  });

  // Clicking the backdrop closes the menu -- the expected "tap outside to
  // dismiss" gesture, and the pointer equivalent of Escape below. The scrim only
  // receives clicks while it is .open (it is visibility:hidden otherwise), so no
  // extra state check is needed here.
  if (navScrim) {
    navScrim.addEventListener("click", dismissMobileNav);
  }

  // Escape closes the menu, matching the dismiss affordance sighted users get
  // from the scrim. Bound on the document because focus may be anywhere inside
  // the panel (a nav link, the relocated theme toggle) or on the hamburger.
  // The lightbox has its own Escape handler and is the topmost overlay, so when
  // it is open it owns the key and this bails out -- one Escape, one dismissal.
  document.addEventListener("keydown", function (evt) {
    if (evt.key !== "Escape") { return; }
    // Ask the gallery module rather than reaching for its element, so the node
    // stays private to gallery.mjs. `gallery &&` covers both the pages that
    // never load the module (no grid, so no lightbox can exist) and the window
    // before the import resolves -- in both cases "no lightbox is open" is
    // exactly true, so the menu owns Escape.
    if (gallery && gallery.isLightboxOpen()) { return; }
    dismissMobileNav();
  });

  initThemeToggle();
})();
