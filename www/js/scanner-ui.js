/**
 * Injectable full-screen scanner overlay DOM.
 */

const OVERLAY_CSS_HREF = new URL("../css/scanner-overlay.css", import.meta.url).href;

let cssLoaded = false;

function ensureStyles() {
  if (cssLoaded) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = OVERLAY_CSS_HREF;
  link.dataset.rustbar = "overlay";
  document.head.appendChild(link);
  cssLoaded = true;
}

/**
 * @returns {{
 *   root: HTMLElement;
 *   video: HTMLVideoElement;
 *   status: HTMLElement;
 *   allowBtn: HTMLButtonElement;
 *   closeBtn: HTMLButtonElement;
 *   destroy: () => void;
 * }}
 */
export function createScannerOverlay() {
  ensureStyles();

  const root = document.createElement("div");
  root.className = "rustbar-overlay";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "QR code scanner");
  root.innerHTML = `
    <header class="rustbar-overlay__header">
      <h2 class="rustbar-overlay__title">Scan QR code</h2>
      <button type="button" class="rustbar-overlay__close" data-rustbar-close>Close</button>
    </header>
    <div class="rustbar-overlay__body">
      <div class="rustbar-overlay__viewport">
        <video class="rustbar-overlay__video" playsinline muted autoplay></video>
        <div class="rustbar-overlay__frame" aria-hidden="true">
          <span class="rustbar-overlay__corner rustbar-overlay__corner--tl"></span>
          <span class="rustbar-overlay__corner rustbar-overlay__corner--tr"></span>
          <span class="rustbar-overlay__corner rustbar-overlay__corner--bl"></span>
          <span class="rustbar-overlay__corner rustbar-overlay__corner--br"></span>
        </div>
      </div>
      <p class="rustbar-overlay__status" role="status">Starting camera…</p>
      <button type="button" class="rustbar-overlay__allow" hidden data-rustbar-allow>
        Allow camera
      </button>
    </div>
  `;

  document.body.appendChild(root);
  document.body.style.overflow = "hidden";

  const video = root.querySelector(".rustbar-overlay__video");
  const status = root.querySelector(".rustbar-overlay__status");
  const allowBtn = root.querySelector("[data-rustbar-allow]");
  const closeBtn = root.querySelector("[data-rustbar-close]");

  function destroy() {
    root.remove();
    if (!document.querySelector(".rustbar-overlay")) {
      document.body.style.overflow = "";
    }
  }

  return { root, video, status, allowBtn, closeBtn, destroy };
}

/**
 * @param {HTMLElement} el
 * @param {string} text
 * @param {"scanning"|"error"|""} [kind]
 */
export function setOverlayStatus(el, text, kind = "") {
  el.textContent = text;
  el.className = "rustbar-overlay__status";
  if (kind === "scanning") el.classList.add("rustbar-overlay__status--scanning");
  if (kind === "error") el.classList.add("rustbar-overlay__status--error");
}
