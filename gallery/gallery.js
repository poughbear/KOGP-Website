(() => {
  "use strict";

  const GALLERY_ENDPOINT = "/.netlify/functions/gallery";
  const LOAD_TIMEOUT_MS = 15000;
  const SLIDE_INTERVAL_MS = 4000;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const elements = {
    grid: document.querySelector("#gallery-grid"),
    status: document.querySelector("#gallery-status"),
    empty: document.querySelector("#empty-state"),
    error: document.querySelector("#error-state"),
    retry: document.querySelector("#retry-button"),
    viewSwitch: document.querySelector("#view-switch"),
    slideshowViewButton: document.querySelector("#slideshow-view-button"),
    thumbnailViewButton: document.querySelector("#thumbnail-view-button"),
    slideshow: document.querySelector("#gallery-slideshow"),
    slideshowImageButton: document.querySelector("#slideshow-image-button"),
    slideshowImage: document.querySelector("#slideshow-image"),
    slideshowCaption: document.querySelector("#slideshow-caption"),
    slideshowCount: document.querySelector("#slideshow-count"),
    slideshowToggle: document.querySelector("#slideshow-toggle"),
    slideshowPrevious: document.querySelector("#slideshow-previous"),
    slideshowNext: document.querySelector("#slideshow-next"),
    viewer: document.querySelector("#photo-viewer"),
    viewerImage: document.querySelector("#viewer-image"),
    viewerCaption: document.querySelector("#viewer-caption"),
    viewerClose: document.querySelector("#viewer-close"),
    viewerPrevious: document.querySelector("#viewer-previous"),
    viewerNext: document.querySelector("#viewer-next")
  };

  let photos = [];
  let galleryMode = "slideshow";
  let activeSlideIndex = 0;
  let activePhotoIndex = 0;
  let slideshowPlaying = !reducedMotion.matches;
  let slideshowTimer = null;

  elements.retry.addEventListener("click", loadGallery);
  elements.slideshowViewButton.addEventListener("click", () => setGalleryMode("slideshow"));
  elements.thumbnailViewButton.addEventListener("click", () => setGalleryMode("thumbnails"));
  elements.slideshowPrevious.addEventListener("click", () => showAdjacentSlide(-1));
  elements.slideshowNext.addEventListener("click", () => showAdjacentSlide(1));
  elements.slideshowImageButton.addEventListener("click", () => openViewer(activeSlideIndex));
  elements.slideshowToggle.addEventListener("click", () => setSlideshowPlaying(!slideshowPlaying));
  elements.slideshowImage.addEventListener("load", () => elements.slideshowImage.classList.add("is-loaded"));

  elements.viewerClose.addEventListener("click", () => elements.viewer.close());
  elements.viewerPrevious.addEventListener("click", () => showAdjacentPhoto(-1));
  elements.viewerNext.addEventListener("click", () => showAdjacentPhoto(1));
  elements.viewer.addEventListener("click", (event) => {
    if (event.target === elements.viewer) elements.viewer.close();
  });
  elements.viewer.addEventListener("close", scheduleNextSlide);

  document.addEventListener("keydown", (event) => {
    if (!elements.viewer.open) return;
    if (event.key === "ArrowLeft") showAdjacentPhoto(-1);
    if (event.key === "ArrowRight") showAdjacentPhoto(1);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopSlideshowTimer();
    else scheduleNextSlide();
  });
  reducedMotion.addEventListener?.("change", (event) => {
    if (event.matches) setSlideshowPlaying(false);
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

      photos = shufflePhotos(payload.photos.filter(isValidPhoto));
      activeSlideIndex = 0;
      activePhotoIndex = 0;

      if (photos.length === 0) {
        setView("empty");
        return;
      }

      renderPhotos();
      updateSlideshow();
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

  function shufflePhotos(items) {
    const shuffled = [...items];

    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
    }

    return shuffled;
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
      image.loading = "lazy";
      image.decoding = "async";
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
    const galleryVisible = view === "gallery";
    elements.status.hidden = !loading;
    elements.viewSwitch.hidden = !galleryVisible;
    elements.empty.hidden = view !== "empty";
    elements.error.hidden = view !== "error";
    elements.grid.setAttribute("aria-busy", String(loading));

    if (loading) elements.grid.replaceChildren();

    if (galleryVisible) applyGalleryMode();
    else {
      elements.slideshow.hidden = true;
      elements.grid.hidden = true;
      stopSlideshowTimer();
    }
  }

  function setGalleryMode(mode) {
    if (mode !== "slideshow" && mode !== "thumbnails") return;
    galleryMode = mode;
    applyGalleryMode();
  }

  function applyGalleryMode() {
    const showingSlideshow = galleryMode === "slideshow";
    elements.slideshow.hidden = !showingSlideshow;
    elements.grid.hidden = showingSlideshow;
    elements.slideshowViewButton.classList.toggle("is-active", showingSlideshow);
    elements.thumbnailViewButton.classList.toggle("is-active", !showingSlideshow);
    elements.slideshowViewButton.setAttribute("aria-pressed", String(showingSlideshow));
    elements.thumbnailViewButton.setAttribute("aria-pressed", String(!showingSlideshow));

    if (showingSlideshow) {
      updateSlideshow();
      scheduleNextSlide();
    } else {
      stopSlideshowTimer();
    }
  }

  function updateSlideshow() {
    const photo = photos[activeSlideIndex];
    if (!photo) return;

    elements.slideshowImage.classList.remove("is-loaded");
    elements.slideshowImage.src = photo.imageUrl;
    elements.slideshowImage.alt = photo.caption || "KOGP event photo";
    elements.slideshowImageButton.setAttribute(
      "aria-label",
      photo.caption ? `Open photo: ${photo.caption}` : `Open KOGP photo ${activeSlideIndex + 1}`
    );
    elements.slideshowCount.textContent = `Photo ${activeSlideIndex + 1} of ${photos.length}`;
    elements.slideshowCaption.textContent = photo.caption || "KOGP memory";

    const singlePhoto = photos.length < 2;
    elements.slideshowPrevious.hidden = singlePhoto;
    elements.slideshowNext.hidden = singlePhoto;
    elements.slideshowToggle.hidden = singlePhoto;
    updateSlideshowToggle();
  }

  function showAdjacentSlide(direction) {
    if (photos.length < 2) return;
    activeSlideIndex = (activeSlideIndex + direction + photos.length) % photos.length;
    updateSlideshow();
    scheduleNextSlide();
  }

  function setSlideshowPlaying(playing) {
    slideshowPlaying = Boolean(playing) && photos.length > 1;
    updateSlideshowToggle();
    scheduleNextSlide();
  }

  function updateSlideshowToggle() {
    elements.slideshowToggle.textContent = slideshowPlaying ? "Pause slideshow" : "Play slideshow";
    elements.slideshowToggle.setAttribute("aria-pressed", String(slideshowPlaying));
  }

  function scheduleNextSlide() {
    stopSlideshowTimer();
    if (
      galleryMode !== "slideshow" ||
      !slideshowPlaying ||
      photos.length < 2 ||
      document.hidden ||
      elements.viewer.open
    ) return;

    slideshowTimer = window.setTimeout(() => showAdjacentSlide(1), SLIDE_INTERVAL_MS);
  }

  function stopSlideshowTimer() {
    if (slideshowTimer === null) return;
    window.clearTimeout(slideshowTimer);
    slideshowTimer = null;
  }

  function openViewer(index) {
    activePhotoIndex = index;
    updateViewer();
    stopSlideshowTimer();

    if (typeof elements.viewer.showModal === "function") {
      elements.viewer.showModal();
    } else {
      window.open(photos[index].imageUrl, "_blank", "noopener,noreferrer");
      scheduleNextSlide();
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
