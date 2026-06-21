/*
 * background.js — MV3 service worker.
 * Currently just wires the keyboard shortcut to the field-name toggle.
 * Good place to later add: context menus, cross-tab state, alarms, etc.
 */

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-field-names") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/\.service-now\.com/.test(tab.url || "")) return;
  postWindowMessageInAllFrames(tab.id, "TOGGLE_FIELD_NAMES");
});

function sendToTab(tabId, msg, options) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, msg, options).catch(() => {});
}

function togglePaletteInTopFrame(tabId) {
  if (!tabId) return;
  sendToTab(tabId, { type: "TOGGLE_PALETTE" }, { frameId: 0 });
  chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: () => {
      window.postMessage(
        { source: "SN_DEV_HELPER_FRAME_COMMAND", type: "TOGGLE_PALETTE" },
        location.origin
      );
    },
  }).catch(() => {});
}

function postWindowMessageInAllFrames(tabId, type) {
  if (!tabId) return;
  chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (messageType) => {
      window.postMessage(
        { source: "SN_DEV_HELPER_FRAME_COMMAND", type: messageType },
        location.origin
      );
    },
    args: [type],
  }).catch(() => {});
}

function extractSysId() {
  const fromText = (text) => {
    if (!text) return null;
    let value = String(text);
    for (let i = 0; i < 3; i++) {
      const workspaceMatch = value.match(
        /\/now\/(?:[^/?#]+\/)*record\/[^/?#]+\/([0-9a-f]{32})(?:[/?#]|$)/i
      );
      if (workspaceMatch) return workspaceMatch[1];

      const match = value.match(/(?:[?&]sys_id=|sys_id=)([0-9a-f]{32})/i);
      if (match) return match[1];
      try {
        const decoded = decodeURIComponent(value);
        if (decoded === value) break;
        value = decoded;
      } catch (e) {
        break;
      }
    }
    return null;
  };

  try {
    if (typeof g_form !== "undefined" && g_form) {
      const id = g_form.getUniqueValue && g_form.getUniqueValue();
      if (id && /^[0-9a-f]{32}$/i.test(id)) return id;
    }
  } catch (e) {}

  return fromText(location.href);
}

async function tableApiGetInPage(request) {
  const params = new URLSearchParams();
  params.set("sysparm_query", request.query || "");
  params.set("sysparm_fields", request.fields || "");
  params.set("sysparm_limit", String(request.limit || 200));
  if (request.options && request.options.displayAll) {
    params.set("sysparm_display_value", "all");
  }
  if (request.options && request.options.excludeRefLinks) {
    params.set("sysparm_exclude_reference_link", "true");
  }

  const url =
    location.origin +
    "/api/now/table/" +
    encodeURIComponent(request.table) +
    "?" +
    params.toString();
  const headers = { Accept: "application/json" };
  try {
    if (typeof g_ck !== "undefined" && g_ck) headers["X-UserToken"] = g_ck;
  } catch (e) {}

  const res = await fetch(url, {
    credentials: "same-origin",
    headers,
  });
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: "HTTP " + res.status + " reading " + request.table,
    };
  }
  const data = await res.json();
  return { ok: true, result: (data && data.result) || [] };
}

