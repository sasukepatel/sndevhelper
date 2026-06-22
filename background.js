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
  if (request.fields) params.set("sysparm_fields", request.fields);
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

async function fillPortalVariables(variables) {
  const result = {
    foundForm: false,
    filled: 0,
    alreadySet: 0,
    skipped: 0,
    unmatched: 0,
    total: Array.isArray(variables) ? variables.length : 0,
  };
  const values = Array.isArray(variables) ? variables : [];
  const simpleFillDelayMs = 75;
  const choiceFillDelayMs = 300;
  const referenceFillDelayMs = 900;
  const triggerReferenceDelayMs = 2500;
  const retryDelayMs = 500;
  const maxFillPasses = 3;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const emitProgress = (message) => {
    try {
      window.postMessage(
        { source: "SN_DEV_HELPER_PREFILL_PROGRESS", message },
        location.origin
      );
    } catch (e) {}
  };

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

  const currentCatalogItemSysId = () => {
    try {
      const url = new URL(location.href);
      const sysId = url.searchParams.get("sys_id");
      if (sysId && /^[0-9a-f]{32}$/i.test(sysId)) return sysId;
    } catch (e) {}

    try {
      const el = document.querySelector("[cat-item-sys-id],[data-item-sys-id],[data-sys-id]");
      const sysId =
        (el && (el.getAttribute("cat-item-sys-id") || el.getAttribute("data-item-sys-id") || el.getAttribute("data-sys-id"))) ||
        "";
      if (/^[0-9a-f]{32}$/i.test(sysId)) return sysId;
    } catch (e) {}

    return "";
  };

  const gFormSysId = (gForm) => {
    try {
      return typeof gForm.getSysId === "function" ? String(gForm.getSysId() || "") : "";
    } catch (e) {
      return "";
    }
  };

  const scoreGForm = (gForm, scope, el, itemSysId, source) => {
    if (!isGForm(gForm)) return -1;
    let score = 0;
    const sysId = gFormSysId(gForm);
    if (source && source.indexOf("getGlideForm()") >= 0) score += 300;
    if (source === "scope.page.g_form" || source === "scope.page.gForm") score += 250;
    if (source === "scope.g_form" || source === "scope.gForm") score += 150;
    if (itemSysId && sysId === itemSysId) score += 100;
    if (sysId === "-1") score += 80;
    if (!sysId) score += 10;

    try {
      if (scope && scope.c && typeof scope.c.getItemId === "function" && scope.c.getItemId() === itemSysId) {
        score += 100;
      }
    } catch (e) {}
    try {
      if (scope && scope.data && scope.data.sc_cat_item && scope.data.sc_cat_item.sys_id === itemSysId) {
        score += 80;
      }
    } catch (e) {}
    try {
      if (scope && scope.data && scope.data.sys_id === itemSysId) score += 40;
    } catch (e) {}
    try {
      if (el && el.id === "sc_cat_item") score += 150;
    } catch (e) {}
    try {
      if (el && el.matches && el.matches("sp-variable-layout,sp-cat-item,sp-sc-cat-item,.sc-form,.catalog-form,[sp-model]")) {
        score += 25;
      }
    } catch (e) {}

    return score;
  };

  const findGFormsInObject = (obj, depth, seen, found) => {
    if (!obj || typeof obj !== "object" || depth > 3) return;
    if (seen.indexOf(obj) >= 0) return null;
    seen.push(obj);
    if (isGForm(obj) && found.indexOf(obj) < 0) found.push(obj);

    const directKeys = ["g_form", "gForm", "page", "c", "data", "$parent"];
    for (const key of directKeys) {
      try {
        findGFormsInObject(obj[key], depth + 1, seen, found);
      } catch (e) {}
    }
  };

  const getAngular = () => {
    try {
      return window.angular || null;
    } catch (e) {
      return null;
    }
  };

  const findPortalGForm = () => {
    const itemSysId = currentCatalogItemSysId();
    const candidates = [];
    const addCandidate = (gForm, scope, el, source) => {
      if (!isGForm(gForm)) return;
      if (candidates.some((candidate) => candidate.gForm === gForm)) return;
      candidates.push({
        gForm,
        score: scoreGForm(gForm, scope, el, itemSysId, source),
        source,
      });
    };
    const addScopeCandidates = (scope, el, sourcePrefix) => {
      if (!scope) return;
      try {
        if (scope.page) {
          addCandidate(scope.page.g_form, scope, el, sourcePrefix + ".page.g_form");
          addCandidate(scope.page.gForm, scope, el, sourcePrefix + ".page.gForm");
        }
      } catch (e) {}
      try {
        addCandidate(scope.g_form, scope, el, sourcePrefix + ".g_form");
        addCandidate(scope.gForm, scope, el, sourcePrefix + ".gForm");
      } catch (e) {}
      try {
        if (typeof scope.getGlideForm === "function") {
          addCandidate(scope.getGlideForm(), scope, el, sourcePrefix + ".getGlideForm()");
        }
      } catch (e) {}
      try {
        if (scope.$parent && typeof scope.$parent.getGlideForm === "function") {
          addCandidate(scope.$parent.getGlideForm(), scope.$parent, el, sourcePrefix + ".$parent.getGlideForm()");
        }
      } catch (e) {}
    };

    try {
      if (typeof g_form !== "undefined") addCandidate(g_form, null, document.body, "global");
    } catch (e) {}

    const angular = getAngular();
    if (!angular || !angular.element) {
      candidates.sort((a, b) => b.score - a.score);
      return candidates.length ? candidates[0].gForm : null;
    }

    const selectors = [
      "#sc_cat_item",
      "#sc_cat_item sp-variable-layout",
      "sp-variable-layout#sc_cat_item\\.do",
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
        for (let i = 0; i < scopes.length; i++) {
          const scope = scopes[i];
          addScopeCandidates(scope, el, "scope" + i);
          const found = [];
          findGFormsInObject(scope, 0, [], found);
          found.forEach((gForm) => addCandidate(gForm, scope, el, "scope"));
        }
      } catch (e) {}
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].gForm : null;
  };

  const hasPortalFormContainer = () => {
    try {
      return Boolean(
        document.querySelector(
          "#sc_cat_item,sp-variable-layout,sp-cat-item,sp-sc-cat-item,.sc-form,.catalog-form,[sp-model]"
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

  const normalizeComparable = (value) =>
    String(value == null ? "" : value)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");

  const sameValue = (left, right) => {
    const a = normalizeComparable(left);
    const b = normalizeComparable(right);
    return Boolean(a && b && a === b);
  };

  const choiceLabel = (choice) =>
    choice && (choice.display_value || choice.label || choice.text || choice.displayValue || choice.name || "");

  const findChoiceMatch = (choices, value, displayValue) => {
    if (!Array.isArray(choices)) return null;
    return choices.find((choice) => sameValue(choice.value, value)) ||
      choices.find((choice) => sameValue(choiceLabel(choice), displayValue)) ||
      choices.find((choice) => sameValue(choiceLabel(choice), value));
  };

  const isReferenceVariable = (variable) => {
    const type = String((variable && variable.type) || "").trim().toLowerCase();
    return type === "8" || type === "reference";
  };

  const isChoiceLikeVariable = (variable) => {
    const type = String((variable && variable.type) || "").trim().toLowerCase();
    return ["3", "5", "18", "choice", "multiple_choice", "select_box"].indexOf(type) >= 0;
  };

  const isKnownAsyncTriggerVariable = (variable) =>
    ["country_site"].indexOf(String((variable && variable.name) || "").toLowerCase()) >= 0;

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

  const findRadioByChoiceScope = (radios, value, displayValue) => {
    const angular = getAngular();
    if (!angular || !angular.element) return null;

    for (const radio of radios) {
      try {
        const wrapped = angular.element(radio);
        const scopes = [];
        if (wrapped.scope) scopes.push(wrapped.scope());
        if (wrapped.isolateScope) scopes.push(wrapped.isolateScope());

        for (const scope of scopes) {
          const choice = scope && (scope.c || scope.choice || scope.option);
          if (choice && findChoiceMatch([choice], value, displayValue)) return radio;
        }
      } catch (e) {}
    }
    return null;
  };

  const findRadioOption = (el, value, displayValue) => {
    const radios = Array.from(
      document.querySelectorAll(
        'input[type="radio"][name="' + el.name.replace(/"/g, '\\"') + '"]'
      )
    );

    return radios.find((radio) => sameValue(radio.value, value)) ||
      radios.find((radio) => sameValue(radio.value, displayValue)) ||
      radios.find((radio) => sameValue(radio.getAttribute("aria-label"), displayValue)) ||
      radios.find((radio) => sameValue(radio.getAttribute("aria-label"), value)) ||
      radios.find((radio) => sameValue(radio.closest("label") && radio.closest("label").textContent, displayValue)) ||
      radios.find((radio) => sameValue(radio.closest("label") && radio.closest("label").textContent, value)) ||
      findRadioByChoiceScope(radios, value, displayValue);
  };

  const selectRadioOption = (option) => {
    if (!option) return false;
    option.checked = true;
    option.setAttribute("aria-checked", "true");
    try {
      option.click();
    } catch (e) {}
    ["input", "change", "blur"].forEach((eventName) => {
      try {
        option.dispatchEvent(new Event(eventName, { bubbles: true }));
      } catch (e) {}
    });
    return true;
  };

  const visibleText = (el) =>
    el && String(el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim();

  const clickOption = (option) => {
    if (!option) return false;
    ["mousedown", "mouseup", "click"].forEach((eventName) => {
      try {
        option.dispatchEvent(new MouseEvent(eventName, { bubbles: true, cancelable: true, view: window }));
      } catch (e) {}
    });
    try {
      option.click();
    } catch (e) {}
    return true;
  };

  const dispatchKeyboardCommit = (el) => {
    if (!el) return;
    ["ArrowDown", "Enter", "Tab"].forEach((key) => {
      try {
        el.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            code: key,
            bubbles: true,
            cancelable: true,
            view: window,
          })
        );
      } catch (e) {}
    });
  };

  const findReferenceSuggestion = (value, displayValue) => {
    const selectors = [
      "[role='option']",
      ".select2-result-selectable",
      ".select2-result",
      ".angucomplete-row",
      ".typeahead li",
      ".typeahead-result",
      ".dropdown-menu li",
      "ul[role='listbox'] li",
      "li",
    ];
    const candidates = [];
    selectors.forEach((selector) => {
      try {
        document.querySelectorAll(selector).forEach((option) => {
          if (option.offsetParent !== null && candidates.indexOf(option) < 0) candidates.push(option);
        });
      } catch (e) {}
    });

    return candidates.find((option) => sameValue(visibleText(option), displayValue)) ||
      candidates.find((option) => sameValue(visibleText(option), value)) ||
      candidates.find((option) => {
        const text = normalizeComparable(visibleText(option));
        const display = normalizeComparable(displayValue);
        const raw = normalizeComparable(value);
        return Boolean(text && ((display && text.indexOf(display) >= 0) || (raw && text.indexOf(raw) >= 0)));
      }) ||
      (/^[0-9a-f]{32}$/i.test(String(value || "")) && sameValue(value, displayValue) ? candidates[0] : null);
  };

  const commitReferenceSuggestion = async (el, value, displayValue) => {
    if (!displayValue && !value) return false;

    const query = displayValue || value;
    if (el && "value" in el) {
      el.value = query;
      ["focus", "input", "keyup"].forEach((eventName) => {
        try {
          el.dispatchEvent(new Event(eventName, { bubbles: true }));
        } catch (e) {}
      });
      dispatchKeyboardCommit(el);
    }

    for (let i = 0; i < 8; i++) {
      await sleep(125);
      const option = findReferenceSuggestion(value, displayValue);
      if (clickOption(option)) {
        await sleep(125);
        return true;
      }
    }
    return false;
  };

  const invokeAngularChangeHandlers = (el, variable, value, displayValue) => {
    const angular = getAngular();
    if (!angular || !angular.element) return;

    const scopes = findAngularFieldScopes(el, variable);
    scopes.forEach((scope) => {
      try {
        if (scope.field) {
          scope.field.value = value;
          scope.field.display_value = displayValue;
          scope.field.displayValue = displayValue;
          scope.field.stagedValue = value;
        }
        ["onChange", "change", "fieldChange", "fieldChanged", "onFieldChange"].forEach((name) => {
          try {
            if (typeof scope[name] === "function") scope[name](scope.field, value, displayValue);
          } catch (e) {}
          try {
            if (scope.field && typeof scope.field[name] === "function") {
              scope.field[name](value, displayValue);
            }
          } catch (e) {}
        });
        if (typeof scope.$emit === "function") {
          scope.$emit("field.change", scope.field || variable, value, displayValue);
          scope.$emit("spModel.field.change", scope.field || variable, value, displayValue);
        }
        if (typeof scope.$broadcast === "function") {
          scope.$broadcast("field.change", scope.field || variable, value, displayValue);
        }
        if (typeof scope.$applyAsync === "function") scope.$applyAsync();
      } catch (e) {}
    });
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

  const invokeGFormChangeHandlers = (gForm, key, variable, oldValue) => {
    if (!gForm || !key) return;
    const newValue = variable && variable.value != null ? String(variable.value) : "";
    const displayValue = variable && variable.displayValue != null ? String(variable.displayValue) : newValue;

    ["triggerOnChange", "_triggerOnChange", "fieldChanged", "onChange", "notifyChange", "change"].forEach((name) => {
      try {
        if (typeof gForm[name] === "function") gForm[name](key, oldValue || "", newValue, false);
      } catch (e) {}
      try {
        if (typeof gForm[name] === "function") gForm[name](key, newValue, displayValue);
      } catch (e) {}
      try {
        if (typeof gForm[name] === "function") gForm[name](key);
      } catch (e) {}
    });

    try {
      const events = gForm.$private && gForm.$private.events;
      if (events && typeof events.fire === "function") {
        events.fire("change", key, oldValue || "", newValue);
        events.fire("propertyChange", key, oldValue || "", newValue);
      }
    } catch (e) {}
  };

  const setGFormValue = (gForm, key, variable) => {
    if (!gForm || !key || !variable) return false;
    try {
      if (variable.displayValue && variable.displayValue !== variable.value) {
        gForm.setValue(key, variable.value, variable.displayValue);
      } else {
        gForm.setValue(key, variable.value);
      }
      return true;
    } catch (e) {
      return false;
    }
  };

  const setElementValue = async (el, variable) => {
    let value = variable.value == null ? "" : String(variable.value);
    let displayValue =
      variable.displayValue == null ? value : String(variable.displayValue);
    let fieldScopes = findAngularFieldScopes(el, variable);
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
      const option = findRadioOption(el, value, displayValue);
      if (!selectRadioOption(option)) return false;
      if (option !== el) {
        fieldScopes = fieldScopes.concat(
          findAngularFieldScopes(option, variable).filter((scope) => fieldScopes.indexOf(scope) < 0)
        );
        el = option;
      }
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
          ngModel.$setViewValue(value);
          if (typeof ngModel.$render === "function") ngModel.$render();
        }
        if (scope && typeof scope.$applyAsync === "function") scope.$applyAsync();
        if (isolateScope && typeof isolateScope.$applyAsync === "function") {
          isolateScope.$applyAsync();
        }
      }
    } catch (e) {}

    updateSelect2Display(el, value, displayValue);

    if (isReference && !(el.classList && el.classList.contains("select2-offscreen"))) {
      await commitReferenceSuggestion(el, value, displayValue);
    }
    invokeAngularChangeHandlers(el, variable, value, displayValue);

    try {
      const jq = window.jQuery || window.$;
      if (jq) {
        const wrapped = jq(el);
        if (isReference && wrapped.data && wrapped.data("select2")) {
          try {
            wrapped.select2("close");
          } catch (e) {}
        } else if (isReference) {
          wrapped.trigger("change");
          wrapped.trigger("blur");
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

    return true;
  };

  const findDomField = (variable) => {
    const label = variable && variable.label;
    const keys = variableKeys(variable);
    const candidates = Array.from(
      document.querySelectorAll("input,textarea,select,[contenteditable='true']")
    ).filter((el) => el.type !== "hidden");

    const direct = candidates.find((el) => {
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

    if (direct) return direct;

    const fieldContainers = Array.from(
      document.querySelectorAll(
        "fieldset,[id^='sp_formfield_'],[data-variable-name],[data-field-name],[data-name]"
      )
    );
    const matchesContainer = (el) => {
      const attrs = [
        el.getAttribute("id"),
        el.getAttribute("name"),
        el.getAttribute("data-name"),
        el.getAttribute("data-variable-name"),
        el.getAttribute("data-field"),
        el.getAttribute("data-field-name"),
        el.getAttribute("aria-label"),
      ].filter(Boolean);

      return attrs.some((attr) => {
        const normalizedAttr = attr.replace(/^sp_formfield_/, "");
        return keys.indexOf(attr) >= 0 ||
          keys.indexOf(normalizedAttr) >= 0 ||
          (label && sameValue(attr, label));
      });
    };

    const container = fieldContainers.find(matchesContainer);
    if (!container) return null;
    return container.querySelector("input:not([type='hidden']),textarea,select,[contenteditable='true']");
  };

  const fillDomVariable = async (variable) => {
    const el = findDomField(variable);
    if (!el) return "missing";
    result.foundForm = true;
    if (!isEmpty(getElementValue(el))) return "already";
    if (!(await setElementValue(el, variable))) return "missing";
    return "filled";
  };

  const triggerDomChangeForVariable = async (variable) => {
    const el = findDomField(variable);
    if (!el) return false;
    result.foundForm = true;
    return Boolean(await setElementValue(el, variable));
  };

  const delayAfterVariableChange = async (variable) => {
    let delay = simpleFillDelayMs;
    if (isChoiceLikeVariable(variable)) delay = choiceFillDelayMs;
    if (isReferenceVariable(variable)) delay = referenceFillDelayMs;
    if (isKnownAsyncTriggerVariable(variable)) delay = triggerReferenceDelayMs;
    if (delay > 0) await sleep(delay);
  };

  const fillWithDom = async () => {
    result.foundForm = hasPortalFormContainer();
    if (!result.foundForm) return result;

    const fillDomBatch = async (batch, pass) => {
      const missing = [];
      let index = 0;
      for (const variable of batch) {
        index++;
        if (!variable || !variable.name || isUnsupported(variable)) {
          if (pass === 1) result.skipped++;
          continue;
        }
        try {
          const prefix = pass > 1 ? "Retrying" : "Filling";
          emitProgress(prefix + " " + index + " of " + batch.length + ": " + (variable.label || variable.name));
          const domResult = await fillDomVariable(variable);
          if (domResult === "filled") {
            result.filled++;
            await delayAfterVariableChange(variable);
          } else if (domResult === "already") {
            result.alreadySet++;
          } else {
            missing.push(variable);
          }
        } catch (e) {
          if (pass === maxFillPasses) result.skipped++;
          else missing.push(variable);
        }
      }
      return missing;
    };

    let pending = await fillDomBatch(values, 1);
    for (let pass = 2; pass <= maxFillPasses && pending.length; pass++) {
      emitProgress("Waiting for dependent fields...");
      await sleep(retryDelayMs);
      pending = await fillDomBatch(pending, pass);
    }

    result.unmatched += pending.length;
    return result;
  };

  const fillWithGForm = async (gForm) => {
    result.foundForm = true;

    const fillBatch = async (batch, pass) => {
      const missing = [];
      let index = 0;
      for (const variable of batch) {
        index++;
        if (!variable || !variable.name || isUnsupported(variable)) {
          if (pass === 1) result.skipped++;
          continue;
        }

        let handled = false;
        for (const key of variableKeys(variable)) {
          try {
            const prefix = pass > 1 ? "Retrying" : "Filling";
            emitProgress(prefix + " " + index + " of " + batch.length + ": " + (variable.label || variable.name));
            const current = gForm.getValue(key);
            if (!isEmpty(current)) {
              if (isKnownAsyncTriggerVariable(variable)) {
                await triggerDomChangeForVariable(variable);
                setGFormValue(gForm, key, variable);
                invokeGFormChangeHandlers(gForm, key, variable, current);
                await delayAfterVariableChange(variable);
              }
              result.alreadySet++;
              handled = true;
              break;
            }
            if (!setGFormValue(gForm, key, variable)) continue;
            await triggerDomChangeForVariable(variable);
            setGFormValue(gForm, key, variable);
            invokeGFormChangeHandlers(gForm, key, variable, current);
            result.filled++;
            handled = true;
            await delayAfterVariableChange(variable);
            break;
          } catch (e) {}
        }

        if (handled) continue;
        try {
          const prefix = pass > 1 ? "Retrying" : "Filling";
          emitProgress(prefix + " " + index + " of " + batch.length + ": " + (variable.label || variable.name));
          const domResult = await fillDomVariable(variable);
          if (domResult === "filled") {
            result.filled++;
            await delayAfterVariableChange(variable);
          } else if (domResult === "already") {
            result.alreadySet++;
          } else {
            missing.push(variable);
          }
        } catch (e) {
          if (pass === maxFillPasses) result.skipped++;
          else missing.push(variable);
        }
      }
      return missing;
    };

    let pending = await fillBatch(values, 1);
    for (let pass = 2; pass <= maxFillPasses && pending.length; pass++) {
      emitProgress("Waiting for dependent fields...");
      await sleep(retryDelayMs);
      pending = await fillBatch(pending, pass);
    }

    result.unmatched += pending.length;
    return result;
  };

  const gForm = findPortalGForm();
  return gForm ? await fillWithGForm(gForm) : await fillWithDom();
}

function inspectPortalVariableDebug() {
  const report = {
    href: location.href,
    title: document.title,
    hasAngular: false,
    hasGlobalGForm: false,
    portalContainers: 0,
    gForm: null,
    gFormCandidates: [],
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
      "#sc_cat_item,sp-variable-layout,sp-cat-item,sp-sc-cat-item,.sc-form,.catalog-form,[sp-model]"
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
    if (!gForm) return;
    if (report.gFormCandidates.some((candidate) => candidate.source === source)) return;
    const summary = { source, keys: [], fieldNames: [] };
    try {
      summary.sysId = typeof gForm.getSysId === "function" ? safeValue(gForm.getSysId()) : "";
    } catch (e) {}
    try {
      summary.countrySite = typeof gForm.getValue === "function" ? safeValue(gForm.getValue("country_site")) : "";
    } catch (e) {}
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
    report.gFormCandidates.push(summary);
    if (!report.gForm) report.gForm = summary;
  };

  const summarizeScopeGForms = (scope, source) => {
    if (!scope) return;
    try {
      if (scope.page) {
        summarizeGForm(scope.page.g_form, source + ".page.g_form");
        summarizeGForm(scope.page.gForm, source + ".page.gForm");
      }
    } catch (e) {}
    try {
      summarizeGForm(scope.g_form, source + ".g_form");
      summarizeGForm(scope.gForm, source + ".gForm");
    } catch (e) {}
    try {
      if (typeof scope.getGlideForm === "function") {
        summarizeGForm(scope.getGlideForm(), source + ".getGlideForm()");
      }
    } catch (e) {}
    try {
      if (scope.$parent && typeof scope.$parent.getGlideForm === "function") {
        summarizeGForm(scope.$parent.getGlideForm(), source + ".$parent.getGlideForm()");
      }
    } catch (e) {}
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
      "#sc_cat_item",
      "#sc_cat_item sp-variable-layout",
      "sp-variable-layout#sc_cat_item\\.do",
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
        if (wrapped.scope) {
          const scope = wrapped.scope();
          summarizeScopeGForms(scope, "scope[" + index + "]");
          scanObjectForFields(scope, "scope[" + index + "]", 0, []);
        }
        if (wrapped.isolateScope) {
          const isolateScope = wrapped.isolateScope();
          summarizeScopeGForms(isolateScope, "isolateScope[" + index + "]");
          scanObjectForFields(isolateScope, "isolateScope[" + index + "]", 0, []);
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
  if (msg && msg.type === "PREFILL_PROGRESS" && sender.tab) {
    sendToTab(
      sender.tab.id,
      { type: "PREFILL_PROGRESS", message: msg.message || "Filling portal form..." },
      { frameId: 0 }
    );
  }
  // A sub-frame (e.g. gsft_main) pressed the shortcut; relay to the whole
  // tab so the top frame's content script can toggle the palette.
  if (msg && msg.type === "TOGGLE_PALETTE" && sender.tab) {
    togglePaletteInTopFrame(sender.tab.id);
  }
});
