(() => {
  "use strict";

  if (window.__pathVaultContentLoaded) return;
  window.__pathVaultContentLoaded = true;

  let appConfig = {
    initialized: false,
    unlocked: false,
    recording: false,
    origin: location.origin,
    pathPrefix: "",
    appKey: location.origin,
    depth: 1
  };
  let lastCaptureAt = 0;
  let autoFillTimer = null;
  let overlayHost = null;
  let overlayShadow = null;
  let overlayHideTimer = null;
  let attemptedPasswords = new WeakSet();
  let lastUrl = location.href;
  let isFilling = false;
  let loginInteractionAt = 0;
  let pendingCredential = null;

  function isVisible(element) {
    if (!(element.offsetWidth || element.offsetHeight || element.getClientRects().length)) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse";
  }

  function isPasswordInput(input) {
    const type = (input.type || "text").toLowerCase();
    const haystack = [
      input.name,
      input.id,
      input.autocomplete,
      input.placeholder,
      input.className
    ].join(" ").toLowerCase();
    return type === "password" || /password|passwd|pwd|密码/.test(haystack);
  }

  function passwordFields() {
    return Array.from(document.querySelectorAll("input"))
      .filter(isVisible)
      .filter((input) => !input.disabled)
      .filter(isPasswordInput);
  }

  function collectUsernameCandidates(scope, password) {
    const inputs = Array.from(scope.querySelectorAll("input"))
      .filter(isVisible)
      .filter((input) => !input.disabled)
      .filter((input) => input !== password)
      .filter((input) => {
        const type = (input.type || "text").toLowerCase();
        return ["text", "email", "tel", "search"].includes(type);
      });

    const named = inputs.filter((input) => {
      const haystack = [
        input.name,
        input.id,
        input.autocomplete,
        input.placeholder,
        input.className
      ].join(" ").toLowerCase();
      return /user|account|login|email|phone|mobile|username|账号|用户名|登录名|手机号/.test(haystack) &&
        !/code|captcha|sms|verify|验证码/.test(haystack);
    });

    if (named.length > 0) return named;
    const beforePassword = inputs.filter((input) => {
      return input.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    return beforePassword.length > 0 ? beforePassword : inputs;
  }

  function findLoginFields() {
    const passwords = passwordFields();
    if (passwords.length !== 1) return null;
    const password = passwords[0];
    const form = password.closest("form");
    const text = [
      form?.innerText || "",
      form?.getAttribute("data-title") || "",
      document.title
    ].join(" ").toLowerCase();
    if (/新密码|确认密码|修改密码|重置密码|旧密码|new password|confirm password|change password|reset password/.test(text)) {
      return null;
    }
    let candidates = collectUsernameCandidates(form || document, password);
    if (candidates.length === 0 && form) {
      candidates = collectUsernameCandidates(document, password);
    }
    const username = candidates.length > 0 ? candidates[candidates.length - 1] : null;
    return { username, password };
  }

  function looksLikeLoginContext(fields) {
    const form = fields.password.closest("form") || document.body || document.documentElement;
    const text = [
      location.href,
      document.title,
      form?.innerText || ""
    ].join(" ").toLowerCase();
    if (/login|signin|sign-in|登录|登陆/.test(text)) return true;

    const controls = Array.from((form || document).querySelectorAll(
      "button, input[type='submit'], a, [role='button'], .mini-button, .e-btn, .btn"
    ));
    return controls.some((control) => {
      const label = [
        control.innerText || "",
        control.value || "",
        control.title || "",
        control.getAttribute("aria-label") || ""
      ].join(" ").toLowerCase();
      return /登录|登陆|login|sign\s*in|submit/.test(label);
    });
  }

  function getFormInfo(usePending = true) {
    const fields = findLoginFields();
    if (fields) {
      const info = {
        url: location.href,
        username: fields.username ? fields.username.value : "",
        password: fields.password.value,
        likelyLogin: looksLikeLoginContext(fields)
      };
      if (info.password) {
        pendingCredential = { ...info, savedAt: Date.now() };
      }
      if (!info.password && usePending && pendingCredential &&
        Date.now() - pendingCredential.savedAt < 5 * 60 * 1000) {
        return pendingCredential;
      }
      return info;
    }
    if (usePending && pendingCredential &&
      Date.now() - pendingCredential.savedAt < 5 * 60 * 1000) {
      return pendingCredential;
    }
    return null;
  }

  function setNativeValue(input, value) {
    if (input instanceof HTMLInputElement && input.readOnly) {
      input.readOnly = false;
    }
    const prototype = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function fillCredentials(username, password) {
    const fields = findLoginFields();
    if (!fields) return false;
    isFilling = true;
    try {
      if (fields.username && username) {
        setNativeValue(fields.username, username);
      }
      setNativeValue(fields.password, password);
      fields.password.focus();
    } finally {
      isFilling = false;
    }
    return true;
  }

  window.__pathVaultGetForm = getFormInfo;
  window.__pathVaultFill = fillCredentials;
  window.__pathVaultForceAutoFill = () => {
    attemptedPasswords = new WeakSet();
    refreshConfig();
    scheduleAutoFill(50);
    return true;
  };

  function refreshConfig() {
    chrome.runtime.sendMessage({
      type: "getAppConfig",
      url: location.href
    }).then((response) => {
      if (!response?.ok || !response.config) return;
      appConfig = response.config;
      if (!appConfig.unlocked || appConfig.autofill === false) {
        removeOverlay();
      } else {
        scheduleAutoFill(100);
      }
    }).catch(() => {});
  }

  function stagePendingCredential(intent = false) {
    const info = getFormInfo(true);
    if (!info || !info.password || !info.likelyLogin) return false;
    chrome.runtime.sendMessage({
      type: "stageCredential",
      url: info.url,
      username: info.username,
      password: info.password,
      likelyLogin: true,
      intent
    }).catch(() => {});
    return true;
  }

  function captureIfEnabled() {
    if (isFilling) return;
    if (!appConfig.recording || !appConfig.unlocked) return;
    const shouldCommit = Date.now() - lastCaptureAt >= 1500;
    const info = getFormInfo(true);
    if (info) {
      if (!info.likelyLogin) return;
      loginInteractionAt = Date.now();
      chrome.runtime.sendMessage({
        type: "stageCredential",
        url: info.url,
        username: info.username,
        password: info.password,
        likelyLogin: true,
        intent: true
      }).then(() => {
        if (!shouldCommit) return null;
        lastCaptureAt = Date.now();
        return chrome.runtime.sendMessage({
          type: "commitCredential",
          url: info.url,
          username: info.username,
          password: info.password
        });
      }).catch(() => {});
      return;
    }
    chrome.runtime.sendMessage({
      type: "captureAnyFrame",
      url: location.href
    }).catch(() => {});
  }

  function removeOverlay() {
    if (overlayHideTimer) {
      clearTimeout(overlayHideTimer);
      overlayHideTimer = null;
    }
    if (overlayHost?.isConnected) {
      overlayHost.remove();
    }
    overlayHost = null;
    overlayShadow = null;
  }

  function ensureOverlay() {
    if (overlayHost?.isConnected && overlayShadow) return overlayShadow;

    overlayHost = document.createElement("div");
    overlayHost.style.setProperty("all", "initial", "important");
    overlayHost.style.setProperty("position", "fixed", "important");
    overlayHost.style.setProperty("right", "18px", "important");
    overlayHost.style.setProperty("bottom", "18px", "important");
    overlayHost.style.setProperty("z-index", "2147483647", "important");
    overlayHost.style.setProperty("display", "block", "important");
    overlayShadow = overlayHost.attachShadow({ mode: "closed" });
    document.documentElement.appendChild(overlayHost);
    return overlayShadow;
  }

  function createPanel() {
    const panel = document.createElement("div");
    panel.style.cssText = [
      "all:initial",
      "box-sizing:border-box",
      "min-width:230px",
      "padding:12px",
      "border:1px solid #cbd5e1",
      "border-radius:10px",
      "background:#ffffff",
      "box-shadow:0 10px 30px rgba(15,23,42,.22)",
      "font:13px/1.4 'Segoe UI','Microsoft YaHei',system-ui,sans-serif",
      "color:#1f2937"
    ].join(";");
    return panel;
  }

  function createTitle(text) {
    const title = document.createElement("div");
    title.textContent = text;
    title.style.cssText = "all:initial;display:block;margin:0 0 8px;font:600 13px/1.4 'Segoe UI','Microsoft YaHei',system-ui,sans-serif;color:#1f2937;";
    return title;
  }

  function showFilledNotice(username) {
    const shadow = ensureOverlay();
    shadow.textContent = "";
    const panel = createPanel();
    const title = createTitle("应用级密码库");
    const message = document.createElement("div");
    message.textContent = `已自动填充：${username || "(未识别用户名)"}`;
    message.style.cssText = "all:initial;display:block;font:12px/1.5 'Segoe UI','Microsoft YaHei',system-ui,sans-serif;color:#475569;";
    panel.append(title, message);
    shadow.appendChild(panel);
    overlayHideTimer = setTimeout(removeOverlay, 2500);
  }

  function showAccountSelector(entries, selectedEntryId, appKey) {
    const shadow = ensureOverlay();
    shadow.textContent = "";

    const panel = createPanel();
    const title = createTitle("应用级密码库");
    const hint = document.createElement("div");
    hint.textContent = "选择要自动填充的账号";
    hint.style.cssText = "all:initial;display:block;margin-bottom:7px;font:12px/1.4 'Segoe UI','Microsoft YaHei',system-ui,sans-serif;color:#64748b;";

    const select = document.createElement("select");
    select.style.cssText = [
      "all:initial",
      "box-sizing:border-box",
      "width:100%",
      "padding:7px 8px",
      "border:1px solid #cbd5e1",
      "border-radius:7px",
      "background:#ffffff",
      "color:#1f2937",
      "font:13px/1.4 'Segoe UI','Microsoft YaHei',system-ui,sans-serif"
    ].join(";");

    for (const entry of entries) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.username || "(未识别用户名)";
      option.selected = entry.id === selectedEntryId;
      select.appendChild(option);
    }

    const status = document.createElement("div");
    status.style.cssText = "all:initial;display:block;min-height:17px;margin-top:6px;font:12px/1.4 'Segoe UI','Microsoft YaHei',system-ui,sans-serif;color:#64748b;";

    select.addEventListener("change", async () => {
      status.textContent = "正在填充...";
      try {
        const response = await chrome.runtime.sendMessage({
          type: "getCredential",
          url: location.href,
          entryId: select.value
        });
        if (!response?.ok) throw new Error(response?.error || "读取记录失败");
        if (!fillCredentials(response.username, response.password)) {
          throw new Error("当前页面没有可填充的表单");
        }
        status.textContent = "已填充所选账号";
        chrome.runtime.sendMessage({
          type: "setDefaultEntry",
          appKey,
          entryId: select.value
        }).catch(() => {});
      } catch (error) {
        status.textContent = error.message || "填充失败";
      }
    });

    panel.append(title, hint, select, status);
    shadow.appendChild(panel);
  }

  async function fillByEntryId(entryId) {
    const response = await chrome.runtime.sendMessage({
      type: "getCredential",
      url: location.href,
      entryId
    });
    if (!response?.ok) {
      if (response?.code === "LOCKED") appConfig.unlocked = false;
      throw new Error(response?.error || "读取记录失败");
    }

    const fields = findLoginFields();
    if (!fields) return false;
    const usernameMatches = !fields.username ||
      !response.username ||
      fields.username.value === response.username;
    const passwordMatches = fields.password.value === response.password;
    if (usernameMatches && passwordMatches) return true;
    if (document.activeElement === fields.password && fields.password.value) {
      return false;
    }
    return fillCredentials(response.username, response.password);
  }

  async function tryAutoFill() {
    if (Date.now() - loginInteractionAt < 60000) return;
    if (!appConfig.unlocked) return;
    if (appConfig.autofill === false) {
      removeOverlay();
      return;
    }
    const fields = findLoginFields();
    if (!fields || !looksLikeLoginContext(fields)) {
      if (overlayHost) removeOverlay();
      return;
    }
    if (attemptedPasswords.has(fields.password)) return;
    attemptedPasswords.add(fields.password);

    const response = await chrome.runtime.sendMessage({
      type: "getAutoFill",
      url: location.href
    });
    if (!response?.ok) {
      if (response?.code === "LOCKED") appConfig.unlocked = false;
      return;
    }
    if (!response.enabled || !response.entries?.length) return;

    const entryId = response.defaultEntryId || response.entries[0].id;
    const filled = await fillByEntryId(entryId);
    if (!filled) return;

    if (response.entries.length > 1) {
      showAccountSelector(response.entries, entryId, response.appKey);
    } else {
      showFilledNotice(response.entries[0].username);
    }
  }

  function scheduleAutoFill(delay = 350) {
    if (autoFillTimer) clearTimeout(autoFillTimer);
    autoFillTimer = setTimeout(() => {
      autoFillTimer = null;
      tryAutoFill().catch(() => {});
    }, delay);
  }

  function handleUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    attemptedPasswords = new WeakSet();
    pendingCredential = null;
    removeOverlay();
    scheduleAutoFill(650);
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.type === "configUpdate" && request.config) {
      appConfig = request.config;
      if (!appConfig.unlocked || appConfig.autofill === false) removeOverlay();
      scheduleAutoFill(150);
      sendResponse({ ok: true });
      return false;
    }
    if (request.type === "getForm") {
      sendResponse(getFormInfo());
      return false;
    }
    if (request.type === "fillCredentials") {
      sendResponse({
        filled: fillCredentials(request.username, request.password)
      });
      return false;
    }
    return false;
  });

  window.addEventListener("submit", (event) => {
    if (!event.defaultPrevented) captureIfEnabled();
  }, true);

  function isLoginControl(control) {
    const type = (control.getAttribute("type") || "").toLowerCase();
    const label = [
      control.innerText || "",
      control.value || "",
      control.title || "",
      control.getAttribute("aria-label") || ""
    ].join(" ").replace(/\s+/g, "").toLowerCase();
    const attrs = [
      typeof control.className === "string" ? control.className : "",
      control.id || "",
      control.getAttribute("name") || "",
      control.getAttribute("href") || ""
    ].join(" ").toLowerCase();
    const inForm = Boolean(control.closest("form"));
    return type === "submit" ||
      (control.tagName === "BUTTON" && !type && inForm) ||
      /登录|登陆|login|signin|sign-in|submit|提交|确定/.test(label) ||
      /submit|signin|sign-in|login-btn|login-submit|btn|button/.test(attrs);
  }

  function findLoginControl(target) {
    let node = target instanceof Element ? target : null;
    while (node) {
      if (isLoginControl(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  document.addEventListener("mousedown", (event) => {
    if (findLoginControl(event.target)) captureIfEnabled();
  }, true);

  document.addEventListener("click", (event) => {
    if (findLoginControl(event.target)) captureIfEnabled();
  }, true);

  document.addEventListener("focusin", refreshConfig, true);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const target = event.target;
    if (target instanceof HTMLInputElement && isPasswordInput(target)) {
      captureIfEnabled();
    }
  }, true);

  document.addEventListener("input", (event) => {
    if (isFilling) return;
    const target = event.target;
    if (target instanceof HTMLInputElement && isPasswordInput(target) && target.value) {
      getFormInfo();
      stagePendingCredential(false);
    }
  }, true);

  document.addEventListener("change", (event) => {
    if (isFilling) return;
    const target = event.target;
    if (target instanceof HTMLInputElement && isPasswordInput(target) && target.value) {
      stagePendingCredential(false);
    }
  }, true);

  document.addEventListener("blur", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && isPasswordInput(target) && target.value) {
      stagePendingCredential(false);
    }
  }, true);

  setInterval(() => {
    handleUrlChange();
    if (document.visibilityState === "visible") {
      stagePendingCredential(false);
      scheduleAutoFill(50);
    }
  }, 1800);

  refreshConfig();
})();


