function fillPortalVariables(variables) {
  const result = {
    foundForm: false,
    filled: 0,
    alreadySet: 0,
    skipped: 0,
    unmatched: 0,
    total: Array.isArray(variables) ? variables.length : 0,
  };
  const values = Array.isArray(variables) ? variables : [];

  const unsupportedTypes = new Set([
    "11",
    "14",
    "15",
    "17",
    "19",
    "20",
    "21",
    "24",
    "25",
    "31",
    "33",
    "attachment",
    "container",
    "container_end",
    "container_start",
    "encrypted",
    "label",
    "list_collector",
    "macro",
    "multi_row",
    "multi_row_variable_set",
    "password",
    "rich_text_label",
  ]);

  const isEmpty = (value) =>
    value == null ||
    String(value).trim() === "" ||
    (Array.isArray(value) && value.length === 0);

  const isUnsupported = (variable) => {
    const type = String((variable && variable.type) || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_");
    return Boolean(type && unsupportedTypes.has(type));
  };

  const isGForm = (candidate) =>
    candidate &&
    typeof candidate.getValue === "function" &&
    typeof candidate.setValue === "function";

  const findGFormInObject = (obj, depth, seen) => {
    if (!obj || typeof obj !== "object" || depth > 3) return null;
    if (seen.indexOf(obj) >= 0) return null;
    seen.push(obj);
    if (isGForm(obj)) return obj;

    const directKeys = ["g_form", "gForm", "page", "c", "data", "$parent"];
    for (const key of directKeys) {
      try {
        const found = findGFormInObject(obj[key], depth + 1, seen);
        if (found) return found;
      } catch (e) {}
    }
    return null;
  };

  const getAngular = () => {
    try {
      return window.angular || null;
    } catch (e) {
      return null;
    }
  };

  const findPortalGForm = () => {
    try {
      if (typeof g_form !== "undefined" && isGForm(g_form)) return g_form;
    } catch (e) {}

    const angular = getAngular();
    if (!angular || !angular.element) return null;

    const selectors = [
      "sp-variable-layout",
      "sp-cat-item",
      "sp-sc-cat-item",
      ".sc-form",
      ".catalog-form",
      "[sp-model]",
      "[ng-controller]",
      "body",
    ];
    const elements = [];
    selectors.forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach((el) => elements.push(el));
      } catch (e) {}
    });

    for (const el of elements) {
      try {
        const wrapped = angular.element(el);
        const scopes = [];
        if (wrapped.scope) scopes.push(wrapped.scope());
        if (wrapped.isolateScope) scopes.push(wrapped.isolateScope());
        for (const scope of scopes) {
          const found = findGFormInObject(scope, 0, []);
          if (found) return found;
        }
      } catch (e) {}
    }
    return null;
  };

  const hasPortalFormContainer = () => {
    try {
      return Boolean(
        document.querySelector(
          "sp-variable-layout,sp-cat-item,sp-sc-cat-item,.sc-form,.catalog-form,[sp-model]"
        )
      );
    } catch (e) {
      return false;
    }
  };

  const getElementValue = (el) => {
    if (!el) return "";
    if (el.type === "checkbox") return el.checked ? "true" : "";
    if (el.type === "radio") {
      const checked = document.querySelector(
        'input[type="radio"][name="' + el.name.replace(/"/g, '\\"') + '"]:checked'
      );
      return checked ? checked.value : "";
    }
    return el.value != null ? el.value : el.textContent;
  };

  const findChoiceMatch = (choices, value, displayValue) => {
    if (!Array.isArray(choices)) return null;
    return choices.find((choice) => String(choice.value) === value) ||
      choices.find((choice) => String(choice.display_value || choice.label || choice.text) === displayValue) ||
      choices.find((choice) => String(choice.display_value || choice.label || choice.text) === value);
  };

  const isReferenceVariable = (variable) => {
    const type = String((variable && variable.type) || "").trim().toLowerCase();
    return type === "8" || type === "reference";
  };

  const findAngularFieldScopes = (el, variable) => {
    const angular = getAngular();
    if (!angular || !angular.element) return [];
    const scopes = [];
    const addScope = (scope) => {
      if (!scope || scopes.indexOf(scope) >= 0) return;
      if (scope.field && scope.field.name && variable.name && scope.field.name !== variable.name) return;
      scopes.push(scope);
    };

    let node = el;
    for (let i = 0; node && i < 8; i++, node = node.parentElement) {
      try {
        const wrapped = angular.element(node);
        if (wrapped.scope) addScope(wrapped.scope());
        if (wrapped.isolateScope) addScope(wrapped.isolateScope());
      } catch (e) {}
    }
    return scopes;
  };

  const updateSelect2Display = (el, value, displayValue) => {
    const label = displayValue || value;
    if (!label) return;

    const candidates = [];
    if (el.id) {
      candidates.push(document.getElementById("s2id_" + el.id));
    }
    let node = el;
    for (let i = 0; node && i < 4; i++, node = node.parentElement) {
      try {
        node.querySelectorAll &&
          node.querySelectorAll(".select2-container").forEach((candidate) => candidates.push(candidate));
      } catch (e) {}
      if (node.previousElementSibling) candidates.push(node.previousElementSibling);
      if (node.nextElementSibling) candidates.push(node.nextElementSibling);
    }

    candidates.filter(Boolean).forEach((container) => {
      try {
        const chosen = container.querySelector && container.querySelector(".select2-chosen");
        if (chosen) chosen.textContent = label;
        container.classList && container.classList.remove("select2-default");
        container.classList && container.classList.remove("select2-dropdown-open");
        container.setAttribute && container.setAttribute("aria-expanded", "false");
      } catch (e) {}
    });
    try {
      document.querySelectorAll(".select2-drop-active,.select2-drop,.select2-drop-mask").forEach((drop) => {
        drop.style.display = "none";
      });
    } catch (e) {}
  };

  const variableKeys = (variable) => {
    const keys = [];
    const add = (value) => {
      if (value && keys.indexOf(value) < 0) keys.push(value);
    };
    add(variable && variable.name);
    if (variable && variable.name) add("variables." + variable.name);
    if (variable && variable.questionId) {
      add(variable.questionId);
      add("IO:" + variable.questionId);
      add("ni.IO:" + variable.questionId);
      add("sys_original.IO:" + variable.questionId);
    }
    return keys;
  };

  const setElementValue = (el, variable) => {
    let value = variable.value == null ? "" : String(variable.value);
    let displayValue =
      variable.displayValue == null ? value : String(variable.displayValue);
    const fieldScopes = findAngularFieldScopes(el, variable);
    const isReference = isReferenceVariable(variable);

    fieldScopes.forEach((candidate) => {
      if (!candidate.field) return;
      const match = findChoiceMatch(candidate.field.choices, value, displayValue);
      if (match) {
        value = String(match.value);
        displayValue = String(match.display_value || match.label || match.text || displayValue);
      }
    });

    if (el.type === "checkbox") {
      el.checked = ["true", "1", "yes", "y", "on"].includes(value.toLowerCase());
    } else if (el.type === "radio") {
      const option = document.querySelector(
        'input[type="radio"][name="' +
          el.name.replace(/"/g, '\\"') +
          '"][value="' +
          value.replace(/"/g, '\\"') +
          '"]'
      );
      if (option) option.checked = true;
    } else if (el.isContentEditable) {
      el.textContent = value;
    } else if (el.tagName && el.tagName.toLowerCase() === "select") {
      const options = Array.from(el.options || []);
      const match = options.find((option) => option.value === value) ||
        options.find((option) => option.text === displayValue || option.text === value);
      if (match) {
        el.value = match.value;
        value = match.value;
        displayValue = match.text || displayValue;
      } else {
        el.value = value;
      }
    } else if (isReference && el.classList && el.classList.contains("select2-focusser")) {
      el.value = "";
    } else if (isReference && el.classList && el.classList.contains("select2-input")) {
      el.value = "";
    } else if (isReference && el.classList && el.classList.contains("select2-offscreen")) {
      el.value = value;
    } else {
      el.value = isReference ? displayValue : value;
    }

    try {
      const angular = getAngular();
      if (angular && angular.element) {
        const wrapped = angular.element(el);
        const scope = wrapped.scope && wrapped.scope();
        const isolateScope = wrapped.isolateScope && wrapped.isolateScope();
        fieldScopes.concat([scope, isolateScope]).forEach((candidate) => {
          if (!candidate || !candidate.field) return;
          if (candidate.field.name && variable.name && candidate.field.name !== variable.name) {
            return;
          }
          candidate.field.value = value;
          candidate.field.stagedValue = value;
          candidate.field.display_value = displayValue;
          candidate.field.displayValue = displayValue;
          candidate.field.display_value_list = displayValue;
          candidate.field.value_list = value;
          candidate.field.selectedValue = value;
          candidate.field.selectedDisplayValue = displayValue;
        });

        if (scope && Object.prototype.hasOwnProperty.call(scope, "fieldValue")) {
          scope.fieldValue = value;
        }
        if (isolateScope && Object.prototype.hasOwnProperty.call(isolateScope, "fieldValue")) {
          isolateScope.fieldValue = value;
        }

        const ngModel = wrapped.controller("ngModel");
        if (ngModel && typeof ngModel.$setViewValue === "function") {
          ngModel.$setViewValue(isReference ? displayValue : value);
          if (typeof ngModel.$render === "function") ngModel.$render();
        }
        if (scope && typeof scope.$applyAsync === "function") scope.$applyAsync();
        if (isolateScope && typeof isolateScope.$applyAsync === "function") {
          isolateScope.$applyAsync();
        }
      }
    } catch (e) {}

    updateSelect2Display(el, value, displayValue);

    try {
      const jq = window.jQuery || window.$;
      if (jq) {
        const wrapped = jq(el);
        if (isReference && wrapped.data && wrapped.data("select2")) {
          try {
            wrapped.select2("close");
          } catch (e) {}
        } else {
          wrapped.val(el.value || value);
          wrapped.trigger("input");
          wrapped.trigger("change");
        }
      }
    } catch (e) {}

    const events = isReference ? ["blur"] : ["input", "change", "blur"];
    events.forEach((eventName) => {
      try {
        el.dispatchEvent(new Event(eventName, { bubbles: true }));
      } catch (e) {}
    });
  };

  const findDomField = (variable) => {
    const label = variable && variable.label;
    const keys = variableKeys(variable);
    const candidates = Array.from(
      document.querySelectorAll("input,textarea,select,[contenteditable='true']")
    ).filter((el) => el.type !== "hidden");

    return candidates.find((el) => {
      const attrs = [
        el.getAttribute("name"),
        el.getAttribute("id"),
        el.getAttribute("data-name"),
        el.getAttribute("data-variable-name"),
        el.getAttribute("data-field"),
        el.getAttribute("data-field-name"),
        el.getAttribute("aria-label"),
      ].filter(Boolean);
      return attrs.some((attr) => keys.indexOf(attr) >= 0 || (label && attr === label));
    });
  };

  const fillDomVariable = (variable) => {
    const el = findDomField(variable);
    if (!el) return "missing";
    result.foundForm = true;
    if (!isEmpty(getElementValue(el))) return "already";
    setElementValue(el, variable);
    return "filled";
  };

  const fillWithDom = () => {
    result.foundForm = hasPortalFormContainer();
    values.forEach((variable) => {
      if (!variable || !variable.name || isUnsupported(variable)) {
        result.skipped++;
        return;
      }
      try {
        const domResult = fillDomVariable(variable);
        if (domResult === "filled") result.filled++;
        else if (domResult === "already") result.alreadySet++;
        else result.unmatched++;
      } catch (e) {
        result.skipped++;
      }
    });
    return result;
  };

  const fillWithGForm = (gForm) => {
    result.foundForm = true;
    values.forEach((variable) => {
      if (!variable || !variable.name || isUnsupported(variable)) {
        result.skipped++;
        return;
      }

      let handled = false;
      for (const key of variableKeys(variable)) {
        try {
          const current = gForm.getValue(key);
          if (!isEmpty(current)) {
            result.alreadySet++;
            handled = true;
            break;
          }
          if (variable.displayValue && variable.displayValue !== variable.value) {
            gForm.setValue(key, variable.value, variable.displayValue);
          } else {
            gForm.setValue(key, variable.value);
          }
          result.filled++;
          handled = true;
          break;
        } catch (e) {}
      }

      if (handled) return;
      try {
        const domResult = fillDomVariable(variable);
        if (domResult === "filled") result.filled++;
        else if (domResult === "already") result.alreadySet++;
        else result.unmatched++;
      } catch (e) {
        result.skipped++;
      }
    });
    return result;
  };

  const gForm = findPortalGForm();
  return gForm ? fillWithGForm(gForm) : fillWithDom();
}

function inspectPortalVariableDebug() {
  const report = {
    href: location.href,
    title: document.title,
    hasAngular: false,
    hasGlobalGForm: false,
    portalContainers: 0,
    gForm: null,
    angularFields: [],
    domFields: [],
  };

  const safeValue = (value) => {
    if (value == null) return "";
    if (typeof value === "string") return value.slice(0, 120);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return Object.prototype.toString.call(value);
  };

  const addUnique = (list, item, key) => {
    if (!item || !item[key]) return;
    if (!list.some((existing) => existing[key] === item[key])) list.push(item);
  };

  try {
    report.portalContainers = document.querySelectorAll(
      "sp-variable-layout,sp-cat-item,sp-sc-cat-item,.sc-form,.catalog-form,[sp-model]"
    ).length;
  } catch (e) {}

  try {
    report.hasGlobalGForm =
      typeof g_form !== "undefined" &&
      g_form &&
      typeof g_form.getValue === "function" &&
      typeof g_form.setValue === "function";
  } catch (e) {}

  const summarizeGForm = (gForm, source) => {
    if (!gForm || report.gForm) return;
    const summary = { source, keys: [], fieldNames: [] };
    try {
      summary.keys = Object.keys(gForm).slice(0, 80);
    } catch (e) {}
    const fieldContainers = [
      "_fields",
      "fields",
      "fieldMap",
      "nameMap",
      "catalogFields",
      "variables",
    ];
    fieldContainers.forEach((key) => {
      try {
        const value = gForm[key];
        if (value && typeof value === "object") {
          Object.keys(value).slice(0, 120).forEach((name) => {
            if (summary.fieldNames.indexOf(name) < 0) summary.fieldNames.push(name);
          });
        }
      } catch (e) {}
    });
    report.gForm = summary;
  };

  try {
    if (report.hasGlobalGForm) summarizeGForm(g_form, "global");
  } catch (e) {}

  const angular = (() => {
    try {
      return window.angular || null;
    } catch (e) {
      return null;
    }
  })();
  report.hasAngular = Boolean(angular && angular.element);

  const scanObjectForFields = (obj, path, depth, seen) => {
    if (!obj || typeof obj !== "object" || depth > 4 || seen.indexOf(obj) >= 0) return;
    seen.push(obj);

    try {
      if (
        typeof obj.getValue === "function" &&
        typeof obj.setValue === "function"
      ) {
        summarizeGForm(obj, path);
      }
    } catch (e) {}

    try {
      const maybeName = obj.name || obj.variable_name || obj.fieldName || obj.id;
      const maybeLabel =
        obj.label || obj.question_text || obj.questionText || obj.displayValue || obj.display_value;
      if (maybeName) {
        addUnique(
          report.angularFields,
          {
            path,
            name: safeValue(maybeName),
            label: safeValue(maybeLabel),
            type: safeValue(obj.type || obj.display_type || obj.fieldType),
            value: safeValue(obj.value),
          },
          "name"
        );
      }
    } catch (e) {}

    let keys = [];
    try {
      keys = Object.keys(obj).slice(0, 80);
    } catch (e) {}
    keys.forEach((key) => {
      if (/password|token|secret|cookie|session/i.test(key)) return;
      try {
        const value = obj[key];
        if (value && typeof value === "object") {
          scanObjectForFields(value, path + "." + key, depth + 1, seen);
        }
      } catch (e) {}
    });
  };

  if (angular && angular.element) {
    const elements = [];
    [
      "sp-variable-layout",
      "sp-cat-item",
      "sp-sc-cat-item",
      ".sc-form",
      ".catalog-form",
      "[sp-model]",
      "[ng-controller]",
      "body",
    ].forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach((el) => elements.push(el));
      } catch (e) {}
    });

    elements.slice(0, 80).forEach((el, index) => {
      try {
        const wrapped = angular.element(el);
        if (wrapped.scope) scanObjectForFields(wrapped.scope(), "scope[" + index + "]", 0, []);
        if (wrapped.isolateScope) {
          scanObjectForFields(wrapped.isolateScope(), "isolateScope[" + index + "]", 0, []);
        }
      } catch (e) {}
    });
  }

  try {
    Array.from(document.querySelectorAll("input,textarea,select,[contenteditable='true']"))
      .filter((el) => el.type !== "hidden")
      .slice(0, 160)
      .forEach((el) => {
        report.domFields.push({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type") || "",
          name: el.getAttribute("name") || "",
          id: el.getAttribute("id") || "",
          dataName: el.getAttribute("data-name") || "",
          dataVariableName: el.getAttribute("data-variable-name") || "",
          dataField: el.getAttribute("data-field") || "",
          dataFieldName: el.getAttribute("data-field-name") || "",
          ariaLabel: el.getAttribute("aria-label") || "",
          ngModel: el.getAttribute("ng-model") || "",
          classes: String(el.className || "").slice(0, 120),
          valueLength: el.value ? String(el.value).length : 0,
        });
      });
  } catch (e) {}

  return report;
}

