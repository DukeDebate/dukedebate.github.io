/* =========================================================================
   Duke Debate -- static site builder
   -------------------------------------------------------------------------
   Turns content/*.md into a real HTML file per page:

       content/home.md   ->  dist/index.html          (served at  /     )
       content/about.md  ->  dist/about/index.html     (served at  /about/)

   ZERO DEPENDENCIES on purpose -- Node builtins only, so CI never runs
   `npm install` and there is no lockfile to rot. The Markdown grammar is
   imported from js/render.mjs, the SAME module the browser uses, so build
   output and browser output can never drift apart. Branding and colors
   come from content/site.yaml.

   Run it with:  node build.mjs
   ========================================================================= */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
  escapeHtml,
  parseFrontMatter,
  renderMarkdown,
  safeUrl
} from "./js/render.mjs";

/* Resolve every path against THIS file rather than process.cwd(), so
   `node build.mjs` behaves the same from the repo root, from a CI checkout,
   or from any other working directory. */
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.join(ROOT, "content");
const DIST_DIR = path.join(ROOT, "dist");

/* Directories copied verbatim into the output. These are the only runtime
   assets the prerendered pages reference. */
const COPY_DIRS = ["css", "js", "assets"];

const HOME_SLUG = "home";
const SITE_CONFIG_PATH = path.join(CONTENT_DIR, "site.yaml");

/* Loaded once in main() and read by the shell / page builders. Defaults keep
   a build working if site.yaml is missing; real branding comes from that file. */
let site = {
  name: "Site",
  short_name: "Site",
  brand_name: "Site",
  brand_sub: "",
  description: "",
  footer_note: "",
  colors: { dark: {}, light: {} }
};

/* Counted and reported at the end. A build that warns still exits 0 -- every
   warning here describes a recoverable authoring slip (a nav line pointing at
   a page that doesn't exist yet), not a broken build. */
let warnings = 0;

function warn(message) {
  warnings++;
  console.warn("[build] WARNING: " + message);
}

/* =========================================================================
   Site config -- content/site.yaml (branding + theme colors)
   -------------------------------------------------------------------------
   Tiny YAML subset: "key: value", "#" comments, and one level of nesting
   under "colors:" -> "dark:" / "light:" -> color keys. No arrays, no anchors,
   no multi-line scalars -- keep site.yaml boring on purpose so editors never
   need a YAML textbook and we never need a parser package.
   ========================================================================= */

function stripYamlQuotes(value) {
  const trimmed = value.trim();
  if (
    (trimmed.charAt(0) === '"' && trimmed.charAt(trimmed.length - 1) === '"') ||
    (trimmed.charAt(0) === "'" && trimmed.charAt(trimmed.length - 1) === "'")
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseSiteYaml(raw) {
  const data = { colors: { dark: {}, light: {} } };
  let section = null; // null | "colors"
  let theme = null;   // null | "dark" | "light"

  raw.replace(/\r\n/g, "\n").split("\n").forEach((line) => {
    if (!line.trim() || line.trim().charAt(0) === "#") { return; }

    const indent = line.match(/^[ \t]*/)[0].length;
    const content = line.trim();
    const colon = content.indexOf(":");
    if (colon === -1) { return; }

    const key = content.slice(0, colon).trim();
    const value = content.slice(colon + 1).trim();

    if (indent === 0) {
      section = null;
      theme = null;
      if (key === "colors" && value === "") {
        section = "colors";
        return;
      }
      if (value !== "") {
        data[key] = stripYamlQuotes(value);
      }
      return;
    }

    if (section === "colors" && indent > 0 && indent <= 2 && value === "") {
      if (key === "dark" || key === "light") {
        theme = key;
      }
      return;
    }

    if (section === "colors" && theme && indent >= 2 && value !== "") {
      data.colors[theme][key] = stripYamlQuotes(value);
    }
  });

  return data;
}

function loadSiteConfig() {
  if (!fs.existsSync(SITE_CONFIG_PATH)) {
    warn("content/site.yaml is missing -- using built-in placeholder branding");
    return site;
  }

  const parsed = parseSiteYaml(fs.readFileSync(SITE_CONFIG_PATH, "utf8"));
  site = {
    name: parsed.name || site.name,
    short_name: parsed.short_name || parsed.name || site.short_name,
    brand_name: parsed.brand_name || parsed.short_name || parsed.name || site.brand_name,
    brand_sub: parsed.brand_sub || "",
    description: parsed.description || "",
    footer_note: parsed.footer_note || "",
    colors: {
      dark: (parsed.colors && parsed.colors.dark) || {},
      light: (parsed.colors && parsed.colors.light) || {}
    }
  };
  return site;
}

/* Emit a <style> block that overrides the palette variables in style.css.
   glow_accent / glow_secondary also populate the legacy --glow-teal /
   --glow-amber names the stylesheet already references. */
function renderThemeStyle(colors) {
  function block(selector, map) {
    const keys = Object.keys(map || {});
    if (!keys.length) { return ""; }
    const lines = [];
    keys.forEach((key) => {
      const cssName = key.replace(/_/g, "-");
      lines.push("  --color-" + cssName + ": " + map[key] + ";");
      if (key === "glow_accent") {
        lines.push("  --glow-teal: " + map[key] + ";");
      }
      if (key === "glow_secondary") {
        lines.push("  --glow-amber: " + map[key] + ";");
      }
    });
    return selector + " {\n" + lines.join("\n") + "\n}\n";
  }

  const css = block(":root", colors.dark) +
    block('html[data-theme="light"]', colors.light);
  if (!css.trim()) { return ""; }
  return "  <style id=\"site-theme\">\n" + css + "  </style>\n";
}

/* =========================================================================
   Favicon -- "D" wordmark as a real SVG file (not a data URI)
   -------------------------------------------------------------------------
   Browsers (especially Safari) cache and request /favicon.ico|/favicon.svg at
   the site root. A data-URI <link> on each page is easy to miss on navigation;
   writing dist/favicon.svg and linking /favicon.svg makes every page share
   one stable icon.
   ========================================================================= */

function faviconSvgMarkup() {
  const fill = (site.colors.light && site.colors.light.accent) || "#012169";
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">\n' +
    '  <text x="16" y="24" text-anchor="middle"\n' +
    '    font-family="Georgia, \'Palatino Linotype\', Palatino, \'Times New Roman\', serif"\n' +
    '    font-size="26" font-weight="700" fill="' + fill + '">D</text>\n' +
    "</svg>\n"
  );
}

function writeFavicon() {
  const svg = faviconSvgMarkup();
  const assetPath = path.join(ROOT, "assets", "favicon.svg");
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, svg);
  fs.writeFileSync(assertInsideDist(path.join(DIST_DIR, "favicon.svg")), svg);
  const distAsset = path.join(DIST_DIR, "assets", "favicon.svg");
  fs.mkdirSync(path.dirname(distAsset), { recursive: true });
  fs.writeFileSync(assertInsideDist(distAsset), svg);
  console.info("[build] favicon.svg  ->  dist/favicon.svg");
}

