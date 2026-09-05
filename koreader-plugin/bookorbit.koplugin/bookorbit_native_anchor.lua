local Text = require("bookorbit_anchor_text")
local Native = {}
local MAX_TOC = 10000
local MAX_STEPS = 8192

local function clamp(value)
    return math.max(0, math.min(1, tonumber(value) or 0))
end

local function normalized(value, limit)
    local result = Text.normalize(tostring(value or ""), limit or 16384)
    return result and result.text or ""
end

local function clock()
    local ffiutil = require("ffi/util")
    local seconds, micros = ffiutil.gettime()
    return seconds + (micros or 0) / 1000000
end

local function budget(options)
    local now = options and options.clock or clock
    local deadline, steps = now() + (options and options.seconds or 0.15), 0
    return function()
        steps = steps + 1
        return steps <= MAX_STEPS and now() < deadline
    end
end

local function walk(document, xp, count, backwards, available)
    local segments = {}
    for _ = 1, count do
        if not xp or not available() then break end
        local next_xp
        if backwards then next_xp = document:getPrevVisibleChar(xp)
        else next_xp = document:getNextVisibleChar(xp) end
        if not next_xp or next_xp == xp then break end
        local start_xp, end_xp = backwards and next_xp or xp, backwards and xp or next_xp
        local value = document:getTextFromXPointers(start_xp, end_xp, false)
        if type(value) ~= "string" or #value > 128 then break end
        segments[#segments + 1] = { text = value, xp = start_xp, ending = end_xp }
        xp = next_xp
    end
    if backwards then
        for i = 1, math.floor(#segments / 2) do
            segments[i], segments[#segments - i + 1] = segments[#segments - i + 1], segments[i]
        end
    end
    return segments, xp
end

local function window(document, xp, before, after, available)
    local segments = walk(document, xp, before, true, available)
    local following = walk(document, xp, after, false, available)
    for _, segment in ipairs(following) do segments[#segments + 1] = segment end
    local parts, length = {}, 0
    for _, segment in ipairs(segments) do
        segment.offset = length
        parts[#parts + 1], length = segment.text, length + #segment.text
    end
    local result = Text.normalize(table.concat(parts), 128 * (before + after))
    if not result then return nil end
    result.segments = segments
    return result
end

local function pointerAt(result, normalized_byte)
    local scalar = 1
    for position in result.text:gmatch("()[\1-\127\194-\244]") do
        if position >= normalized_byte then break end
        scalar = scalar + 1
    end
    local offset = result.nativeOffsets[scalar]
    if not offset then return nil end
    for index = #result.segments, 1, -1 do
        local segment = result.segments[index]
        if segment.offset <= offset then return segment.xp end
    end
end

local function toc(ui)
    local items = ui.toc and ui.toc.toc or ui.document:getToc() or {}
    local result = {}
    for index = 1, math.min(#items, MAX_TOC) do
        local item = items[index]
        if type(item.page) == "number" and item.page >= 1 then
            result[#result + 1] = { page = item.page, title = Text.bound(normalized(item.title), 512), xp = item.xpointer }
        end
    end
    return result
end

local function sectionAt(items, page, total)
    local index = 1
    for i, item in ipairs(items) do
        if item.page > page then break end
        index = i
    end
    local item = items[index] or { page = 1, title = "" }
    local ending = total + 1
    for i = index + 1, #items do
        if items[i].page > item.page then ending = items[i].page; break end
    end
    return index, item, math.max(1, ending - item.page)
end

local function excerpt(document, xp, count, available)
    local result = window(document, xp, 0, count, available)
    return result and result.text or ""
end

function Native.capture(ui, revision, event, options)
    local document = ui.document
    if not document or not document.getXPointer then return nil end
    local available = budget(options)
    local xp = options and options.xpointer or document:getXPointer()
    if not xp or not document:isXPointerInDocument(xp) then return nil end
    local page, total = document:getPageFromXPointer(xp), document:getPageCount()
    if not page or not total or total < 1 then return nil end
    local items = toc(ui)
    local index, chapter, span = sectionAt(items, page, total)
    local following = window(document, xp, 0, 384, available)
    local prefix = window(document, xp, 128, 0, available)
    local quote = Text.bound(following and following.text or "", 256)
    local suffix = normalized(following and following.text:sub(#quote + 1) or "")
    local chapter_xp = chapter.xp or document:getPageXPointer(chapter.page)
    local chapter_prefix = chapter_xp and excerpt(document, chapter_xp, 128, available) or ""
    return {
        anchor = {
            schemaVersion = 1, revision = revision, event = event,
            nativeLocator = { kind = "xpointer", value = xp },
            chapterIndex = index - 1, chapterTitle = chapter.title,
            chapterFraction = clamp((page - chapter.page) / span),
            bookFraction = clamp((page - 1) / total),
            quote = quote, prefix = Text.bound(prefix and prefix.text or "", 128), suffix = Text.bound(suffix, 128),
        },
        chapter = { title = chapter.title, prefix = chapter_prefix,
            previousTitle = items[index - 1] and items[index - 1].title,
            nextTitle = items[index + 1] and items[index + 1].title },
    }
end

local function candidates(ui, record, available)
    local items, found, weak = toc(ui), {}, {}
    local total = ui.document:getPageCount()
    local chapter = record.chapter or { title = record.anchor.chapterTitle }
    for index, item in ipairs(items) do
        if item.title == chapter.title and #found < 8 then
            local span = math.max(1, (items[index + 1] and items[index + 1].page or total + 1) - item.page)
            weak[#weak + 1] = { page = math.min(total, item.page + math.floor(clamp(record.anchor.chapterFraction) * span)), index = index }
            local xp = item.xp or ui.document:getPageXPointer(item.page)
            local prefix = xp and excerpt(ui.document, xp, 128, available) or ""
            if chapter.prefix == "" or prefix == chapter.prefix then
                found[#found + 1] = { page = math.min(total, item.page + math.floor(clamp(record.anchor.chapterFraction) * span)), index = index }
            end
        end
        if not available() then break end
    end
    if #found == 0 and #weak == 1 then found = weak end
    if #found == 0 then
        for index, item in ipairs(items) do
            if chapter.previousTitle and item.title == chapter.previousTitle then
                local span = math.max(1, (items[index + 1] and items[index + 1].page or total + 1) - item.page)
                found[1] = { page = math.min(total, item.page + span - 1), index = index }
                break
            end
        end
    end
    if #found == 0 then
        for index, item in ipairs(items) do
            if chapter.nextTitle and item.title == chapter.nextTitle then found[1] = { page = item.page, index = index }; break end
        end
    end
    if #found == 0 then
        found[1] = { page = math.max(1, math.min(total, 1 + math.floor(clamp(record.anchor.bookFraction) * total))) }
    end
    return found
end

local function locate(ui, record, available)
    local anchor = record.anchor
    local quote = anchor.quote or ""
    local choices = candidates(ui, record, available)
    if #quote < 16 or #choices >= 8 then return nil, choices[1] end
    local found
    for _, choice in ipairs(choices) do
        local xp = ui.document:getPageXPointer(choice.page)
        local result = xp and window(ui.document, xp, 1024, 2048, available)
        if result then
            local offset, count = 1, 0
            while count < 32 and available() do
                local first, last = result.text:find(quote, offset, true)
                if not first then break end
                local prefix, suffix = anchor.prefix or "", anchor.suffix or ""
                local context = (#prefix == 0 or normalized(result.text:sub(1, first - 1)):sub(-#prefix) == prefix)
                    and (#suffix == 0 or normalized(result.text:sub(last + 1)):sub(1, #suffix) == suffix)
                if context then
                    local pointer = pointerAt(result, first)
                    if pointer and found and found ~= pointer then return nil, choices[1] end
                    found = pointer
                end
                offset, count = last + 1, count + 1
            end
        end
    end
    if not available() then return nil, choices[1] end
    return found, choices[1]
end

function Native.restore(ui, record, revision, options)
    if not record or not record.anchor or not ui.document.getXPointer then return nil end
    local available = budget(options)
    local target, fallback, quality
    local locator = record.anchor.nativeLocator
    if record.anchor.revision == revision and locator and locator.kind == "xpointer"
        and ui.document:isXPointerInDocument(locator.value) then
        target, quality = locator.value, "exact"
    else
        target, fallback = locate(ui, record, available)
        quality = target and "relocated" or "approximate"
    end
    local Event = require("ui/event")
    if target then ui:handleEvent(Event:new("GotoXPointer", target))
    elseif fallback then ui:handleEvent(Event:new("GotoPage", fallback.page))
    else ui:handleEvent(Event:new("GotoPercent", clamp(record.anchor.bookFraction) * 100)) end
    local actual = ui.document:getXPointer()
    if not actual or not ui.document:isXPointerInDocument(actual) then return nil end
    if target and ui.document:getPageFromXPointer(actual) ~= ui.document:getPageFromXPointer(target) then
        quality = "approximate"
    end
    return { eventId = record.anchor.event and record.anchor.event.id, revision = revision,
        nativeLocator = { kind = "xpointer", value = actual }, quality = quality }
end

function Native.captureAnnotation(ui, annotation, revision, options)
    if type(annotation.page) ~= "string" then return nil end
    options = options or {}
    options.xpointer = annotation.pos0 or annotation.page
    local record = Native.capture(ui, revision, nil, options)
    if not record then return nil end
    if annotation.pos1 then
        local first = ui.document:getPageFromXPointer(options.xpointer)
        local last = ui.document:getPageFromXPointer(annotation.pos1)
        if not first or not last or math.abs(last - first) > 8 then return nil end
        local selected = ui.document:getTextFromXPointers(options.xpointer, annotation.pos1, false)
        if type(selected) ~= "string" or #selected > 16384 then return nil end
        record.selection = normalized(selected)
        if #record.selection == 0 or Text.scalarLength(record.selection) > 2048 then return nil end
    end
    return record
end

function Native.resolveAnnotation(ui, record, options)
    local available = budget(options)
    local target = locate(ui, record, available)
    if not target then return nil, "passage_unverified" end
    local ending
    if record.selection then
        local result = window(ui.document, target, 0, math.min(4096, Text.scalarLength(record.selection) * 2 + 32), available)
        if not result or not available() then return nil, "budget" end
        if result.text:sub(1, #record.selection) ~= record.selection then return nil, "selection_mismatch" end
        ending = pointerAt(result, #record.selection + 1)
        if not ending or normalized(ui.document:getTextFromXPointers(target, ending, false)) ~= record.selection then return nil, "range_verification" end
    end
    return { page = target, pos0 = ending and target or nil, pos1 = ending, pageno = ui.document:getPageFromXPointer(target) }
end

return Native
