local Annotations = {}
local KEY = "bookorbit_revision_annotations_v1"
local Native = require("bookorbit_native_anchor")
local ffiutil = require("ffi/util")
local function now()
    local seconds, micros = ffiutil.gettime()
    return seconds + (micros or 0) / 1000000
end

local function annotationKey(annotation)
    return table.concat({ tostring(annotation.datetime), tostring(annotation.page),
        tostring(annotation.pos0), tostring(annotation.pos1) }, "\0")
end

function Annotations.capture(ui, sha256)
    if not ui.annotation then return end
    local state = ui.doc_settings:readSetting(KEY) or {}
    local same_revision = state.sha256 == sha256
    local anchors = same_revision and state.anchors or {}
    local keys = same_revision and state.anchorKeys or {}
    anchors, keys = anchors or {}, keys or {}
    local items, deadline = ui.annotation.annotations or {}, now() + 0.1
    local cursor = same_revision and tonumber(state.captureCursor) or 1
    cursor = math.max(1, math.floor(cursor or 1))
    for _ = 1, math.min(#items, 100) do
        if now() >= deadline then break end
        local index = (cursor - 1) % #items + 1
        local annotation = items[index]
        cursor = index + 1
        local key = annotationKey(annotation)
        if keys[index] ~= key then anchors[index] = nil end
        keys[index] = key
        local ok, anchor = pcall(Native.captureAnnotation, ui, annotation, "sha256:" .. sha256, { seconds = math.max(0, deadline - now()) })
        if ok and anchor then
            anchors[index] = anchor
            local continuity = ui.bookorbit and ui.bookorbit.reading_continuity
            local identity = continuity and continuity.record and continuity.record.anchor
            if not annotation.bookorbit_source_anchor then
                anchor.anchor.provisionalSha256 = sha256
                annotation.bookorbit_source_anchor = anchor.anchor
            end
            local source = annotation.bookorbit_source_anchor
            if not source.bookId and not source.bookFileId and identity and identity.bookId and identity.bookFileId then
                source.bookId, source.bookFileId = identity.bookId, identity.bookFileId
            end
        end
    end
    state.anchors, state.anchorKeys, state.captureCursor, state.sha256 = anchors, keys, cursor, sha256
    ui.doc_settings:saveSetting(KEY, state)
    ui.doc_settings:saveSetting("annotations", ui.annotation.annotations)
end

function Annotations.begin(ui, revision_record, options)
    if not revision_record then return end
    local state = ui.doc_settings:readSetting(KEY) or {}
    if type(state) ~= "table" then state = {} end
    local items = ui.doc_settings:readSetting("annotations") or ui.doc_settings:readSetting("annotations_rolling")
    if type(items) == "table" and #items > 0 then
        state.held = { sha256 = state.sha256 or revision_record.sha256, items = items, anchors = state.anchors, anchorKeys = state.anchorKeys }
    end
    if not state.held and not state.pending then return end
    ui.doc_settings:saveSetting(KEY, state)
    ui.doc_settings:saveSetting("annotations", {})
    ui.doc_settings:delSetting("annotations_rolling")
    if not options or not options.defer_flush then ui.doc_settings:flush() end
    return state
end

function Annotations.ready(ui, state, sha256)
    if not state then return end
    local restored = {}
    local same_revision = state.sha256 == sha256
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
        local items, anchors, keys = {}, {}, {}
        for index, annotation in ipairs(group.items) do
            local location, anchor = nil, group.anchors and group.anchors[index]
            local key = group.anchorKeys and group.anchorKeys[index]
            if group.anchorKeys and key ~= annotationKey(annotation) then anchor = nil end
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
                local next_index = #items + 1
                items[next_index], anchors[next_index], keys[next_index] = annotation, anchor, key
            end
        end
        if #items > 0 then remaining[#remaining + 1] = { sha256 = group.sha256, items = items, anchors = anchors, anchorKeys = group.anchorKeys and keys } end
    end
    state.pending = #remaining > 0 and remaining or nil
    if not same_revision then state.anchors, state.anchorKeys, state.captureCursor = nil, nil, nil end
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
