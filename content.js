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

const SNH = { fieldNamesOn: false, transIconsOn: false };

function toggleFieldNames(force) {
  const turnOn = typeof force === "boolean" ? force : !SNH.fieldNamesOn;
  SNH.fieldNamesOn = turnOn;

  // Clear any existing badges first (idempotent).
  document.querySelectorAll(".snh-fieldname").forEach((n) => n.remove());
  if (!turnOn) return 0;

  let count = 0;
  // Classic form labels carry an id of the form: label.<table>.<field>
  document.querySelectorAll('[id^="label."]').forEach((labelEl) => {
    const parts = labelEl.id.split(".");
    if (parts.length < 3) return;
    const field = parts.slice(2).join("."); // dotted (dot-walked) fields too
    const badge = document.createElement("span");
    badge.className = "snh-fieldname";
    badge.textContent = " [" + field + "]";
    badge.style.cssText =
      "color:#0a7d4f;font-size:11px;font-weight:700;margin-left:5px;" +
      "font-family:monospace;letter-spacing:.2px;";
    labelEl.appendChild(badge);
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
  const sysId = new URLSearchParams(location.search).get("sys_id");
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

  document.querySelectorAll(".snh-trans-icon").forEach((n) => n.remove());
  if (!turnOn) return 0;

  let count = 0;
  document.querySelectorAll('[id^="label."]').forEach((labelEl) => {
    const parts = labelEl.id.split(".");
    if (parts.length < 3) return;
    const table = parts[1];
    const field = parts.slice(2).join(".");

    labelEl.appendChild(
      makeIcon(
        ICON_DOC,
        `Label translations for ${table}.${field} (sys_documentation)`,
        "#3b7ddd",
        () => openLabelTranslations(table, field)
      )
    );
    labelEl.appendChild(
      makeIcon(
        ICON_VALUE,
        `Value translations for ${table}.${field} (sys_translated_text)`,
        "#8a5cd6",
        () => openValueTranslations(table, field)
      )
    );
    count++;
  });
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
  // return true keeps the message channel open for the async sendResponse
  return true;
});