/* =========================================================================
   Gallery directories -- ::: gallery assets/photos/... expands at build time
   -------------------------------------------------------------------------
   Editors point a gallery at a folder under assets/; we inject one Markdown
   image line per file so render.mjs stays filesystem-free (it also runs in
   the browser). Only paths inside assets/ are allowed.
   ========================================================================= */

const GALLERY_IMAGE_EXT = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".JPG", ".JPEG", ".PNG", ".WEBP", ".GIF", ".SVG"
]);

function altFromFilename(filename) {
  const stem = path.basename(filename, path.extname(filename));
  return stem
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b([a-z])/g, (ch) => ch.toUpperCase());
}

function listGalleryImages(relDir) {
  const cleaned = String(relDir || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!cleaned) { return null; }

  const resolved = path.resolve(ROOT, cleaned);
  const assetsRoot = path.resolve(ROOT, "assets");
  if (resolved !== assetsRoot && !resolved.startsWith(assetsRoot + path.sep)) {
    warn("gallery path must be under assets/: '" + cleaned + "' -- leaving empty");
    return [];
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    warn("gallery directory not found: " + cleaned);
    return [];
  }

  return fs
    .readdirSync(resolved)
    .filter((name) => GALLERY_IMAGE_EXT.has(path.extname(name)))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((name) => {
      const rel = path.join(cleaned, name).split(path.sep).join("/");
      return "![" + altFromFilename(name) + "](" + rel + ")";
    });
}

/* Rewrite ::: gallery [dir] ... ::: blocks so a directory path becomes image
   lines. Explicit ![alt](src) lines in the body are kept when no dir is given. */
function expandGalleryDirectories(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const open = /^\s*:::\s*gallery(?:\s+(\S+))?\s*$/i.exec(lines[i]);
    if (!open) {
      out.push(lines[i]);
      i++;
      continue;
    }

    const dirFromOpener = open[1] || "";
    i++; // skip opener
    const body = [];
    while (i < lines.length && !/^\s*:::\s*$/.test(lines[i])) {
      body.push(lines[i]);
      i++;
    }
    if (i < lines.length) { i++; } // skip closer

    let dir = dirFromOpener;
    if (!dir) {
      const only = body.map((l) => l.trim()).filter(Boolean);
      if (only.length === 1 && !/^!\[/.test(only[0])) {
        dir = only[0];
      }
    }

    out.push("::: gallery");
    if (dir) {
      const images = listGalleryImages(dir);
      if (images && images.length) {
        console.info("[build] gallery " + dir + " -> " + images.length + " image(s)");
        images.forEach((line) => out.push(line));
      } else if (images) {
        console.info("[build] gallery " + dir + " -> 0 images (folder empty or missing)");
      }
    } else {
      body.forEach((line) => out.push(line));
    }
    out.push(":::");
  }

  return out.join("\n");
}

/* Strip EXIF/IPTC/XMP (and similar) from every image under a directory.
   Uses exiftool when available; otherwise warns and continues -- a missing
   stripper must not block the site from publishing. */
function stripImageMetadata(targetDir, label) {
  if (!fs.existsSync(targetDir)) { return; }
  try {
    execFileSync(
      "exiftool",
      ["-all=", "-overwrite_original", "-r", "-q", "-q", targetDir],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    console.info("[build] stripped image metadata in " + label);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      warn("exiftool not found -- skipping metadata strip for " + label);
    } else {
      warn("metadata strip failed for " + label + ": " + (err && err.message || err));
    }
  }
}

