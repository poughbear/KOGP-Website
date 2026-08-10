(() => {
  "use strict";

  const GALLERY_ENDPOINT = "/.netlify/functions/gallery";
  const LOAD_TIMEOUT_MS = 15000;
  const elements = {
    grid: document.querySelector("#gallery-grid"),
    status: document.querySelector("#gallery-status"),
    empty: document.querySelector("#empty-state"),
    error: document.querySelector("#error-state"),
    retry: document.querySelector("#retry-button"),
    viewer: document.querySelector("#photo-viewer"),
    viewerImage: document.querySelector("#viewer-image"),
    viewerCaption: document.querySelector("#viewer-caption"),
    viewerClose: document.querySelector("#viewer-close"),
    viewerPrevious: document.querySelector("#viewer-previous"),
    viewerNext: document.querySelector("#viewer-next")
  };

  let photos = [];
  let activePhotoIndex = 0;

  elements.retry.addEventListener("click", loadGallery);
  elements.viewerClose.addEventListener("click", () => elements.viewer.close());
  elements.viewerPrevious.addEventListener("click", () => showAdjacentPhoto(-1));
  elements.viewerNext.addEventListener("click", () => showAdjacentPhoto(1));
  elements.viewer.addEventListener("click", (event) => {
    if (event.target === elements.viewer) elements.viewer.close();
  });
  document.addEventListener("keydown", (event) => {
    if (!elements.viewer.open) return;
    if (event.key === "ArrowLeft") showAdjacentPhoto(-1);
    if (event.key === "ArrowRight") showAdjacentPhoto(1);
  });

  loadGallery();

  async function loadGallery() {
    setView("loading");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);

    try {
      const response = await fetch(GALLERY_ENDPOINT, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal
      });

      if (!response.ok) throw new Error(`Gallery request returned ${response.status}`);

      const payload = await response.json();
      if (!payload || !Array.isArray(payload.photos)) throw new Error("Gallery response was invalid");

      photos = payload.photos.filter(isValidPhoto);

      if (photos.length === 0) {
        setView("empty");
        return;
      }

      renderPhotos();
      setView("gallery");
    } catch (error) {
      console.error("Gallery could not be loaded:", error.name);
      setView("error");
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function isValidPhoto(photo) {
    if (!photo || typeof photo.id !== "string" || typeof photo.imageUrl !== "string") return false;

    try {
      const url = new URL(photo.imageUrl);
      return url.protocol === "https:";
    } catch {
      return false;
    }
  }

  function renderPhotos() {
    elements.grid.replaceChildren();

    photos.forEach((photo, index) => {
      const card = document.createElement("figure");
      card.className = "photo-card";

      const button = document.createElement("button");
      button.className = "photo-button";
      button.type = "button";
      button.setAttribute("aria-label", photo.caption ? `View photo: ${photo.caption}` : `View KOGP photo ${index + 1}`);
      button.addEventListener("click", () => openViewer(index));

      const image = document.createElement("img");
      image.src = photo.imageUrl;
      image.alt = photo.caption || "KOGP event photo";
      image.loading = index < 2 ? "eager" : "lazy";
      image.decoding = "async";
      if (index === 0) image.fetchPriority = "high";
      image.addEventListener("load", () => image.classList.add("is-loaded"), { once: true });
      image.addEventListener("error", () => {
        button.disabled = true;
        button.setAttribute("aria-label", "Photo unavailable");
      }, { once: true });

      button.append(image);
      card.append(button);

      if (photo.caption) {
        const caption = document.createElement("figcaption");
        caption.textContent = photo.caption;
        card.append(caption);
      }

      elements.grid.append(card);
    });
  }

  function setView(view) {
    const loading = view === "loading";
    elements.status.hidden = !loading;
    elements.grid.hidden = view !== "gallery";
    elements.empty.hidden = view !== "empty";
    elements.error.hidden = view !== "error";
    elements.grid.setAttribute("aria-busy", String(loading));

    if (loading) elements.grid.replaceChildren();
  }

  function openViewer(index) {
    activePhotoIndex = index;
    updateViewer();

    if (typeof elements.viewer.showModal === "function") {
      elements.viewer.showModal();
    } else {
      window.open(photos[index].imageUrl, "_blank", "noopener,noreferrer");
    }
  }

  function showAdjacentPhoto(direction) {
    if (photos.length < 2) return;
    activePhotoIndex = (activePhotoIndex + direction + photos.length) % photos.length;
    updateViewer();
  }

  function updateViewer() {
    const photo = photos[activePhotoIndex];
    elements.viewerImage.src = photo.imageUrl;
    elements.viewerImage.alt = photo.caption || "KOGP event photo";
    elements.viewerCaption.textContent = photo.caption || `Photo ${activePhotoIndex + 1} of ${photos.length}`;
    const singlePhoto = photos.length < 2;
    elements.viewerPrevious.hidden = singlePhoto;
    elements.viewerNext.hidden = singlePhoto;
  }
})();
