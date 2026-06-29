/*
 * MAIN-world Debug Timeline recorder.
 *
 * These functions are injected with chrome.scripting.executeScript, so each
 * entry point must remain self-contained and must return plain serializable
 * data to the service worker.
 */

function startDebugTimelineInPage() {
  const stateKey = "__SN_DEV_HELPER_DEBUG_TIMELINE__";
  const existing = window[stateKey];
  if (existing && existing.active) {
    return {
      ok: true,
      alreadyActive: true,
      frameUrl: location.href,
      startedAt: existing.startedAt,
      capabilities: existing.capabilities,
    };
  }
  if (existing && typeof existing.restore === "function") {
    try {
      existing.restore();
    } catch (e) {}
  }

  const state = {
    active: true,
    startedAt: Date.now(),
    events: [],
    sequence: 0,
    maxEvents: 1000,
    patches: [],
    cleanups: [],
    inputTimers: new Map(),
    capabilities: {
      gFormInstances: 0,
      nativeFields: true,
      glideAjax: false,
      errors: true,
    },
  };
  window[stateKey] = state;

  const sensitivePattern =
    /(password|passwd|secret|token|credential|api[_-]?key|private[_-]?key|authorization)/i;

  const truncate = (value, maxLength) => {
    const text = String(value == null ? "" : value);
    return text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
  };

  const safeValue = (value, fieldName) => {
    if (sensitivePattern.test(String(fieldName || ""))) return "[REDACTED]";
    if (value == null) return value;
    if (typeof value === "string") return truncate(value, 500);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) {
      return value.slice(0, 20).map((item) => safeValue(item, fieldName));
    }
    try {
      return truncate(JSON.stringify(value), 1000);
    } catch (e) {
      return truncate(value, 500);
    }
  };

  const captureStack = () => {
    try {
      return String(new Error().stack || "")
        .split("\n")
        .slice(2, 14)
        .join("\n")
        .slice(0, 4000);
    } catch (e) {
      return "";
    }
  };

  const addEvent = (category, action, summary, details, stack) => {
    if (!state.active) return null;
    const now = Date.now();
    const event = {
      id: ++state.sequence,
      time: now,
      elapsedMs: now - state.startedAt,
      category,
      action,
      summary: truncate(summary, 300),
      details: details || {},
      stack: stack || "",
      frameUrl: location.href,
    };
    state.events.push(event);
    if (state.events.length > state.maxEvents) state.events.shift();
    return event;
  };

  const installPatch = (target, methodName, makeWrapper) => {
    if (!target) return false;
    let original;
    let hadOwnProperty = false;
    let originalDescriptor = null;
    try {
      original = target[methodName];
      hadOwnProperty = Object.prototype.hasOwnProperty.call(target, methodName);
      originalDescriptor = hadOwnProperty
        ? Object.getOwnPropertyDescriptor(target, methodName)
        : null;
    } catch (e) {
      return false;
    }
    if (typeof original !== "function") return false;
    if (state.patches.some((patch) => patch.target === target && patch.methodName === methodName)) {
      return true;
    }

    let wrapper;
    try {
      wrapper = makeWrapper(original);
      target[methodName] = wrapper;
      if (target[methodName] !== wrapper) return false;
      state.patches.push({
        target,
        methodName,
        original,
        originalDescriptor,
        hadOwnProperty,
        wrapper,
      });
      return true;
    } catch (e) {
      try {
        if (wrapper && target[methodName] === wrapper) {
          if (hadOwnProperty && originalDescriptor) {
            Object.defineProperty(target, methodName, originalDescriptor);
          } else {
            delete target[methodName];
          }
        }
      } catch (restoreError) {}
      return false;
    }
  };

  const isGForm = (candidate) =>
    candidate &&
    typeof candidate.getValue === "function" &&
    typeof candidate.setValue === "function";

  const patchedGForms = new WeakSet();
  const gFormMethods = [
    "setValue",
    "clearValue",
    "setMandatory",
    "setVisible",
    "setDisplay",
    "setReadOnly",
    "setDisabled",
    "showFieldMsg",
    "hideFieldMsg",
    "addOption",
    "removeOption",
    "clearOptions",
  ];

  const patchGForm = (gForm) => {
    if (!isGForm(gForm) || patchedGForms.has(gForm)) return;
    let patchedAny = false;

    gFormMethods.forEach((methodName) => {
      const patched = installPatch(gForm, methodName, (original) => {
        return function (...args) {
          const fieldName = String(args[0] == null ? "" : args[0]);
          const stack = captureStack();
          let oldValue;
          if (fieldName && typeof this.getValue === "function") {
            try {
              oldValue = safeValue(this.getValue(fieldName), fieldName);
            } catch (e) {}
          }

          try {
            const returnValue = original.apply(this, args);
            const details = {
              field: fieldName,
              arguments: args.slice(1, 6).map((arg) => safeValue(arg, fieldName)),
            };
            if (oldValue !== undefined) details.oldValue = oldValue;
            addEvent(
              "g_form",
              methodName,
              methodName + (fieldName ? '("' + fieldName + '")' : "()"),
              details,
              stack
            );
            return returnValue;
          } catch (error) {
            addEvent(
              "error",
              methodName,
              methodName + " threw: " + truncate(error && error.message ? error.message : error, 220),
              {
                field: fieldName,
                arguments: args.slice(1, 6).map((arg) => safeValue(arg, fieldName)),
              },
              stack
            );
            throw error;
          }
        };
      });
      patchedAny = patchedAny || patched;
    });

    if (patchedAny) {
      patchedGForms.add(gForm);
      state.capabilities.gFormInstances++;
    }
  };

  const discoverGForms = () => {
    const candidates = [];
    const add = (candidate) => {
      if (isGForm(candidate) && candidates.indexOf(candidate) < 0) candidates.push(candidate);
    };
    const scan = (obj, depth, seen) => {
      if (!obj || typeof obj !== "object" || depth > 3 || seen.indexOf(obj) >= 0) return;
      seen.push(obj);
      add(obj);
      ["g_form", "gForm", "page", "c", "data", "$parent"].forEach((key) => {
        try {
          scan(obj[key], depth + 1, seen);
        } catch (e) {}
      });
      try {
        if (typeof obj.getGlideForm === "function") add(obj.getGlideForm());
      } catch (e) {}
    };

    try {
      if (typeof g_form !== "undefined") add(g_form);
    } catch (e) {}

    try {
      const angular = window.angular;
      if (angular && angular.element) {
        const elements = Array.from(
          document.querySelectorAll(
            "#sc_cat_item,sp-variable-layout,sp-cat-item,sp-sc-cat-item,.sc-form,.catalog-form,[sp-model],[ng-controller]"
          )
        ).slice(0, 80);
        elements.forEach((element) => {
          try {
            const wrapped = angular.element(element);
            if (wrapped.scope) scan(wrapped.scope(), 0, []);
            if (wrapped.isolateScope) scan(wrapped.isolateScope(), 0, []);
          } catch (e) {}
        });
      }
    } catch (e) {}

    candidates.forEach(patchGForm);
  };

  const fieldIdentity = (element) => {
    if (!element || !element.getAttribute) return "";
    return String(
      element.getAttribute("data-field-name") ||
        element.getAttribute("data-variable-name") ||
        element.getAttribute("data-name") ||
        element.getAttribute("name") ||
        element.id ||
        element.getAttribute("aria-label") ||
        ""
    ).trim();
  };

  const fieldValue = (element, fieldName) => {
    if (!element) return "";
    if (sensitivePattern.test(fieldName) || String(element.type || "").toLowerCase() === "password") {
      return "[REDACTED]";
    }
    if (String(element.type || "").toLowerCase() === "checkbox") {
      return Boolean(element.checked);
    }
    if (String(element.type || "").toLowerCase() === "radio") {
      return element.checked ? safeValue(element.value, fieldName) : "[not selected]";
    }
    if (element.isContentEditable) return truncate(element.textContent || "", 500);
    return safeValue(element.value, fieldName);
  };

  const recordNativeFieldEvent = (event) => {
    const element = event && event.target;
    if (
      !element ||
      !element.matches ||
      !element.matches("input,textarea,select,[contenteditable='true']")
    ) {
      return;
    }
    const fieldName = fieldIdentity(element);
    addEvent(
      "field",
      event.type,
      event.type + (fieldName ? ': "' + fieldName + '"' : " event"),
      {
        field: fieldName,
        value: fieldValue(element, fieldName),
        tag: String(element.tagName || "").toLowerCase(),
        type: String(element.type || "").toLowerCase(),
        trusted: Boolean(event.isTrusted),
      },
      captureStack()
    );
  };

  const onInput = (event) => {
    const element = event && event.target;
    if (!element) return;
    const previous = state.inputTimers.get(element);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      state.inputTimers.delete(element);
      recordNativeFieldEvent(event);
    }, 250);
    state.inputTimers.set(element, timer);
  };
  const onChange = (event) => {
    const element = event && event.target;
    const pending = element && state.inputTimers.get(element);
    if (pending) {
      clearTimeout(pending);
      state.inputTimers.delete(element);
    }
    recordNativeFieldEvent(event);
  };
  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onChange, true);
  state.cleanups.push(() => document.removeEventListener("input", onInput, true));
  state.cleanups.push(() => document.removeEventListener("change", onChange, true));

  const onError = (event) => {
    addEvent(
      "error",
      "error",
      truncate((event && event.message) || "JavaScript error", 300),
      {
        file: truncate((event && event.filename) || "", 500),
        line: (event && event.lineno) || 0,
        column: (event && event.colno) || 0,
      },
      truncate((event && event.error && event.error.stack) || "", 4000)
    );
  };
  const onUnhandledRejection = (event) => {
    const reason = event && event.reason;
    addEvent(
      "error",
      "unhandledrejection",
      "Unhandled promise rejection: " +
        truncate(reason && reason.message ? reason.message : reason, 240),
      {},
      truncate((reason && reason.stack) || "", 4000)
    );
  };
  window.addEventListener("error", onError, true);
  window.addEventListener("unhandledrejection", onUnhandledRejection, true);
  state.cleanups.push(() => window.removeEventListener("error", onError, true));
  state.cleanups.push(() =>
    window.removeEventListener("unhandledrejection", onUnhandledRejection, true)
  );

  const glideAjaxMetadata = new WeakMap();
  const patchedGlideAjaxPrototypes = new WeakSet();

  const glideAjaxInfo = (instance) => {
    const metadata = glideAjaxMetadata.get(instance) || { params: {} };
    let className = "";
    try {
      className =
        (typeof instance.getProcessor === "function" && instance.getProcessor()) ||
        instance.processor ||
        instance.className ||
        instance.name ||
        "";
    } catch (e) {}
    return {
      className: String(className || "GlideAjax"),
      method: String(metadata.params.sysparm_name || ""),
      params: Object.assign({}, metadata.params),
    };
  };

  const patchGlideAjax = () => {
    let prototype;
    try {
      prototype = window.GlideAjax && window.GlideAjax.prototype;
    } catch (e) {
      return;
    }
    if (!prototype || patchedGlideAjaxPrototypes.has(prototype)) return;

    installPatch(prototype, "addParam", (original) => {
      return function (name, value) {
        const result = original.apply(this, arguments);
        const metadata = glideAjaxMetadata.get(this) || { params: {} };
        metadata.params[String(name || "")] = safeValue(value, name);
        glideAjaxMetadata.set(this, metadata);
        return result;
      };
    });

    installPatch(prototype, "getXML", (original) => {
      return function (...args) {
        const info = glideAjaxInfo(this);
        const started = Date.now();
        const stack = captureStack();
        const label =
          info.className + (info.method ? "." + info.method : "") + " started";
        addEvent("glideajax", "start", label, info, stack);

        if (typeof args[0] === "function") {
          const callback = args[0];
          args[0] = function (...callbackArgs) {
            addEvent(
              "glideajax",
              "complete",
              info.className +
                (info.method ? "." + info.method : "") +
                " completed in " +
                (Date.now() - started) +
                " ms",
              Object.assign({}, info, { durationMs: Date.now() - started }),
              ""
            );
            return callback.apply(this, callbackArgs);
          };
        }

        try {
          return original.apply(this, args);
        } catch (error) {
          addEvent(
            "error",
            "glideajax",
            info.className +
              (info.method ? "." + info.method : "") +
              " threw: " +
              truncate(error && error.message ? error.message : error, 200),
            Object.assign({}, info, { durationMs: Date.now() - started }),
            stack
          );
          throw error;
        }
      };
    });

    installPatch(prototype, "getXMLWait", (original) => {
      return function (...args) {
        const info = glideAjaxInfo(this);
        const started = Date.now();
        const stack = captureStack();
        try {
          const result = original.apply(this, args);
          addEvent(
            "glideajax",
            "complete",
            info.className +
              (info.method ? "." + info.method : "") +
              " completed synchronously in " +
              (Date.now() - started) +
              " ms",
            Object.assign({}, info, { durationMs: Date.now() - started }),
            stack
          );
          return result;
        } catch (error) {
          addEvent(
            "error",
            "glideajax",
            info.className +
              (info.method ? "." + info.method : "") +
              " threw: " +
              truncate(error && error.message ? error.message : error, 200),
            Object.assign({}, info, { durationMs: Date.now() - started }),
            stack
          );
          throw error;
        }
      };
    });

    patchedGlideAjaxPrototypes.add(prototype);
    state.capabilities.glideAjax = true;
  };

  discoverGForms();
  patchGlideAjax();
  const discoveryTimer = setInterval(() => {
    discoverGForms();
    patchGlideAjax();
  }, 1000);
  state.cleanups.push(() => clearInterval(discoveryTimer));

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    state.active = false;

    state.inputTimers.forEach((timer) => clearTimeout(timer));
    state.inputTimers.clear();
    state.cleanups.splice(0).reverse().forEach((cleanup) => {
      try {
        cleanup();
      } catch (e) {}
    });
    state.patches.splice(0).reverse().forEach((patch) => {
      try {
        if (patch.target[patch.methodName] === patch.wrapper) {
          if (patch.hadOwnProperty && patch.originalDescriptor) {
            Object.defineProperty(
              patch.target,
              patch.methodName,
              patch.originalDescriptor
            );
          } else {
            delete patch.target[patch.methodName];
          }
        }
      } catch (e) {}
    });
  };

  const onPageHide = () => restore();
  window.addEventListener("pagehide", onPageHide, { once: true });
  state.cleanups.push(() => window.removeEventListener("pagehide", onPageHide));

  state.restore = restore;
  state.stop = () => {
    addEvent("system", "stop", "Recording stopped", {}, "");
    const result = {
      ok: true,
      active: false,
      frameUrl: location.href,
      startedAt: state.startedAt,
      stoppedAt: Date.now(),
      events: state.events.slice(),
      capabilities: Object.assign({}, state.capabilities),
      truncated: state.sequence > state.maxEvents,
    };
    restore();
    return result;
  };

  addEvent("system", "start", "Recording started", {}, "");
  return {
    ok: true,
    alreadyActive: false,
    frameUrl: location.href,
    startedAt: state.startedAt,
    capabilities: Object.assign({}, state.capabilities),
  };
}

function stopDebugTimelineInPage() {
  const stateKey = "__SN_DEV_HELPER_DEBUG_TIMELINE__";
  const state = window[stateKey];
  if (!state || typeof state.stop !== "function") {
    return {
      ok: true,
      active: false,
      frameUrl: location.href,
      events: [],
      notRunning: true,
    };
  }
  const result = state.stop();
  try {
    delete window[stateKey];
  } catch (e) {
    window[stateKey] = null;
  }
  return result;
}
