/* =========================================================================
   Duke Debate -- Markdown/front-matter renderer (pure ES module)
   -------------------------------------------------------------------------
   THE ONE HOME of the site's content grammar. Everything here is pure text ->
   text: not a single DOM reference, so the SAME code runs in the browser and
   under Node in build.mjs. That is the whole point of the extraction -- this
   block is the most correctness-sensitive code in the repo and carries
   hard-won fixes (the escaped "&gt;" blockquote marker, the GUARANTEED
   FORWARD PROGRESS guard, the safeUrl scheme allowlist + entity decode).
   Duplicating it into the build would guarantee those bugs come back, so
   there is exactly one copy and both consumers import it.
   Sections below are numbered as they were in app.js, where they used to
   live, so old review comments and commit messages still line up.
   ========================================================================= */

/* =======================================================================
   SECTION 1 -- HTML escaping
   -----------------------------------------------------------------------
   All Markdown source is escaped BEFORE any transformation so that raw
   "<script>" or "&" in a content file can never inject live markup. The
   renderer then re-introduces a known, safe set of tags itself.
   ======================================================================= */
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* Characters a browser THROWS AWAY while parsing a URL: ASCII whitespace
   plus C0/DEL control characters. Stripping them is what makes the scheme
   test see "javascript:" in "java\tscript:" -- the spelling a browser itself
   would follow. Shared by the protocol-relative and scheme checks below so
   the two can never disagree about what the URL "really" says. */
function stripUrlNoise(text) {
  return text.replace(/[\s\u0000-\u001f\u007f]+/g, "");
}

/* =======================================================================
   SECTION 1b -- URL scheme allowlist (link safety)
   -----------------------------------------------------------------------
   ONE shared gate for every href the site emits (Markdown links, CTA
   buttons, footer socials). We ALLOW only:
     - in-app hash routes ............ "#/join", "#anchor"
     - explicit safe schemes ......... "http://"  "https://"  "mailto:"
     - relative / root-relative paths  "assets/x.pdf", "/files/x.pdf"
       (path-relative, so no "scheme:" prefix -- can't smuggle javascript:)
   Anything else -- most importantly "javascript:", but also "data:",
   "vbscript:", "file:" and protocol-relative "//evil.com" -- is NEUTRALIZED
   by returning null. Callers then render plain text instead of a live link,
   so a hostile or mistyped URL can never produce a clickable script handler.

   THE CONTRACT EVERY CALLER RELIES ON: any URL returned from here that
   leaves this origin matches /^https?:\/\//i -- the exact test all three
   callers use to decide on target="_blank" + rel="noopener noreferrer". An
   off-site URL that regex would MISS therefore has to be rejected here;
   otherwise it renders as a live cross-origin link with no rel, handing that
   origin our window.opener. That is why the protocol-relative branch below
   returns null instead of falling through to the permissive relative-path
   exit at the bottom.

   WHAT ACTUALLY MAKES HTML-ESCAPED INPUT SAFE: the probe below reads the
   scheme from a copy with whitespace/control characters stripped AND
   character references decoded, so "java\tscript:" and "javascript&#58;"
   are each recognized and rejected on their own merits. Spelled out because
   the comment that used to sit here credited exactly that decode while the
   code did none: the ONLY thing keeping "javascript&#58;alert(1)" harmless
   was the renderer's output escaping, which ships the "&" as "&amp;" so the
   entity never decodes back to ":" inside a live href. That downstream
   escaping is STILL load-bearing for a second reason -- every caller
   interpolates this return value straight into an href="..." attribute, and
   escaping is what stops a quote inside a URL from breaking out of it. A
   maintainer who removes the escaping reintroduces attribute-breakout XSS,
   and -- if they also drop the decode below -- clickable "javascript:" links.
   ======================================================================= */
