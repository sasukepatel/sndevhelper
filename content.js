/*
 * content.js — runs in the ISOLATED world, in EVERY frame of the instance.
 *
 * Why all frames: the classic ServiceNow UI runs the actual app inside an
 * iframe named "gsft_main". The toolbar/shell is the top frame. Form DOM
 * (labels, fields) lives in gsft_main. By injecting into all frames we make
 * sure DOM features run where the form actually is.
 *
 * This world can read/modify the DOM but CANNOT read page JS globals
 * (g_form, g_user, g_ck). For those we use chrome.scripting in popup.js
 * with world:"MAIN". Here we only touch the DOM.
 */

const SNH = { fieldNamesOn: false, transIconsOn: false, lastPrefillVariables: [] };
const SNH_FRAME_COMMAND_SOURCE = "SN_DEV_HELPER_FRAME_COMMAND";
const SNH_PREFILL_PROGRESS_SOURCE = "SN_DEV_HELPER_PREFILL_PROGRESS";
const WORKSPACE_FIELD_ATTRS = [
  "data-field-name",
  "data-fieldname",
  "data-field",
  "field-name",
  "fieldname",
  "field",
  "data-column-name",
  "data-column",
  "column-name",
  "column",
  "data-name",
  "name",
];
const WORKSPACE_FIELD_DENYLIST = new Set([
  "actions",
  "append",
  "backward",
  "bottom",
  "button",
  "checkbox",
  "clear",
  "combobox",
  "content",
  "control",
  "controls",
  "default",
  "end",
  "error",
  "footer",
  "form",
  "forward",
  "header",
  "help",
  "icon",
  "input",
  "label",
  "leading",
  "left",
  "list",
  "menu",
  "message",
  "prepend",
  "record",
  "right",
  "search",
  "start",
  "suffix",
  "table",
  "text",
  "top",
  "trailing",
  "trigger",
  "value",
]);

function handleFrameCommand(type) {
  if (type === "TOGGLE_FIELD_NAMES") return toggleFieldNames();
  if (type === "TOGGLE_TRANSLATIONS") return toggleTranslationIcons();
  return null;
}

function broadcastFrameCommand(type) {
  chrome.runtime.sendMessage({ type });
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg) return;
  if (event.origin && event.origin !== location.origin) return;

  if (msg.source === SNH_FRAME_COMMAND_SOURCE) {
    handleFrameCommand(msg.type);
  }

  if (msg.source === SNH_PREFILL_PROGRESS_SOURCE) {
    if (window === window.top) {
      showToast(msg.message || "Filling portal form...", false, 6000);
    } else {
      chrome.runtime.sendMessage({
        type: "PREFILL_PROGRESS",
        message: msg.message || "Filling portal form...",
      });
    }
  }
});

function decodedVariants(text) {
  const values = [];
  let value = String(text || "");
  for (let i = 0; i < 3 && value; i++) {
    values.push(value);
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch (e) {
      break;
    }
  }
  return values;
}