/* =========================================================================
   Slug safety -- the only build input that comes straight from a filename
   -------------------------------------------------------------------------
   Every other value here is either authored by us (site.yaml, the shell) or
   escaped on the way out (title, subtitle, nav label, caption, album, social
   name). A slug is the exception: it is taken VERBATIM from a filename an
   editor typed, and it is then used as both a filesystem path segment
   (outputPath) and a URL inside an href (pageUrl). Trusting it broke both:

     content/...md  ->  slug ".."  ->  dist/../index.html: a fully rendered
                        page written OUTSIDE dist/, on top of the repo's own
                        index.html. content/..md -> slug "." clobbered the
                        home page the same way. Both builds exited 0, so CI
                        would have deployed the damage without a word.
     content/ab"onmouseover=alert(1) x.md
                     -> the quote closed the href attribute and everything
                        after it became live attributes on the nav <a>.

   So a slug has to LOOK like a slug before anything is done with it:
   lowercase letters and digits, dashes allowed after the first character.
   That one rule rules out ".", "..", "/", "\", quotes, spaces, uppercase and
   every other shape either problem needed. Kept deliberately narrow -- this is
   also the naming rule the skip message quotes back to the editor, so it has
   to be short enough to state in one sentence. */
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/* Names that pass SAFE_SLUG but are already taken in the published tree: each
   COPY_DIRS entry is copied verbatim to dist/<dir>/, and the error page is
   dist/404.html. A page claiming one of those names does not overwrite the
   files, it just makes the address ambiguous -- /css/ would serve a page while
   /css/style.css kept serving the stylesheet, and /404/ would be a normal page
   sitting next to the real error page. Reserved rather than quietly remapped:
   an editor who names a file "css.md" wants a page at /css/, and should be told
   the name is taken instead of being handed a surprising URL. */
const RESERVED_SLUGS = new Set([...COPY_DIRS, "404"]);

/* Files that never became a page. Named, not just counted, so the summary can
   list them. */
const skippedFiles = [];

/* Announced far louder than warn(), because a skip is the one warning that
   means SOMETHING THE EDITOR MADE IS NOT ON THE SITE. A build that silently
   publishes nothing for a file someone just wrote is as bad as the defect
   this check replaces, so each skip gets a banner, names the offending
   filename AND the naming rule, and is repeated in the final summary so it
   survives a long scrollback. Still exits 0: one mistyped filename must not
   block the other ten pages from publishing. */
function skipFile(filename, reason) {
  skippedFiles.push(filename);
  warnings++;
  console.warn("");
  console.warn("[build] ================================================================");
  console.warn("[build] !! SKIPPED  content/" + filename);
  console.warn("[build] !! NO PAGE WAS PUBLISHED FOR THIS FILE.");
  console.warn("[build] !! " + reason);
  console.warn("[build] !! Page filenames may use only lowercase letters, digits and");
  console.warn('[build] !! dashes -- e.g. "spring-open-house.md". Rename the file and');
  console.warn("[build] !! run the build again.");
  console.warn("[build] ================================================================");
  console.warn("");
}

/* True only for a slug that is safe to put in a path AND in an href. */
function isSafeSlug(slug) {
  if (!SAFE_SLUG.test(slug)) {
    skipFile(slug + ".md", 'The page name "' + slug + '" is not a usable page name.');
    return false;
  }

  if (RESERVED_SLUGS.has(slug)) {
    skipFile(slug + ".md", 'The name "' + slug + '" is reserved -- the site already ' +
      "publishes something of its own at that address.");
    return false;
  }

  return true;
}

/* =========================================================================
   Page discovery -- the content folder IS the page list
   -------------------------------------------------------------------------
   There is no hardcoded array of routes to keep in sync: dropping one .md
   file into content/ publishes a page. nav.txt controls only the ORDER of
   the nav links (see readNavOrder).
   ========================================================================= */

function discoverPages() {
  return fs
    .readdirSync(CONTENT_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -".md".length))
    /* The slug gate lives HERE, at the single point where a filename becomes
       a slug, so nothing downstream ever holds an unvetted one -- not the nav
       model, not an href, not an output path. See SAFE_SLUG. */
    .filter((slug) => isSafeSlug(slug))
    .sort(); // alphabetical baseline; nav.txt imposes display order below
}

/* Read one entry (optionally "target | Custom Label") per line, "#" comments
   allowed -- the same manifest idiom as socials.txt.
   The first field is either an internal page slug OR a full http(s) URL:
       about
       about | About Us
       https://example.com/resources | Team Resources
   External URLs are gated through safeUrl() so a disallowed scheme never
   becomes a live nav link. */