// Content scripts can't call chrome.tabs.create; they ask us via OPEN_URL.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "OPEN_URL" && msg.url) {
    chrome.tabs.create({ url: msg.url });
  }
  if (
    msg &&
    sender.tab &&
    (msg.type === "TOGGLE_FIELD_NAMES" || msg.type === "TOGGLE_TRANSLATIONS")
  ) {
    postWindowMessageInAllFrames(sender.tab.id, msg.type);
  }
  if (msg && msg.type === "SN_TABLE_GET" && sender.tab) {
    const request = {
      table: msg.table,
      query: msg.query,
      fields: msg.fields,
      limit: msg.limit,
      options: msg.options || {},
    };
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, allFrames: true },
      world: "MAIN",
      func: tableApiGetInPage,
      args: [request],
    }).then((results) => {
      const responses = results
        .map((item) => item && item.result)
        .filter(Boolean);
      const ok = responses.find((item) => item.ok);
      if (ok) {
        sendResponse({ ok: true, result: ok.result || [] });
        return;
      }
      const error = responses.find((item) => !item.ok);
      sendResponse({
        ok: false,
        error: (error && error.error) || "Couldn't read " + request.table,
      });
    }).catch((error) => {
      sendResponse({ ok: false, error: String(error) });
    });
    return true;
  }
  if (msg && msg.type === "GET_SYS_ID" && sender.tab) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, allFrames: true },
      world: "MAIN",
      func: extractSysId,
    }).then((results) => {
      const found = results
        .map((item) => item && item.result)
        .find((id) => id && /^[0-9a-f]{32}$/i.test(id));
      sendResponse({ ok: Boolean(found), sysId: found || null });
    }).catch((error) => {
      sendResponse({ ok: false, error: String(error) });
    });
    return true;
  }
  if (msg && msg.type === "FILL_PORTAL_VARIABLES" && sender.tab) {
    const variables = Array.isArray(msg.variables) ? msg.variables : [];
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, allFrames: true },
      world: "MAIN",
      func: fillPortalVariables,
      args: [variables],
    }).then((results) => {
      const frameResults = results
        .map((item) => item && item.result)
        .filter(Boolean);
      const found = frameResults
        .filter((item) => item.foundForm)
        .sort((a, b) => {
          const scoreA = (a.filled || 0) + (a.alreadySet || 0) + (a.skipped || 0);
          const scoreB = (b.filled || 0) + (b.alreadySet || 0) + (b.skipped || 0);
          return scoreB - scoreA;
        })[0];
      sendResponse({
        ok: true,
        foundForm: Boolean(found),
        filled: found ? found.filled || 0 : 0,
        alreadySet: found ? found.alreadySet || 0 : 0,
        skipped: found ? found.skipped || 0 : 0,
        unmatched: found ? found.unmatched || 0 : 0,
        total: variables.length,
      });
    }).catch((error) => {
      sendResponse({ ok: false, error: String(error) });
    });
    return true;
  }
  if (msg && msg.type === "GET_PORTAL_VARIABLE_DEBUG" && sender.tab) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, allFrames: true },
      world: "MAIN",
      func: inspectPortalVariableDebug,
    }).then((results) => {
      sendResponse({
        ok: true,
        frames: results.map((item) => item && item.result).filter(Boolean),
      });
    }).catch((error) => {
      sendResponse({ ok: false, error: String(error) });
    });
    return true;
  }
  // A sub-frame (e.g. gsft_main) pressed the shortcut; relay to the whole
  // tab so the top frame's content script can toggle the palette.
  if (msg && msg.type === "TOGGLE_PALETTE" && sender.tab) {
    togglePaletteInTopFrame(sender.tab.id);
  }
});