function recordContextFromText(text) {
  for (const value of decodedVariants(text)) {
    const workspace = value.match(
      /\/now\/(?:[^/?#]+\/)*record\/([^/?#]+)\/([0-9a-f]{32})(?:[/?#]|$)/i
    );
    if (workspace) return { table: workspace[1], sysId: workspace[2] };

    const classic = value.match(/\/([a-z][a-z0-9_]*)\.do(?:[?#]|$)/i);
    const sysId = sysIdFromText(value);
    if (classic) return { table: classic[1], sysId };
  }
  return { table: null, sysId: sysIdFromText(text) };
}

function isTechnicalFieldName(value) {
  if (!value) return false;
  const text = String(value).trim();
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?$/i.test(text)) return false;
  return !WORKSPACE_FIELD_DENYLIST.has(text.toLowerCase());
}

function parseClassicLabel(labelEl) {
  const parts = labelEl.id.split(".");
  if (parts.length < 3) return null;
  return {
    table: parts[1],
    field: parts.slice(2).join("."),
    target: labelEl,
  };
}

function walkRoots(root, visit) {
  if (!root || !root.querySelectorAll) return;
  visit(root);
  root.querySelectorAll("*").forEach((el) => {
    if (el.shadowRoot) walkRoots(el.shadowRoot, visit);
  });
}

function getWorkspaceFieldInfo(el, context) {
  for (const attr of WORKSPACE_FIELD_ATTRS) {
    const raw = el.getAttribute && el.getAttribute(attr);
    if (!raw) continue;

    let value = raw.trim();
    if (value.includes(".") && context.table && value.startsWith(context.table + ".")) {
      value = value.slice(context.table.length + 1);
    }
    if (!isTechnicalFieldName(value)) continue;

    if (
      ["name", "field", "data-name"].includes(attr) &&
      !isLikelyWorkspaceFieldElement(el)
    ) {
      continue;
    }
    return {
      table: context.table,
      field: value,
      target: findWorkspaceInsertTarget(el),
    };
  }
  return null;
}

function isServiceNowComponent(el) {
  const name = el.localName || "";
  return name.startsWith("now-") || name.startsWith("sn-") || name.includes("record");
}

function isInsideServiceNowShadow(el) {
  const root = el.getRootNode && el.getRootNode();
  return root && root.host && isServiceNowComponent(root.host);
}

function isLikelyWorkspaceFieldElement(el) {
  if (isServiceNowComponent(el) || isInsideServiceNowShadow(el)) return true;

  const role = el.getAttribute && el.getAttribute("role");
  if (["textbox", "combobox", "checkbox", "spinbutton"].includes(role)) return true;

  const tag = el.localName || "";
  if (["input", "textarea", "select"].includes(tag)) return true;

  return Boolean(
    el.closest &&
      el.closest(
        'now-record-form-field,now-record-reference,sn-record-form-field,[data-component-id*="field" i],[class*="field" i]'
      )
  );
}

function findWorkspaceInsertTarget(el) {
  if (el.shadowRoot) {
    const label = el.shadowRoot.querySelector(
      'label,[part~="label"],[class*="label" i],[data-label]'
    );
    if (label) return label;
  }

  const labelled = el.closest &&
    el.closest('label,[data-field-name],[data-fieldname],[data-field],[field-name],[fieldname],[field]');
  if (labelled) return labelled;

  const root = el.getRootNode && el.getRootNode();
  if (root && root.querySelector) {
    const label = root.querySelector(
      'label,[part~="label"],[class*="label" i],[data-label]'
    );
    if (label) return label;
  }

  if (["input", "textarea", "select"].includes(el.localName)) {
    return el.parentElement || (root && root.host) || el;
  }
  return el;
}

function appendFieldBadge(target, field, extraClass) {
  const badge = document.createElement("span");
  badge.className = "snh-fieldname" + (extraClass ? " " + extraClass : "");
  badge.textContent = " [" + field + "]";
  badge.style.cssText =
    "color:#0a7d4f;font-size:11px;font-weight:700;margin-left:5px;" +
    "font-family:monospace;letter-spacing:.2px;";
  target.appendChild(badge);
}

function getClassicFields() {
  return Array.from(document.querySelectorAll('[id^="label."]'))
    .map(parseClassicLabel)
    .filter(Boolean);
}

function getWorkspaceFields() {
  const context = recordContextFromText(location.href);
  if (!context.table) return [];

  const fields = [];
  const seen = new WeakMap();
  walkRoots(document, (root) => {
    root.querySelectorAll("*").forEach((el) => {
      if (el.classList && (el.classList.contains("snh-fieldname") || el.classList.contains("snh-trans-icon"))) {
        return;
      }
      const info = getWorkspaceFieldInfo(el, context);
      if (!info || !info.target) return;

      let targetFields = seen.get(info.target);
      if (!targetFields) {
        targetFields = new Set();
        seen.set(info.target, targetFields);
      }
      if (targetFields.has(info.field)) return;
      targetFields.add(info.field);
      fields.push(info);
    });
  });
  return fields;
}

function removeSnhElements(selector) {
  document.querySelectorAll(selector).forEach((n) => n.remove());
  walkRoots(document, (root) => {
    if (root === document) return;
    root.querySelectorAll(selector).forEach((n) => n.remove());
  });
}

function toggleFieldNames(force) {
  const turnOn = typeof force === "boolean" ? force : !SNH.fieldNamesOn;
  SNH.fieldNamesOn = turnOn;

  removeSnhElements(".snh-fieldname");
  if (!turnOn) return 0;

  let count = 0;
  getClassicFields().forEach(({ field, target }) => {
    appendFieldBadge(target, field);
    count++;
  });

  getWorkspaceFields().forEach(({ field, target }) => {
    appendFieldBadge(target, field, "snh-workspace-fieldname");
    count++;
  });
  return count;
}

/*
 * Translation icons: two clickable icons next to each form label.
 *
 *  1. Globe  -> sys_documentation  (per-language LABEL / plural / hint).
 *               Keyed by table.field, NOT per record.
 *  2. Glyph  -> sys_translated_text (per-record translated VALUES, for fields
 *               flagged translatable). Keyed by the record's sys_id.
 *
 * Inheritance: a field shown on a form may be defined on a PARENT table
 * (e.g. task.short_description on an incident form), and its sys_documentation
 * rows are keyed to the parent. So before opening, we resolve the field's
 * DEFINING table by walking the sys_db_object.super_class chain and checking
 * sys_dictionary at each level. This uses same-origin authenticated GETs from
 * the gsft_main frame (the session cookie carries auth). If an instance
 * enforces a CSRF token on GET, the calls fail and we fall back to the form
 * table — never worse than before.
 */

// Lucide "globe" (label/documentation translations).
const ICON_DOC =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="9"></circle>' +
  '<path d="M3 12h18"></path>' +
  '<path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18"></path></svg>';

// Lucide "languages" (data-value translations).
const ICON_VALUE =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<path d="m5 8 6 6"></path><path d="m4 14 6-6 2-3"></path>' +
  '<path d="M2 5h12"></path><path d="M7 2h1"></path>' +
  '<path d="m22 22-5-10-5 10"></path><path d="M14 18h6"></path></svg>';

// Minimal authenticated Table API GET (same-origin, cookie auth).
async function snGet(table, query, fields) {
  const url =
    location.origin +
    "/api/now/table/" +
    encodeURIComponent(table) +
    "?sysparm_query=" + encodeURIComponent(query) +
    "&sysparm_fields=" + encodeURIComponent(fields) +
    "&sysparm_limit=1";
  const res = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  return (data && data.result) || [];
}

async function snGetMany(table, query, fields, limit, options) {
  const resp = await chrome.runtime.sendMessage({
    type: "SN_TABLE_GET",
    table,
    query,
    fields,
    limit: limit || 200,
    options: options || {},
  });
  if (!resp || !resp.ok) {
    throw new Error((resp && resp.error) || "Couldn't read " + table);
  }
  return resp.result || [];
}

function snFieldValue(row, field) {
  const raw = row && row[field];
  if (raw == null) return "";
  if (typeof raw === "object" && !Array.isArray(raw)) {
    if (raw.value != null) return String(raw.value);
    if (raw.display_value != null) return String(raw.display_value);
    return "";
  }
  return String(raw);
}

function snFieldDisplay(row, field) {
  const raw = row && row[field];
  if (raw == null) return "";
  if (typeof raw === "object" && !Array.isArray(raw)) {
    if (raw.display_value != null) return String(raw.display_value);
    if (raw.value != null) return String(raw.value);
    return "";
  }
  return String(raw);
}

function isEmptyPrefillValue(value) {
  return value == null || String(value).trim() === "";
}

function isSysId(value) {
  return /^[0-9a-f]{32}$/i.test(String(value || ""));
}

function normalizeSourceInput(input) {
  const text = String(input || "").trim();
  const sysId = sysIdFromText(text) || (/^[0-9a-f]{32}$/i.test(text) ? text : null);
  if (sysId) return { kind: "sys_id", value: sysId.toLowerCase() };

  const ticketMatch = text.match(/[A-Za-z][A-Za-z0-9_-]*\d[A-Za-z0-9_-]*/);
  const value = (ticketMatch ? ticketMatch[0] : text).replace(/\^/g, "").trim();
  return { kind: "number", value };
}

async function resolveVariableSource(input) {
  const parsed = normalizeSourceInput(input);
  if (!parsed.value) throw new Error("Enter a ticket number or sys_id.");

  const taskQuery =
    parsed.kind === "sys_id"
      ? "sys_id=" + parsed.value
      : "number=" + parsed.value;
  const taskRows = await snGetMany(
    "task",
    taskQuery,
    "sys_id,number,sys_class_name",
    2
  );
  const task = taskRows[0];

  if (!task) {
    if (parsed.kind === "sys_id") {
      return {
        mode: "producer",
        sysId: parsed.value,
        table: null,
        number: null,
        requestItemId: null,
      };
    }
    throw new Error("No task found for " + parsed.value + ".");
  }

  const sysId = snFieldValue(task, "sys_id");
  const table = snFieldValue(task, "sys_class_name");
  const number = snFieldValue(task, "number");

  if (table === "sc_req_item") {
    return { mode: "catalog", sysId, table, number, requestItemId: sysId };
  }

  if (table === "sc_task") {
    const taskDetails = await snGetMany("sc_task", "sys_id=" + sysId, "request_item", 1);
    const requestItemId = snFieldValue(taskDetails[0], "request_item");
    if (!requestItemId) throw new Error("Catalog task has no request item.");
    return { mode: "catalog", sysId, table, number, requestItemId };
  }

  if (table === "sc_request") {
    const ritms = await snGetMany(
      "sc_req_item",
      "request=" + sysId,
      "sys_id,number",
      10
    );
    if (ritms.length === 1) {
      return {
        mode: "catalog",
        sysId,
        table,
        number,
        requestItemId: snFieldValue(ritms[0], "sys_id"),
      };
    }
    if (ritms.length > 1) {
      throw new Error("REQ has " + ritms.length + " items. Paste a specific RITM.");
    }
    throw new Error("REQ has no requested items.");
  }

  return { mode: "producer", sysId, table, number, requestItemId: null };
}

const UNSUPPORTED_VARIABLE_TYPES = new Set([
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

function isUnsupportedVariableType(type) {
  const normalized = String(type || "").trim().toLowerCase().replace(/\s+/g, "_");
  return normalized && UNSUPPORTED_VARIABLE_TYPES.has(normalized);
}

function parseVariableOrder(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return { known: false, value: 0 };
  const order = Number(text);
  return Number.isFinite(order)
    ? { known: true, value: order }
    : { known: false, value: 0 };
}

function normalizeSourceVariable(row, mapping) {
  const name = snFieldValue(row, mapping.name).trim();
  const value = snFieldValue(row, mapping.value);
  if (!name || isEmptyPrefillValue(value)) return { variable: null, skipped: 0 };

  const type = snFieldValue(row, mapping.type);
  if (isUnsupportedVariableType(type)) return { variable: null, skipped: 1 };
  const order = parseVariableOrder(mapping.order ? snFieldValue(row, mapping.order) : "");

  return {
    variable: {
      name,
      label: snFieldDisplay(row, mapping.label),
      type,
      value,
      displayValue: snFieldDisplay(row, mapping.value),
      order: order.value,
      orderKnown: order.known,
      questionId: mapping.questionId ? snFieldValue(row, mapping.questionId) : "",
      referenceTable:
        (mapping.referenceTable ? snFieldValue(row, mapping.referenceTable) : "") ||
        (mapping.lookupTable ? snFieldValue(row, mapping.lookupTable) : ""),
    },
    skipped: 0,
  };
}

function addVariablesFromRows(target, rows, mapping) {
  let skipped = 0;
  rows.forEach((row, index) => {
    const normalized = normalizeSourceVariable(row, mapping);
    skipped += normalized.skipped;
    if (!normalized.variable) return;
    if (!target.has(normalized.variable.name)) {
      normalized.variable.sourceIndex = target.size + index / 100000;
      target.set(normalized.variable.name, normalized.variable);
    }
  });
  return skipped;
}

async function fetchCatalogVariables(requestItemId) {
  const rows = await snGetMany(
    "sc_item_option_mtom",
    "request_item=" + requestItemId,
    [
      "sc_item_option.value",
      "sc_item_option.item_option_new",
      "sc_item_option.item_option_new.name",
      "sc_item_option.item_option_new.question_text",
      "sc_item_option.item_option_new.type",
      "sc_item_option.item_option_new.order",
      "sc_item_option.item_option_new.reference",
      "sc_item_option.item_option_new.lookup_table",
    ].join(","),
    300,
    { displayAll: true, excludeRefLinks: true }
  );
  const variables = new Map();
  const skipped = addVariablesFromRows(variables, rows, {
    name: "sc_item_option.item_option_new.name",
    label: "sc_item_option.item_option_new.question_text",
    type: "sc_item_option.item_option_new.type",
    order: "sc_item_option.item_option_new.order",
    value: "sc_item_option.value",
    questionId: "sc_item_option.item_option_new",
    referenceTable: "sc_item_option.item_option_new.reference",
    lookupTable: "sc_item_option.item_option_new.lookup_table",
  });
  return { variables, skipped };
}

async function fetchProducerVariables(sysId) {
  const fields = [
    "value",
    "question",
    "question.name",
    "question.question_text",
    "question.type",
    "question.order",
    "question.reference",
    "question.lookup_table",
  ].join(",");
  const queries = ["document=" + sysId, "table_sys_id=" + sysId];
  const variables = new Map();
  let skipped = 0;
  let readAny = false;

  for (const query of queries) {
    try {
      const rows = await snGetMany("question_answer", query, fields, 300, {
        displayAll: true,
        excludeRefLinks: true,
      });
      if (!rows.length) continue;
      readAny = true;
      skipped += addVariablesFromRows(variables, rows, {
        name: "question.name",
        label: "question.question_text",
        type: "question.type",
        order: "question.order",
        value: "value",
        questionId: "question",
        referenceTable: "question.reference",
        lookupTable: "question.lookup_table",
      });
      break;
    } catch (e) {
      /* Some instances use only one of these key fields. Try the next shape. */
    }
  }

  return { variables, skipped, readAny };
}

function isReferenceVariable(variable) {
  const type = String((variable && variable.type) || "").trim().toLowerCase();
  return type === "8" || type === "reference";
}

function bestDisplayValue(row) {
  const displayFields = [
    "name",
    "number",
    "display_name",
    "title",
    "short_description",
    "u_name",
    "u_display_name",
    "u_site_name",
    "u_location_name",
    "u_label",
    "street",
  ];
  for (const field of displayFields) {
    const value = snFieldDisplay(row, field);
    if (value && !isSysId(value)) return value;
  }

  const locationParts = ["street", "city", "state"].map((field) => snFieldDisplay(row, field)).filter(Boolean);
  if (locationParts.length) return locationParts.join(", ");

  const preferredKeyPattern = /(^|_)(display|name|title|label|description|site|location)(_|$)/i;
  const ignoredKeyPattern = /sys_|^u?active$|^id$|^value$|^link$|^order$/i;
  const keys = Object.keys(row || {}).filter((key) => preferredKeyPattern.test(key) && !ignoredKeyPattern.test(key));
  for (const key of keys) {
    const value = snFieldDisplay(row, key);
    if (value && !isSysId(value)) return value;
  }

  return "";
}

async function resolveReferenceDisplayValues(variables, onProgress) {
  const referenceVariables = Array.from(variables.values()).filter(
    (variable) =>
      isReferenceVariable(variable) &&
      isSysId(variable.value) &&
      (!variable.displayValue || variable.displayValue === variable.value || isSysId(variable.displayValue)) &&
      variable.referenceTable
  );
  let index = 0;

  for (const variable of variables.values()) {
    if (!isReferenceVariable(variable) || !isSysId(variable.value)) continue;
    if (variable.displayValue && variable.displayValue !== variable.value && !isSysId(variable.displayValue)) {
      continue;
    }

    const table = variable.referenceTable || "";
    if (!table) continue;
    index++;
    if (onProgress) {
      onProgress(
        "Resolving reference values " +
          index +
          " of " +
          referenceVariables.length +
          ": " +
          (variable.label || variable.name)
      );
    }

    try {
      const rows = await snGetMany(
        table,
        "sys_id=" + variable.value,
        "sys_id,name,number,display_name,title,short_description,u_name,u_display_name,u_site_name,u_location_name,u_label,street,city,state",
        1,
        { displayAll: true, excludeRefLinks: true }
      );
      let display = rows.length ? bestDisplayValue(rows[0]) : "";
      if (!display) {
        const broadRows = await snGetMany(table, "sys_id=" + variable.value, "", 1, {
          displayAll: true,
          excludeRefLinks: true,
        });
        display = broadRows.length ? bestDisplayValue(broadRows[0]) : "";
      }
      if (display) variable.displayValue = display;
    } catch (e) {
      /* Keep the sys_id fallback if reference display lookup is blocked. */
    }
  }
}

function sortVariablesForFill(variables) {
  return Array.from(variables.values()).sort((a, b) => {
    if (a.orderKnown !== b.orderKnown) return a.orderKnown ? 1 : -1;
    const orderA = Number.isFinite(a.order) ? a.order : 0;
    const orderB = Number.isFinite(b.order) ? b.order : 0;
    if (orderA !== orderB) return orderA - orderB;
    const indexA = Number.isFinite(a.sourceIndex) ? a.sourceIndex : 999999;
    const indexB = Number.isFinite(b.sourceIndex) ? b.sourceIndex : 999999;
    if (indexA !== indexB) return indexA - indexB;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

async function fetchSourceVariables(source, onProgress) {
  const variables = new Map();
  let skipped = 0;
  let hadReadError = false;

  if (source.mode === "catalog" && source.requestItemId) {
    try {
      if (onProgress) onProgress("Reading catalog variables...");
      const catalog = await fetchCatalogVariables(source.requestItemId);
      skipped += catalog.skipped;
      catalog.variables.forEach((variable, name) => variables.set(name, variable));
    } catch (e) {
      hadReadError = true;
    }
  }

  try {
    if (onProgress) onProgress("Reading producer variables...");
    const producer = await fetchProducerVariables(source.sysId);
    skipped += producer.skipped;
    producer.variables.forEach((variable, name) => {
      if (!variables.has(name)) variables.set(name, variable);
    });
  } catch (e) {
    if (source.mode === "producer") hadReadError = true;
  }

  if (!variables.size && hadReadError) {
    throw new Error("Couldn't read variables. Check access to catalog variable tables.");
  }

  await resolveReferenceDisplayValues(variables, onProgress);

  return { variables: sortVariablesForFill(variables), skipped };
}

async function prefillPortalVariablesFromTicket(input) {
  const value = String(input || "").trim();
  if (!value) {
    showToast("Enter a ticket number or sys_id", true);
    return;
  }

  showToast("Reading variables...", false, 6000);
  try {
    const source = await resolveVariableSource(value);
    const sourceResult = await fetchSourceVariables(source, (message) => showToast(message, false, 6000));
    const variables = sourceResult.variables;
    SNH.lastPrefillVariables = variables;
    if (!variables.length) {
      const suffix = sourceResult.skipped ? " (" + sourceResult.skipped + " unsupported)" : "";
      showToast("No copyable variables found" + suffix, true);
      return;
    }

    showToast("Found " + variables.length + " variables. Filling portal form...", false, 6000);
    await new Promise((resolve) => setTimeout(resolve, 75));
    const resp = await chrome.runtime.sendMessage({
      type: "FILL_PORTAL_VARIABLES",
      variables,
    });

    if (!resp || !resp.ok) {
      throw new Error((resp && resp.error) || "Couldn't fill portal variables.");
    }
    if (!resp.foundForm) {
      showToast("Open a catalog order form first", true);
      return;
    }

    const skipped = (resp.skipped || 0) + (sourceResult.skipped || 0);
    const already = resp.alreadySet || 0;
    const unmatched = resp.unmatched || 0;
    let message = "Filled " + (resp.filled || 0) + " of " + variables.length + " variables";
    const details = [];
    if (already) details.push(already + " already set");
    if (unmatched) details.push(unmatched + " not on this form");
    if (skipped) details.push(skipped + " skipped");
    if (details.length) message += " (" + details.join(", ") + ")";
    if (!resp.filled && unmatched === variables.length) {
      message = "No matching variables on this form (" + unmatched + " not found)";
    }
    showToast(message);
  } catch (error) {
    showToast(String(error && error.message ? error.message : error), true);
  }
}

async function copyPortalVariableDebugInfo() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_PORTAL_VARIABLE_DEBUG" });
    if (!resp || !resp.ok) {
      throw new Error((resp && resp.error) || "Couldn't inspect portal form.");
    }
    const report = {
      url: location.href,
      sourceVariables: SNH.lastPrefillVariables.map((variable) => ({
        name: variable.name,
        label: variable.label,
        type: variable.type,
        questionId: variable.questionId,
        referenceTable: variable.referenceTable,
        valueLength: variable.value ? String(variable.value).length : 0,
        displayValue: variable.displayValue,
      })),
      frames: resp.frames || [],
    };
    await copyText(JSON.stringify(report, null, 2));
    showToast("Copied portal variable debug info");
  } catch (error) {
    showToast(String(error && error.message ? error.message : error), true);
  }
}

// Walk up the table hierarchy to find where the field's dictionary entry lives.
async function resolveDefiningTable(startTable, field) {
  let table = startTable;
  for (let hop = 0; hop < 8 && table; hop++) {
    const dict = await snGet("sys_dictionary", `name=${table}^element=${field}`, "sys_id");
    if (dict.length) return table; // defined directly on this table
    const obj = await snGet("sys_db_object", `name=${table}`, "super_class.name");
    const parent = obj.length && obj[0]["super_class.name"];
    if (!parent) break;
    table = parent;
  }
  return null;
}

function openList(table, query) {
  const url =
    location.origin + "/" + table + "_list.do?sysparm_query=" +
    encodeURIComponent(query);
  chrome.runtime.sendMessage({ type: "OPEN_URL", url });
}

function sysIdFromText(text) {
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
}

async function openLabelTranslations(formTable, field) {
  let table = formTable;
  try {
    const resolved = await resolveDefiningTable(formTable, field);
    if (resolved) table = resolved;
  } catch (e) {
    /* token-enforced GET or network error: fall back to form table */
  }
  openList("sys_documentation", `name=${table}^element=${field}`);
}

function openValueTranslations(formTable, field) {
  // Prefer the current record's sys_id (from the form URL) so we land on the
  // values for THIS record; documentkey + fieldname is table-agnostic.
  const sysId = sysIdFromText(location.href);
  const query =
    sysId && /^[0-9a-f]{32}$/i.test(sysId)
      ? `documentkey=${sysId}^fieldname=${field}`
      : `tablename=${formTable}^fieldname=${field}`;
  openList("sys_translated_text", query);
}

function makeIcon(svg, title, color, onClick) {
  const btn = document.createElement("span");
  btn.className = "snh-trans-icon";
  btn.setAttribute("role", "button");
  btn.tabIndex = 0;
  btn.title = title;
  btn.innerHTML = svg;
  btn.style.cssText =
    "display:inline-flex;align-items:center;vertical-align:middle;" +
    "margin-left:5px;color:" + color + ";cursor:pointer;line-height:0;";
  const handler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  };
  btn.addEventListener("click", handler);
  btn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") handler(e);
  });
  btn.addEventListener("mouseenter", () => (btn.style.opacity = "0.65"));
  btn.addEventListener("mouseleave", () => (btn.style.opacity = "1"));
  return btn;
}

function toggleTranslationIcons(force) {
  const turnOn = typeof force === "boolean" ? force : !SNH.transIconsOn;
  SNH.transIconsOn = turnOn;

  removeSnhElements(".snh-trans-icon");
  if (!turnOn) return 0;

  let count = 0;
  const appendIcons = ({ table, field, target }) => {
    if (!table || !field || !target) return;
    target.appendChild(
      makeIcon(
        ICON_DOC,
        `Label translations for ${table}.${field} (sys_documentation)`,
        "#3b7ddd",
        () => openLabelTranslations(table, field)
      )
    );
    target.appendChild(
      makeIcon(
        ICON_VALUE,
        `Value translations for ${table}.${field} (sys_translated_text)`,
        "#8a5cd6",
        () => openValueTranslations(table, field)
      )
    );
    count++;
  };

  getClassicFields().forEach(appendIcons);
  getWorkspaceFields().forEach(appendIcons);
  return count;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "TOGGLE_FIELD_NAMES") {
    const count = toggleFieldNames(msg.force);
    sendResponse({ ok: true, count, on: SNH.fieldNamesOn });
  }
  if (msg && msg.type === "TOGGLE_TRANSLATIONS") {
    const count = toggleTranslationIcons(msg.force);
    sendResponse({ ok: true, count, on: SNH.transIconsOn });
  }
  if (msg && msg.type === "TOGGLE_PALETTE") {
    // Only the top frame owns the palette to avoid duplicate overlays.
    if (window === window.top) togglePalette();
  }
  if (msg && msg.type === "PREFILL_PROGRESS") {
    if (window === window.top) showToast(msg.message || "Filling portal form...", false, 6000);
  }
  return true;
});

function togglePalette() {
  paletteHost ? closePalette() : openPalette();
}

/* =====================================================================
 * COMMAND PALETTE
 * Rendered into a shadow root so SN styles can't bleed in.
 * Only mounted in the top frame (shell); messages dispatched down to
 * gsft_main frames for DOM-touching commands via chrome.runtime.sendMessage.
 * ===================================================================== */

const DEV_LINKS = [
  ["Background Scripts",  "/sys.scripts.modern.do"],
  ["Script Includes",     "/sys_script_include_list.do"],
  ["Business Rules",      "/sys_script_list.do"],
  ["Client Scripts",      "/sys_script_client_list.do"],
  ["UI Actions",          "/sys_ui_action_list.do"],
  ["System Logs",         "/syslog_list.do?sysparm_query=ORDERBYDESCsys_created_on"],
  ["Update Sets",         "/sys_update_set_list.do"],
  ["Scheduled Jobs",      "/sysauto_script_list.do"],
  ["Fix Scripts",         "/sys_script_fix_list.do"],
  ["Sys Properties",      "/sys_properties_list.do"],
  ["REST Explorer",       "/$restapi.do"],
  ["Flow Designer",       "/$flow-designer.do"],
];

function buildCommands() {
  const navTo = (path) =>
    chrome.runtime.sendMessage({ type: "OPEN_URL", url: location.origin + path });

  const cmds = [
    {
      id: "toggle-fields",
      name: "Toggle field names",
      keywords: ["technical", "label", "badge", "field name", "alt shift f"],
      group: "Tools",
      hint: "Alt+Shift+F",
      run: () => broadcastFrameCommand("TOGGLE_FIELD_NAMES"),
    },
    {
      id: "toggle-translations",
      name: "Toggle translation icons",
      keywords: ["globe", "i18n", "l10n", "translate", "sys_documentation", "sys_translated_text"],
      group: "Tools",
      run: () => broadcastFrameCommand("TOGGLE_TRANSLATIONS"),
    },
    {
      id: "copy-sysid",
      name: "Copy sys_id",
      keywords: ["copy", "sys_id", "record", "id", "guid"],
      group: "Record",
      keepOpen: true,
      run: async () => {
        const localId = sysIdFromText(location.href);
        const resp = localId ? null : await chrome.runtime.sendMessage({ type: "GET_SYS_ID" });
        const id = localId || (resp && resp.sysId);
        if (id) {
          try {
            await copyText(id);
            showToast("Copied " + id);
          } catch (e) {
            showCopyFallback(id);
          }
        } else {
          showToast("No record sys_id found", true);
        }
      },
    },
    {
      id: "prefill-variables",
      name: "Prefill variables from ticket...",
      keywords: ["variable", "prefill", "copy", "ritm", "sctask", "req", "catalog", "portal", "clone"],
      group: "Catalog",
      input: true,
      placeholder: "RITM/SCTASK/REQ/task number or sys_id",
      keepOpen: true,
      run: prefillPortalVariablesFromTicket,
    },
    {
      id: "copy-portal-variable-debug",
      name: "Copy portal variable debug info",
      keywords: ["debug", "portal", "variable", "field", "dom", "g_form"],
      group: "Catalog",
      keepOpen: true,
      run: copyPortalVariableDebugInfo,
    },
    {
      id: "open-table-list",
      name: "Open table list…",
      keywords: ["navigate", "jump", "list", "table", "open"],
      group: "Navigate",
      input: true,
      placeholder: "table name (e.g. incident)",
      run: (arg) => {
        if (!arg) return;
        navTo("/" + arg.trim() + "_list.do");
      },
    },
    {
      id: "open-table-new",
      name: "Open new record…",
      keywords: ["new", "create", "insert", "table"],
      group: "Navigate",
      input: true,
      placeholder: "table name (e.g. incident)",
      run: (arg) => {
        if (!arg) return;
        navTo("/" + arg.trim() + ".do?sys_id=-1");
      },
    },
    ...DEV_LINKS.map(([label, path]) => ({
      id: "devlink-" + path,
      name: label,
      keywords: [label.toLowerCase(), "dev", "link"],
      group: "Dev Links",
      run: () => navTo(path),
    })),
  ];
  return cmds;
}

/* ---- Palette state ---- */
let paletteHost = null;
let paletteShadow = null;
let paletteInput = null;
let paletteList = null;
let paletteToast = null;
let activeIndex = 0;
let filteredCmds = [];
let activeInputCmd = null; // command waiting for a text argument

const PALETTE_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  :host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  #overlay{
    position:fixed;inset:0;z-index:2147483647;
    background:rgba(0,0,0,.45);display:flex;
    align-items:flex-start;justify-content:center;padding-top:12vh;
  }
  #box{
    background:#1e1e2e;border:1px solid #3a3a5c;border-radius:10px;
    width:520px;max-width:calc(100vw - 32px);
    box-shadow:0 24px 64px rgba(0,0,0,.6);overflow:hidden;
  }
  #search-wrap{
    display:flex;align-items:center;padding:12px 14px;
    border-bottom:1px solid #2e2e4e;gap:8px;
  }
  #search-icon{color:#666;flex-shrink:0;font-size:15px}
  #search{
    flex:1;background:transparent;border:none;outline:none;
    color:#e0e0f0;font-size:14px;caret-color:#7c7cf8;
  }
  #search::placeholder{color:#555}
  #kbd-hint{color:#555;font-size:11px;white-space:nowrap}
  #results{max-height:360px;overflow-y:auto;padding:6px 0}
  .group-label{
    color:#555;font-size:10px;font-weight:700;letter-spacing:.08em;
    text-transform:uppercase;padding:10px 16px 4px;
  }
  .cmd{
    display:flex;align-items:center;padding:9px 16px;cursor:pointer;
    gap:10px;color:#c0c0d8;font-size:13px;border-radius:0;
    transition:background .08s;
  }
  .cmd.active{background:#2d2d50;color:#fff}
  .cmd:hover{background:#272740}
  .cmd-name{flex:1}
  .cmd-hint{color:#555;font-size:11px;font-family:monospace}
  .cmd-input-row{
    display:flex;align-items:center;padding:10px 16px;
    border-top:1px solid #2e2e4e;gap:8px;
  }
  .cmd-input-label{color:#7c7cf8;font-size:12px;white-space:nowrap}
  #arg-input{
    flex:1;background:transparent;border:none;outline:none;
    color:#e0e0f0;font-size:13px;
  }
  #arg-input::placeholder{color:#555}
  #toast{
    display:none;padding:8px 16px;font-size:12px;
    border-top:1px solid #2e2e4e;color:#a0e0b0;
  }
  #toast.err{color:#ff8b8b}
  #empty{padding:20px 16px;color:#555;font-size:13px;text-align:center}
`;

function showToast(msg, isErr, durationMs) {
  if (!paletteToast) return;
  paletteToast.textContent = msg;
  paletteToast.className = isErr ? "err" : "";
  paletteToast.style.display = "block";
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    if (paletteToast) paletteToast.style.display = "none";
  }, durationMs || 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) throw e;
    return true;
  }
}

function showCopyFallback(text) {
  if (!paletteToast) return;
  paletteToast.innerHTML = "";
  const label = document.createElement("span");
  label.textContent = "Copy blocked. sys_id: ";
  const code = document.createElement("input");
  code.value = text;
  code.readOnly = true;
  code.style.cssText =
    "width:100%;margin-top:6px;background:#151522;border:1px solid #3a3a5c;" +
    "color:#e0e0f0;border-radius:4px;padding:5px;font:12px monospace;";
  paletteToast.appendChild(label);
  paletteToast.appendChild(code);
  paletteToast.className = "err";
  paletteToast.style.display = "block";
  code.focus();
  code.select();
}

function renderResults(query) {
  if (!paletteList) return;
  const cmds = buildCommands();
  const q = query.trim().toLowerCase();
  filteredCmds = q
    ? cmds.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.keywords || []).some((k) => k.includes(q))
      )
    : cmds;

  paletteList.innerHTML = "";

  if (!filteredCmds.length) {
    paletteList.innerHTML = '<div id="empty">No commands match</div>';
    activeIndex = 0;
    return;
  }

  let lastGroup = null;
  filteredCmds.forEach((cmd, i) => {
    if (cmd.group && cmd.group !== lastGroup) {
      const gl = document.createElement("div");
      gl.className = "group-label";
      gl.textContent = cmd.group;
      paletteList.appendChild(gl);
      lastGroup = cmd.group;
    }
    const el = document.createElement("div");
    el.className = "cmd" + (i === activeIndex ? " active" : "");
    el.dataset.idx = i;
    el.innerHTML =
      `<span class="cmd-name">${cmd.name}</span>` +
      (cmd.hint ? `<span class="cmd-hint">${cmd.hint}</span>` : "");
    el.addEventListener("mouseenter", () => {
      activeIndex = i;
      highlightActive();
    });
    el.addEventListener("click", () => selectCommand(filteredCmds[i]));
    paletteList.appendChild(el);
  });

  activeIndex = Math.min(activeIndex, filteredCmds.length - 1);
  highlightActive();
}

function highlightActive() {
  if (!paletteList) return;
  paletteList.querySelectorAll(".cmd").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.idx) === activeIndex);
  });
  const active = paletteList.querySelector(".cmd.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function selectCommand(cmd) {
  if (!cmd) return;
  if (cmd.input) {
    showArgInput(cmd);
    return;
  }
  Promise.resolve(cmd.run()).catch((error) => {
    showToast(String(error && error.message ? error.message : error), true);
  });
  if (!cmd.keepOpen) closePalette();
}

function showArgInput(cmd) {
  if (!paletteShadow || !paletteList || !paletteInput) return;

  activeInputCmd = cmd;
  const shadow = paletteShadow;
  // Hide results, show arg input row
  paletteList.style.display = "none";
  let row = shadow.getElementById("arg-row");
  const box = shadow.getElementById("box");
  const toast = shadow.getElementById("toast");
  if (!box || !toast) return;

  if (!row) {
    row = document.createElement("div");
    row.id = "arg-row";
    row.className = "cmd-input-row";
    row.innerHTML =
      `<span class="cmd-input-label">${cmd.name.replace("…", "")}:</span>` +
      `<input id="arg-input" placeholder="${cmd.placeholder || ""}" autocomplete="off" spellcheck="false" />`;
    box.insertBefore(row, toast);
  }
  const argInput = shadow.getElementById("arg-input");
  if (!argInput) return;

  argInput.value = "";
  argInput.focus();
  argInput.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = activeInputCmd;
      const value = argInput.value.trim();
      if (!cmd) return;
      Promise.resolve(cmd.run(value)).catch((error) => {
        showToast(String(error && error.message ? error.message : error), true);
      });
      if (!cmd.keepOpen) closePalette();
    }
    if (e.key === "Escape") {
      activeInputCmd = null;
      if (row.isConnected) row.remove();
      if (paletteList) paletteList.style.display = "";
      if (paletteInput) paletteInput.focus();
    }
    e.stopPropagation();
  };
}

function openPalette() {
  if (paletteHost) {
    paletteInput && paletteInput.focus();
    return;
  }

  paletteHost = document.createElement("div");
  paletteHost.id = "snh-palette-host";
  document.body.appendChild(paletteHost);
  paletteShadow = paletteHost.attachShadow({ mode: "closed" });

  paletteShadow.innerHTML = `
    <style>${PALETTE_CSS}</style>
    <div id="overlay">
      <div id="box">
        <div id="search-wrap">
          <span id="search-icon">⌘</span>
          <input id="search" placeholder="Search commands…" autocomplete="off" spellcheck="false" />
          <span id="kbd-hint">ESC to close</span>
        </div>
        <div id="results"></div>
        <div id="toast"></div>
      </div>
    </div>
  `;

  paletteInput = paletteShadow.getElementById("search");
  paletteList  = paletteShadow.getElementById("results");
  paletteToast = paletteShadow.getElementById("toast");

  activeIndex = 0;
  activeInputCmd = null;
  renderResults("");
  paletteInput.focus();

  paletteInput.addEventListener("input", () => {
    activeIndex = 0;
    renderResults(paletteInput.value);
  });

  paletteInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, filteredCmds.length - 1);
      highlightActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      highlightActive();
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectCommand(filteredCmds[activeIndex]);
    } else if (e.key === "Escape") {
      closePalette();
    }
  });

  const overlay = paletteShadow.getElementById("overlay");
  if (overlay) overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePalette();
  });
}

function closePalette() {
  if (paletteHost) {
    paletteHost.remove();
    paletteHost = null;
    paletteShadow = null;
    paletteInput = null;
    paletteList = null;
    paletteToast = null;
    activeInputCmd = null;
  }
}

// Ctrl+\ listener — attached in EVERY frame, because in the classic UI the
// keypress usually lands inside the gsft_main iframe, not the top frame.
// The top frame owns the single palette; sub-frames route the trigger up
// through the background worker. (Ctrl+/ collides with snUtils; Alt+Space
// with the ChatGPT desktop app.)
const handledPaletteKeyEvents = new WeakSet();

function handlePaletteShortcut(e) {
  if (handledPaletteKeyEvents.has(e)) return;
  const isBackslash =
    e.key === "\\" || e.code === "Backslash" || e.code === "IntlBackslash";
  if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && isBackslash) {
    handledPaletteKeyEvents.add(e);
    e.preventDefault();
    e.stopPropagation();
    if (window === window.top) {
      togglePalette();
    } else {
      chrome.runtime.sendMessage({ type: "TOGGLE_PALETTE" });
    }
  }
}

window.addEventListener("keydown", handlePaletteShortcut, true);
document.addEventListener("keydown", handlePaletteShortcut, true);