function safeUrl(rawUrl) {
  if (!rawUrl) { return null; }
  var url = String(rawUrl).trim();

  // Hash routes and pure fragments are always in-app and safe.
  if (url.charAt(0) === "#") { return url; }

  // Everything below judges a NORMALIZED copy, never the raw string. Decode
  // character references first, so an escaped "&#58;" is weighed as the ":"
  // it stands for, then strip the noise a browser itself ignores. Decode
  // BEFORE strip, because a decoded "&#9;" is fresh whitespace that lands
  // inside the scheme and only the later strip removes it. Two decode passes:
  // "&amp;#58;" needs its own "&amp;" resolved before the "&#58;" underneath
  // is even visible, which is exactly the shape the renderer produces when it
  // escapes "javascript&#58;alert(1)" from a content file.
  var probeSource = url.toLowerCase();
  for (var pass = 0; pass < 2; pass++) {
    probeSource = probeSource
      .replace(/&#x([0-9a-f]+);?/g, function (_m, hex) {
        return String.fromCharCode(parseInt(hex, 16));
      })
      .replace(/&#(\d+);?/g, function (_m, dec) {
        return String.fromCharCode(parseInt(dec, 10));
      })
      .replace(/&colon;/g, ":")
      .replace(/&amp;/g, "&");
  }
  var probe = stripUrlNoise(probeSource);

  // PROTOCOL-RELATIVE "//evil.com" (and "///evil.com", which browsers read as
  // authority-relative too): there is no scheme text for the allowlist to
  // judge, yet it resolves OFF SITE using the page's own scheme. It used to
  // fall through to the relative-path exit at the bottom and come back as a
  // live off-site href -- and because /^https?:\/\//i does not match it, the
  // callers' external-link test failed too, so the link also rendered WITHOUT
  // rel="noopener noreferrer". Reject it like every other URL we can't vouch
  // for; callers then render plain text.
  if (probe.charAt(0) === "/" && probe.charAt(1) === "/") { return null; }

  // Root-relative paths are same-origin by definition, so no scheme check is
  // needed. ("//" is already gone -- rejected directly above.)
  if (url.charAt(0) === "/") { return url; }

  // If there's a "scheme:" prefix, it must be one of the allowlisted ones.
  var schemeMatch = /^([a-z][a-z0-9+.-]*):/.exec(probe);
  if (schemeMatch) {
    var scheme = schemeMatch[1];
    if (scheme === "http" || scheme === "https") {
      // Insist on the plain "http(s)://" spelling of the RAW url. A browser
      // will also send "https:/evil.com", "https:evil.com" and
      // "ht\ttps://evil.com" off site, but the callers' /^https?:\/\//i
      // external test matches none of them -- precisely the live cross-origin
      // link with no rel that the contract above forbids. Legitimate content
      // has no reason to spell it any of those ways.
      if (!/^https?:\/\//i.test(url)) { return null; }
      return url;
    }
    if (scheme === "mailto") { return url; }
    return null; // disallowed scheme (javascript:, data:, vbscript:, ...)
  }

  // No scheme and not an absolute URL: treat as a relative path (safe).
  return url;
}

/* =======================================================================
   SECTION 2 -- Front-matter parser
   -----------------------------------------------------------------------
   Optional leading block delimited by lines of exactly "---":
       ---
       title: About Us
       subtitle: Who we are
       ---
   Returns { data: {key: value}, body: "<remaining markdown>" }.
   Only simple "key: value" pairs are supported (prototype scope).
   ======================================================================= */
