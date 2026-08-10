(() => {
  "use strict";

  const MAX_FILES = 30;
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const UPLOAD_CONCURRENCY = 3;
  const CONFIG_ENDPOINT = "/.netlify/functions/supabase-config";
  const STORAGE_BUCKET = "gallery";
  const DATABASE_TABLE = "gallery_uploads";
  const HEIC_CONVERTER_URL = "/upload/vendor/heic-to.js";
  const HEIC_JPEG_QUALITIES = Object.freeze([.9, .78, .65]);

  const MIME_TO_EXTENSION = Object.freeze({
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif"
  });

  const EXTENSION_TO_MIME = Object.freeze({
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif"
  });

  const elements = {
    form: document.querySelector("#upload-form"),
    name: document.querySelector("#uploader-name"),
    email: document.querySelector("#uploader-email"),
    input: document.querySelector("#photo-input"),
    picker: document.querySelector("#picker"),
    feedback: document.querySelector("#selection-feedback"),
    selectedHeading: document.querySelector("#selected-heading"),
    photoCount: document.querySelector("#photo-count"),
    fileList: document.querySelector("#file-list"),
    progress: document.querySelector("#upload-progress"),
    progressTrack: document.querySelector(".progress-track"),
    progressBar: document.querySelector("#progress-bar"),
    progressCount: document.querySelector("#progress-count"),
    alert: document.querySelector("#form-alert"),
    submit: document.querySelector("#submit-button"),
    submitLabel: document.querySelector("#submit-button span"),
    result: document.querySelector("#result-panel"),
    resultIcon: document.querySelector("#result-icon"),
    resultTitle: document.querySelector("#result-title"),
    resultMessage: document.querySelector("#result-message"),
    submitMore: document.querySelector("#submit-more")
  };

  let files = [];
  let isUploading = false;
  let cachedConfig = null;
  let heicConverterPromise = null;
  let heicConversionQueue = Promise.resolve();

  elements.input.addEventListener("change", (event) => {
    addFiles(event.target.files);
    event.target.value = "";
  });

  elements.email.addEventListener("input", () => {
    elements.email.removeAttribute("aria-invalid");
    hideAlert();
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    elements.picker.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (!isUploading) {
        elements.picker.classList.add("is-dragging");
      }
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    elements.picker.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.picker.classList.remove("is-dragging");
    });
  });

  elements.picker.addEventListener("drop", (event) => {
    if (!isUploading && event.dataTransfer?.files) {
      addFiles(event.dataTransfer.files);
    }
  });

  elements.form.addEventListener("submit", handleSubmit);
  elements.submitMore.addEventListener("click", resetForm);

  window.addEventListener("beforeunload", (event) => {
    if (!isUploading) return;
    event.preventDefault();
    event.returnValue = "";
  });

  function addFiles(fileList) {
    if (isUploading || !fileList?.length) return;

    const notices = [];
    let addedCount = 0;

    for (const file of Array.from(fileList)) {
      if (files.length >= MAX_FILES) {
        notices.push(`Only ${MAX_FILES} photos can be included at one time.`);
        break;
      }

      const extension = getAllowedExtension(file);

      if (!extension) {
        notices.push(`${file.name || "One file"} is not a supported image type.`);
        continue;
      }

      if (file.size === 0) {
        notices.push(`${file.name} is empty and was not added.`);
        continue;
      }

      if (file.size > MAX_FILE_BYTES) {
        notices.push(`${file.name} is larger than 10 MB.`);
        continue;
      }

      const duplicate = files.some((item) => (
        item.file.name === file.name &&
        item.file.size === file.size &&
        item.file.lastModified === file.lastModified
      ));

      if (duplicate) {
        notices.push(`${file.name} is already selected.`);
        continue;
      }

      files.push({
        id: createUuid(),
        file,
        originalName: file.name,
        extension,
        previewUrl: URL.createObjectURL(file),
        uploadBlob: file,
        wasConverted: false,
        storagePath: null,
        state: "ready",
        progress: 0,
        status: "Ready",
        element: null,
        previewElement: null,
        sizeElement: null,
        statusElement: null,
        removeButton: null
      });
      addedCount += 1;
    }

    renderFiles();
    hideAlert();

    if (notices.length) {
      const shown = notices.slice(0, 3);
      const remaining = notices.length - shown.length;
      elements.feedback.textContent = `${shown.join(" ")}${remaining > 0 ? ` Plus ${remaining} more file${remaining === 1 ? "" : "s"} could not be added.` : ""}`;
    } else if (addedCount > 0) {
      elements.feedback.textContent = `${addedCount} photo${addedCount === 1 ? "" : "s"} added.`;
    }
  }

  function renderFiles() {
    elements.fileList.replaceChildren();

    files.forEach((item) => {
      const row = document.createElement("li");
      row.className = "file-item";
      row.dataset.state = item.state;

      const preview = document.createElement("div");
      preview.className = "file-preview";

      const fallback = document.createElement("span");
      fallback.textContent = item.extension.toUpperCase();
      preview.append(fallback);

      if (!isHeicExtension(item.extension) || item.wasConverted) {
        addPreviewImage(item, preview, fallback);
      }

      const details = document.createElement("div");
      details.className = "file-details";

      const name = document.createElement("p");
      name.className = "file-name";
      name.textContent = item.originalName;
      name.title = item.originalName;

      const meta = document.createElement("p");
      meta.className = "file-meta";

      const size = document.createElement("span");
      size.textContent = formatBytes(item.file.size);

      const separator = document.createElement("span");
      separator.setAttribute("aria-hidden", "true");
      separator.textContent = "•";

      const status = document.createElement("span");
      status.className = "file-status";
      status.textContent = item.status;

      meta.append(size, separator, status);
      details.append(name, meta);

      const remove = document.createElement("button");
      remove.className = "remove-file";
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${item.file.name}`);
      remove.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      remove.disabled = isUploading || item.state !== "ready";
      remove.addEventListener("click", () => removeFile(item.id));

      row.append(preview, details, remove);
      elements.fileList.append(row);

      item.element = row;
      item.previewElement = preview;
      item.sizeElement = size;
      item.statusElement = status;
      item.removeButton = remove;
    });

    elements.selectedHeading.hidden = files.length === 0;
    elements.photoCount.textContent = `${files.length} of ${MAX_FILES}`;
    elements.submit.disabled = isUploading || files.length === 0;
  }

  function removeFile(id) {
    if (isUploading) return;
    const index = files.findIndex((item) => item.id === id);
    if (index === -1) return;

    URL.revokeObjectURL(files[index].previewUrl);
    files.splice(index, 1);
    elements.feedback.textContent = files.length ? "Photo removed." : "";
    renderFiles();
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (isUploading || files.length === 0) return;

    const uploaderName = elements.name.value.trim();
    const uploaderEmail = elements.email.value.trim();

    if (uploaderEmail && !elements.email.checkValidity()) {
      elements.email.setAttribute("aria-invalid", "true");
      showAlert("Please enter a valid email address or leave the email field blank.");
      elements.email.focus();
      return;
    }

    setUploadingState(true);
    hideAlert();
    elements.feedback.textContent = "";
    elements.result.hidden = true;
    elements.progress.hidden = false;

    files.forEach((item) => {
      item.progress = 0;
      setItemState(item, "queued", "Waiting…");
    });
    updateOverallProgress();

    let config;

    try {
      config = await getServiceConfig();
    } catch (error) {
      console.error("Upload configuration could not be loaded:", error.message);
      files.forEach((item) => setItemState(item, "ready", "Ready"));
      elements.progress.hidden = true;
      setUploadingState(false);
      showAlert("The upload service is temporarily unavailable. Please wait a moment and try again.");
      return;
    }

    let nextIndex = 0;
    const workerCount = Math.min(UPLOAD_CONCURRENCY, files.length);

    async function worker() {
      while (nextIndex < files.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        await uploadFile(files[currentIndex], uploaderName, uploaderEmail, config);
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    setUploadingState(false);
    finishSubmission();
  }

  async function uploadFile(item, uploaderName, uploaderEmail, config) {
    try {
      await prepareFileForUpload(item);
    } catch (error) {
      console.error(`Preparation failed for ${item.originalName}:`, error.message);
      item.progress = 100;
      setItemState(item, "error", error.userStatus || "HEIC conversion failed");
      updateOverallProgress();
      return;
    }

    item.storagePath = createStoragePath(item.extension);
    item.progress = Math.max(item.progress, 1);
    setItemState(item, "uploading", "Starting upload…");
    updateOverallProgress();

    try {
      await uploadObject(item, config);
    } catch (error) {
      console.error(`Upload failed for ${item.originalName}:`, error.message);
      item.progress = 100;
      setItemState(item, "error", "Upload failed");
      updateOverallProgress();
      return;
    }

    item.progress = 94;
    setItemState(item, "saving", "Saving submission…");
    updateOverallProgress();

    try {
      await createDatabaseRecord(item, uploaderName, uploaderEmail, config);
    } catch (error) {
      console.error(`Submission record failed for ${item.originalName}:`, error.message);
      item.progress = 100;
      setItemState(item, "error", "Photo uploaded, but record failed");
      updateOverallProgress();
      return;
    }

    item.progress = 100;
    setItemState(item, "success", "Submitted for review");
    updateOverallProgress();
  }

  async function prepareFileForUpload(item) {
    if (!isHeicExtension(item.extension)) return;

    item.progress = 2;
    setItemState(item, "converting", "Preparing HEIC for the gallery…");
    updateOverallProgress();

    const converted = await queueHeicConversion(async () => {
      const { heicTo, isHeic } = await loadHeicConverter();

      if (!(await isHeic(item.file))) {
        throw createPreparationError("Not a valid HEIC photo");
      }

      let jpeg = null;

      for (const quality of HEIC_JPEG_QUALITIES) {
        const result = await heicTo({
          blob: item.file,
          type: "image/jpeg",
          quality
        });

        jpeg = Array.isArray(result) ? result[0] : result;

        if (!(jpeg instanceof Blob)) {
          throw createPreparationError("HEIC conversion failed");
        }

        if (jpeg.size <= MAX_FILE_BYTES) break;
      }

      if (!jpeg || jpeg.size === 0) {
        throw createPreparationError("HEIC conversion failed");
      }

      if (jpeg.size > MAX_FILE_BYTES) {
        throw createPreparationError("Converted photo exceeds 10 MB");
      }

      return jpeg;
    });

    URL.revokeObjectURL(item.previewUrl);
    item.previewUrl = URL.createObjectURL(converted);
    item.uploadBlob = converted;
    item.extension = "jpg";
    item.wasConverted = true;
    item.progress = 8;

    if (item.previewElement) {
      const fallback = item.previewElement.querySelector("span");
      if (fallback) fallback.textContent = "JPG";
      addPreviewImage(item, item.previewElement, fallback);
    }

    if (item.sizeElement) {
      item.sizeElement.textContent = `${formatBytes(converted.size)} after conversion`;
    }

    setItemState(item, "converting", "Converted to JPEG");
    updateOverallProgress();
  }

  function queueHeicConversion(task) {
    const queued = heicConversionQueue.then(task, task);
    heicConversionQueue = queued.catch(() => undefined);
    return queued;
  }

  async function loadHeicConverter() {
    if (!heicConverterPromise) {
      heicConverterPromise = import(HEIC_CONVERTER_URL)
        .then((module) => {
          if (typeof module.heicTo !== "function" || typeof module.isHeic !== "function") {
            throw new Error("The HEIC converter did not load correctly");
          }
          return module;
        })
        .catch((error) => {
          heicConverterPromise = null;
          throw error;
        });
    }

    return heicConverterPromise;
  }

  function createPreparationError(userStatus) {
    const error = new Error(userStatus);
    error.userStatus = userStatus;
    return error;
  }

  function addPreviewImage(item, preview, fallback) {
    const existingImage = preview.querySelector("img");
    if (existingImage) existingImage.remove();

    const image = document.createElement("img");
    image.src = item.previewUrl;
    image.alt = "";
    image.addEventListener("load", () => fallback?.remove(), { once: true });
    image.addEventListener("error", () => image.remove(), { once: true });
    preview.prepend(image);
  }

  function uploadObject(item, config) {
    return new Promise((resolve, reject) => {
      const objectPath = encodePath(item.storagePath);
      const url = `${config.supabaseUrl}/storage/v1/object/${STORAGE_BUCKET}/${objectPath}`;
      const request = new XMLHttpRequest();

      request.open("POST", url, true);
      request.setRequestHeader("apikey", config.supabasePublishableKey);
      request.setRequestHeader("Content-Type", EXTENSION_TO_MIME[item.extension]);
      request.setRequestHeader("cache-control", "3600");
      request.setRequestHeader("x-upsert", "false");

      request.upload.addEventListener("progress", (event) => {
        if (!event.lengthComputable) return;
        const uploadPercent = Math.round((event.loaded / event.total) * 100);
        item.progress = Math.max(1, Math.min(90, Math.round(uploadPercent * .9)));
        setItemState(item, "uploading", `${uploadPercent}% uploaded`);
        updateOverallProgress();
      });

      request.addEventListener("load", () => {
        if (request.status >= 200 && request.status < 300) {
          resolve();
          return;
        }
        reject(new Error(readErrorMessage(request.responseText, request.status)));
      });

      request.addEventListener("error", () => reject(new Error("Network error while uploading")));
      request.addEventListener("timeout", () => reject(new Error("Upload timed out")));
      request.timeout = 300000;
      request.send(item.uploadBlob);
    });
  }

  async function createDatabaseRecord(item, uploaderName, uploaderEmail, config) {
    const response = await fetch(`${config.supabaseUrl}/rest/v1/${DATABASE_TABLE}`, {
      method: "POST",
      headers: {
        apikey: config.supabasePublishableKey,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        storage_path: item.storagePath,
        uploader_name: uploaderName || null,
        uploader_email: uploaderEmail || null,
        status: "pending"
      })
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(readErrorMessage(responseText, response.status));
    }
  }

  async function getServiceConfig() {
    if (cachedConfig) return cachedConfig;

    const response = await fetch(CONFIG_ENDPOINT, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin"
    });

    if (!response.ok) {
      throw new Error(`Configuration request returned ${response.status}`);
    }

    const config = await response.json();

    if (
      typeof config.supabaseUrl !== "string" ||
      !config.supabaseUrl.startsWith("https://") ||
      typeof config.supabasePublishableKey !== "string" ||
      config.supabasePublishableKey.length < 20
    ) {
      throw new Error("Configuration response was invalid");
    }

    cachedConfig = Object.freeze({
      supabaseUrl: config.supabaseUrl.replace(/\/$/, ""),
      supabasePublishableKey: config.supabasePublishableKey
    });

    return cachedConfig;
  }

  function finishSubmission() {
    const succeeded = files.filter((item) => item.state === "success").length;
    const failed = files.length - succeeded;

    elements.result.hidden = false;

    if (failed === 0) {
      elements.result.dataset.result = "success";
      elements.resultIcon.textContent = "✓";
      elements.resultTitle.textContent = succeeded === 1 ? "Your photo was received!" : "Your photos were received!";
      elements.resultMessage.textContent = `Thank you for sharing ${succeeded === 1 ? "this memory" : `these ${succeeded} memories`} with KOGP. ${succeeded === 1 ? "It is" : "They are"} private and pending review.`;
      elements.submitLabel.textContent = "Upload complete";
    } else if (succeeded > 0) {
      elements.result.dataset.result = "partial";
      elements.resultIcon.textContent = "!";
      elements.resultTitle.textContent = `${succeeded} of ${files.length} photos were received`;
      elements.resultMessage.textContent = `${failed} photo${failed === 1 ? " was" : "s were"} not submitted. Your successful uploads are safe and pending review; the failed photos are marked above in red.`;
      elements.submitLabel.textContent = "Upload finished";
      showAlert(`${failed} photo${failed === 1 ? "" : "s"} failed. Successful photos were not affected.`);
    } else {
      elements.result.dataset.result = "partial";
      elements.resultIcon.textContent = "!";
      elements.resultTitle.textContent = "We could not finish the upload";
      elements.resultMessage.textContent = "No photos were submitted. Please check your connection and try selecting the photos again in a moment.";
      elements.submitLabel.textContent = "Upload failed";
      showAlert("No photos were submitted. See the red status message beside each photo.");
    }

    elements.submit.disabled = true;
    elements.result.focus({ preventScroll: true });
    elements.result.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function resetForm() {
    files.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    files = [];
    elements.form.reset();
    elements.email.removeAttribute("aria-invalid");
    elements.feedback.textContent = "";
    elements.progress.hidden = true;
    elements.result.hidden = true;
    elements.result.removeAttribute("data-result");
    elements.submitLabel.textContent = "Upload photos";
    hideAlert();
    renderFiles();
    elements.form.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => elements.input.focus({ preventScroll: true }), 450);
  }

  function setUploadingState(uploading) {
    isUploading = uploading;
    document.body.classList.toggle("is-uploading", uploading);
    elements.input.disabled = uploading;
    elements.name.disabled = uploading;
    elements.email.disabled = uploading;
    elements.submit.disabled = uploading || files.length === 0;
    files.forEach((item) => {
      if (item.removeButton) item.removeButton.disabled = uploading || item.state !== "ready";
    });
    elements.submitLabel.textContent = uploading ? "Uploading…" : "Upload photos";
  }

  function setItemState(item, state, status) {
    item.state = state;
    item.status = status;

    if (item.element) item.element.dataset.state = state;
    if (item.statusElement) item.statusElement.textContent = status;
    if (item.removeButton) item.removeButton.disabled = isUploading || state !== "ready";
  }

  function updateOverallProgress() {
    if (!files.length) return;
    const totalProgress = files.reduce((sum, item) => sum + item.progress, 0);
    const percent = Math.round(totalProgress / files.length);
    const finished = files.filter((item) => item.state === "success" || item.state === "error").length;

    elements.progressBar.style.width = `${percent}%`;
    elements.progressTrack.setAttribute("aria-valuenow", String(percent));
    elements.progressCount.textContent = `${finished} of ${files.length} finished`;
  }

  function getAllowedExtension(file) {
    const mimeType = (file.type || "").toLowerCase().split(";")[0].trim();

    if (MIME_TO_EXTENSION[mimeType]) {
      return MIME_TO_EXTENSION[mimeType];
    }

    if (mimeType && mimeType !== "application/octet-stream") {
      return null;
    }

    const extension = file.name.includes(".")
      ? file.name.split(".").pop().toLowerCase()
      : "";

    if (!EXTENSION_TO_MIME[extension]) return null;
    return extension === "jpeg" ? "jpg" : extension;
  }

  function isHeicExtension(extension) {
    return extension === "heic" || extension === "heif";
  }

  function createStoragePath(extension) {
    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `uploads/${year}/${month}/${createUuid()}.${extension}`;
  }

  function createUuid() {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }

  function encodePath(path) {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) {
      return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function readErrorMessage(responseText, status) {
    try {
      const parsed = JSON.parse(responseText);
      const message = parsed.message || parsed.error || parsed.msg;
      if (typeof message === "string" && message.length < 300) {
        return `${status}: ${message}`;
      }
    } catch {
      // The response was not JSON; return the status without reflecting response text.
    }
    return `Request failed with status ${status}`;
  }

  function showAlert(message) {
    elements.alert.textContent = message;
    elements.alert.hidden = false;
  }

  function hideAlert() {
    elements.alert.textContent = "";
    elements.alert.hidden = true;
  }
})();