function readNavOrder() {
  const navPath = path.join(CONTENT_DIR, "nav.txt");

  if (!fs.existsSync(navPath)) {
    warn("content/nav.txt is missing -- falling back to alphabetical nav order");
    return [];
  }

  return fs
    .readFileSync(navPath, "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line.charAt(0) !== "#")
    .map((line) => {
      const pipe = line.indexOf("|");
      const target = (pipe === -1 ? line : line.slice(0, pipe)).trim();
      const customLabel = pipe === -1 ? "" : line.slice(pipe + 1).trim();

      if (/^https?:\/\//i.test(target)) {
        const safe = safeUrl(target);
        if (!safe) {
          warn(
            "content/nav.txt lists a disallowed external URL -- skipping that nav link"
          );
          return null;
        }
        if (!customLabel) {
          warn(
            "content/nav.txt external link is missing a label after '|' -- skipping " +
            safe
          );
          return null;
        }
        return { external: true, url: safe, label: customLabel };
      }

      return {
        external: false,
        slug: target,
        label: customLabel || defaultLabel(target)
      };
    })
    .filter((entry) => entry && (entry.external || Boolean(entry.slug)));
}

// "about" -> "About". Reproduces the hand-written labels the SPA nav used.
function defaultLabel(slug) {
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/* Merge the discovered pages with the requested order. The rules exist so
   that "drop in a file" always publishes something reachable:
     - listed in nav.txt AND has a .md  -> nav link in that exact position;
     - listed as an http(s) URL         -> external nav link in that position
                                          (no .md required; never marked active);
     - has a .md but NOT listed        -> built anyway, link appended at the
                                          end (alphabetically), with a note;
     - listed but has no .md           -> skipped with a warning
                                          (unless it is an external URL). */
function buildNavModel(pages, navOrder) {
  const known = new Set(pages);
  const nav = [];
  const placed = new Set();
  const placedExternal = new Set();

  for (const entry of navOrder) {
    if (entry.external) {
      if (placedExternal.has(entry.url)) {
        warn(
          "content/nav.txt lists '" + entry.url +
          "' more than once -- ignoring the repeat"
        );
        continue;
      }
      nav.push(entry);
      placedExternal.add(entry.url);
      continue;
    }

    if (!known.has(entry.slug)) {
      warn(
        "content/nav.txt lists '" + entry.slug +
        "' but there is no content/" + entry.slug + ".md -- skipping that nav link"
      );
      continue;
    }
    if (placed.has(entry.slug)) {
      warn("content/nav.txt lists '" + entry.slug + "' more than once -- ignoring the repeat");
      continue;
    }
    nav.push(entry);
    placed.add(entry.slug);
  }

  const unlisted = pages.filter((slug) => !placed.has(slug));
  for (const slug of unlisted) {
    console.info(
      "[build] content/" + slug + ".md is not listed in content/nav.txt -- " +
      "publishing it at " + pageUrl(slug) + " with its nav link appended at the end"
    );
    nav.push({ external: false, slug, label: defaultLabel(slug) });
  }

  return nav;
}

/* =========================================================================
   URL + path shape -- clean directory URLs
   -------------------------------------------------------------------------
   Home lives at the site root; every other page gets its own directory so
   the shareable URL is /about/ rather than /about.html.
   ========================================================================= */

function pageUrl(slug) {
  return slug === HOME_SLUG ? "/" : "/" + slug + "/";
}

/* The same URL, escaped for use INSIDE an href attribute -- which is the only
   way it may ever reach the output. A page URL carries a slug, and a slug used
   to be interpolated raw: content/ab"onmouseover=alert(1) x.md closed the
   attribute with its own quote and turned the rest of the filename into live
   event-handler markup on the nav link, right next to a LABEL that was being
   escaped correctly. isSafeSlug() now rejects that filename outright, but the
   escaping is what makes the emission safe on its own terms, independent of
   which slugs happen to get through -- so hrefs call this and only logging and
   comparisons call pageUrl() directly. */
function pageHref(slug) {
  return escapeHtml(pageUrl(slug));
}

function outputPath(slug) {
  return assertInsideDist(
    slug === HOME_SLUG
      ? path.join(DIST_DIR, "index.html")
      : path.join(DIST_DIR, slug, "index.html")
  );
}

/* THE BACKSTOP, and the reason it is not redundant with isSafeSlug().
   isSafeSlug() is the thing that currently makes a traversal impossible, but
   it is one regex in one filter, several calls away from the writes -- loosen it
   to allow (say) a "docs/guide" nested slug, or add a second place that derives
   a slug and forgets the gate, and dist/../index.html is reachable again with
   no test necessarily noticing, because the build would still exit 0.

   This check sits at the LAST moment before a write instead, where the only
   thing that matters is the final resolved path, and it FAILS THE BUILD rather
   than warning: a write outside the output directory is never a recoverable
   authoring slip, it is the build touching files it does not own.

   path.resolve first, because "dist/../index.html" only reveals itself as
   outside dist/ once ".." and "." are folded out; the trailing separator on
   the prefix stops a sibling directory named "dist-backup" from passing a
   bare startsWith.

   LIMIT OF THIS CHECK, stated precisely so nobody trusts it further than it
   goes: path.resolve does PURELY LEXICAL normalization. It does not read the
   filesystem, so it does not resolve symlinks. If dist/ were itself replaced
   by a symlink pointing somewhere else, every resolved path would still be
   prefixed by dist/ and this check would pass while the writes followed the
   link out. That is not reachable from the threat this file defends against --
   an editor controls filenames (already gated to [a-z0-9-] by isSafeSlug) and
   never DIST_DIR, which is a fixed constant above -- so this is deliberately
   not hardened. If DIST_DIR ever becomes configurable (a --out flag, an env
   var), that assumption dies and this needs fs.realpathSync on the parent. */
function assertInsideDist(destination) {
  const resolved = path.resolve(destination);
  const distRoot = path.resolve(DIST_DIR);

  if (resolved !== distRoot && !resolved.startsWith(distRoot + path.sep)) {
    console.error(
      "[build] ERROR: refusing to write outside the output directory:\n" +
      "[build]   wanted: " + resolved + "\n" +
      "[build]   dist:   " + distRoot + "\n" +
      "[build] This is a bug in build.mjs, not in your content -- the page name " +
      "check that should have caught it has been bypassed."
    );
    process.exit(1);
  }

  return resolved;
}

/* THE TRAILING-SLASH LANDMINE, defused.
   Under /about/ a RELATIVE reference resolves BELOW that directory:
   "assets/photos/x.svg" becomes /about/assets/photos/x.svg -- a 404 that only
   shows up on subpages, never on the home page, which is exactly what makes
   it so easy to ship. Every reference that survives into the output therefore
   has to be absolute. The shell is authored with /css and /js directly; this
   pass fixes the asset paths that come out of CONTENT, where editors sensibly
   write the repo-relative "assets/..." the old SPA needed.
   Anchored on the quote so it can only ever match the START of an attribute
   value -- "/assets/" and "https://x/assets/" are both left alone. */
function rootifyAssets(html) {
  return html
    .replace(/src="assets\//g, 'src="/assets/')
    .replace(/href="assets\//g, 'href="/assets/');
}

/* Path-level twin of rootifyAssets(), for asset references that travel as
   DATA rather than as an HTML attribute -- the inlined photo manifest. Same
   rule and same reason as above; only a leading "assets/" is touched, so an
   already-absolute "/assets/..." or an off-site "https://.../assets/..." is left
   exactly as the editor wrote it. */
function rootifyAssetPath(src) {
  return src.indexOf("assets/") === 0 ? "/" + src : src;
}

/* =========================================================================
   Internal link translation -- editors keep typing "#/join"
   -------------------------------------------------------------------------
   The hash form stays THE authoring syntax (it is what README teaches and
   what ~30 links across content/*.md already use); this pass is the only
   place that knows the published URL shape. Two payoffs: content files need
   no churn now, and if the URL scheme ever changes again only this function
   moves. Do NOT "fix" the "#/" links in content/ -- they are correct.

   Both link forms the renderer emits arrive here as the same attribute:
   Markdown "[Join](#/join)" and the "[[button: ... -> #/join]]" CTA both go
   through safeUrl(), which returns a "#"-prefixed URL untouched. So matching
   href="#/..." covers both, and it CANNOT touch the skip link's href="#app"
   (no slash) or any other in-page fragment.
   ========================================================================= */
function rewriteLinks(html, sourceSlug, knownSlugs) {
  return html.replace(/href="#\/([^"]*)"/g, function (match, target) {
    /* Normalize exactly the way the old router's currentPage() did -- first
       path segment, lowercased, trailing "/?#" noise dropped, an empty target
       ("#/") meaning home -- so a link that resolved to a page in the SPA
       resolves to the SAME page here. */
    const slug = target.split(/[\/?#]/)[0].trim().toLowerCase() || HOME_SLUG;

    if (!knownSlugs.has(slug)) {
      /* An unknown target is an authoring typo, not a broken build, so we
         warn and LEAVE THE LINK ALONE. Untranslated it is still a bare
         fragment, i.e. a dead in-page anchor: clicking it does nothing
         visible and stays on the page. The alternatives are worse -- failing
         the build blocks every other page over one typo, and silently
         downgrading the link to plain text hides the mistake from the person
         who has to fix it. The warning names the file so it is findable. */
      warn(
        "content/" + sourceSlug + ".md links to '#/" + target + "' but there is no " +
        "content/" + slug + ".md -- leaving it as a dead in-page anchor"
      );
      return match;
    }

    // Escaped, like every other attribute value the build emits -- see pageHref.
    return 'href="' + pageHref(slug) + '"';
  });
}

/* =========================================================================
   Footer social links -- rendered ONCE per page at build time
   -------------------------------------------------------------------------
   Same manifest and same output as the old runtime fetch of socials.txt, so
   the footer is identical; it just no longer costs every visitor a request.
   THE ONLY copy: js/app.js's runtime version went away with the router, so
   nothing here can drift out of sync with a second implementation.
   ========================================================================= */

// Inline SVG icon paths (24x24 viewBox), keyed by lowercased network name.
// currentColor makes them inherit the link color, so they theme for free.
const SOCIAL_ICONS = {
  email: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 6 10 7L22 6"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/></svg>',
  youtube: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9.5v5l4-2.5z" fill="currentColor" stroke="none"/></svg>',
  github: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.85 9.73.5.1.68-.22.68-.49 0-.24-.01-.87-.01-1.71-2.78.62-3.37-1.37-3.37-1.37-.46-1.18-1.11-1.5-1.11-1.5-.91-.63.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.36 9.36 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.81 0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 --.52 2 12 2z"/></svg>',
  linkedin: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M4.98 3.5A2.5 2.5 0 1 1 5 8.5a2.5 2.5 0 0 1-.02-5zM3 9h4v12H3zM10 9h3.8v1.7h.05c.53-1 1.83-2.05 3.76-2.05C21.4 8.65 22 10.9 22 14v7h-4v-6.2c0-1.48-.03-3.38-2.06-3.38-2.06 0-2.38 1.61-2.38 3.27V21h-4z"/></svg>'
};

function parseSocialsManifest(raw) {
  return raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line.charAt(0) !== "#") // blank/comment
    .map((line) => {
      const parts = line.split("|").map((part) => part.trim());
      return { name: parts[0], url: parts[1] };
    })
    .filter((social) => Boolean(social.name) && Boolean(social.url)); // malformed -- skip
}

function renderFooterSocials(socials) {
  if (!socials.length) { return ""; } // degrade to no row

  const linksHtml = socials.map((social) => {
    // Gate the URL through the SAME allowlist the renderer uses. Social links
    // are raw (not pre-escaped), so safeUrl sees the real value; a disallowed
    // scheme returns null and we DROP that link entirely (an icon with no
    // working destination would just mislead). Escape only after it passes.
    const safe = safeUrl(social.url);
    if (!safe) {
      warn("socials: skipped '" + social.name + "': disallowed URL");
      return "";
    }
    const icon = SOCIAL_ICONS[social.name.toLowerCase()] ||
      ('<span class="social-fallback">' + escapeHtml(social.name) + "</span>");
    // mailto: links (or a bare email) should not open a new tab; http(s) do.
    const attrs = /^https?:\/\//i.test(safe)
      ? ' target="_blank" rel="noopener noreferrer"'
      : "";
    return '<a class="social-link" href="' + escapeHtml(safe) + '"' + attrs +
      ' aria-label="' + escapeHtml(social.name) + '" title="' + escapeHtml(social.name) + '">' +
      icon + "</a>";
  }).join("");

  // If every entry was filtered out (all URLs disallowed), emit no row.
  if (linksHtml === "") { return ""; }

  return '<nav class="footer-socials" aria-label="Social links">' + linksHtml + "</nav>";
}

function loadFooterSocials() {
  const socialsPath = path.join(CONTENT_DIR, "socials.txt");
  if (!fs.existsSync(socialsPath)) {
    // Missing manifest is fine -- the footer just has no socials row.
    console.info("[build] no content/socials.txt -- footer will have no socials row");
    return "";
  }
  return renderFooterSocials(parseSocialsManifest(fs.readFileSync(socialsPath, "utf8")));
}

/* =========================================================================
   The HTML shell -- one template, every page
   -------------------------------------------------------------------------
   Lifted from index.html so the prerendered pages are the same document the
   SPA produced, with three differences that matter:
     1. /css and /js are ROOT-relative (see rootifyAssets for why);
     2. the nav links are real page URLs, and the active one is baked in
        with aria-current="page" -- no JS needed to highlight it;
     3. #app already contains the finished page, so there is no "Loading...".
   ========================================================================= */

function renderNav(nav, activeSlug) {
  const items = nav.map((entry) => {
    if (entry.external) {
      // External links never get aria-current / .active -- they are not pages
      // on this site. Open in a new tab with the usual opener protection.
      // The ^ marker is decorative (aria-hidden); the link text itself is
      // the accessible name.
      return '<li><a href="' + escapeHtml(entry.url) +
        '" target="_blank" rel="noopener noreferrer">' +
        escapeHtml(entry.label) +
        '<span class="nav-external" aria-hidden="true">^</span></a></li>';
    }

    const isActive = entry.slug === activeSlug;
    // Active state is baked at BUILD time; setActiveNav() used to do this on
    // every route change. aria-current marks it for assistive tech.
    const attrs = isActive ? ' class="active" aria-current="page"' : "";
    // BOTH halves escaped: the label always was, the href is no longer the
    // one interpolation in this file that wasn't (see pageHref).
    return '<li><a href="' + pageHref(entry.slug) + '"' + attrs + ">" +
      escapeHtml(entry.label) + "</a></li>";
  }).join("\n          ");

  return '<nav class="primary-nav" id="primary-nav" aria-label="Primary">\n' +
    "        <ul>\n          " + items + "\n        </ul>\n      </nav>";
}

function renderShell({ title, description, nav, activeSlug, socialsHtml, main, scripts }) {
  const siteName = escapeHtml(site.name);
  const brandName = escapeHtml(site.brand_name);
  const pageTitle = activeSlug === HOME_SLUG
    ? siteName
    : escapeHtml(title) + " - " + siteName;
  const themeStyle = renderThemeStyle(site.colors);
  const footerNote = escapeHtml(site.footer_note || "");
  /* Favicon: file at /favicon.svg for shared probes, plus an inline data-URI
     so each HTML document carries the current "D" icon. Browsers often cache
     favicons per page URL; after the old robotics mark, subpages kept the
     stale icon even when the <link> pointed at the new file. */
  const faviconDataHref =
    "data:image/svg+xml," + encodeURIComponent(faviconSvgMarkup().trim());

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${pageTitle}</title>
  <meta name="description" content="${escapeHtml(description)}" />

  <!-- THEME BOOTSTRAP -- must run BEFORE the stylesheet paints so the correct
       palette is applied on the very first frame (no flash of the wrong theme).
       Priority: an explicit saved choice in localStorage, otherwise the OS
       preference via prefers-color-scheme. Kept tiny and inline on purpose.
       Inlined into EVERY page: a real page load happens on every navigation
       now, so each one has its own first frame to get right. -->
  <script>
    (function () {
      try {
        var saved = localStorage.getItem("theme");
        var prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
        var theme = (saved === "light" || saved === "dark")
          ? saved
          : (prefersLight ? "light" : "dark");
        document.documentElement.setAttribute("data-theme", theme);
      } catch (err) {
        // localStorage/matchMedia unavailable -- fall back to the dark default.
        document.documentElement.setAttribute("data-theme", "dark");
      }
    })();
  </script>

  <!-- ROOT-relative on purpose: "css/style.css" would resolve to
       /about/css/style.css from a subpage and 404. See rootifyAssets(). -->
  <link rel="preload" href="/assets/fonts/eb-garamond-400-normal.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="stylesheet" href="/css/fonts.css" />
  <link rel="stylesheet" href="/css/style.css" />
${themeStyle}  <!-- Favicon: inline first (busts per-page cache), then site-root file. -->
  <link rel="icon" href="${faviconDataHref}" type="image/svg+xml" />
  <link rel="icon" href="/favicon.svg?v=2" type="image/svg+xml" />
</head>
<body>
  <!-- Skip link for keyboard/screen-reader users to jump past the nav.
       Stays a bare fragment: it targets THIS page's <main>, which is exactly
       why <base href="/"> was rejected -- it would have turned this into a
       jump back to the home page from every subpage. -->
  <a class="skip-link" href="#app">Skip to main content</a>

  <header class="site-header">
    <div class="header-inner">
      <a class="brand" href="/" aria-label="${siteName} home">
        <span class="brand-name">${brandName}</span>
      </a>

      <!-- Header controls, pinned to the right. Holds the theme toggle AND the
           hamburger above the nav breakpoint; below it, app.js moves the theme
           toggle into the slide-down menu, leaving just the hamburger here. -->
      <div class="header-controls">
        <!-- Theme toggle. ONE button, relocated by JS: it lives here (icon-only)
             above the nav breakpoint, and moves INTO the slide-down menu (icon +
             text label) below it. Both icons ship inline; CSS shows the relevant
             one per theme. The aria-label/aria-pressed here are a THEME-NEUTRAL
             pre-JS fallback (true in either theme); app.js sets the precise
             action label + aria-pressed as soon as it runs, so the markup is
             never stale regardless of which theme the bootstrap applied. -->
        <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Switch color theme">
          <svg class="icon-sun" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="5" fill="currentColor"/>
            <g stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="12" y1="1" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="23"/>
              <line x1="1" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="23" y2="12"/>
              <line x1="4.2" y1="4.2" x2="6.3" y2="6.3"/><line x1="17.7" y1="17.7" x2="19.8" y2="19.8"/>
              <line x1="4.2" y1="19.8" x2="6.3" y2="17.7"/><line x1="17.7" y1="6.3" x2="19.8" y2="4.2"/>
            </g>
          </svg>
          <svg class="icon-moon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" fill="currentColor"/>
          </svg>
          <!-- Visible only when the button sits in the menu; JS keeps the text in
               sync with the theme. aria-hidden so it never double-announces on
               top of the button's aria-label. -->
          <span class="theme-toggle-label" aria-hidden="true"></span>
        </button>

        <!-- Hamburger toggle. Visible below the inline-nav breakpoint. JS flips aria-expanded. -->
        <button class="nav-toggle" id="nav-toggle" aria-expanded="false" aria-controls="primary-nav" aria-label="Toggle navigation menu">
          <span class="nav-toggle-bar" aria-hidden="true"></span>
          <span class="nav-toggle-bar" aria-hidden="true"></span>
          <span class="nav-toggle-bar" aria-hidden="true"></span>
        </button>
      </div>

      ${renderNav(nav, activeSlug)}
    </div>
  </header>

  <!-- Backdrop scrim for the open hamburger menu. Present in the markup (rather
       than created on first open) so CSS can cross-fade it in BOTH directions;
       it is display:none above the nav breakpoint and fully transparent +
       visibility:hidden until app.js mirrors the nav's .open class onto it.
       Purely decorative: aria-hidden keeps it out of the a11y tree, and it is a
       <div> (not a button) so it never enters the tab order -- Escape is the
       keyboard equivalent of clicking it, and the hamburger itself is the
       focusable control that owns the menu's state. -->
  <div class="nav-scrim" id="nav-scrim" aria-hidden="true"></div>

  <!-- The page, already rendered. No router, no fetch, no "Loading..." -- the
       content below is in the HTML as it comes off the wire. -->
  <main id="app" tabindex="-1">
${main}
  </main>

  <footer class="site-footer">
    <div class="footer-inner">
      ${socialsHtml}
      <p class="footer-brand">${siteName}</p>
      <p class="footer-note">
        ${footerNote}
      </p>
    </div>
  </footer>

  <!-- The enhancement layer: theme toggle + hamburger nav, on every page.
       A CLASSIC <script src> (no type="module") at the end of <body>, which is
       what index.html always used -- so it executes during parse, with the whole
       document above it already available, and needs no boot handshake.
       Safe to load on prerendered markup precisely because app.js no longer
       WRITES any: the router that used to rewrite the URL to "#/home" and
       replace #app with content it fetched itself is gone, which is what let
       this tag come back. It only reaches js/gallery.mjs (via a dynamic
       import(), the one loader a classic script has) to ask whether the
       lightbox is open, and only on a page that has a grid. -->
  <script src="/js/app.js"></script>
${scripts}
</body>
</html>
`;
}

/* =========================================================================
   The 404 page -- ONE file at the publish root, and it needs no JavaScript
   -------------------------------------------------------------------------
   GitHub Pages answers ANY unknown path with /404.html, at any depth, without
   redirecting: a request for /nope/deep/ gets this file's bytes back while the
   address bar still reads /nope/deep/. That is precisely why every reference
   in it must be absolute -- a relative "css/style.css" would be resolved
   against /nope/deep/ and 404 in turn, leaving the visitor on an unstyled
   page. The shell already authors /css and /js root-relative, so reusing it IS
   the fix; there is nothing depth-specific left to do here.

   Unlike renderNotFound() in the old SPA, this page cannot name the address
   that was missed -- there is no router, and reading location would mean
   requiring JavaScript for a detail that helps nobody. The copy is therefore
   address-free and offers a REAL link to the home page instead of a "#/home"
   route that no longer exists.
   ========================================================================= */

function build404(nav, socialsHtml) {
  const main =
    '<section class="page-error" role="alert">' +
    "<h1>Page not found</h1>" +
    "<p>There's no page at that address.</p>" +
    '<p>Try the <a href="/">home page</a>, or pick a section from the ' +
    "navigation above.</p>" +
    "</section>";

  const html = renderShell({
    title: "Page not found",
    description: "That page could not be found on the " + site.name + " site.",
    nav,
    /* No page is active here, so nothing in the nav should look current. ""
       can never equal a real slug, so renderNav() marks no link. */
    activeSlug: "",
    socialsHtml,
    main,
    scripts: ""
  });

  /* Routed through the same containment check as the pages even though this
     path has no slug in it, so that "every write in this file is checked" is
     true by inspection rather than by remembering which paths are constant. */
  const destination = assertInsideDist(path.join(DIST_DIR, "404.html"));
  fs.writeFileSync(destination, html);

  return path.relative(ROOT, destination);
}

/* =========================================================================
   Per-page render
   ========================================================================= */

function buildPage(slug, nav, socialsHtml, knownSlugs) {
  const raw = fs.readFileSync(path.join(CONTENT_DIR, slug + ".md"), "utf8");
  const parsed = parseFrontMatter(raw);
  const title = parsed.data.title || defaultLabel(slug);
  const subtitle = parsed.data.subtitle || "";

  const hero =
    '<header class="page-hero">' +
    '<p class="eyebrow">' + escapeHtml(site.name) + "</p>" +
    "<h1>" + escapeHtml(title) + "</h1>" +
    (subtitle ? '<p class="subtitle">' + escapeHtml(subtitle) + "</p>" : "") +
    "</header>";

  /* Galleries: ::: gallery assets/photos/... is expanded to image lines here so
     render.mjs stays filesystem-free (it also runs in the browser). app.js
     dynamic-imports gallery.mjs when it finds .content-gallery. */
  const markdown = expandGalleryDirectories(parsed.body);
  const body = '<div class="page-content">' + renderMarkdown(markdown) + "</div>";

  const html = renderShell({
    title,
    description: subtitle || site.description || site.name,
    nav,
    activeSlug: slug,
    socialsHtml,
    main: rewriteLinks(rootifyAssets(hero + "\n" + body), slug, knownSlugs),
    scripts: ""
  });

  const destination = outputPath(slug);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, html);

  return path.relative(ROOT, destination);
}

/* =========================================================================
   Main
   ========================================================================= */

function main() {
  // Start from a clean tree so a deleted page can never linger in the output.
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  loadSiteConfig();
  console.info("[build] site: " + site.name);

  /* Strip EXIF/etc. from source assets first so copies (and the repo itself)
     stay clean; strip dist again after copy in case anything slipped through. */
  stripImageMetadata(path.join(ROOT, "assets"), "assets/");

  const pages = discoverPages();
  if (pages.length === 0) {
    /* Distinguish "there is nothing here" from "everything here was rejected",
       because the fix is completely different: add a file, versus rename the
       files you already have. */
    console.error(
      skippedFiles.length
        ? "[build] ERROR: every .md file in content/ was skipped for an unusable " +
          "page name -- nothing to build. Rename them using only lowercase " +
          "letters, digits and dashes."
        : "[build] ERROR: no .md files found in content/ -- nothing to build"
    );
    process.exit(1);
  }

  const nav = buildNavModel(pages, readNavOrder());
  const socialsHtml = loadFooterSocials();

  /* The link translator validates against the pages that actually EXIST, not
     against the nav -- an unlisted page is still published and still a legal
     link target. */
  const knownSlugs = new Set(pages);

  console.info(
    "[build] " + pages.length + " page(s) discovered in content/; " +
    "nav order: " + nav.map((entry) =>
      entry.external ? ("^ " + entry.label) : entry.slug
    ).join(" > ")
  );

  for (const entry of nav) {
    // External nav entries are links only -- there is no page to build.
    if (entry.external) {
      console.info("[build] external nav: " + entry.label + " -> " + entry.url);
      continue;
    }
    console.info(
      "[build] " + pageUrl(entry.slug) + "  ->  " +
      buildPage(entry.slug, nav, socialsHtml, knownSlugs)
    );
  }

  // Not a page in the nav (nothing links to it) -- the host serves it for us.
  console.info("[build] /404.html (unknown paths)  ->  " + build404(nav, socialsHtml));

  for (const dir of COPY_DIRS) {
    const source = path.join(ROOT, dir);
    if (!fs.existsSync(source)) {
      warn("no " + dir + "/ directory to copy");
      continue;
    }
    fs.cpSync(source, assertInsideDist(path.join(DIST_DIR, dir)), { recursive: true });
    console.info("[build] copied " + dir + "/");
  }

  stripImageMetadata(path.join(DIST_DIR, "assets"), "dist/assets/");
  writeFavicon();

  const pageCount = nav.filter((entry) => !entry.external).length;
  console.info(
    "[build] done -- " + pageCount + " page(s) written to dist/" +
    (warnings ? " with " + warnings + " warning(s)" : "")
  );

  /* Repeated at the very end because the banner above scrolls away behind ten
     pages of build output, and this is the line an editor is looking at when
     they wonder where their new page went. */
  if (skippedFiles.length) {
    console.warn(
      "[build] !! " + skippedFiles.length + " file(s) in content/ were SKIPPED and are " +
      "NOT on the site: " + skippedFiles.map((name) => "content/" + name).join(", ") +
      " -- rename them using only lowercase letters, digits and dashes."
    );
  }
}

main();