function parseFrontMatter(raw) {
  var data = {};
  // Normalize newlines so \r\n files behave.
  var text = raw.replace(/\r\n/g, "\n");
  var lines = text.split("\n");

  if (lines[0].trim() !== "---") {
    return { data: data, body: text };
  }

  var end = -1;
  for (var i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { end = i; break; }
  }
  if (end === -1) {
    // No closing fence -- treat the whole file as body to fail safe.
    return { data: data, body: text };
  }

  for (var j = 1; j < end; j++) {
    var line = lines[j];
    var colon = line.indexOf(":");
    if (colon === -1) { continue; }
    var key = line.slice(0, colon).trim();
    var value = line.slice(colon + 1).trim();
    // Strip optional surrounding quotes.
    value = value.replace(/^["'](.*)["']$/, "$1");
    if (key) { data[key] = value; }
  }

  var body = lines.slice(end + 1).join("\n");
  return { data: data, body: body };
}

/* =======================================================================
   SECTION 3 -- Markdown renderer
   -----------------------------------------------------------------------
   A compact block-then-inline parser. It walks the ESCAPED source line by
   line, grouping lines into blocks (headings, lists, tables, code fences,
   blockquotes, rules, paragraphs) and then applies inline formatting to
   the text of each block.

   Supported: h1-h4, paragraphs, **bold**, *italic*, [links](url),
   ![images](url), unordered/ordered lists, blockquotes, `inline code`,
   ```fenced code blocks```, horizontal rules (---/***), pipe tables.
   ======================================================================= */

// Inline formatting. Input is already HTML-escaped text.
function renderInline(text) {
  var out = text;

  // CTA button directive: [[button: Label -> target]]  ->  big link-button.
  // NOTE: input is already HTML-escaped, so the author's "->" arrives here as
  // "-&gt;"; we match that escaped form. Label/target are already escaped and
  // safe to interpolate. display:inline-block styling lets it sit on its own
  // line (the documented use) or inside a sentence. Runs first so its own
  // brackets can't be mistaken for link syntax. See README "Split sections
  // & buttons".
  out = out.replace(
    /\[\[button:\s*([^\]]+?)\s*-&gt;\s*([^\]\s]+)\s*\]\]/g,
    function (_m, label, target) {
      // Gate the target through the shared URL allowlist. A disallowed
      // scheme (javascript:, data:, ...) yields null -- we then render the
      // label as plain, non-clickable text rather than a live button.
      var safe = safeUrl(target);
      if (!safe) { return label; }
      var external = /^https?:\/\//i.test(safe);
      var attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
      return '<a class="cta-button" href="' + safe + '"' + attrs + ">" + label + "</a>";
    }
  );

  // Inline code first: protect its contents from further formatting by
  // capturing between backticks. (Escaped source means no nested tags.)
  out = out.replace(/`([^`]+)`/g, function (_m, code) {
    return "<code>" + code + "</code>";
  });

  // Images: ![alt](src)  -- must run before links (shares "(...)" syntax).
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, function (_m, alt, src) {
    return '<img src="' + src + '" alt="' + alt + '" loading="lazy" />';
  });

  // Links: [text](url). Flag external http(s) links for a new tab.
  // Gate every href through the shared allowlist; a disallowed scheme
  // renders as plain text (the label) instead of a clickable link.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_m, label, url) {
    var safe = safeUrl(url);
    if (!safe) { return label; }
    var external = /^https?:\/\//i.test(safe);
    var attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
    return '<a href="' + safe + '"' + attrs + ">" + label + "</a>";
  });

  // Bold then italic. Bold uses ** or __, italic uses * or _.
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1<em>$2</em>");

  return out;
}

// Detect a pipe-table divider row like "| --- | :--: |".
function isTableDivider(line) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.indexOf("-") !== -1;
}

// Split a "| a | b |" row into trimmed cell strings.
function splitTableRow(line) {
  var trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map(function (cell) { return cell.trim(); });
}

function renderMarkdown(src) {
  // Escape the whole source EXACTLY ONCE up front, then hand the escaped
  // lines to the block walker. Splitting escape from walking lets block
  // containers (the split directive) recursively render their inner lines
  // via renderBlocks without escaping a second time.
  return renderBlocks(escapeHtml(src).split("\n"));
}

// Walk an array of ALREADY-ESCAPED source lines and emit block-level HTML.
// (Function declaration is hoisted, so renderMarkdown above may call it.)
function renderBlocks(lines) {
  var html = [];
  var i = 0;

  while (i < lines.length) {
    var line = lines[i];

    // --- Fenced code block: ``` ... ``` ---
    if (/^```/.test(line)) {
      var code = [];
      i++; // skip opening fence
      while (i < lines.length && !/^```/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      html.push("<pre><code>" + code.join("\n") + "</code></pre>");
      continue;
    }

    // --- Split section: ::: split [flip] ... ||| ... ::: ---
    // Two-column container. Everything up to a lone "|||" separator is the
    // first column; everything after (until the closing ":::") is the second.
    // Each column's inner lines are rendered as normal Markdown via a
    // recursive renderBlocks call (no re-escaping -- lines are already escaped).
    // An optional "flip" word after "split" swaps the visual column order.
    // Forgiving syntax:
    //   - the "|||" separator is optional; with no second column the block
    //     renders as a single full-width column (see the .split--single CSS)
    //     instead of squeezing content into half the width beside an empty box;
    //   - an UNTERMINATED block (no closing ":::") consumes to end-of-input
    //     and still RENDERS its content -- it never silently swallows the page.
    // NOTE: valid "::: ..." openers are handled above the forward-progress
    // guard (split, accordion, logos). Any other "::: ..." line falls through
    // to that guard so it can never spin here.
    var splitOpen = /^\s*:::\s*split\s*(flip)?\s*$/i.exec(line);
    if (splitOpen) {
      var isFlip = Boolean(splitOpen[1]);
      i++; // consume the opening ":::" line
      var colA = [];
      var colB = [];
      var sawDivider = false;
      var current = colA;
      while (i < lines.length && !/^\s*:::\s*$/.test(lines[i])) {
        if (/^\s*\|\|\|\s*$/.test(lines[i])) {
          sawDivider = true;
          current = colB; // switch to the second column at the "|||" divider
        } else {
          current.push(lines[i]);
        }
        i++;
      }
      i++; // consume the closing ":::" (or run off the end if unterminated)

      // Is there any real content in the second column? A "|||" with nothing
      // meaningful after it still counts as one-column.
      var colBHtml = renderBlocks(colB);
      var hasColB = sawDivider && colBHtml.trim() !== "";

      if (hasColB) {
        // Two columns. The second is the media side for the flip variant.
        var wrapperClass = isFlip ? "split split--flip" : "split";
        html.push(
          '<div class="' + wrapperClass + '">' +
          '<div class="split-col split-content">' + renderBlocks(colA) + "</div>" +
          '<div class="split-col split-media">' + colBHtml + "</div>" +
          "</div>"
        );
      } else {
        // One column: render full-width, no empty media box. (flip is moot.)
        html.push(
          '<div class="split split--single">' +
          '<div class="split-col split-content">' + renderBlocks(colA) + "</div>" +
          "</div>"
        );
      }
      continue;
    }

    // --- Accordion: ::: accordion Title ... ::: ---
    // Generic expandable section via native <details>/<summary> -- no JS.
    // The title is everything after "accordion" on the opener line; the body
    // is normal Markdown (paragraphs, lists, links, bold/italic, etc.) via a
    // recursive renderBlocks call. Multiple accordions on one page are fine;
    // each is an independent <details>. Same unterminated-block forgiveness
    // as split: missing closer consumes to end-of-input and still renders.
    var accordionOpen = /^\s*:::\s*accordion\s+(.+?)\s*$/i.exec(line);
    if (accordionOpen) {
      var accordionTitle = accordionOpen[1];
      i++; // consume the opening ":::" line
      var accordionBody = [];
      while (i < lines.length && !/^\s*:::\s*$/.test(lines[i])) {
        accordionBody.push(lines[i]);
        i++;
      }
      i++; // consume the closing ":::" (or run off the end if unterminated)

      html.push(
        '<details class="accordion">' +
        "<summary>" + renderInline(accordionTitle) + "</summary>" +
        '<div class="accordion-body">' + renderBlocks(accordionBody) + "</div>" +
        "</details>"
      );
      continue;
    }

    // --- Logo grid: ::: logos ... ::: ---
    // Responsive grid of organization/company logos. Collects every
    // ![Name](path) in the block (including wrapped / multi-per-line forms).
    // Alt text is preserved. Same unterminated-block forgiveness as the
    // other ::: directives.
    var logosOpen = /^\s*:::\s*logos\s*$/i.exec(line);
    if (logosOpen) {
      i++; // consume the opening ":::" line
      var logoBody = [];
      while (i < lines.length && !/^\s*:::\s*$/.test(lines[i])) {
        logoBody.push(lines[i]);
        i++;
      }
      i++; // consume the closing ":::" (or run off the end if unterminated)

      var logoItems = [];
      // Join with spaces so a wrapped ![alt](src) still matches.
      var logoSrc = logoBody.join(" ");
      var logoRe = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
      var logoMatch;
      while ((logoMatch = logoRe.exec(logoSrc)) !== null) {
        logoItems.push(
          '<div class="logo-grid-item" role="listitem">' +
          '<img src="' + logoMatch[2] + '" alt="' + logoMatch[1] + '" loading="lazy" />' +
          "</div>"
        );
      }

      if (logoItems.length) {
        html.push('<div class="logo-grid" role="list">' + logoItems.join("") + "</div>");
      }
      continue;
    }

    // --- Photo gallery: ::: gallery ... ::: ---
    // Responsive image grid for page content (e.g. the Photos page). Collects
    // every ![alt](src) in the block. js/gallery.mjs hydrates .content-gallery
    // grids for the lightbox. Multiple galleries on one page are independent
    // (arrows stay within that grid). Same unterminated-block forgiveness.
    var galleryOpen = /^\s*:::\s*gallery\s*$/i.exec(line);
    if (galleryOpen) {
      i++; // consume the opening ":::" line
      var galleryBody = [];
      while (i < lines.length && !/^\s*:::\s*$/.test(lines[i])) {
        galleryBody.push(lines[i]);
        i++;
      }
      i++; // consume the closing ":::" (or run off the end if unterminated)

      var galleryItems = [];
      var gallerySrc = galleryBody.join(" ");
      var galleryRe = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
      var galleryMatch;
      while ((galleryMatch = galleryRe.exec(gallerySrc)) !== null) {
        var gAlt = galleryMatch[1];
        var gSrc = galleryMatch[2];
        galleryItems.push(
          '<figure class="content-gallery-item photo-tile" role="button" tabindex="0" ' +
          'aria-label="View photo: ' + gAlt + '">' +
          '<img src="' + gSrc + '" alt="' + gAlt + '" loading="lazy" />' +
          (gAlt ? "<figcaption>" + gAlt + "</figcaption>" : "") +
          "</figure>"
        );
      }

      if (galleryItems.length) {
        html.push(
          '<div class="content-gallery photo-grid" role="list">' +
          galleryItems.join("") +
          "</div>"
        );
      }
      continue;
    }

    // --- Blank line: separates blocks ---
    if (line.trim() === "") { i++; continue; }

    // --- Horizontal rule: ---, ***, ___ (3+), on their own line ---
    if (/^(\s*)(---+|\*\*\*+|___+)\s*$/.test(line)) {
      html.push("<hr />");
      i++;
      continue;
    }

    // --- ATX headings: #, ##, ###, #### ---
    var heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      var level = heading[1].length;
      html.push("<h" + level + ">" + renderInline(heading[2].trim()) + "</h" + level + ">");
      i++;
      continue;
    }

    // --- Pipe table: header row + divider + body rows ---
    if (line.indexOf("|") !== -1 && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      var headers = splitTableRow(line);
      i += 2; // consume header + divider
      var rows = [];
      while (i < lines.length && lines[i].indexOf("|") !== -1 && lines[i].trim() !== "") {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      var table = ["<table><thead><tr>"];
      headers.forEach(function (cell) {
        table.push("<th>" + renderInline(cell) + "</th>");
      });
      table.push("</tr></thead><tbody>");
      rows.forEach(function (row) {
        table.push("<tr>");
        row.forEach(function (cell) {
          table.push("<td>" + renderInline(cell) + "</td>");
        });
        table.push("</tr>");
      });
      table.push("</tbody></table>");
      html.push(table.join(""));
      continue;
    }

    // --- Blockquote: one or more consecutive ">" lines ---
    // IMPORTANT: the source is HTML-escaped BEFORE this walker runs, so a
    // ">" marker has already become "&gt;". The blockquote branch therefore
    // matches the ESCAPED marker -- matching a literal ">" (as the original
    // code did) never fired, so every quote silently fell through to a
    // paragraph that showed a raw ">" character. That was the reported
    // "'>' formatting is broken" bug.
    // Having detected the block, strip the "&gt;" marker (plus one optional
    // space) from each line, then group the remaining lines into paragraphs:
    // a blank quoted line starts a new paragraph, and consecutive non-blank
    // lines keep their line breaks via <br /> (so a multi-line quote like the
    // Contact page's mailing address is no longer collapsed into one line).
    if (/^\s*&gt;/.test(line)) {
      var quoteLines = [];
      while (i < lines.length && /^\s*&gt;/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*&gt;\s?/, ""));
        i++;
      }

      var quoteHtml = [];
      var quotePara = [];
      var flushQuotePara = function () {
        if (quotePara.length) {
          quoteHtml.push("<p>" + renderInline(quotePara.join("<br />")) + "</p>");
          quotePara = [];
        }
      };
      quoteLines.forEach(function (quoteLine) {
        if (quoteLine.trim() === "") { flushQuotePara(); }
        else { quotePara.push(quoteLine); }
      });
      flushQuotePara();

      html.push("<blockquote>" + quoteHtml.join("") + "</blockquote>");
      continue;
    }

    // --- Unordered list: -, *, or + markers ---
    if (/^\s*[-*+]\s+/.test(line)) {
      var uItems = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        uItems.push("<li>" + renderInline(lines[i].replace(/^\s*[-*+]\s+/, "")) + "</li>");
        i++;
      }
      html.push("<ul>" + uItems.join("") + "</ul>");
      continue;
    }

    // --- Ordered list: "1. ", "2. " ... ---
    if (/^\s*\d+\.\s+/.test(line)) {
      var oItems = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        oItems.push("<li>" + renderInline(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>");
        i++;
      }
      html.push("<ol>" + oItems.join("") + "</ol>");
      continue;
    }

    // --- Paragraph: gather consecutive non-blank, non-special lines ---
    // The blockquote guard matches the ESCAPED marker "&gt;" (see the
    // blockquote block above for why), and a ":::" guard stops a paragraph
    // that runs straight into a split directive.
    var para = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*&gt;/.test(lines[i]) &&
      !/^\s*:::/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^(\s*)(---+|\*\*\*+|___+)\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) {
      html.push("<p>" + renderInline(para.join(" ")) + "</p>");
    } else {
      // GUARANTEED FORWARD PROGRESS -- do not remove.
      // We reach here only when the current line matched NONE of the block
      // branches above yet ALSO tripped one of the paragraph-gather guards,
      // so nothing was consumed. In practice that means a "::: ..." line that
      // isn't a valid opener (::: split [flip], ::: accordion Title, ::: logos,
      // ::: gallery), e.g. a bare ":::", "::::", "::: something-else", or a
      // stray closer left by an editor. Without this else the outer
      // `while (i < lines.length)` would re-test the SAME line forever -- an
      // infinite loop that pins the CPU and freezes the tab. Skipping the
      // stray marker line (rather than emitting it) degrades a mistyped
      // directive to "the marker just disappears", which is the least-
      // surprising outcome for the non-technical editors this syntax targets.
      // Every other branch above advances `i` unconditionally, so this is the
      // only spot that needed an explicit guard.
      i++;
    }
  }

  return html.join("\n");
}

/* =======================================================================
   SECTION 4 -- Photo gallery markup (manifest -> chips + grid + data)
   -----------------------------------------------------------------------
   Here for exactly the reason the Markdown grammar is: it is the ONE home of
   a shape two files have to agree on. build.mjs calls this to bake the static
   "All" grid into /photos/, so a visitor with no JavaScript still gets a real
   gallery; js/gallery.mjs then hydrates whatever grid it finds by looking for
   the four hooks emitted below (#photo-data, #photo-grid, .chip, data-index).
   Keeping the markup here rather than inlining it in build.mjs is what makes
   that contract readable from one place -- the hydration layer's expectations
   and the markup that satisfies them sit in files that reference each other.
   Pure text -> text like everything else in this file: no DOM, so Node can
   run it at build time.
   ======================================================================= */

/* Manifest format, one image per line:  src | album | caption
   ("#" lines are comments, blank lines ignored -- the same "edit a text file"
   idiom as nav.txt and socials.txt.) */
function parsePhotoManifest(raw) {
  var lines = raw.replace(/\r\n/g, "\n").split("\n");
  var photos = [];
  lines.forEach(function (line) {
    var trimmed = line.trim();
    // Skip blanks and "#" comment lines.
    if (trimmed === "" || trimmed.charAt(0) === "#") { return; }
    var parts = trimmed.split("|").map(function (part) { return part.trim(); });
    if (parts.length < 3) { return; } // malformed line -- skip defensively
    photos.push({ src: parts[0], album: parts[1], caption: parts[2] });
  });
  return photos;
}

/* Serialize the manifest for the inline <script type="application/json">.
   The one thing that can break out of a script element is the string "</",
   so escape every "<" as its JSON < form: JSON.parse turns it back into
   "<" on the client, but the HTML parser never sees a tag. Cheaper and more
   obviously correct than trying to spot "</script>" specifically. */
function encodePhotoData(photos) {
  return JSON.stringify(photos).replace(/</g, "\\u003c");
}

/* The gallery: filter chips, the FULL set of tiles, and the manifest as data.
   Two deliberate choices the hydration layer depends on:
     1. every photo gets a tile, and the "All" chip ships pressed, so the grid
        in the HTML is the complete gallery. Filtering is then hiding tiles
        rather than regenerating them -- no markup is ever built at runtime,
        and the no-JS view is the real gallery rather than an empty box;
     2. data-index is the photo's position in the FULL manifest, which stays
        valid no matter which filter is active. The lightbox steps through
        what is on SCREEN, so gallery.mjs translates between the two.
   Captions are escaped for display here but stay RAW in the JSON -- the
   client escapes them itself when it paints the lightbox caption, exactly as
   the runtime gallery always did. */
function renderPhotoGallery(photos) {
  // Distinct albums, in first-seen order, prefixed with "All".
  var albums = ["All"];
  photos.forEach(function (photo) {
    if (albums.indexOf(photo.album) === -1) { albums.push(photo.album); }
  });

  var chipsHtml = albums.map(function (album, idx) {
    var pressed = idx === 0 ? "true" : "false";
    return '<button class="chip" type="button" data-album="' +
      escapeHtml(album) + '" aria-pressed="' + pressed + '">' +
      escapeHtml(album) + "</button>";
  }).join("");

  var tilesHtml = photos.map(function (photo, idx) {
    // The caption doubles as alt text so screen-reader users get the same
    // description sighted users read under the thumbnail.
    return '<figure class="photo-tile" role="button" tabindex="0" ' +
      'data-index="' + idx + '" aria-label="View photo: ' + escapeHtml(photo.caption) + '">' +
      '<span class="photo-album-tag">' + escapeHtml(photo.album) + "</span>" +
      '<img src="' + escapeHtml(photo.src) + '" alt="' + escapeHtml(photo.caption) + '" loading="lazy" />' +
      "<figcaption>" + escapeHtml(photo.caption) + "</figcaption>" +
      "</figure>";
  }).join("");

  return '<div class="album-filters" role="group" aria-label="Filter photos by album">' +
    chipsHtml + "</div>" +
    '<div class="photo-grid" id="photo-grid">' + tilesHtml + "</div>" +
    '<script type="application/json" id="photo-data">' + encodePhotoData(photos) + "<\/script>";
}

/* One export list at the bottom rather than "export function" on each
   declaration: it keeps the code above a byte-for-byte move out of app.js
   (modulo indentation), so this extraction stays auditable as a pure
   refactor. renderBlocks stays private -- renderMarkdown is the entry point
   that guarantees the source is escaped exactly once before walking it.
   encodePhotoData is private too: it only makes sense as part of the gallery
   markup renderPhotoGallery emits. */
export {
  escapeHtml,
  stripUrlNoise,
  safeUrl,
  parseFrontMatter,
  renderInline,
  isTableDivider,
  splitTableRow,
  renderMarkdown,
  parsePhotoManifest,
  renderPhotoGallery
};
