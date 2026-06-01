/**
 * Injectable full-screen scanner overlay DOM (Scanbot-style).
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
 *   finderHint: HTMLElement;
 *   allowBtn: HTMLButtonElement;
 *   closeBtn: HTMLButtonElement;
 *   torchBtn: HTMLButtonElement;
 *   resultPanel: HTMLElement;
 *   resultThumb: HTMLImageElement;
 *   resultFormat: HTMLElement;
 *   resultText: HTMLElement;
 *   resultCloseBtn: HTMLButtonElement;
 *   resultCopyBtn: HTMLButtonElement;
 *   destroy: () => void;
 * }}
 */
export function createScannerOverlay() {
  ensureStyles();

  const root = document.createElement("div");
  root.className = "rustbar-overlay";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Barcode scanner");
  root.innerHTML = `
    <video class="rustbar-overlay__video" playsinline muted autoplay></video>
    <div class="rustbar-overlay__scrim-top" aria-hidden="true"></div>
    <div class="rustbar-overlay__scrim-bottom" aria-hidden="true"></div>
    <header class="rustbar-overlay__header">
      <button type="button" class="rustbar-overlay__icon-btn rustbar-overlay__torch" hidden data-rustbar-torch aria-label="Flashlight">&#128161;</button>
      <button type="button" class="rustbar-overlay__icon-btn" data-rustbar-close aria-label="Close">&times;</button>
    </header>
    <div class="rustbar-overlay__frame-layer" aria-hidden="true">
      <p class="rustbar-overlay__finder-hint">Move the finder over a barcode</p>
      <span class="rustbar-overlay__corner rustbar-overlay__corner--tl"></span>
      <span class="rustbar-overlay__corner rustbar-overlay__corner--tr"></span>
      <span class="rustbar-overlay__corner rustbar-overlay__corner--bl"></span>
      <span class="rustbar-overlay__corner rustbar-overlay__corner--br"></span>
    </div>
    <p class="rustbar-overlay__status" role="status">Starting camera…</p>
    <button type="button" class="rustbar-overlay__allow" hidden data-rustbar-allow>Allow camera</button>
    <div class="rustbar-overlay__result" hidden data-rustbar-result>
      <div class="rustbar-overlay__result-row">
        <img class="rustbar-overlay__result-thumb" alt="" data-rustbar-thumb />
        <div class="rustbar-overlay__result-body">
          <p class="rustbar-overlay__result-format" data-rustbar-format></p>
          <p class="rustbar-overlay__result-text" data-rustbar-text></p>
        </div>
      </div>
      <div class="rustbar-overlay__result-actions">
        <button type="button" class="rustbar-overlay__result-btn rustbar-overlay__result-btn--secondary" data-rustbar-result-close>Close</button>
        <button type="button" class="rustbar-overlay__result-btn rustbar-overlay__result-btn--primary" data-rustbar-result-copy>Copy</button>
      </div>
    </div>
  `;

  document.body.appendChild(root);
  document.body.style.overflow = "hidden";

  return {
    root,
    video: root.querySelector(".rustbar-overlay__video"),
    status: root.querySelector(".rustbar-overlay__status"),
    finderHint: root.querySelector(".rustbar-overlay__finder-hint"),
    allowBtn: root.querySelector("[data-rustbar-allow]"),
    closeBtn: root.querySelector("[data-rustbar-close]"),
    torchBtn: root.querySelector("[data-rustbar-torch]"),
    resultPanel: root.querySelector("[data-rustbar-result]"),
    resultThumb: root.querySelector("[data-rustbar-thumb]"),
    resultFormat: root.querySelector("[data-rustbar-format]"),
    resultText: root.querySelector("[data-rustbar-text]"),
    resultCloseBtn: root.querySelector("[data-rustbar-result-close]"),
    resultCopyBtn: root.querySelector("[data-rustbar-result-copy]"),
    destroy() {
      root.remove();
      if (!document.querySelector(".rustbar-overlay")) {
        document.body.style.overflow = "";
      }
    },
  };
}

/**
 * @param {HTMLElement} el
 * @param {string} text
 * @param {"scanning"|"error"|""} [kind]
 */
export function setOverlayStatus(el, text, kind = "") {
  el.textContent = text;
  el.hidden = !text;
  el.className = "rustbar-overlay__status";
  if (kind === "scanning") el.classList.add("rustbar-overlay__status--scanning");
  if (kind === "error") el.classList.add("rustbar-overlay__status--error");
}

/**
 * @param {object} ui - overlay from createScannerOverlay
 * @param {{ text: string, format: string, thumbUrl?: string }} result
 */
export function showResultSheet(ui, result) {
  ui.resultFormat.textContent = result.format.replace(/_/g, " ");
  ui.resultText.textContent = result.text;
  if (result.thumbUrl) {
    ui.resultThumb.src = result.thumbUrl;
    ui.resultThumb.hidden = false;
  } else {
    ui.resultThumb.removeAttribute("src");
    ui.resultThumb.hidden = true;
  }
  ui.status.hidden = true;
  ui.finderHint.hidden = true;
  ui.resultPanel.hidden = false;
}

export function hideResultSheet(ui) {
  ui.resultPanel.hidden = true;
  ui.finderHint.hidden = false;
}
