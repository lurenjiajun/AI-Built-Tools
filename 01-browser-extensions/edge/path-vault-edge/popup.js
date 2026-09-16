(() => {
  "use strict";

  const state = {
    tab: null,
    status: null,
    app: null
  };



  const elements = {
    versionText: document.getElementById("versionText"),
    openChangelog: document.getElementById("openChangelog"),
    stateBadge: document.getElementById("stateBadge"),
    pauseAutofill: document.getElementById("pauseAutofill"),
    rememberUnlock: document.getElementById("rememberUnlock"),
    message: document.getElementById("message"),
    setupView: document.getElementById("setupView"),
    unlockView: document.getElementById("unlockView"),
    appView: document.getElementById("appView"),
    setupPassphrase: document.getElementById("setupPassphrase"),
    setupConfirm: document.getElementById("setupConfirm"),
    createVault: document.getElementById("createVault"),
    unlockPassphrase: document.getElementById("unlockPassphrase"),
    unlockVault: document.getElementById("unlockVault"),
    originText: document.getElementById("originText"),
    prefixText: document.getElementById("prefixText"),
    appKeyText: document.getElementById("appKeyText"),
    autoFillToggle: document.getElementById("autoFillToggle"),
    recordToggle: document.getElementById("recordToggle"),
    depthSelect: document.getElementById("depthSelect"),
    saveForm: document.getElementById("saveForm"),
    forceAutoFill: document.getElementById("forceAutoFill"),
    diagnosePage: document.getElementById("diagnosePage"),
    diagnosticPanel: document.getElementById("diagnosticPanel"),
    diagnosticOutput: document.getElementById("diagnosticOutput"),
    copyDiagnostic: document.getElementById("copyDiagnostic"),
    lockNow: document.getElementById("lockNow"),
    refresh: document.getElementById("refresh"),
    entries: document.getElementById("entries"),
    exportVault: document.getElementById("exportVault"),
    importFile: document.getElementById("importFile")
  };

  elements.versionText.textContent = `v${chrome.runtime.getManifest().version}`;
  elements.openChangelog.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("changelog.html") });
  });

  function show(element) {
    element.classList.remove("hidden");
  }

  function hide(element) {
    element.classList.add("hidden");
  }

  function setMessage(text, isError = false) {
    elements.message.textContent = text || "";
    elements.message.classList.toggle("error", isError);
    elements.message.classList.toggle("hidden", !text);
  }

  function setStateBadge(text, kind = "") {
    elements.stateBadge.textContent = text;
    elements.stateBadge.className = `badge ${kind}`.trim();
  }

  function formatTime(value) {
    if (!value) return "从未使用";
    return new Date(value).toLocaleString();
  }

  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) {
      throw new Error(response?.error || "操作失败");
    }
    return response;
  }

  async function loadTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.tab = tab || null;
    if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) {
      throw new Error("请在一个 http/https 页面上使用");
    }
  }

  function renderEntries() {
    elements.entries.textContent = "";
    if (!state.app?.entries?.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "当前应用暂无记录";
      elements.entries.appendChild(empty);
      return;
    }

    for (const entry of state.app.entries) {
      const item = document.createElement("article");
      item.className = "entry";

      const top = document.createElement("div");
      top.className = "entry-top";

      const title = document.createElement("div");
      title.className = "entry-title";
      title.textContent = `${entry.username || "(未识别用户名)"}${entry.id === state.app.defaultEntryId ? "（默认自动填充）" : ""}`;

      const meta = document.createElement("div");
      meta.className = "entry-meta";
      meta.textContent = `更新：${formatTime(entry.updatedAt)}；${formatTime(entry.lastUsedAt)}`;

      const actions = document.createElement("div");
      actions.className = "entry-actions";

      const fillButton = document.createElement("button");
      fillButton.textContent = "填充";
      fillButton.addEventListener("click", async () => {
        try {
          setMessage("正在填充...");
          await send({
            type: "fill",
            tabId: state.tab.id,
            entryId: entry.id
          });
          state.app = await send({
            type: "getAppStatus",
            url: state.tab.url
          });
          renderEntries();
          setMessage("已填充，请确认后自行提交登录");
          setTimeout(() => window.close(), 150);
        } catch (error) {
          setMessage(error.message, true);
        }
      });

      const defaultButton = document.createElement("button");
      defaultButton.textContent = "设为默认";
      defaultButton.disabled = entry.id === state.app.defaultEntryId;
      defaultButton.addEventListener("click", async () => {
        try {
          await send({
            type: "setDefaultEntry",
            appKey: state.app.appKey,
            entryId: entry.id
          });
          state.app = await send({
            type: "getAppStatus",
            url: state.tab.url
          });
          renderEntries();
          setMessage("已设为当前应用的默认自动填充账号");
        } catch (error) {
          setMessage(error.message, true);
        }
      });

      const deleteButton = document.createElement("button");
      deleteButton.textContent = "删除";
      deleteButton.addEventListener("click", async () => {
        if (!confirm(`删除 “${entry.username || "(未识别用户名)"}” 的记录？`)) return;
        try {
          await send({
            type: "deleteEntry",
            entryId: entry.id
          });
          state.app = await send({
            type: "getAppStatus",
            url: state.tab.url
          });
          renderEntries();
          setMessage("记录已删除");
        } catch (error) {
          setMessage(error.message, true);
        }
      });

      actions.append(fillButton, defaultButton, deleteButton);
      top.append(title);
      item.append(top, meta, actions);
      elements.entries.appendChild(item);
    }
  }

  function renderApp() {
    if (!state.app) return;
    elements.originText.textContent = state.app.origin;
    elements.prefixText.textContent = state.app.pathPrefix || "(根路径)";
    elements.appKeyText.textContent = state.app.appKey;
    elements.autoFillToggle.checked = state.app.autofill !== false;
    elements.recordToggle.checked = state.app.recording === true;
    elements.depthSelect.value = String(state.app.depth || 1);
    if (!state.app.pathPrefix) {
      setMessage("当前页面没有应用路径层级；如果同主机有多个根路径应用，可能需要提高层级或手动区分。", false);
    }
    renderEntries();
  }

  async function render() {
    hide(elements.setupView);
    hide(elements.unlockView);
    hide(elements.appView);
    setMessage("");

    try {
      await loadTab();
      const statusResponse = await send({ type: "status" });
      state.status = statusResponse;

      if (!state.status.initialized) {
        setStateBadge("未初始化", "warn");
        show(elements.setupView);
        return;
      }

      if (!state.status.unlocked) {
        setStateBadge("已锁定", "warn");
        show(elements.unlockView);
        elements.unlockPassphrase.focus();
        return;
      }

      setStateBadge("已解锁", "ok");
      const appResponse = await send({
        type: "getAppStatus",
        url: state.tab.url
      });
      state.app = appResponse;
      show(elements.appView);
      renderApp();
    } catch (error) {
      setStateBadge("错误", "warn");
      setMessage(error.message, true);
    }
  }

  chrome.storage.local.get(["pv.pauseAutofill", "pv.rememberUnlock"])
    .then((record) => {
      elements.pauseAutofill.checked = record["pv.pauseAutofill"] === true;
      elements.rememberUnlock.checked = record["pv.rememberUnlock"] !== false;
    })
    .catch(() => {});

  elements.rememberUnlock.addEventListener("change", async () => {
    try {
      await chrome.storage.local.set({
        "pv.rememberUnlock": elements.rememberUnlock.checked
      });
      setMessage(elements.rememberUnlock.checked
        ? "已开启浏览器重启后自动解锁；下次解锁后生效"
        : "已关闭浏览器重启后自动解锁；本机保存的解锁密钥已清除");
    } catch (error) {
      elements.rememberUnlock.checked = !elements.rememberUnlock.checked;
      setMessage(error.message, true);
    }
  });

  elements.pauseAutofill.addEventListener("change", async () => {
    try {
      await chrome.storage.local.set({
        "pv.pauseAutofill": elements.pauseAutofill.checked
      });
      setMessage(elements.pauseAutofill.checked
        ? "已暂停所有页面自动填充；恢复后刷新页面即可"
        : "已恢复自动填充；刷新页面即可");
    } catch (error) {
      elements.pauseAutofill.checked = !elements.pauseAutofill.checked;
      setMessage(error.message, true);
    }
  });

  elements.createVault.addEventListener("click", async () => {
    const passphrase = elements.setupPassphrase.value;
    const confirmValue = elements.setupConfirm.value;
    try {
      if (passphrase.length < 12) throw new Error("主口令至少需要 12 个字符");
      if (passphrase !== confirmValue) throw new Error("两次输入的主口令不一致");
      await send({ type: "init", passphrase });
      elements.setupPassphrase.value = "";
      elements.setupConfirm.value = "";
      await render();
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  elements.unlockVault.addEventListener("click", async () => {
    try {
      await send({ type: "unlock", passphrase: elements.unlockPassphrase.value });
      elements.unlockPassphrase.value = "";
      await render();
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  elements.unlockPassphrase.addEventListener("keydown", (event) => {
    if (event.key === "Enter") elements.unlockVault.click();
  });

  elements.autoFillToggle.addEventListener("change", async () => {
    try {
      await send({
        type: "setAutoFill",
        url: state.tab.url,
        enabled: elements.autoFillToggle.checked
      });
      state.app = await send({
        type: "getAppStatus",
        url: state.tab.url
      });
      renderApp();
      setMessage(elements.autoFillToggle.checked ? "已开启打开页面自动填充" : "已关闭打开页面自动填充");
    } catch (error) {
      elements.autoFillToggle.checked = !elements.autoFillToggle.checked;
      setMessage(error.message, true);
    }
  });

  elements.recordToggle.addEventListener("change", async () => {
    try {
      await send({
        type: "setRecording",
        url: state.tab.url,
        enabled: elements.recordToggle.checked
      });
      state.app = await send({
        type: "getAppStatus",
        url: state.tab.url
      });
      renderApp();
      setMessage(elements.recordToggle.checked ? "已开启本应用提交记录" : "已关闭本应用提交记录");
    } catch (error) {
      elements.recordToggle.checked = !elements.recordToggle.checked;
      setMessage(error.message, true);
    }
  });

  elements.depthSelect.addEventListener("change", async () => {
    try {
      await send({
        type: "setPathDepth",
        origin: state.app.origin,
        depth: Number(elements.depthSelect.value)
      });
      await render();
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  elements.saveForm.addEventListener("click", async () => {
    try {
      const response = await send({
        type: "saveCurrentForm",
        tabId: state.tab.id
      });
      state.app = response;
      renderApp();
      setMessage("当前表单已加密保存");
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  elements.forceAutoFill.addEventListener("click", async () => {
    try {
      await send({
        type: "forceAutoFill",
        tabId: state.tab.id
      });
      setMessage("已触发自动填充，请查看页面");
      setTimeout(() => window.close(), 250);
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  elements.diagnosePage.addEventListener("click", async () => {
    try {
      const response = await send({
        type: "diagnosePage",
        tabId: state.tab.id
      });
      elements.diagnosticOutput.textContent = JSON.stringify(response, null, 2);
      show(elements.diagnosticPanel);
      setMessage("检测完成，可复制结果发给 Codex");
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  elements.copyDiagnostic.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(elements.diagnosticOutput.textContent || "");
      setMessage("检测结果已复制");
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  elements.lockNow.addEventListener("click", async () => {
    try {
      await send({ type: "lock" });
      await render();
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  elements.refresh.addEventListener("click", render);

  elements.exportVault.addEventListener("click", async () => {
    try {
      const response = await send({ type: "exportVault" });
      const blob = new Blob([response.data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `path-vault-backup-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage("已导出加密备份；文件仍需主口令才能解密");
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  elements.importFile.addEventListener("change", async () => {
    const file = elements.importFile.files?.[0];
    if (!file) return;
    if (!confirm("导入会覆盖当前同步密码库，确定继续？")) {
      elements.importFile.value = "";
      return;
    }
    try {
      const data = await file.text();
      await send({ type: "importVault", data });
      elements.importFile.value = "";
      setMessage("导入完成，请用备份文件对应的主口令解锁");
      await render();
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  render();
})();








