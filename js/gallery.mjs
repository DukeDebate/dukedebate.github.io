/* =========================================================================
   Photo gallery behavior (lightbox for ::: gallery grids)
   -------------------------------------------------------------------------
   Hydrates any .content-gallery blocks the Markdown renderer emitted. Each
   grid is independent: opening a photo only arrows through that gallery.
   No filter chips -- section headings in the Markdown own the grouping.

   Loaded on demand: app.js dynamic-imports this module when a gallery is
   present, and this file also self-boots when included as type="module".
   ========================================================================= */

import { escapeHtml } from "./render.mjs";

var lightboxState = {
  photos: [],
  index: 0,
  lastTrigger: null
};

/* Attach lightbox behavior to every .content-gallery already in the DOM.
   Safe on any page: with no galleries it returns immediately. */
function hydrateGallery(root) {
  var grids = root.querySelectorAll(".content-gallery");
  if (!grids.length) { return; }

  grids.forEach(function (gridEl) {
    var tiles = Array.prototype.slice.call(
      gridEl.querySelectorAll(".content-gallery-item, .photo-tile")
    );
    if (!tiles.length) { return; }

    var photos = tiles.map(function (tile) {
      var img = tile.querySelector("img");
      var caption = "";
      if (img && img.getAttribute("alt")) {
        caption = img.getAttribute("alt");
      } else {
        var fig = tile.querySelector("figcaption");
        if (fig) { caption = fig.textContent || ""; }
      }
      return {
        src: img ? img.getAttribute("src") : "",
        caption: caption,
        album: ""
      };
    });

    function openTile(tile) {
      var index = tiles.indexOf(tile);
      if (index === -1) { return; }
      lightboxState.photos = photos;
      openLightbox(index, tile);
    }

    gridEl.addEventListener("click", function (evt) {
      var tile = evt.target.closest(".content-gallery-item, .photo-tile");
      if (tile && gridEl.contains(tile)) { openTile(tile); }
    });
    gridEl.addEventListener("keydown", function (evt) {
      if (evt.key !== "Enter" && evt.key !== " ") { return; }
      var tile = evt.target.closest(".content-gallery-item, .photo-tile");
      if (tile && gridEl.contains(tile)) {
        evt.preventDefault();
        openTile(tile);
      }
    });
  });
}

var lightboxEl = null;
var lightboxImg = null;
var lightboxCaption = null;

function ensureLightbox() {
  if (lightboxEl) { return; }
  lightboxEl = document.createElement("div");
  lightboxEl.className = "lightbox";
  lightboxEl.setAttribute("role", "dialog");
  lightboxEl.setAttribute("aria-modal", "true");
  lightboxEl.setAttribute("aria-label", "Photo viewer");
  lightboxEl.hidden = true;
  lightboxEl.innerHTML =
    '<button class="lightbox-btn lightbox-close" type="button" aria-label="Close viewer">&times;</button>' +
    '<button class="lightbox-btn lightbox-prev" type="button" aria-label="Previous photo">&#8249;</button>' +
    '<button class="lightbox-btn lightbox-next" type="button" aria-label="Next photo">&#8250;</button>' +
    '<figure class="lightbox-figure">' +
    '<img alt="" />' +
    '<figcaption class="lightbox-caption"></figcaption>' +
    "</figure>";
  document.body.appendChild(lightboxEl);

  lightboxImg = lightboxEl.querySelector("img");
  lightboxCaption = lightboxEl.querySelector(".lightbox-caption");

  lightboxEl.querySelector(".lightbox-close").addEventListener("click", closeLightbox);
  lightboxEl.querySelector(".lightbox-prev").addEventListener("click", function () { step(-1); });
  lightboxEl.querySelector(".lightbox-next").addEventListener("click", function () { step(1); });

  lightboxEl.addEventListener("click", function (evt) {
    if (evt.target === lightboxEl) { closeLightbox(); }
  });

  document.addEventListener("keydown", function (evt) {
    if (lightboxEl.hidden) { return; }
    if (evt.key === "Escape") { closeLightbox(); }
    else if (evt.key === "ArrowLeft") { step(-1); }
    else if (evt.key === "ArrowRight") { step(1); }
  });
}

function showCurrent() {
  var photo = lightboxState.photos[lightboxState.index];
  if (!photo) { return; }
  lightboxImg.src = photo.src;
  lightboxImg.alt = photo.caption;
  lightboxCaption.innerHTML = photo.album
    ? '<span class="album">' + escapeHtml(photo.album) + "</span><br />" +
      escapeHtml(photo.caption)
    : escapeHtml(photo.caption);
}

function step(delta) {
  var count = lightboxState.photos.length;
  if (count === 0) { return; }
  lightboxState.index = (lightboxState.index + delta + count) % count;
  showCurrent();
}

function openLightbox(index, triggerEl) {
  ensureLightbox();
  lightboxState.index = index;
  lightboxState.lastTrigger = triggerEl;
  showCurrent();
  lightboxEl.hidden = false;
  document.body.style.overflow = "hidden";
  lightboxEl.querySelector(".lightbox-close").focus();
}

function closeLightbox() {
  if (!lightboxEl) { return; }
  lightboxEl.hidden = true;
  document.body.style.overflow = "";
  if (lightboxState.lastTrigger) {
    lightboxState.lastTrigger.focus();
    lightboxState.lastTrigger = null;
  }
}

function isLightboxOpen() {
  return Boolean(lightboxEl) && !lightboxEl.hidden;
}

function bootFromDocument() {
  hydrateGallery(document);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootFromDocument);
} else {
  bootFromDocument();
}

export { hydrateGallery, isLightboxOpen };
