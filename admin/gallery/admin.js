(() => {
  "use strict";

  const CONFIG_ENDPOINT = "/.netlify/functions/supabase-config";
  const ADMIN_ENDPOINT = "/.netlify/functions/admin-gallery";
  const HEIC_CONVERTER_URL = "/upload/vendor/heic-to.js";
  const VALID_STATUSES = new Set(["pending", "approved", "rejected"]);
  const STATUS_LABELS = Object.freeze({
    pending: "Pending",
    approved: "Approved",
    rejected: "Rejected"
  });

  const elements = {
    authShell: document.querySelector("#auth-shell"),
    loginForm: document.querySelector("#login-form"),
    email: document.querySelector("#admin-email"),
    loginButton: document.querySelector("#login-button"),
    authMessage: document.querySelector("#auth-message"),
    dashboard: document.querySelector("#dashboard"),
    reviewerEmail: document.querySelector("#reviewer-email"),
    signOut: document.querySelector("#sign-out-button"),
    tabs: Array.from(document.querySelectorAll(".status-tab")),
    counts: {
      pending: document.querySelector("#pending-count"),
      approved: document.querySelector("#approved-count"),
      rejected: document.querySelector("#rejected-count")
    },
    bulkToolbar: document.querySelector("#bulk-toolbar"),
    selectAll: document.querySelector("#select-all"),
    selectionCount: document.querySelector("#selection-count"),
    approveSelected: document.querySelector("#approve-selected"),
    rejectSelected: document.querySelector("#reject-selected"),
    pendingSelected: document.querySelector("#pending-selected"),
    alert: document.querySelector("#dashboard-alert"),
    loading: document.querySelector("#loading-state"),
    empty: document.querySelector("#empty-state"),
    emptyTitle: document.querySelector("#empty-title"),
    emptyMessage: document.querySelector("#empty-message"),
    grid: document.querySelector("#review-grid"),
    limitNote: document.querySelector("#limit-note"),
    toast: document.querySelector("#toast"),
    toastMessage: document.querySelector("#toast-message"),
    undo: document.querySelector("#undo-button"),
    viewer: document.querySelector("#photo-viewer"),
    viewerClose: document.querySelector("#viewer-close"),
    viewerImage: document.querySelector("#viewer-image"),
    viewerMeta: document.querySelector("#viewer-meta")
  };

  let authClient = null;
  let session = null;
  let currentStatus = "pending";
  let items = [];
  let selectedIds = new Set();
  let isBusy = false;
  let loadSequence = 0;
  let renderSequence = 0;
  let lastAction = null;
  let toastTimer = null;
  let heicConverterPromise = null;
  let heicConversionQueue = Promise.resolve();
  const objectUrls = new Set();

  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  });

  bindEvents();
  initialize();

  function bindEvents() {
    elements.loginForm.addEventListener("submit", handleLogin);
    elements.email.addEventListener("input", () => {
      elements.email.removeAttribute("aria-invalid");
      setAuthMessage("");
    });
    elements.signOut.addEventListener("click", handleSignOut);
    elements.selectAll.addEventListener("change", toggleSelectAll);
    elements.approveSelected.addEventListener("click", () => updateSelected("approved"));
    elements.rejectSelected.addEventListener("click", () => updateSelected("rejected"));
    elements.pendingSelected.addEventListener("click", () => updateSelected("pending"));
    elements.undo.addEventListener("click", undoLastAction);
    elements.viewerClose.addEventListener("click", closeViewer);
    elements.viewer.addEventListener("click", (event) => {
      if (event.target === elements.viewer) closeViewer();
    });

    elements.tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const status = tab.dataset.status;
        if (!VALID_STATUSES.has(status) || status === currentStatus || isBusy) return;
        currentStatus = status;
        loadSubmissions();
      });
    });

    window.addEventListener("beforeunload", revokeObjectUrls);
  }

  async function initialize() {
    const redirectError = readRedirectError();

    try {
      const config = await getServiceConfig();

      if (!window.supabase?.createClient) {
        throw new Error("The sign-in service did not load");
      }

      authClient = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storage: window.sessionStorage
        }
      });

      authClient.auth.onAuthStateChange((_event, nextSession) => {
        window.setTimeout(() => applySession(nextSession), 0);
      });

      const { data, error } = await authClient.auth.getSession();
      if (error) throw error;

      cleanRedirectUrl();
      await applySession(data.session);

      if (!data.session && redirectError) {
        setAuthMessage(redirectError, "error");
      }
    } catch (error) {
      console.error("Gallery administration initialization failed:", error.message);
      showLogin();
      setAuthMessage("The secure sign-in service is temporarily unavailable. Please refresh and try again.", "error");
    }
  }

  async function applySession(nextSession) {
    const tokenChanged = nextSession?.access_token !== session?.access_token;
    session = nextSession || null;

    if (!session) {
      showLogin();
      return;
    }

    showDashboard();
    if (tokenChanged || (items.length === 0 && !isBusy)) await loadSubmissions();
  }

  async function handleLogin(event) {
    event.preventDefault();
    if (isBusy) return;
    if (!authClient) {
      setAuthMessage("The secure sign-in service is unavailable. Refresh the page and try again.", "error");
      return;
    }

    const email = elements.email.value.trim();
    if (!email || !elements.email.checkValidity()) {
      elements.email.setAttribute("aria-invalid", "true");
      setAuthMessage("Enter a valid administrator email address.", "error");
      elements.email.focus();
      return;
    }

    setLoginBusy(true);
    setAuthMessage("Sending your secure sign-in link...");

    try {
      const redirectTo = new URL("/admin/gallery/", window.location.origin).href;
      const { error } = await authClient.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: redirectTo,
          shouldCreateUser: false
        }
      });

      if (error) throw error;
      setAuthMessage("Check your email for the secure KOGP sign-in link. You can close this message after opening the link in this browser.", "success");
    } catch (error) {
      console.error("Gallery sign-in failed:", error.message);
      setAuthMessage("We could not send the sign-in link. Confirm that this is an authorized email and try again.", "error");
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleSignOut() {
    if (!authClient || isBusy) return;
    setBusy(true);

    try {
      await authClient.auth.signOut({ scope: "local" });
    } catch (error) {
      console.error("Local sign-out failed:", error.message);
    } finally {
      session = null;
      setBusy(false);
      showLogin();
      setAuthMessage("You have been signed out.", "success");
    }
  }

  function showLogin() {
    loadSequence += 1;
    renderSequence += 1;
    revokeObjectUrls();
    items = [];
    selectedIds.clear();
    setBusy(false);
    elements.dashboard.hidden = true;
    elements.authShell.hidden = false;
    hideToast();
    hideAlert();
  }

  function showDashboard() {
    elements.authShell.hidden = true;
    elements.dashboard.hidden = false;
  }

  async function loadSubmissions() {
    if (!session) return;

    const requestedStatus = currentStatus;
    const requestNumber = ++loadSequence;
    setBusy(true);
    hideAlert();
    selectedIds.clear();
    updateSelectionControls();
    updateTabs();
    elements.loading.hidden = false;
    elements.empty.hidden = true;
    elements.limitNote.hidden = true;
    elements.grid.setAttribute("aria-busy", "true");

    try {
      const payload = await adminRequest(`?status=${encodeURIComponent(requestedStatus)}`);
      if (requestNumber !== loadSequence || requestedStatus !== currentStatus) return;

      if (!isValidListPayload(payload, requestedStatus)) {
        throw new Error("The gallery response was invalid");
      }

      items = payload.items;
      elements.reviewerEmail.textContent = payload.reviewer.email;
      Object.keys(elements.counts).forEach((status) => {
        elements.counts[status].textContent = String(payload.counts[status]);
      });
      renderSubmissions();
      elements.limitNote.hidden = !payload.truncated;
    } catch (error) {
      if (requestNumber !== loadSequence) return;
      handleAdminError(error, "The submissions could not be loaded. Please try again.");
      items = [];
      renderSubmissions();
    } finally {
      if (requestNumber === loadSequence) {
        elements.loading.hidden = true;
        elements.grid.setAttribute("aria-busy", "false");
        setBusy(false);
      }
    }
  }

  function renderSubmissions() {
    const thisRender = ++renderSequence;
    revokeObjectUrls();
    elements.grid.replaceChildren();
    elements.empty.hidden = items.length !== 0;

    if (items.length === 0) {
      const copy = emptyStateCopy(currentStatus);
      elements.emptyTitle.textContent = copy.title;
      elements.emptyMessage.textContent = copy.message;
      return;
    }

    items.forEach((item) => elements.grid.append(createSubmissionCard(item, thisRender)));
  }

  function createSubmissionCard(item, thisRender) {
    const card = document.createElement("article");
    card.className = "review-card";
    card.dataset.id = item.id;

    const selectLabel = document.createElement("label");
    selectLabel.className = "photo-select";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", `Select photo submitted ${formatDate(item.createdAt)}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedIds.add(item.id);
      else selectedIds.delete(item.id);
      card.classList.toggle("is-selected", checkbox.checked);
      updateSelectionControls();
    });
    selectLabel.append(checkbox);

    const badge = document.createElement("span");
    badge.className = "status-badge";
    badge.textContent = STATUS_LABELS[item.status];

    const photoButton = document.createElement("button");
    photoButton.className = "photo-open";
    photoButton.type = "button";
    photoButton.setAttribute("aria-label", "Open larger photo preview");

    const placeholder = document.createElement("span");
    placeholder.className = "photo-placeholder";
    placeholder.textContent = item.fileType ? item.fileType.toUpperCase() : "PHOTO";
    photoButton.append(placeholder);

    if (item.imageUrl) {
      if (isHeic(item.fileType)) prepareHeicPreview(item, photoButton, placeholder, thisRender);
      else attachPreviewImage(item, photoButton, placeholder, item.imageUrl);
    } else {
      placeholder.textContent = "PREVIEW UNAVAILABLE";
    }

    photoButton.addEventListener("click", () => {
      if (item.displayUrl) openViewer(item);
    });

    const body = document.createElement("div");
    body.className = "card-body";

    const date = document.createElement("p");
    date.className = "photo-date";
    date.textContent = formatDate(item.createdAt);
    body.append(date);

    if (item.uploaderName) body.append(createTextLine("photo-uploader", `From: ${item.uploaderName}`));
    if (item.uploaderEmail) {
      const emailLine = document.createElement("p");
      emailLine.className = "photo-email";
      const emailLink = document.createElement("a");
      emailLink.href = `mailto:${item.uploaderEmail}`;
      emailLink.textContent = item.uploaderEmail;
      emailLine.append(emailLink);
      body.append(emailLine);
    }
    if (!item.uploaderName && !item.uploaderEmail) body.append(createTextLine("photo-uploader", "Submitted anonymously"));
    if (item.caption) body.append(createTextLine("photo-caption", item.caption));

    const actions = document.createElement("div");
    actions.className = "card-actions";
    ["approved", "rejected", "pending"].forEach((status) => {
      const button = document.createElement("button");
      button.className = "card-action";
      button.type = "button";
      button.dataset.action = status;
      button.textContent = status === "approved" ? "Approve" : status === "rejected" ? "Reject" : "Pending";
      button.setAttribute("aria-pressed", String(item.status === status));
      button.addEventListener("click", () => changeStatus([item.id], status));
      actions.append(button);
    });
    body.append(actions);

    card.append(selectLabel, badge, photoButton, body);
    return card;
  }

  function attachPreviewImage(item, container, placeholder, url) {
    const image = document.createElement("img");
    image.alt = "Submitted KOGP gallery photo";
    image.decoding = "async";
    image.loading = "lazy";
    image.addEventListener("load", () => {
      image.classList.add("is-loaded");
      placeholder.remove();
    }, { once: true });
    image.addEventListener("error", () => {
      image.remove();
      placeholder.textContent = "PREVIEW UNAVAILABLE";
    }, { once: true });
    item.displayUrl = url;
    image.src = url;
    container.prepend(image);
  }

  async function prepareHeicPreview(item, container, placeholder, thisRender) {
    placeholder.textContent = "PREPARING HEIC...";

    try {
      const jpegBlob = await queueHeicConversion(async () => {
        const response = await fetch(item.imageUrl, { cache: "no-store", referrerPolicy: "no-referrer" });
        if (!response.ok) throw new Error(`Photo request returned ${response.status}`);
        const heicBlob = await response.blob();
        const converter = await loadHeicConverter();
        const result = await converter.heicTo({ blob: heicBlob, type: "image/jpeg", quality: .82 });
        const converted = Array.isArray(result) ? result[0] : result;
        if (!(converted instanceof Blob) || converted.size === 0) throw new Error("HEIC conversion returned no image");
        return converted;
      });

      if (thisRender !== renderSequence || !container.isConnected) return;
      const objectUrl = URL.createObjectURL(jpegBlob);
      objectUrls.add(objectUrl);
      attachPreviewImage(item, container, placeholder, objectUrl);
    } catch (error) {
      console.error("HEIC preview failed:", error.message);
      if (thisRender === renderSequence && container.isConnected) placeholder.textContent = "PREVIEW UNAVAILABLE";
    }
  }

  function queueHeicConversion(task) {
    const queued = heicConversionQueue.then(task, task);
    heicConversionQueue = queued.catch(() => undefined);
    return queued;
  }

  async function loadHeicConverter() {
    if (!heicConverterPromise) {
      heicConverterPromise = import(HEIC_CONVERTER_URL).then((module) => {
        if (typeof module.heicTo !== "function") throw new Error("HEIC converter unavailable");
        return module;
      }).catch((error) => {
        heicConverterPromise = null;
        throw error;
      });
    }
    return heicConverterPromise;
  }

  function toggleSelectAll() {
    const shouldSelect = elements.selectAll.checked;
    selectedIds = shouldSelect ? new Set(items.map((item) => item.id)) : new Set();
    elements.grid.querySelectorAll(".review-card").forEach((card) => {
      const selected = selectedIds.has(card.dataset.id);
      card.classList.toggle("is-selected", selected);
      const checkbox = card.querySelector(".photo-select input");
      if (checkbox) checkbox.checked = selected;
    });
    updateSelectionControls();
  }

  function updateSelected(status) {
    if (selectedIds.size > 0) changeStatus(Array.from(selectedIds), status);
  }

  async function changeStatus(ids, status, options = {}) {
    if (isBusy || !VALID_STATUSES.has(status) || ids.length === 0) return;
    if (status === currentStatus && options.allowSameStatus !== true) return;

    const previousStatus = options.previousStatus || currentStatus;
    setBusy(true);
    hideAlert();

    try {
      const payload = await adminRequest("", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, status })
      });

      if (!Array.isArray(payload.updated) || payload.updated.length !== ids.length) {
        throw new Error("Not every selected submission was updated");
      }

      await loadSubmissions();

      if (options.allowUndo !== false) {
        lastAction = { ids: ids.slice(), previousStatus, changedTo: status };
        showToast(`${ids.length} photo${ids.length === 1 ? "" : "s"} moved to ${STATUS_LABELS[status].toLowerCase()}.`, true);
      } else {
        showToast(`${ids.length} photo${ids.length === 1 ? "" : "s"} restored to ${STATUS_LABELS[status].toLowerCase()}.`, false);
      }
    } catch (error) {
      handleAdminError(error, "The selected photos could not be updated. No other decisions were lost.");
    } finally {
      setBusy(false);
    }
  }

  async function undoLastAction() {
    if (!lastAction || isBusy) return;
    const action = lastAction;
    lastAction = null;
    hideToast();
    await changeStatus(action.ids, action.previousStatus, {
      previousStatus: action.changedTo,
      allowUndo: false,
      allowSameStatus: true
    });
  }

  async function adminRequest(query = "", options = {}, mayRefresh = true) {
    const accessToken = session?.access_token;
    if (!accessToken) throw createRequestError(401, "Authentication required");

    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${accessToken}`);

    const response = await fetch(`${ADMIN_ENDPOINT}${query}`, {
      ...options,
      headers,
      cache: "no-store",
      credentials: "same-origin"
    });

    if (response.status === 401 && mayRefresh && authClient) {
      const { data, error } = await authClient.auth.refreshSession();
      if (!error && data.session) {
        session = data.session;
        return adminRequest(query, options, false);
      }
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) throw createRequestError(response.status, payload?.error || "Request failed");
    return payload;
  }

  function handleAdminError(error, fallbackMessage) {
    console.error("Gallery administration request failed:", error.message);

    if (error.status === 401) {
      session = null;
      authClient?.auth.signOut({ scope: "local" }).catch(() => undefined);
      showLogin();
      setAuthMessage("Your sign-in expired. Request a new secure link to continue.", "error");
      return;
    }

    if (error.status === 403) {
      session = null;
      authClient?.auth.signOut({ scope: "local" }).catch(() => undefined);
      showLogin();
      setAuthMessage("This email is signed in but is not authorized to review KOGP photos.", "error");
      return;
    }

    showAlert(fallbackMessage);
  }

  function updateTabs() {
    elements.tabs.forEach((tab) => {
      const isActive = tab.dataset.status === currentStatus;
      tab.classList.toggle("active", isActive);
      if (isActive) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
      tab.disabled = isBusy;
    });
  }

  function updateSelectionControls() {
    const count = selectedIds.size;
    const allSelected = items.length > 0 && count === items.length;
    elements.selectAll.checked = allSelected;
    elements.selectAll.indeterminate = count > 0 && !allSelected;
    elements.selectAll.disabled = isBusy || items.length === 0;
    elements.selectionCount.textContent = `${count} selected`;

    const controls = [
      [elements.approveSelected, "approved"],
      [elements.rejectSelected, "rejected"],
      [elements.pendingSelected, "pending"]
    ];
    controls.forEach(([button, status]) => {
      button.disabled = isBusy || count === 0 || status === currentStatus;
    });
  }

  function setBusy(value) {
    isBusy = value;
    elements.bulkToolbar.setAttribute("aria-busy", String(value));
    elements.signOut.disabled = value;
    updateTabs();
    updateSelectionControls();
    elements.grid.querySelectorAll("button, input").forEach((control) => {
      control.disabled = value;
    });
  }

  function setLoginBusy(value) {
    elements.loginButton.disabled = value;
    elements.email.disabled = value;
    elements.loginButton.textContent = value ? "Sending..." : "Send secure sign-in link";
  }

  function openViewer(item) {
    if (!item.displayUrl) return;
    elements.viewerImage.src = item.displayUrl;
    elements.viewerImage.alt = "Submitted KOGP gallery photo";
    elements.viewerMeta.textContent = `${formatDate(item.createdAt)}${item.uploaderName ? ` - ${item.uploaderName}` : ""}`;
    if (typeof elements.viewer.showModal === "function") elements.viewer.showModal();
    else elements.viewer.setAttribute("open", "");
  }

  function closeViewer() {
    if (typeof elements.viewer.close === "function" && elements.viewer.open) elements.viewer.close();
    else elements.viewer.removeAttribute("open");
    elements.viewerImage.removeAttribute("src");
  }

  function showToast(message, canUndo) {
    window.clearTimeout(toastTimer);
    elements.toastMessage.textContent = message;
    elements.undo.hidden = !canUndo;
    elements.toast.hidden = false;
    toastTimer = window.setTimeout(hideToast, 9000);
  }

  function hideToast() {
    window.clearTimeout(toastTimer);
    elements.toast.hidden = true;
  }

  function showAlert(message) {
    elements.alert.textContent = message;
    elements.alert.hidden = false;
  }

  function hideAlert() {
    elements.alert.hidden = true;
    elements.alert.textContent = "";
  }

  function setAuthMessage(message, state = "info") {
    elements.authMessage.textContent = message;
    elements.authMessage.dataset.state = state;
  }

  function revokeObjectUrls() {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
  }

  function createTextLine(className, text) {
    const line = document.createElement("p");
    line.className = className;
    line.textContent = text;
    return line;
  }

  function createRequestError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Submission date unavailable" : dateFormatter.format(date);
  }

  function isHeic(fileType) {
    return fileType === "heic" || fileType === "heif";
  }

  function emptyStateCopy(status) {
    if (status === "approved") return { title: "No approved photos yet.", message: "Photos you approve will appear here and in the public gallery." };
    if (status === "rejected") return { title: "No rejected photos.", message: "Photos you reject will remain private and appear here." };
    return { title: "The pending queue is clear.", message: "New photo submissions will appear here." };
  }

  function isValidListPayload(payload, status) {
    if (!payload || payload.status !== status || !Array.isArray(payload.items)) return false;
    if (!payload.reviewer || typeof payload.reviewer.email !== "string") return false;
    if (!payload.counts || ["pending", "approved", "rejected"].some((key) => !Number.isInteger(payload.counts[key]) || payload.counts[key] < 0)) return false;
    return payload.items.every((item) => (
      item &&
      typeof item.id === "string" &&
      VALID_STATUSES.has(item.status) &&
      typeof item.createdAt === "string" &&
      (item.imageUrl === null || typeof item.imageUrl === "string")
    ));
  }

  async function getServiceConfig() {
    const response = await fetch(CONFIG_ENDPOINT, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin"
    });
    if (!response.ok) throw new Error(`Configuration request returned ${response.status}`);

    const config = await response.json();
    if (
      typeof config.supabaseUrl !== "string" ||
      !config.supabaseUrl.startsWith("https://") ||
      typeof config.supabasePublishableKey !== "string" ||
      config.supabasePublishableKey.length < 20
    ) {
      throw new Error("Configuration response was invalid");
    }
    return config;
  }

  function readRedirectError() {
    const parameters = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const description = parameters.get("error_description");
    return description ? description.replace(/\+/g, " ") : "";
  }

  function cleanRedirectUrl() {
    if (!window.location.hash || !/(access_token|refresh_token|error_description)=/.test(window.location.hash)) return;
    window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
  }
})();
