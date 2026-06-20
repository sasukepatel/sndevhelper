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
  if (msg && msg.type === "OPEN_PALETTE") {
    // Only the top frame owns the palette to avoid duplicate overlays.
    if (window === window.top) openPalette();
  }
  return true;
});

/* =====================================================================
 * COMMAND PALETTE
 * Rendered into a shadow root so SN styles can't bleed in.
 * Only mounted in the top frame (shell); messages dispatched down to
 * gsft_main frames for DOM-touching commands via chrome.runtime.sendMessage.
 * ===================================================================== */

const DEV_LINKS = [
  ["Background Scripts",  "/sys.scripts.do"],
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
  const sysIdFromUrl = () => {
    const p = new URLSearchParams(location.search).get("sys_id");
    return p && /^[0-9a-f]{32}$/i.test(p) ? p : null;
  };

  const navTo = (path) =>
    chrome.runtime.sendMessage({ type: "OPEN_URL", url: location.origin + path });

  const cmds = [
    {
      id: "toggle-fields",
      name: "Toggle field names",
      keywords: ["technical", "label", "badge", "field name", "alt shift f"],
      group: "Tools",
      hint: "Alt+Shift+F",
      run: () => chrome.runtime.sendMessage({ type: "TOGGLE_FIELD_NAMES" }),
    },
    {
      id: "toggle-translations",
      name: "Toggle translation icons",
      keywords: ["globe", "i18n", "l10n", "translate", "sys_documentation", "sys_translated_text"],
      group: "Tools",
      run: () => chrome.runtime.sendMessage({ type: "TOGGLE_TRANSLATIONS" }),
    },
    {
      id: "copy-sysid",
      name: "Copy sys_id",
      keywords: ["copy", "sys_id", "record", "id", "guid"],
      group: "Record",
      run: () => {
        const id = sysIdFromUrl();
        if (id) {
          navigator.clipboard.writeText(id).then(() => showToast("Copied " + id));
        } else {
          showToast("No sys_id in URL", true);
        }
      },
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

function showToast(msg, isErr) {
  if (!paletteToast) return;
  paletteToast.textContent = msg;
  paletteToast.className = isErr ? "err" : "";
  paletteToast.style.display = "block";
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    if (paletteToast) paletteToast.style.display = "none";
  }, 2200);
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
  cmd.run();
  closePalette();
}

function showArgInput(cmd) {
  activeInputCmd = cmd;
  const shadow = paletteShadow;
  // Hide results, show arg input row
  paletteList.style.display = "none";
  let row = shadow.getElementById("arg-row");
  if (!row) {
    row = document.createElement("div");
    row.id = "arg-row";
    row.className = "cmd-input-row";
    row.innerHTML =
      `<span class="cmd-input-label">${cmd.name.replace("…", "")}:</span>` +
      `<input id="arg-input" placeholder="${cmd.placeholder || ""}" autocomplete="off" spellcheck="false" />`;
    shadow.getElementById("box").insertBefore(row, shadow.getElementById("toast"));
  }
  const argInput = shadow.getElementById("arg-input");
  argInput.value = "";
  argInput.focus();
  argInput.onkeydown = (e) => {
    if (e.key === "Enter") {
      activeInputCmd.run(argInput.value.trim());
      closePalette();
    }
    if (e.key === "Escape") {
      activeInputCmd = null;
      row.remove();
      paletteList.style.display = "";
      paletteInput.focus();
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

  paletteShadow.getElementById("overlay").addEventListener("click", (e) => {
    if (e.target === paletteShadow.getElementById("overlay")) closePalette();
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
