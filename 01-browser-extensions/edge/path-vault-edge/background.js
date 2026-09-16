(() => {
  "use strict";

  const AUTO_LOCK_MINUTES = 0;
  const CHUNK_SIZE = 7000;
  const META_KEY = "pv.meta";
  const SESSION_KEY = "pv.sessionKey";
  const PAUSE_KEY = "pv.pauseAutofill";
  const REMEMBER_KEY = "pv.rememberUnlock";
  const KEY_DB_NAME = "pv-key-store";
  const KEY_STORE_NAME = "pv-keys";
  const DEVICE_KEY_ID = "vaultKey";
  const PENDING_PREFIX = "pv.pending.";
  const chunkKey = (index) => `pv.chunk.${index}`;
  const PBKDF2_ITERATIONS = 600000;

  let session = null;
  let lastSeenUpdatedAt = null;
  let pauseAutofill = false;
  let rememberUnlock = true;
  const pendingMemory = new Map();

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function fromBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function openKeyDatabase() {
    return new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error("IndexedDB unavailable"));
        return;
      }
      const request = indexedDB.open(KEY_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(KEY_STORE_NAME)) {
          database.createObjectStore(KEY_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    });
  }

  async function idbPut(key, value) {
    const database = await openKeyDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(KEY_STORE_NAME, "readwrite");
      transaction.objectStore(KEY_STORE_NAME).put(value, key);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error("IndexedDB write failed"));
      };
    });
  }

  async function idbGet(key) {
    const database = await openKeyDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(KEY_STORE_NAME, "readonly");
      const request = transaction.objectStore(KEY_STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("IndexedDB read failed"));
      transaction.oncomplete = () => database.close();
    });
  }

  async function idbDelete(key) {
    const database = await openKeyDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(KEY_STORE_NAME, "readwrite");
      transaction.objectStore(KEY_STORE_NAME).delete(key);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error || new Error("IndexedDB delete failed"));
      };
    });
  }

  async function storePersistentKey(key) {
    if (!rememberUnlock || !key) return;
    try {
      await idbPut(DEVICE_KEY_ID, key);
    } catch (_) {
      // Current-session unlock still works if persistent storage is unavailable.
    }
  }

  async function loadPersistentKey() {
    if (!rememberUnlock) return null;
    try {
      return await idbGet(DEVICE_KEY_ID);
    } catch (_) {
      return null;
    }
  }

  async function forgetPersistentKey() {
    try {
      await idbDelete(DEVICE_KEY_ID);
    } catch (_) {
      // Nothing else to do if the key store is already unavailable.
    }
  }

  async function importRawKey(rawKey) {
    return crypto.subtle.importKey(
      "raw",
      fromBase64(rawKey),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function deriveKey(passphrase, salt, iterations, extractable = false) {
    const material = await crypto.subtle.importKey(
      "raw",
      encoder.encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations,
        hash: "SHA-256"
      },
      material,
      {
        name: "AES-GCM",
        length: 256
      },
      extractable,
      ["encrypt", "decrypt"]
    );
  }

  async function deriveKeyForSession(passphrase, salt, iterations) {
    const exportedKey = await deriveKey(passphrase, salt, iterations, true);
    const rawKey = await crypto.subtle.exportKey("raw", exportedKey);
    const key = await crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
    return { key, rawKey };
  }

  chrome.storage.local.get([PAUSE_KEY, REMEMBER_KEY])
    .then((record) => {
      pauseAutofill = record[PAUSE_KEY] === true;
      rememberUnlock = record[REMEMBER_KEY] !== false;
    })
    .catch(() => {});

  async function rememberSessionKey(rawKey, key) {
    try {
      if (chrome.storage.session) {
        await chrome.storage.session.set({ [SESSION_KEY]: toBase64(rawKey) });
      }
    } catch (_) {
      // Persistent unlock below can still work.
    }
    await storePersistentKey(key);
  }

  async function ensureSessionUnlocked() {
    if (session) return;
    const encrypted = await loadEncrypted();
    if (!encrypted) {
      if (chrome.storage.session) {
        await chrome.storage.session.remove(SESSION_KEY).catch(() => {});
      }
      return;
    }

    let key = null;
    if (chrome.storage.session) {
      const record = await chrome.storage.session.get(SESSION_KEY).catch(() => ({}));
      const rawKey = record[SESSION_KEY];
      if (rawKey) {
        try {
          key = await importRawKey(rawKey);
        } catch (_) {
          await chrome.storage.session.remove(SESSION_KEY).catch(() => {});
        }
      }
    }

    if (!key) {
      key = await loadPersistentKey();
    }
    if (!key) return;

    try {
      const vault = await decryptVault(encrypted, key);
      session = { key, meta: encrypted.meta, vault };
      lastSeenUpdatedAt = encrypted.meta.updatedAt;
      scheduleAutoLock();
    } catch (_) {
      if (chrome.storage.session) {
        await chrome.storage.session.remove(SESSION_KEY).catch(() => {});
      }
      await forgetPersistentKey();
    }
  }

  async function loadEncrypted() {
    const metaRecord = await chrome.storage.sync.get(META_KEY);
    const meta = metaRecord[META_KEY];
    if (!meta) return null;

    const keys = [];
    for (let i = 0; i < meta.chunkCount; i += 1) {
      keys.push(chunkKey(i));
    }
    const chunkRecord = await chrome.storage.sync.get(keys);
    const chunks = [];
    for (let i = 0; i < meta.chunkCount; i += 1) {
      const chunk = chunkRecord[chunkKey(i)];
      if (typeof chunk !== "string") {
        throw new Error("加密库数据不完整");
      }
      chunks.push(chunk);
    }
    return { meta, chunks };
  }

  function normalizeVault(vault) {
    vault.settings = vault.settings || {};
    vault.settings.recording = vault.settings.recording || {};
    vault.settings.pathDepth = vault.settings.pathDepth || {};
    vault.settings.autofill = vault.settings.autofill || {};
    vault.settings.defaultEntry = vault.settings.defaultEntry || {};
    return vault;
  }

  async function decryptVault(encrypted, key) {
    const iv = fromBase64(encrypted.meta.iv);
    const ciphertext = fromBase64(encrypted.chunks.join(""));
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    const vault = JSON.parse(decoder.decode(plaintext));
    if (!vault || !Array.isArray(vault.entries) || typeof vault.settings !== "object") {
      throw new Error("加密库格式无效");
    }
    return normalizeVault(vault);
  }

  async function persistVault() {
    assertUnlocked();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      session.key,
      encoder.encode(JSON.stringify(session.vault))
    );
    const payload = toBase64(ciphertext);
    const chunks = [];
    for (let i = 0; i < payload.length; i += CHUNK_SIZE) {
      chunks.push(payload.slice(i, i + CHUNK_SIZE));
    }

    const meta = {
      version: 1,
      salt: session.meta.salt,
      iterations: session.meta.iterations,
      iv: toBase64(iv),
      chunkCount: chunks.length,
      updatedAt: Date.now()
    };

    const record = { [META_KEY]: meta };
    chunks.forEach((chunk, index) => {
      record[chunkKey(index)] = chunk;
    });
    await chrome.storage.sync.set(record);

    const all = await chrome.storage.sync.get(null);
    const stale = Object.keys(all)
      .filter((key) => key.startsWith("pv.chunk."))
      .filter((key) => Number(key.slice("pv.chunk.".length)) >= chunks.length);
    if (stale.length > 0) {
      await chrome.storage.sync.remove(stale);
    }

    session.meta = meta;
    lastSeenUpdatedAt = meta.updatedAt;
  }

  function assertUnlocked() {
    if (!session) {
      const error = new Error("密码库未解锁");
      error.code = "LOCKED";
      throw error;
    }
  }

  function scheduleAutoLock() {
    if (AUTO_LOCK_MINUTES <= 0) return;
    const when = Date.now() + AUTO_LOCK_MINUTES * 60 * 1000;
    chrome.alarms.create("path-vault-auto-lock", { when });
  }

  function touchActivity() {
    if (session) scheduleAutoLock();
  }

  async function lockVault(forgetPersistent = false) {
    session = null;
    lastSeenUpdatedAt = null;
    await chrome.storage.session?.remove(SESSION_KEY).catch(() => {});
    if (forgetPersistent) {
      await forgetPersistentKey();
    }
    await broadcastConfig().catch(() => {});
  }

  async function initializeVault(passphrase) {
    const existing = await loadEncrypted();
    if (existing) {
      throw new Error("密码库已初始化，请直接解锁");
    }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const { key, rawKey } = await deriveKeyForSession(passphrase, salt, PBKDF2_ITERATIONS);
    session = {
      key,
      meta: {
        salt: toBase64(salt),
        iterations: PBKDF2_ITERATIONS
      },
      vault: {
        version: 1,
        entries: [],
        settings: {
          recording: {},
          pathDepth: {},
          autofill: {},
          defaultEntry: {}
        }
      }
    };
    await persistVault();
    await rememberSessionKey(rawKey, key);
    scheduleAutoLock();
    await broadcastConfig();
    return { initialized: true };
  }

  async function unlockVault(passphrase) {
    const encrypted = await loadEncrypted();
    if (!encrypted) {
      throw new Error("密码库尚未初始化");
    }
    const salt = fromBase64(encrypted.meta.salt);
    const { key, rawKey } = await deriveKeyForSession(passphrase, salt, encrypted.meta.iterations);
    const vault = await decryptVault(encrypted, key);
    session = {
      key,
      meta: encrypted.meta,
      vault
    };
    lastSeenUpdatedAt = encrypted.meta.updatedAt;
    await rememberSessionKey(rawKey, key);
    scheduleAutoLock();
    await broadcastConfig();
    return { unlocked: true };
  }

  function getAppInfoFromUrl(rawUrl, settings) {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("仅支持 http/https 页面");
    }
    const configuredDepth = settings?.pathDepth?.[url.origin];
    const depth = Math.max(1, Math.min(4, Number(configuredDepth) || 1));
    const segments = url.pathname.split("/").filter(Boolean);
    const pathPrefix = segments.length === 0
      ? ""
      : `/${segments.slice(0, depth).join("/")}`;
    return {
      origin: url.origin,
      pathPrefix,
      appKey: `${url.origin}${pathPrefix}`,
      depth
    };
  }

  function publicEntry(entry) {
    return {
      id: entry.id,
      appKey: entry.appKey,
      username: entry.username,
      url: entry.url,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      lastUsedAt: entry.lastUsedAt || null
    };
  }

  function getAppStatus(rawUrl) {
    assertUnlocked();
    const app = getAppInfoFromUrl(rawUrl, session.vault.settings);
    const entries = session.vault.entries
      .filter((entry) => entry.appKey === app.appKey)
      .map(publicEntry)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      ...app,
      recording: session.vault.settings.recording[app.appKey] !== false,
      autofill: session.vault.settings.autofill[app.appKey] !== false,
      defaultEntryId: session.vault.settings.defaultEntry[app.appKey] || null,
      entries
    };
  }

  async function setRecording(rawUrl, enabled) {
    assertUnlocked();
    const app = getAppInfoFromUrl(rawUrl, session.vault.settings);
    session.vault.settings.recording[app.appKey] = enabled === true;
    await persistVault();
    await broadcastConfig();
    return getAppStatus(rawUrl);
  }

  async function setPathDepth(origin, depth) {
    assertUnlocked();
    const normalizedDepth = Math.max(1, Math.min(4, Number(depth) || 1));
    session.vault.settings.pathDepth[origin] = normalizedDepth;
    await persistVault();
    await broadcastConfig();
  }

  function getAppStatusForAppKey(appKey) {
    assertUnlocked();
    const entry = session.vault.entries.find((item) => item.appKey === appKey);
    const origin = appKey.replace(/\/[^/]+(?:\/[^/]+)?$/, "");
    return {
      appKey,
      recording: session.vault.settings.recording[appKey] !== false,
      entries: session.vault.entries
        .filter((item) => item.appKey === appKey)
        .map(publicEntry)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    };
  }

  function pendingKey(tabId, frameId = 0) {
    return `${PENDING_PREFIX}${tabId}.${frameId}`;
  }

  async function readPending(tabId, frameId = 0) {
    const key = pendingKey(tabId, frameId);
    if (pendingMemory.has(key)) return pendingMemory.get(key);
    if (!chrome.storage.session) return null;
    const record = await chrome.storage.session.get(key).catch(() => ({}));
    const value = record[key] || null;
    if (value) pendingMemory.set(key, value);
    return value;
  }

  async function writePending(tabId, frameId, value) {
    const key = pendingKey(tabId, frameId);
    pendingMemory.set(key, value);
    if (chrome.storage.session) {
      await chrome.storage.session.set({ [key]: value }).catch(() => {});
    }
  }

  async function clearPending(tabId, frameId = 0) {
    const key = pendingKey(tabId, frameId);
    pendingMemory.delete(key);
    if (chrome.storage.session) {
      await chrome.storage.session.remove(key).catch(() => {});
    }
  }

  async function getPendingForTab(tabId) {
    const prefix = `${PENDING_PREFIX}${tabId}.`;
    const values = [];
    for (const [key, value] of pendingMemory.entries()) {
      if (key.startsWith(prefix)) values.push(value);
    }
    if (chrome.storage.session) {
      const record = await chrome.storage.session.get(null).catch(() => ({}));
      for (const [key, value] of Object.entries(record)) {
        if (key.startsWith(prefix) && value) {
          pendingMemory.set(key, value);
          if (!values.some((item) => item.frameId === value.frameId)) values.push(value);
        }
      }
    }
    return values;
  }

  async function stageCredential(request, sender) {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== "number") return { staged: false };
    const frameId = sender.frameId || 0;
    const previous = await readPending(tabId, frameId) || {};
    const password = String(request.password || previous.password || "");
    if (!password) return { staged: false };
    const username = String(request.username || previous.username || "");
    const intent = request.intent === true || previous.intent === true;
    if (previous.password === password &&
      previous.username === username &&
      previous.intent === intent) {
      return { staged: true };
    }
    const pending = {
      tabId,
      frameId,
      appUrl: sender.tab.url || request.url || previous.appUrl || "",
      pageUrl: request.url || previous.pageUrl || "",
      username,
      password,
      likelyLogin: request.likelyLogin !== false,
      intent,
      intentAt: request.intent === true ? Date.now() : (previous.intentAt || 0),
      updatedAt: Date.now()
    };
    await writePending(tabId, frameId, pending);
    return { staged: true };
  }

  async function commitPendingCredential(request, sender) {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== "number") throw new Error("无法识别当前标签页");
    const frameId = sender.frameId || 0;
    const pending = await readPending(tabId, frameId);
    const username = String(request.username || pending?.username || "");
    const password = String(request.password || pending?.password || "");
    if (!password) throw new Error("未获取到密码");
    const appUrl = sender.tab.url || pending?.appUrl || request.url || "";
    const result = await captureCredential(appUrl, username, password);
    await clearPending(tabId, frameId);
    return result;
  }

  async function commitIntentPendingForTab(tabId) {
    await ensureSessionUnlocked();
    const pendingList = await getPendingForTab(tabId);
    for (const pending of pendingList) {
      if (!pending?.intent || !pending.password) continue;
      if (Date.now() - (pending.intentAt || 0) > 2 * 60 * 1000) {
        await clearPending(tabId, pending.frameId || 0);
        continue;
      }
      try {
        await captureCredential(pending.appUrl, pending.username, pending.password);
        await clearPending(tabId, pending.frameId || 0);
      } catch (_) {
        // Keep the pending item for a short time so a late navigation can retry.
      }
    }
  }

  async function captureCredential(rawUrl, username, password) {
    assertUnlocked();
    const app = getAppInfoFromUrl(rawUrl, session.vault.settings);
    if (session.vault.settings.recording[app.appKey] === false) {
      throw new Error("当前应用未开启记录");
    }
    const normalizedUsername = String(username || "").trim();
    const normalizedPassword = String(password || "");
    if (!normalizedPassword) {
      throw new Error("未识别到密码输入框");
    }

    const now = Date.now();
    const existing = session.vault.entries.find((entry) => {
      return entry.appKey === app.appKey &&
        entry.username.toLowerCase() === normalizedUsername.toLowerCase();
    });

    let entryId;
    if (existing) {
      if (!existing.username && normalizedUsername) {
        existing.username = normalizedUsername;
      }
      if (!existing.password && normalizedPassword) {
        existing.password = normalizedPassword;
      }
      existing.url = rawUrl;
      existing.updatedAt = now;
      entryId = existing.id;
    } else {
      entryId = crypto.randomUUID();
      session.vault.entries.push({
        id: entryId,
        appKey: app.appKey,
        origin: app.origin,
        pathPrefix: app.pathPrefix,
        username: normalizedUsername,
        password: normalizedPassword,
        url: rawUrl,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null
      });
    }
    session.vault.settings.defaultEntry[app.appKey] = entryId;
    await persistVault();
    return getAppStatus(rawUrl);
  }

  async function markEntryUsed(entry) {
    const now = Date.now();
    if (!entry.lastUsedAt || now - entry.lastUsedAt > 60000) {
      entry.lastUsedAt = now;
      try {
        await persistVault();
      } catch (_) {
        // Filling should still work even if sync is temporarily unavailable.
      }
    }
  }

  async function getAutoFill(rawUrl) {
    assertUnlocked();
    const app = getAppInfoFromUrl(rawUrl, session.vault.settings);
    const enabled = !pauseAutofill && session.vault.settings.autofill[app.appKey] !== false;
    const entries = session.vault.entries
      .filter((entry) => entry.appKey === app.appKey)
      .map(publicEntry)
      .sort((a, b) => {
        const aTime = a.lastUsedAt || a.updatedAt || 0;
        const bTime = b.lastUsedAt || b.updatedAt || 0;
        return bTime - aTime;
      });
    const configured = session.vault.settings.defaultEntry[app.appKey];
    const defaultEntryId = entries.some((entry) => entry.id === configured)
      ? configured
      : (entries[0]?.id || null);
    return {
      appKey: app.appKey,
      enabled,
      defaultEntryId,
      entries
    };
  }

  async function getCredential(rawUrl, entryId) {
    assertUnlocked();
    const app = getAppInfoFromUrl(rawUrl, session.vault.settings);
    const entry = session.vault.entries.find((item) => item.id === entryId);
    if (!entry || entry.appKey !== app.appKey) {
      throw new Error("当前应用没有这条记录");
    }
    await markEntryUsed(entry);
    return {
      entryId: entry.id,
      username: entry.username,
      password: entry.password
    };
  }

  async function setDefaultEntry(appKey, entryId) {
    assertUnlocked();
    const entry = session.vault.entries.find((item) => item.id === entryId);
    if (!entry || entry.appKey !== appKey) {
      throw new Error("记录不存在");
    }
    session.vault.settings.defaultEntry[appKey] = entryId;
    await persistVault();
    return { defaultEntryId: entryId };
  }

  async function setAutoFill(rawUrl, enabled) {
    assertUnlocked();
    const app = getAppInfoFromUrl(rawUrl, session.vault.settings);
    session.vault.settings.autofill[app.appKey] = enabled === true;
    await persistVault();
    await broadcastConfig();
    return getAppStatus(rawUrl);
  }

  async function fillEntry(tabId, entryId) {
    assertUnlocked();
    const entry = session.vault.entries.find((item) => item.id === entryId);
    if (!entry) {
      throw new Error("记录不存在");
    }
    const filled = await fillCredentialInTab(tabId, entry.username, entry.password);
    if (!filled) {
      throw new Error("当前页面没有可填充的登录输入框");
    }
    await markEntryUsed(entry);
    return { filled: true, appKey: entry.appKey };
  }

  async function deleteEntry(entryId) {
    assertUnlocked();
    const index = session.vault.entries.findIndex((item) => item.id === entryId);
    if (index === -1) {
      throw new Error("记录不存在");
    }
    const [removed] = session.vault.entries.splice(index, 1);
    if (session.vault.settings.defaultEntry[removed.appKey] === removed.id) {
      const replacement = session.vault.entries.find((entry) => entry.appKey === removed.appKey);
      if (replacement) {
        session.vault.settings.defaultEntry[removed.appKey] = replacement.id;
      } else {
        delete session.vault.settings.defaultEntry[removed.appKey];
      }
    }
    await persistVault();
    return { deleted: true, appKey: removed.appKey };
  }

  async function fillCredentialInTab(tabId, username, password) {
    const results = await executeInFrames(tabId, true, (fillUsername, fillPassword) => {
      function isVisible(element) {
        if (!(element.offsetWidth || element.offsetHeight || element.getClientRects().length)) return false;
        const style = getComputedStyle(element);
        return style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.visibility !== "collapse";
      }

      function attributeText(input) {
        return [
          input.name,
          input.id,
          input.autocomplete,
          input.placeholder,
          input.className
        ].join(" ").toLowerCase();
      }

      function isPasswordInput(input) {
        const type = (input.type || "text").toLowerCase();
        return type === "password" || /password|passwd|pwd|密码/.test(attributeText(input));
      }

      function setNativeValue(input, value) {
        if (input.readOnly) input.readOnly = false;
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

      const inputs = Array.from(document.querySelectorAll("input")).filter(isVisible);
      const passwordInputs = inputs.filter(isPasswordInput);
      if (passwordInputs.length !== 1) return false;

      const passwordInput = passwordInputs[0];
      const form = passwordInput.closest("form") || document.body || document.documentElement;
      const scopeText = [
        location.href,
        document.title,
        form?.innerText || ""
      ].join(" ").toLowerCase();
      const controls = Array.from((form || document).querySelectorAll(
        "button, input[type='submit'], a, [role='button'], .mini-button, .e-btn, .btn"
      ));
      const likelyLogin = /login|signin|sign-in|登录|登陆/.test(scopeText) ||
        controls.some((control) => {
          const label = [
            control.innerText || "",
            control.value || "",
            control.title || "",
            control.getAttribute("aria-label") || ""
          ].join(" ").toLowerCase();
          return /登录|登陆|login|sign\s*in|submit/.test(label);
        });
      if (!likelyLogin) return false;

      if (document.activeElement === passwordInput && passwordInput.value && passwordInput.value !== fillPassword) {
        return false;
      }

      const candidates = inputs
        .filter((input) => input !== passwordInput)
        .filter((input) => ["text", "email", "tel", "search"].includes((input.type || "text").toLowerCase()));
      const named = candidates.filter((input) => {
        return /user|account|login|email|phone|mobile|username|账号|用户名|登录名|手机号/.test(attributeText(input)) &&
          !/code|captcha|sms|verify|验证码/.test(attributeText(input));
      });
      const beforePassword = candidates.filter((input) => {
        return input.compareDocumentPosition(passwordInput) & Node.DOCUMENT_POSITION_FOLLOWING;
      });
      const usernameCandidates = named.length > 0
        ? named
        : (beforePassword.length > 0 ? beforePassword : candidates);
      const usernameInput = usernameCandidates.length > 0
        ? usernameCandidates[usernameCandidates.length - 1]
        : null;

      const usernameMatches = !usernameInput || !fillUsername || usernameInput.value === fillUsername;
      const passwordMatches = passwordInput.value === fillPassword;
      if (usernameMatches && passwordMatches) return true;

      if (usernameInput && fillUsername) setNativeValue(usernameInput, fillUsername);
      setNativeValue(passwordInput, fillPassword);
      return true;
    }, [username, password], false);

    return results.includes(true);
  }

  async function autoFillTab(tabId, rawUrl, force = false) {
    await ensureSessionUnlocked();
    await ensureContentScript(tabId, true).catch(() => {});
    if (!session || !rawUrl || pauseAutofill) return { filled: false };
    const app = getAppInfoFromUrl(rawUrl, session.vault.settings);
    if (!force && session.vault.settings.autofill[app.appKey] === false) {
      return { filled: false };
    }
    const entries = session.vault.entries
      .filter((entry) => entry.appKey === app.appKey)
      .sort((a, b) => {
        const aTime = a.lastUsedAt || a.updatedAt || 0;
        const bTime = b.lastUsedAt || b.updatedAt || 0;
        return bTime - aTime;
      });
    if (entries.length === 0) return { filled: false };
    const configured = session.vault.settings.defaultEntry[app.appKey];
    const entry = entries.find((item) => item.id === configured) || entries[0];
    const filled = await fillCredentialInTab(tabId, entry.username, entry.password);
    if (filled) {
      await markEntryUsed(entry);
      setTimeout(() => {
        fillCredentialInTab(tabId, entry.username, entry.password).catch(() => {});
      }, 900);
      setTimeout(() => {
        fillCredentialInTab(tabId, entry.username, entry.password).catch(() => {});
      }, 2600);
    }
    return { filled, entryId: filled ? entry.id : null };
  }

  async function forceAutoFill(tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url) return { filled: false };
    return autoFillTab(tabId, tab.url, true);
  }

  async function diagnosePage(tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const topUrl = tab?.url || "";
    const settings = session?.vault?.settings || {};
    let app = null;
    try {
      app = getAppInfoFromUrl(topUrl, settings);
    } catch (_) {
      app = null;
    }

    const frameDiagnostics = await executeInFrames(tabId, true, () => {
      function isVisible(element) {
        if (!(element.offsetWidth || element.offsetHeight || element.getClientRects().length)) return false;
        const style = getComputedStyle(element);
        return style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.visibility !== "collapse";
      }
      const inputs = Array.from(document.querySelectorAll("input")).map((input) => {
        const haystack = [
          input.name,
          input.id,
          input.autocomplete,
          input.placeholder,
          input.className
        ].join(" ").toLowerCase();
        return {
          type: (input.type || "text").toLowerCase(),
          name: input.name || "",
          id: input.id || "",
          className: typeof input.className === "string" ? input.className : "",
          placeholder: input.placeholder || "",
          autocomplete: input.autocomplete || "",
          readOnly: input.readOnly,
          disabled: input.disabled,
          visible: isVisible(input),
          hasValue: Boolean(input.value),
          passwordLike: (input.type || "").toLowerCase() === "password" || /password|passwd|pwd|密码/.test(haystack),
          usernameLike: /user|account|login|email|phone|mobile|username|账号|用户名|登录名|手机号/.test(haystack)
        };
      });
      return {
        title: document.title || "",
        frameUrl: location.href,
        isTopFrame: window.top === window,
        inputCount: inputs.length,
        inputs
      };
    }, [], false);

    const entries = session
      ? session.vault.entries.filter((entry) => entry.appKey === app?.appKey)
      : [];

    return {
      version: chrome.runtime.getManifest().version,
      topUrl,
      app,
      unlocked: session !== null,
      rememberUnlock,
      pauseAutofill,
      autofillEnabled: session !== null && !pauseAutofill && settings.autofill?.[app?.appKey] !== false,
      recordingEnabled: settings.recording?.[app?.appKey] !== false,
      entries: entries.map((entry) => ({
        id: entry.id,
        usernameLength: String(entry.username || "").length,
        updatedAt: entry.updatedAt,
        lastUsedAt: entry.lastUsedAt
      })),
      frames: frameDiagnostics
    };
  }

  async function captureAnyFrame(sender, fallbackUrl) {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== "number") {
      throw new Error("无法识别当前标签页");
    }
    const forms = await collectFromFrames(
      tabId,
      () => window.__pathVaultGetForm?.() || null
    );
    const response = forms.find((form) => form?.url && form?.password && form?.likelyLogin !== false);
    if (!response) {
      throw new Error("当前页面没有识别到登录表单");
    }
    const result = await captureCredential(
      sender.tab.url || fallbackUrl || response.url,
      response.username,
      response.password
    );
    const pendingList = await getPendingForTab(tabId);
    for (const pending of pendingList) {
      await clearPending(tabId, pending.frameId || 0);
    }
    return result;
  }

  async function saveCurrentForm(tabId) {
    const forms = await collectFromFrames(
      tabId,
      () => window.__pathVaultGetForm?.() || null
    );
    const response = forms.find((form) => form?.url && form?.password);
    if (!response) {
      throw new Error("当前页面没有可保存的登录表单");
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const appUrl = tab?.url || response.url;
    return captureCredential(appUrl, response.username, response.password);
  }

  async function collectFromFrames(tabId, func, args = []) {
    const topResults = await executeInFrames(tabId, false, func, args);
    if (topResults.length > 0) return topResults;
    return executeInFrames(tabId, true, func, args);
  }

  async function executeInFrames(tabId, allFrames, func, args, ensureContent = true) {
    try {
      if (ensureContent) {
        await ensureContentScript(tabId, allFrames);
      }
      const results = await chrome.scripting.executeScript({
        target: allFrames ? { tabId, allFrames: true } : { tabId },
        func,
        args
      });
      return results
        .map((result) => result.result)
        .filter((result) => result !== undefined && result !== null && result !== false);
    } catch (_) {
      return [];
    }
  }

  async function ensureContentScript(tabId, allFrames = false) {
    try {
      await chrome.scripting.executeScript({
        target: allFrames ? { tabId, allFrames: true } : { tabId },
        files: ["content.js"]
      });
    } catch (error) {
      // Content script may already be declared; only fail if messaging also fails.
    }
  }

  function configForUrl(rawUrl) {
    const settings = session?.vault?.settings || {};
    let app;
    try {
      app = getAppInfoFromUrl(rawUrl, settings);
    } catch {
      return null;
    }
    return {
      type: "configUpdate",
      config: {
        initialized: true,
        unlocked: session !== null,
        recording: session !== null && settings.recording?.[app.appKey] !== false,
        autofill: !pauseAutofill && session !== null && settings.autofill?.[app.appKey] !== false,
        ...app
      }
    };
  }

  async function broadcastConfig() {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map(async (tab) => {
      if (!tab.url || typeof tab.id !== "number") return;
      const message = configForUrl(tab.url);
      if (!message) return;
      try {
        await chrome.tabs.sendMessage(tab.id, message);
      } catch (_) {
        // The tab may not have a content script yet.
      }
    }));
  }

  async function exportVault() {
    const encrypted = await loadEncrypted();
    if (!encrypted) {
      throw new Error("密码库尚未初始化");
    }
    return {
      data: JSON.stringify({
        format: "path-aware-password-vault",
        ...encrypted
      }, null, 2)
    };
  }

  async function importVault(data) {
    const parsed = JSON.parse(data);
    if (parsed?.format !== "path-aware-password-vault") {
      throw new Error("备份文件格式无效");
    }
    if (!parsed.meta?.salt || !parsed.meta?.iv || !Array.isArray(parsed.chunks)) {
      throw new Error("备份文件缺少加密数据");
    }

    const record = { [META_KEY]: parsed.meta };
    parsed.chunks.forEach((chunk, index) => {
      record[chunkKey(index)] = chunk;
    });
    await chrome.storage.sync.set(record);

    const all = await chrome.storage.sync.get(null);
    const stale = Object.keys(all)
      .filter((key) => key.startsWith("pv.chunk."))
      .filter((key) => Number(key.slice("pv.chunk.".length)) >= parsed.chunks.length);
    if (stale.length > 0) {
      await chrome.storage.sync.remove(stale);
    }
    await lockVault(true);
    return { imported: true };
  }

  async function handleRemoteChange() {
    const encrypted = await loadEncrypted();
    if (!encrypted || !session) return;
    if (encrypted.meta.updatedAt === lastSeenUpdatedAt) return;
    try {
      const vault = await decryptVault(encrypted, session.key);
      session.vault = vault;
      session.meta = encrypted.meta;
      lastSeenUpdatedAt = encrypted.meta.updatedAt;
      await broadcastConfig();
    } catch (_) {
      await lockVault(true);
    }
  }

  function getAppUrl(request, sender) {
    return sender?.tab?.url || request.url || "";
  }

  async function handleMessage(request, sender) {
    await ensureSessionUnlocked();
    touchActivity();
    switch (request.type) {
      case "status":
        return {
          initialized: Boolean(await loadEncrypted()),
          unlocked: session !== null,
          autoLockMinutes: AUTO_LOCK_MINUTES
        };
      case "init":
        return initializeVault(String(request.passphrase || ""));
      case "unlock":
        return unlockVault(String(request.passphrase || ""));
      case "lock":
        await lockVault(true);
        return { locked: true };
      case "getAppStatus":
        return getAppStatus(getAppUrl(request, sender));
      case "setRecording":
        return setRecording(String(request.url || ""), request.enabled === true);
      case "setPathDepth":
        return setPathDepth(String(request.origin || ""), Number(request.depth || 1));
      case "getAutoFill":
        return getAutoFill(getAppUrl(request, sender));
      case "getCredential":
        return getCredential(getAppUrl(request, sender), String(request.entryId || ""));
      case "setDefaultEntry":
        return setDefaultEntry(String(request.appKey || ""), String(request.entryId || ""));
      case "setAutoFill":
        return setAutoFill(String(request.url || ""), request.enabled === true);
      case "capture":
        return captureCredential(getAppUrl(request, sender), request.username, request.password);
      case "stageCredential":
        return stageCredential(request, sender);
      case "commitCredential":
        return commitPendingCredential(request, sender);
      case "captureAnyFrame":
        return captureAnyFrame(sender, String(request.url || ""));
      case "forceAutoFill":
        return forceAutoFill(Number(request.tabId));
      case "diagnosePage":
        return diagnosePage(Number(request.tabId));
      case "fill":
        return fillEntry(Number(request.tabId), String(request.entryId || ""));
      case "deleteEntry":
        return deleteEntry(String(request.entryId || ""));
      case "saveCurrentForm":
        return saveCurrentForm(Number(request.tabId));
      case "exportVault":
        return exportVault();
      case "importVault":
        return importVault(String(request.data || ""));
      case "getAppConfig":
        return configForUrl(getAppUrl(request, sender))?.config || null;
      default:
        throw new Error("未知消息");
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleMessage(request, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({
        ok: false,
        error: String(error?.message || error),
        code: error?.code || null
      }));
    return true;
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "path-vault-auto-lock") {
      lockVault(false).catch(() => {});
    }
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "loading") {
      commitIntentPendingForTab(tabId).catch(() => {});
    }
    if (changeInfo.status === "complete" && tab?.url) {
      const url = tab.url;
      autoFillTab(tabId, url)
        .then((result) => {
          if (!result.filled) {
            setTimeout(() => autoFillTab(tabId, url).catch(() => {}), 1200);
            setTimeout(() => autoFillTab(tabId, url).catch(() => {}), 3200);
          }
        })
        .catch(() => {});
    }
  });

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs.get(tabId)
      .then((tab) => {
        if (tab?.url) return autoFillTab(tabId, tab.url);
        return null;
      })
      .catch(() => {});
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "sync" && changes[META_KEY]) {
      handleRemoteChange().catch(() => {});
    }
    if (areaName === "local" && changes[PAUSE_KEY]) {
      pauseAutofill = changes[PAUSE_KEY].newValue === true;
      broadcastConfig().catch(() => {});
    }
    if (areaName === "local" && changes[REMEMBER_KEY]) {
      rememberUnlock = changes[REMEMBER_KEY].newValue !== false;
      if (!rememberUnlock) {
        forgetPersistentKey().catch(() => {});
      } else if (session) {
        storePersistentKey(session.key).catch(() => {});
      }
    }
  });
})();






































