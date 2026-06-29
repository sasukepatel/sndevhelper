/*
 * Isolated-world UI for Debug Timeline.
 * Loaded before content.js so command-palette actions can call the public API.
 */

(() => {
  if (globalThis.SNDebugTimelineUI) return;

  let recording = false;
  let indicatorHost = null;
  let resultsHost = null;
  let resultsShadow = null;
  let resultsKeydownHandler = null;
  let lastResult = null;
  let activeFilter = "all";
  let searchQuery = "";

  const CATEGORY_LABELS = {
    system: "System",
    g_form: "g_form",
    field: "Field",
    glideajax: "GlideAjax",
    error: "Error",
  };

  const UI_CSS = `
    *{box-sizing:border-box}
    :host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    button,input{font:inherit}
    .recording{
      position:fixed;top:18px;right:18px;z-index:2147483646;
      display:flex;align-items:center;gap:9px;padding:8px 9px 8px 12px;
      color:#f3f3ff;background:#1e1e2e;border:1px solid #4a3a54;
      border-radius:999px;box-shadow:0 12px 34px rgba(0,0,0,.38);
      font-size:12px;
    }
    .recording-dot{
      width:8px;height:8px;border-radius:50%;background:#ff5f6d;
      box-shadow:0 0 0 4px rgba(255,95,109,.13);
      animation:snh-pulse 1.7s ease-in-out infinite;
    }
    @keyframes snh-pulse{50%{opacity:.5;transform:scale(.82)}}
    .recording button,.toolbar button,.filter{
      border:1px solid #3a3a5c;background:#292941;color:#d8d8ea;
      border-radius:6px;padding:6px 9px;cursor:pointer;
    }
    .recording button:hover,.toolbar button:hover,.filter:hover{background:#343453;color:#fff}
    .overlay{
      position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.52);
      display:flex;align-items:center;justify-content:center;padding:24px;
    }
    .panel{
      width:min(920px,calc(100vw - 32px));height:min(720px,calc(100vh - 40px));
      display:flex;flex-direction:column;overflow:hidden;
      background:#1e1e2e;border:1px solid #3a3a5c;border-radius:12px;
      box-shadow:0 28px 80px rgba(0,0,0,.65);color:#dedeee;
    }
    .header{
      display:flex;align-items:flex-start;gap:14px;padding:18px 20px 14px;
      border-bottom:1px solid #2e2e4e;
    }
    .heading{flex:1;min-width:0}
    h2{font-size:17px;line-height:1.2;margin:0 0 5px;color:#f5f5ff;font-weight:650}
    .subtitle{font-size:12px;color:#85859f;line-height:1.45}
    .best-effort{
      display:inline-flex;margin-left:7px;padding:3px 7px;border-radius:999px;
      color:#c7b9ff;background:#302b50;border:1px solid #4a4271;
      font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;
      vertical-align:2px;
    }
    .close{
      border:0;background:transparent;color:#85859f;padding:3px 5px;
      font-size:12px;line-height:1;cursor:pointer;border-radius:5px;
    }
    .close:hover{color:#fff;background:#2d2d48}
    .summary{
      display:flex;gap:18px;align-items:center;padding:10px 20px;
      border-bottom:1px solid #292944;color:#aaaac1;font-size:11px;
    }
    .summary strong{color:#f0f0fa;font-size:13px;margin-right:4px}
    .warning{margin-left:auto;color:#d2b779}
    .controls{
      display:flex;align-items:center;gap:8px;padding:10px 14px;
      border-bottom:1px solid #292944;
    }
    .filters{display:flex;gap:6px;flex-wrap:wrap}
    .filter{padding:5px 9px;font-size:11px;color:#9898b2}
    .filter.active{background:#373766;border-color:#6262a1;color:#fff}
    .search{
      margin-left:auto;width:230px;max-width:38vw;background:#151522;
      border:1px solid #353553;border-radius:6px;color:#e5e5f4;
      outline:none;padding:7px 9px;font-size:12px;
    }
    .search:focus{border-color:#6767aa}
    .search::placeholder{color:#64647b}
    .events{flex:1;overflow:auto;padding:6px 0}
    .event{border-bottom:1px solid #292941}
    .event-main{
      width:100%;display:grid;grid-template-columns:76px 82px 1fr auto;
      align-items:center;gap:10px;padding:10px 18px;background:transparent;
      color:#d7d7e8;border:0;text-align:left;cursor:pointer;
    }
    .event-main:hover{background:#25253d}
    .time{font:11px ui-monospace,SFMono-Regular,Consolas,monospace;color:#76768f}
    .category{
      justify-self:start;padding:3px 6px;border-radius:4px;font-size:10px;
      color:#aeb0d4;background:#2c2d4a;border:1px solid #3c3e62;
    }
    .category.error{color:#ffb1b1;background:#432a36;border-color:#684050}
    .category.glideajax{color:#a9d5ff;background:#24364a;border-color:#365573}
    .category.field{color:#b5e4c2;background:#263b35;border-color:#39594d}
    .event-summary{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .expand{color:#6f6f86;font-size:11px}
    .event-details{
      display:none;margin:0 18px 12px 186px;padding:10px 12px;
      background:#171725;border:1px solid #2d2d47;border-radius:6px;
      color:#a9a9bf;font:11px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;
      white-space:pre-wrap;overflow-wrap:anywhere;
    }
    .event.open .event-details{display:block}
    .empty{padding:48px 20px;text-align:center;color:#74748b;font-size:13px}
    .toolbar{
      display:flex;align-items:center;gap:8px;padding:11px 14px;
      border-top:1px solid #2e2e4e;background:#1b1b2b;
    }
    .toolbar-note{font-size:11px;color:#67677e;flex:1}
    .toolbar button{font-size:12px}
    .toolbar .primary{background:#4b4b91;border-color:#6565b5;color:#fff}
    .toolbar .primary:hover{background:#5959a5}
    @media(max-width:640px){
      .overlay{padding:8px}.panel{width:100%;height:calc(100vh - 16px)}
      .header{padding:14px}.summary{padding:9px 14px;gap:10px;flex-wrap:wrap}
      .warning{width:100%;margin-left:0}.controls{align-items:stretch;flex-direction:column}
      .search{width:100%;max-width:none;margin-left:0}
      .event-main{grid-template-columns:62px 70px 1fr;padding:10px 12px}
      .expand{display:none}.event-details{margin:0 12px 10px}
    }
  `;

  const removeIndicator = () => {
    if (indicatorHost) indicatorHost.remove();
    indicatorHost = null;
  };

  const showIndicator = () => {
    if (window !== window.top || indicatorHost) return;
    indicatorHost = document.createElement("div");
    indicatorHost.id = "snh-debug-timeline-indicator";
    document.documentElement.appendChild(indicatorHost);
    const shadow = indicatorHost.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>${UI_CSS}</style>
      <div class="recording" role="status" aria-live="polite">
        <span class="recording-dot"></span>
        <span>Debug Timeline recording</span>
        <button type="button">Stop</button>
      </div>
    `;
    const stopButton = shadow.querySelector("button");
    if (stopButton) {
      stopButton.addEventListener("click", () => {
        stopAndView().catch(() => {});
      });
    }
  };

  const closeResults = () => {
    if (resultsKeydownHandler) {
      window.removeEventListener("keydown", resultsKeydownHandler, true);
      resultsKeydownHandler = null;
    }
    if (resultsHost) resultsHost.remove();
    resultsHost = null;
    resultsShadow = null;
  };

  const formatElapsed = (milliseconds) => {
    const value = Math.max(0, Number(milliseconds) || 0);
    return "+" + (value / 1000).toFixed(3) + "s";
  };

  const eventSearchText = (event) =>
    [
      event.category,
      event.action,
      event.summary,
      event.frameLabel,
      JSON.stringify(event.details || {}),
      event.stack,
    ]
      .join(" ")
      .toLowerCase();

  const filteredEvents = () => {
    const events = (lastResult && lastResult.events) || [];
    return events.filter((event) => {
      if (activeFilter !== "all" && event.category !== activeFilter) return false;
      return !searchQuery || eventSearchText(event).includes(searchQuery);
    });
  };

  const detailText = (event) => {
    const parts = [];
    if (event.frameLabel) parts.push("Frame: " + event.frameLabel);
    if (event.frameUrl) parts.push("URL: " + event.frameUrl);
    const details = event.details || {};
    if (Object.keys(details).length) parts.push(JSON.stringify(details, null, 2));
    if (event.stack) parts.push("Stack (best effort):\n" + event.stack);
    return parts.join("\n\n") || "No additional details.";
  };

  const renderEvents = () => {
    if (!resultsShadow) return;
    const list = resultsShadow.querySelector(".events");
    if (!list) return;
    list.textContent = "";

    const events = filteredEvents();
    if (!events.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No timeline events match these filters.";
      list.appendChild(empty);
      return;
    }

    events.forEach((event) => {
      const row = document.createElement("div");
      row.className = "event";

      const main = document.createElement("button");
      main.type = "button";
      main.className = "event-main";

      const time = document.createElement("span");
      time.className = "time";
      time.textContent = formatElapsed(event.elapsedMs);

      const category = document.createElement("span");
      category.className = "category " + String(event.category || "");
      category.textContent = CATEGORY_LABELS[event.category] || event.category || "Event";

      const summary = document.createElement("span");
      summary.className = "event-summary";
      summary.textContent = event.summary || event.action || "Timeline event";
      summary.title = summary.textContent;

      const expand = document.createElement("span");
      expand.className = "expand";
      expand.textContent = "Details";

      main.append(time, category, summary, expand);

      const details = document.createElement("pre");
      details.className = "event-details";
      details.textContent = detailText(event);

      main.addEventListener("click", () => {
        row.classList.toggle("open");
        expand.textContent = row.classList.contains("open") ? "Hide" : "Details";
      });

      row.append(main, details);
      list.appendChild(row);
    });
  };

  const traceAsText = () => {
    const result = lastResult || { events: [] };
    const lines = [
      "SN Dev Helper - Debug Timeline",
      "Best-effort trace; script and UI Policy attribution is not guaranteed.",
      "Started: " + (result.startedAt ? new Date(result.startedAt).toISOString() : "unknown"),
      "Stopped: " + (result.stoppedAt ? new Date(result.stoppedAt).toISOString() : "unknown"),
      "Frames: " + String(result.frameCount || 0),
      "Events: " + String((result.events || []).length),
      "",
    ];

    (result.events || []).forEach((event) => {
      lines.push(
        formatElapsed(event.elapsedMs) +
          " [" +
          (CATEGORY_LABELS[event.category] || event.category || "Event") +
          "] " +
          (event.summary || event.action || "")
      );
      if (event.frameLabel) lines.push("  Frame: " + event.frameLabel);
      if (event.details && Object.keys(event.details).length) {
        lines.push("  Details: " + JSON.stringify(event.details));
      }
      if (event.stack) {
        lines.push(
          event.stack
            .split("\n")
            .map((line) => "  " + line)
            .join("\n")
        );
      }
      lines.push("");
    });
    return lines.join("\n");
  };

  const copyTrace = async () => {
    const text = traceAsText();
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.readOnly = true;
      textarea.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw error;
    }

    if (resultsShadow) {
      const copyButton = resultsShadow.querySelector("[data-action='copy']");
      if (copyButton) {
        const previous = copyButton.textContent;
        copyButton.textContent = "Copied";
        setTimeout(() => {
          if (copyButton) copyButton.textContent = previous;
        }, 1400);
      }
    }
  };

  const showResults = (result) => {
    if (window !== window.top) return;
    closeResults();
    lastResult = result;
    activeFilter = "all";
    searchQuery = "";

    resultsHost = document.createElement("div");
    resultsHost.id = "snh-debug-timeline-results";
    document.documentElement.appendChild(resultsHost);
    resultsShadow = resultsHost.attachShadow({ mode: "closed" });
    resultsShadow.innerHTML = `
      <style>${UI_CSS}</style>
      <div class="overlay">
        <section class="panel" role="dialog" aria-modal="true" aria-labelledby="snh-debug-title">
          <header class="header">
            <div class="heading">
              <h2 id="snh-debug-title">Debug Timeline <span class="best-effort">Best effort</span></h2>
              <div class="subtitle">ServiceNow form activity correlated across the frames that were available during this interaction.</div>
            </div>
            <button class="close" type="button">Close</button>
          </header>
          <div class="summary">
            <span><strong data-count="events">0</strong>events</span>
            <span><strong data-count="frames">0</strong>frames</span>
            <span><strong data-count="duration">0.0s</strong>duration</span>
            <span class="warning">Some internal ServiceNow changes may not be captured.</span>
          </div>
          <div class="controls">
            <div class="filters" aria-label="Timeline filters">
              <button class="filter active" type="button" data-filter="all">All</button>
              <button class="filter" type="button" data-filter="g_form">g_form</button>
              <button class="filter" type="button" data-filter="field">Fields</button>
              <button class="filter" type="button" data-filter="glideajax">GlideAjax</button>
              <button class="filter" type="button" data-filter="error">Errors</button>
            </div>
            <input class="search" type="search" placeholder="Search events, fields, stacks…" aria-label="Search timeline" />
          </div>
          <div class="events"></div>
          <footer class="toolbar">
            <span class="toolbar-note">Stacks identify runtime calls, not guaranteed Client Script or UI Policy names.</span>
            <button type="button" data-action="close">Close</button>
            <button class="primary" type="button" data-action="copy">Copy trace</button>
          </footer>
        </section>
      </div>
    `;

    const eventsCount = resultsShadow.querySelector("[data-count='events']");
    const framesCount = resultsShadow.querySelector("[data-count='frames']");
    const durationCount = resultsShadow.querySelector("[data-count='duration']");
    if (eventsCount) eventsCount.textContent = String((result.events || []).length);
    if (framesCount) framesCount.textContent = String(result.frameCount || 0);
    if (durationCount) {
      durationCount.textContent =
        (((result.stoppedAt || 0) - (result.startedAt || result.stoppedAt || 0)) / 1000).toFixed(1) +
        "s";
    }

    resultsShadow.querySelectorAll("[data-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        activeFilter = button.dataset.filter || "all";
        resultsShadow.querySelectorAll("[data-filter]").forEach((candidate) => {
          candidate.classList.toggle("active", candidate === button);
        });
        renderEvents();
      });
    });

    const search = resultsShadow.querySelector(".search");
    if (search) {
      search.addEventListener("input", () => {
        searchQuery = search.value.trim().toLowerCase();
        renderEvents();
      });
    }

    const closeButton = resultsShadow.querySelector(".close");
    const footerClose = resultsShadow.querySelector("[data-action='close']");
    const copyButton = resultsShadow.querySelector("[data-action='copy']");
    if (closeButton) closeButton.addEventListener("click", closeResults);
    if (footerClose) footerClose.addEventListener("click", closeResults);
    if (copyButton) copyButton.addEventListener("click", () => copyTrace().catch(() => {}));

    const overlay = resultsShadow.querySelector(".overlay");
    if (overlay) {
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closeResults();
      });
    }

    resultsKeydownHandler = (event) => {
      if (event.key !== "Escape" || !resultsHost) return;
      event.preventDefault();
      event.stopPropagation();
      closeResults();
    };
    window.addEventListener("keydown", resultsKeydownHandler, true);
    renderEvents();
  };

  const start = async () => {
    if (recording) return { ok: true, alreadyActive: true };
    const response = await chrome.runtime.sendMessage({ type: "START_DEBUG_TIMELINE" });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Couldn't start Debug Timeline.");
    }
    recording = true;
    showIndicator();
    return response;
  };

  async function stopAndView() {
    const response = await chrome.runtime.sendMessage({ type: "STOP_DEBUG_TIMELINE" });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Couldn't stop Debug Timeline.");
    }
    recording = false;
    removeIndicator();
    showResults(response);
    return response;
  }

  globalThis.SNDebugTimelineUI = {
    start,
    stopAndView,
    isRecording: () => recording,
    showResults,
  };
})();
