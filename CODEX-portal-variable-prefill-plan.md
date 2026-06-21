# Codex Plan: ServiceNow Portal Variable Prefill Command

## Summary

Add a new `Ctrl+\` command palette action named `Fill portal variables from previous ticket...`. The user enters a ServiceNow task number or sys_id; the extension resolves the record, fetches catalog variable values from the related RITM, and fills matching variables on the current Service Portal catalog item form.

This is a planning document only. It does not implement the feature.

## Key Changes

- Add a new command in `content.js` under `buildCommands()`.
- Command name: `Fill portal variables from previous ticket...`
- Command input placeholder: `RITM/SCTASK/REQ/task number or sys_id`
- Keep the command palette open while lookup and fill run.
- Show success, error, filled, and skipped counts in the palette toast.

Add same-origin ServiceNow lookup helpers:

- Resolve a 32-character sys_id or task number through the `task` table.
- Accept any task number as input, but only fill when a catalog variable source can be resolved.
- If the resolved record is `sc_req_item`, use that RITM.
- If the resolved record is `sc_task`, use its `request_item`.
- If the resolved record is `sc_request`, use its single RITM only when exactly one related RITM exists.
- For other task classes, show `No catalog variables found for this task.`

Fetch variables from the RITM:

- Query `sc_item_option_mtom` for the RITM.
- Follow references to `sc_item_option` and `item_option_new`.
- Normalize variables into `{ name, label, type, value, displayValue }`.
- Match target fields by internal variable name first.
- Fall back to label matching only when a stable variable name is unavailable.

## Fill Behavior

Add a background message path because portal form APIs may require MAIN-world access:

- `content.js` asks `background.js` to inject a self-contained MAIN-world filler into the active ServiceNow tab.
- The MAIN-world filler first tries `g_form.setValue(name, value, displayValue)`.
- If `g_form` is unavailable, fall back to Service Portal Angular scope or field model updates.
- If the model path is unavailable, fall back to DOM `input`, `change`, and `blur` event dispatch on matching inputs.

Default fill policy:

- Skip target variables that already have a value.
- Fill common variable types: text, textarea, choice/select, reference, boolean, date, and date-time.
- For reference variables, use sys_id as the value and display value where available.
- Skip attachments, encrypted variables, unsupported complex widgets, and multi-row variable sets.
- Report skipped variables in the toast rather than failing the whole command.

Constraints:

- Do not add runtime dependencies.
- Do not add a bundler or build step.
- Do not add new Chrome permissions unless implementation proves the existing `activeTab`, `scripting`, and ServiceNow host permission are insufficient.
- Keep the feature aligned with the existing MV3 architecture in `CLAUDE.md`.

## Test Plan

Static checks:

- Run `node --check content.js`.
- Run `node --check background.js`.
- Validate `manifest.json` remains valid JSON.

Manual Chrome extension verification:

- Reload the unpacked extension from `chrome://extensions`.
- Refresh the ServiceNow tab after content-script changes.
- Open a Service Portal catalog item form.
- Press `Ctrl+\`.
- Choose `Fill portal variables from previous ticket...`.
- Test with a RITM number that has variables.
- Test with a SCTASK number linked to a RITM.
- Test with a RITM sys_id.
- Test with a non-catalog task number, such as an incident, and expect a clear no-variable message.
- Confirm empty target variables are filled.
- Confirm already-filled target variables are skipped.
- Confirm unsupported variable types do not break the form.
- Confirm the palette toast reports filled and skipped counts.

## Assumptions

- Source ticket and target portal form are on the same ServiceNow instance and origin.
- The user's existing browser session cookies authorize the Table API reads.
- First version targets Service Portal catalog item forms, not classic catalog forms.
- Matching by internal variable name is the primary contract.
- `Any task number` means the command accepts any task input, but catalog variable fill only succeeds when the task can resolve to a RITM.
