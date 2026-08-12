// Prompt-optimization button injected next to the Codex composer model picker.
// The button joins the composer's native action row so it follows normal
// responsive layout instead of floating above the input. The enabled flag is
// read from /settings/get at runtime, so the console switch applies without a
// Codex restart. All API traffic goes through the Codey bridge and never
// carries the configured API key into this page.
(() => {
  const moduleLoaded = window.__codeyPromptOptimizeModuleLoaded === true;
  window.__codeyPromptOptimizeModuleLoaded = true;
  if (moduleLoaded && window.__codeyPromptOptimize) {
    return;
  }

  const settingsPath = "/settings/get";
  const optimizePath = "/api/optimize_prompt";
  const applyTemplatePath = "/api/apply_prompt_optimization_template";
  const buttonId = "codey-prompt-optimize-button";
  const menuButtonId = "codey-prompt-optimize-menu-button";
  const menuId = "codey-prompt-optimize-menu";
  const styleId = "codey-prompt-optimize-style";
  const toastId = "codey-runtime-toast";
  const configChangedEvent = "codey:config-changed";
  const optimizeTimeoutMs = 75_000;
  const applyTemplateTimeoutMs = 10_000;
  const scanDelayMs = 250;
  const repositionDelayMs = 100;
  const composerAnchorSelector = "[data-above-composer-conversation-id]";
  const composerCandidateSelector =
    "textarea, [contenteditable='true'], [role='textbox']";
  const composerFallbackSelector =
    "main textarea, main [contenteditable='true'], main [role='textbox'], textarea, [contenteditable='true'][role='textbox']";
  const composerControlSelector = "button, [role='button']";
  const ignoredComposerContainerSelector =
    "dialog, [role='dialog'], [aria-modal='true']";

  let enabled = false;
  let ready = false;
  let inputElement = null;
  let button = null;
  let menuButton = null;
  let menuElement = null;
  let menuOpen = false;
  let templates = [];
  let busy = false;
  let scanTimer = 0;
  let repositionTimer = 0;
  let configLoadTimer = 0;
  let configLoadBackoffMs = 120;
  let configLoadAttempts = 0;
  let observer = null;
  let trackedScrollRoot = null;

  const MAX_CONFIG_LOAD_ATTEMPTS = 10;

  const callBridge = (path, payload = {}) => {
    if (typeof window.__codexSessionDeleteBridge === "function") {
      return window.__codexSessionDeleteBridge(path, payload);
    }
    return Promise.reject(new Error("Codey bridge 尚未就绪"));
  };

  const withTimeout = (promise, ms, message) => {
    let timer = 0;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: "failed", message }), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };

  const addStyle = () => {
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      #${buttonId}, #${menuButtonId} {
        -webkit-app-region: no-drag !important;
        pointer-events: auto !important;
        position: relative !important;
        z-index: 1 !important;
        display: none;
        flex: 0 0 auto;
        align-items: center;
        gap: 4px;
        box-sizing: border-box;
        min-height: 28px !important;
        height: 28px !important;
        margin: 0 6px 0 0;
        border: 0;
        border-radius: 999px;
        background: rgba(30, 30, 30, .92);
        color: #f5f5f5;
        font: 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
        cursor: pointer;
        user-select: none;
        box-shadow: 0 1px 4px rgba(0, 0, 0, .35);
        opacity: .88;
        transition: opacity .15s ease, transform .15s ease;
      }
      #${buttonId} { padding: 0 8px; }
      #${menuButtonId} { padding: 0 5px; margin-left: -6px; width: 22px; }
      #${buttonId}:hover, #${menuButtonId}:hover { opacity: 1; }
      #${buttonId}:active, #${menuButtonId}:active { transform: translateY(1px); }
      #${buttonId}:disabled, #${menuButtonId}:disabled { cursor: not-allowed; box-shadow: none; opacity: .42; }
      #${buttonId}[data-busy="true"] { cursor: wait; opacity: .7; }
      #${buttonId} svg, #${menuButtonId} svg { flex: 0 0 auto; width: 12px; height: 12px; }
      #${buttonId} [data-codey-optimize-spinner] { display: none; animation: codey-prompt-optimize-spin .75s linear infinite; }
      #${buttonId}[data-busy="true"] [data-codey-optimize-icon] { display: none; }
      #${buttonId}[data-busy="true"] [data-codey-optimize-spinner] { display: block; }
      @keyframes codey-prompt-optimize-spin { to { transform: rotate(360deg); } }
      #${menuId} {
        -webkit-app-region: no-drag !important;
        position: fixed !important;
        z-index: 2147483642 !important;
        display: none;
        box-sizing: border-box;
        min-width: 140px;
        max-width: 260px;
        padding: 4px;
        border-radius: 10px;
        background: rgba(30, 30, 30, .96);
        box-shadow: 0 6px 20px rgba(0, 0, 0, .45);
      }
      #${menuId} button {
        display: block;
        width: 100%;
        box-sizing: border-box;
        padding: 7px 10px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: #f5f5f5;
        font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
        text-align: left;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #${menuId} button:hover { background: rgba(127, 127, 127, .25); }
      #${toastId} { -webkit-app-region: no-drag !important; position: fixed; right: 20px; bottom: 22px; z-index: 2147483645; max-width: 360px; border: 1px solid rgba(124, 140, 255, .4); border-radius: 11px; padding: 10px 13px; background: rgba(20, 24, 36, .97); color: #eef2ff; box-shadow: 0 12px 36px rgba(0,0,0,.4); font: 12px/1.45 system-ui, sans-serif; }
      #${toastId}[data-tone="error"] { border-color: rgba(248, 113, 113, .6); color: #fecaca; }
    `;
    document.documentElement.appendChild(style);
  };

  const createButton = () => {
    const element = document.createElement("button");
    element.id = buttonId;
    element.type = "button";
    element.dataset.codeyPromptOptimize = "true";
    element.setAttribute("aria-label", "优化提示词");
    element.setAttribute("aria-disabled", "true");
    element.setAttribute("aria-busy", "false");
    element.disabled = true;
    element.innerHTML = `
      <svg data-codey-optimize-icon viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"></path>
        <path d="M19 15l.9 2.4L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.6z"></path>
      </svg>
      <svg data-codey-optimize-spinner viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none"
        stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <path d="M20 12a8 8 0 1 1-5.3-7.5"></path>
      </svg>
      <span>优化</span>
    `;
    element.addEventListener("click", handleClick, true);
    return element;
  };

  const createMenuButton = () => {
    const element = document.createElement("button");
    element.id = menuButtonId;
    element.type = "button";
    element.dataset.codeyPromptOptimize = "true";
    element.setAttribute("aria-label", "选择优化指令模板");
    element.setAttribute("aria-haspopup", "menu");
    element.setAttribute("aria-expanded", "false");
    element.disabled = true;
    element.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 9l6 6 6-6"></path>
      </svg>
    `;
    element.addEventListener("click", handleMenuButtonClick, true);
    return element;
  };

  const createMenu = () => {
    const element = document.createElement("div");
    element.id = menuId;
    element.dataset.codeyPromptOptimize = "true";
    element.setAttribute("role", "menu");
    element.style.display = "none";
    document.documentElement.appendChild(element);
    return element;
  };

  const renderMenu = () => {
    if (!menuElement) menuElement = createMenu();
    menuElement.innerHTML = "";
    const items = [
      { id: "default", name: "默认指令" },
      ...templates.map((template) => ({
        id: template.id,
        name: template.name,
      })),
    ];
    for (const item of items) {
      const itemElement = document.createElement("button");
      itemElement.type = "button";
      itemElement.dataset.codeyPromptOptimize = "true";
      itemElement.setAttribute("role", "menuitem");
      itemElement.textContent = item.name;
      itemElement.addEventListener(
        "click",
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          closeMenu();
          applyTemplateAndOptimize(item.id);
        },
        true,
      );
      menuElement.appendChild(itemElement);
    }
  };

  const positionMenu = () => {
    if (!menuElement || !menuButton) return;
    const rect = menuButton.getBoundingClientRect();
    menuElement.style.top = `${rect.bottom + 4}px`;
    menuElement.style.left = `${Math.max(
      4,
      Math.min(rect.left, window.innerWidth - menuElement.offsetWidth - 4),
    )}px`;
  };

  const openMenu = () => {
    if (busy || templates.length === 0) return;
    renderMenu();
    menuOpen = true;
    menuElement.style.display = "block";
    menuButton.setAttribute("aria-expanded", "true");
    positionMenu();
  };

  const closeMenu = () => {
    menuOpen = false;
    if (menuElement) menuElement.style.display = "none";
    if (menuButton) menuButton.setAttribute("aria-expanded", "false");
  };

  const handleMenuButtonClick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy || !readComposerText().trim()) return;
    if (menuOpen) {
      closeMenu();
    } else {
      openMenu();
    }
  };

  const installRuntimeToast = () => {
    if (typeof window.__codeyShowRuntimeToast === "function") return;
    window.__codeyShowRuntimeToast = (message, tone = "success") => {
      document.getElementById(toastId)?.remove();
      const toast = document.createElement("div");
      toast.id = toastId;
      toast.dataset.tone = tone;
      toast.setAttribute("role", tone === "error" ? "alert" : "status");
      toast.setAttribute(
        "aria-live",
        tone === "error" ? "assertive" : "polite",
      );
      toast.textContent = message;
      document.documentElement.appendChild(toast);
      setTimeout(() => toast.remove(), tone === "error" ? 8_000 : 3_500);
    };
  };

  const isComposerInput = (element) => {
    if (!element) return false;
    if (element.tagName === "TEXTAREA") return true;
    if (element.isContentEditable === true) return true;
    if (element.getAttribute?.("contenteditable") === "true") return true;
    return element.getAttribute?.("role") === "textbox";
  };

  const isVisible = (element) => {
    if (!isComposerInput(element)) return false;
    if (element.closest?.(ignoredComposerContainerSelector)) return false;
    if (element.closest?.("[hidden], [aria-hidden='true']")) return false;
    if (element.disabled) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const findComposerInput = () => {
    const seen = new Set();
    for (const anchor of document.querySelectorAll(composerAnchorSelector)) {
      if (seen.has(anchor)) continue;
      seen.add(anchor);
      const scope = anchor.parentElement || anchor;
      const candidates = [...scope.querySelectorAll(composerCandidateSelector)];
      for (const candidate of candidates) {
        if (isVisible(candidate)) return candidate;
      }
    }
    // New conversations do not have a conversation-id anchor yet. Prefer the
    // lowest visible editable textbox, then its area, so the composer wins over
    // search fields and historical message editors.
    let best = null;
    let bestScore = -1;
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight || 0;
    for (const candidate of document.querySelectorAll(
      composerFallbackSelector,
    )) {
      if (!isVisible(candidate)) continue;
      const rect = candidate.getBoundingClientRect();
      if (
        viewportHeight > 0 &&
        (rect.bottom <= 0 || rect.top >= viewportHeight)
      )
        continue;
      const area = rect.width * rect.height;
      const score =
        Math.max(0, rect.bottom) * 10_000 + Math.min(area, 9_999_999);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  };

  const controlDescriptor = (element) =>
    [
      element?.getAttribute?.("aria-label"),
      element?.getAttribute?.("title"),
      element?.getAttribute?.("data-testid"),
      element?.textContent,
      element?.innerText,
    ]
      .filter((value) => typeof value === "string" && value.trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

  const isVisibleControl = (element) => {
    if (!element || element === button) return false;
    if (element.closest?.(ignoredComposerContainerSelector)) return false;
    if (element.closest?.("[hidden], [aria-hidden='true']")) return false;
    if (element.disabled) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const modelControlScore = (control, inputRect) => {
    const rect = control.getBoundingClientRect();
    const descriptor = controlDescriptor(control);
    const visibleText = [control.textContent, control.innerText]
      .filter((value) => typeof value === "string" && value.trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const hasModelHint = /(^|[^a-z])model([^a-z]|$)|模型/i.test(descriptor);
    if (!hasModelHint && !visibleText) return Number.NEGATIVE_INFINITY;
    if (
      !hasModelHint &&
      /完全访问|full access|附件|attach|上传|upload|优化/i.test(descriptor)
    ) {
      return Number.NEGATIVE_INFINITY;
    }
    if (
      !hasModelHint &&
      inputRect.width > 0 &&
      rect.right < inputRect.left + inputRect.width * 0.45
    ) {
      return Number.NEGATIVE_INFINITY;
    }
    return (
      (hasModelHint ? 1_000_000 : 0) +
      (control.getAttribute?.("aria-haspopup") ? 100_000 : 0) +
      Math.max(0, rect.right) * 10 +
      Math.min(rect.width, 500)
    );
  };

  const findModelInsertionTarget = () => {
    if (!inputElement?.parentElement) return null;
    const inputRect = inputElement.getBoundingClientRect();
    const seen = new Set();
    let bestControl = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    let scope = inputElement.parentElement;
    let depth = 0;
    while (scope && depth < 8) {
      for (const control of scope.querySelectorAll?.(composerControlSelector) ||
        []) {
        if (seen.has(control) || !isVisibleControl(control)) continue;
        seen.add(control);
        const score = modelControlScore(control, inputRect);
        if (score > bestScore) {
          bestControl = control;
          bestScore = score;
        }
      }
      if (bestScore >= 1_000_000) break;
      scope = scope.parentElement;
      depth += 1;
    }
    if (!bestControl) return null;

    let anchor = bestControl;
    let host = bestControl.parentElement;
    while (host?.parentElement && host.children?.length === 1) {
      anchor = host;
      host = host.parentElement;
    }
    if (!host?.insertBefore) return null;
    return { anchor, host };
  };

  const isMountedBefore = (element, anchor, host) => {
    if (element?.parentElement !== host) return false;
    const children = [...(host.children || [])];
    return children.indexOf(element) + 1 === children.indexOf(anchor);
  };

  const updateButtonPosition = () => {
    if (!button || !inputElement) return;
    if (!isVisible(inputElement)) {
      inputElement = null;
      button.style.display = "none";
      scheduleScan();
      return;
    }
    const target = findModelInsertionTarget();
    if (!target) {
      button.style.display = "none";
      return;
    }
    if (!isMountedBefore(button, target.anchor, target.host)) {
      target.host.insertBefore(button, target.anchor);
    }
    if (templates.length > 0) {
      if (!menuButton) menuButton = createMenuButton();
      if (button.nextElementSibling !== menuButton) {
        target.host.insertBefore(menuButton, button.nextElementSibling);
      }
    } else if (menuButton) {
      menuButton.remove();
      menuButton = null;
      closeMenu();
    }
    button.style.top = "";
    button.style.left = "";
    button.style.display = "inline-flex";
    button.dataset.codeyPromptOptimizeLayout = "model-picker";
    updateButtonState();
  };

  const readComposerText = () => {
    if (!inputElement) return "";
    if (inputElement.tagName === "TEXTAREA") {
      return inputElement.value;
    }
    return inputElement.innerText || "";
  };

  const updateButtonState = () => {
    if (!button) return;
    const empty = !readComposerText().trim();
    const disabled = busy || empty;
    button.disabled = disabled;
    button.dataset.busy = String(busy);
    button.dataset.empty = String(empty);
    button.setAttribute("aria-busy", String(busy));
    button.setAttribute("aria-disabled", String(disabled));
    button.setAttribute(
      "aria-label",
      busy ? "正在优化提示词" : empty ? "请输入内容后优化" : "优化提示词",
    );
    if (menuButton) {
      const menuDisabled = busy || empty;
      menuButton.disabled = menuDisabled;
      if (menuDisabled) closeMenu();
    }
  };

  const showError = (message) => {
    window.__codeyShowRuntimeToast?.(message, "error");
  };

  const replaceComposerText = (text) => {
    if (inputElement.tagName === "TEXTAREA") {
      const prototype = window.HTMLTextAreaElement?.prototype;
      const setter =
        prototype && Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) {
        setter.call(inputElement, text);
      } else {
        inputElement.value = text;
      }
      inputElement.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    inputElement.innerText = text;
    inputElement.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }),
    );
  };

  const optimizeWithCurrentConfig = (text) => {
    // `optimize_prompt` only ever receives the composer text; the active
    // instruction always comes from the persisted configuration.
    const bridgeCall = callBridge(optimizePath, { text });
    return withTimeout(
      bridgeCall,
      optimizeTimeoutMs,
      "优化请求超时，请稍后重试",
    ).then((value) => {
      if (value?.status === "failed") {
        throw new Error(value.message || "优化失败");
      }
      const optimized =
        typeof value?.optimized === "string" ? value.optimized : "";
      if (!optimized) {
        throw new Error("优化结果为空");
      }
      replaceComposerText(optimized);
      if (inputElement?.focus) inputElement.focus();
    });
  };

  const applyTemplateAndOptimize = (templateId) => {
    const text = readComposerText().trim();
    if (!text) return;
    busy = true;
    updateButtonState();
    const applyCall = callBridge(applyTemplatePath, { templateId });
    withTimeout(applyCall, applyTemplateTimeoutMs, "切换指令模板超时")
      .then((value) => {
        if (value?.status === "failed") {
          throw new Error(value.message || "切换指令模板失败");
        }
        return optimizeWithCurrentConfig(text);
      })
      .catch((error) => {
        const message =
          error instanceof Error
            ? error.message
            : String(error || "切换指令模板失败");
        showError(message);
      })
      .finally(() => {
        busy = false;
        updateButtonState();
      });
  };

  const handleClick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    const text = readComposerText().trim();
    if (!text) {
      updateButtonState();
      return;
    }
    busy = true;
    updateButtonState();
    optimizeWithCurrentConfig(text)
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : String(error || "优化失败");
        showError(message);
      })
      .finally(() => {
        busy = false;
        updateButtonState();
      });
  };

  const refreshButton = () => {
    if (!enabled) {
      if (button) button.style.display = "none";
      return;
    }
    const input = findComposerInput();
    if (input === inputElement && input) {
      updateButtonPosition();
      return;
    }
    inputElement = input || null;
    if (!inputElement) {
      if (button) button.style.display = "none";
      return;
    }
    if (!button) {
      button = createButton();
    }
    updateButtonPosition();
  };

  const scheduleScan = () => {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      refreshButton();
    }, scanDelayMs);
  };

  const scheduleReposition = () => {
    clearTimeout(repositionTimer);
    repositionTimer = setTimeout(updateButtonPosition, repositionDelayMs);
  };

  const loadConfig = () => {
    configLoadAttempts += 1;
    callBridge(settingsPath, {})
      .then((config) => {
        configLoadAttempts = 0;
        configLoadBackoffMs = 120;
        let nextEnabled = false;
        try {
          const optimization = config?.promptOptimization;
          nextEnabled =
            optimization?.enabled === true &&
            optimization.apiKeyConfigured === true;
          const nextTemplates = Array.isArray(optimization?.templates)
            ? optimization.templates
                .filter(
                  (template) =>
                    template && template.id && template.name,
                )
                .map((template) => ({
                  id: template.id,
                  name: template.name,
                }))
            : [];
          if (nextTemplates.length !== templates.length) {
            templates = nextTemplates;
          }
          if (nextEnabled !== enabled) {
            enabled = nextEnabled;
            refreshButton();
          }
          if (enabled) refreshButton();
        } catch (error) {
          // A script-side error must not look like a missing bridge; report
          // it once and leave the switch in its last known state.
          if (
            typeof console !== "undefined" &&
            typeof console.error === "function"
          ) {
            console.error("Codey 提示词优化脚本异常：", error);
          }
        }
        ready = true;
      })
      .catch(() => {
        // The bridge may not be ready during early startup; retry with
        // bounded backoff so the switch still applies once it is.
        if (configLoadAttempts >= MAX_CONFIG_LOAD_ATTEMPTS) return;
        clearTimeout(configLoadTimer);
        configLoadTimer = setTimeout(loadConfig, configLoadBackoffMs);
        configLoadBackoffMs = Math.min(configLoadBackoffMs * 2, 2_000);
      });
  };

  const installObserver = () => {
    observer = new MutationObserver((mutations) => {
      if (!enabled) return;
      const hasExternalMutation = mutations.some((mutation) => {
        const target = mutation.target;
        if (!target) return true;
        if (target === button || target.id === toastId) return false;
        if (target.id === styleId || target.id === menuId) return false;
        return !target.closest?.(
          `#${buttonId}, #${menuButtonId}, #${toastId}, #${menuId}`,
        );
      });
      if (hasExternalMutation) scheduleScan();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "aria-hidden",
        "class",
        "contenteditable",
        "data-above-composer-conversation-id",
        "disabled",
        "hidden",
        "role",
        "style",
      ],
    });
  };

  window.addEventListener(configChangedEvent, () => {
    ready = false;
    loadConfig();
  });
  window.addEventListener("scroll", scheduleReposition, true);
  window.addEventListener("resize", scheduleReposition);
  window.addEventListener("hashchange", scheduleScan);
  window.addEventListener("popstate", scheduleScan);
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!menuOpen) return;
      if (event.target?.closest?.(`#${menuId}, #${menuButtonId}`)) return;
      closeMenu();
    },
    true,
  );
  document.addEventListener(
    "input",
    (event) => {
      if (event.target === inputElement) updateButtonState();
    },
    true,
  );

  addStyle();
  installRuntimeToast();
  installObserver();
  loadConfig();

  window.__codeyPromptOptimize = {
    snapshot: () => ({
      ready: ready,
      enabled: enabled,
      hasInput: Boolean(inputElement && isVisible(inputElement)),
      hasButton: Boolean(button && button.style.display !== "none"),
      hasTemplates: templates.length > 0,
      buttonBusy: Boolean(button && busy),
      buttonDisabled: Boolean(button?.disabled),
    }),
  };
})();
