local Annotations = {}
local KEY = "bookorbit_revision_annotations_v1"
local Native = require("bookorbit_native_anchor")
local ffiutil = require("ffi/util")
local function now()
    local seconds, micros = ffiutil.gettime()
    return seconds + (micros or 0) / 1000000
end

function Annotations.capture(ui, sha256)
    if not ui.annotation then return end
    local state = ui.doc_settings:readSetting(KEY) or {}
    local anchors, deadline = {}, now() + 0.1
    for index, annotation in ipairs(ui.annotation.annotations or {}) do
        if index > 100 or now() >= deadline then break end
        local ok, anchor = pcall(Native.captureAnnotation, ui, annotation, "sha256:" .. sha256, { seconds = math.max(0, deadline - now()) })
        if ok and anchor then anchors[index] = anchor end
    end
    state.anchors, state.sha256 = anchors, sha256
    ui.doc_settings:saveSetting(KEY, state)
end

function Annotations.begin(ui, revision_record)
    if not revision_record then return end
    local state = ui.doc_settings:readSetting(KEY) or {}
    if type(state) ~= "table" then state = {} end
    local items = ui.doc_settings:readSetting("annotations") or ui.doc_settings:readSetting("annotations_rolling")
    if type(items) == "table" and #items > 0 then
        state.held = { sha256 = state.sha256 or revision_record.sha256, items = items, anchors = state.anchors }
    end
    if not state.held and not state.pending then return end
    ui.doc_settings:saveSetting(KEY, state)
    ui.doc_settings:saveSetting("annotations", {})
    ui.doc_settings:delSetting("annotations_rolling")
    ui.doc_settings:flush()
    return state
end

function Annotations.ready(ui, state, sha256)
    if not state then return end
    local restored = {}
    if state.held then
        if state.held.sha256 == sha256 then
            restored = state.held.items
        else
            state.pending = state.pending or {}
            state.pending[#state.pending + 1] = state.held
        end
        state.held = nil
    end
    state.sha256 = sha256
    local deadline, remaining = now() + 0.15, {}
    for _, group in ipairs(state.pending or {}) do
        local items, anchors = {}, {}
        for index, annotation in ipairs(group.items) do
            local location, anchor = nil, group.anchors and group.anchors[index]
            if anchor and now() < deadline then
                local ok, result = pcall(Native.resolveAnnotation, ui, anchor, { seconds = deadline - now() })
                if ok then location = result end
            end
            if location then
                local mapped = {}
                for key, value in pairs(annotation) do mapped[key] = value end
                mapped.page, mapped.pos0, mapped.pos1, mapped.pageno = location.page, location.pos0, location.pos1, location.pageno
                restored[#restored + 1] = mapped
            else
                items[#items + 1], anchors[#items + 1] = annotation, anchor
            end
        end
        if #items > 0 then remaining[#remaining + 1] = { sha256 = group.sha256, items = items, anchors = anchors } end
    end
    state.pending, state.anchors = #remaining > 0 and remaining or nil, nil
    if ui.annotation then
        ui.annotation.annotations = restored
        ui.annotation:sortItems(restored)
        ui.annotation:updatePageNumbers()
    end
    ui.doc_settings:saveSetting("annotations", restored)
    ui.doc_settings:saveSetting(KEY, state)
    ui.doc_settings:flush()
    return state.pending ~= nil and #state.pending > 0
end

return Annotations
