local fixture_dir, plugin_dir = assert(arg[1]), assert(arg[2])
package.path = plugin_dir .. "/?.lua;frontend/?.lua;" .. package.path
if not table.pack then table.pack = function(...) return { n = select("#", ...), ... } end end
local Native = require("bookorbit_native_anchor")
local cre = require("libs/libkoreader-cre")
cre.registerFont("fonts/noto/NotoSerif-Regular.ttf")

local function open(name)
    local raw = cre.newDocView(600, 800, 1)
    raw:setStringProperty("font.face.default", "Noto Serif")
    raw:setIntProperty("font.size", 24)
    assert(raw:loadDocument(fixture_dir .. "/" .. name .. ".epub"))
    raw:renderDocument()
    local document = setmetatable({}, { __index = function(_, key)
        local method = raw[key == "getPageCount" and "getPages" or key]
        if type(method) == "function" then return function(_, ...) return method(raw, ...) end end
    end })
    local ui = { document = document, toc = { toc = raw:getToc() } }
    function ui:handleEvent(event)
        if event.handler == "onGotoXPointer" then raw:gotoXPointer(event.args[1])
        elseif event.handler == "onGotoPage" then raw:gotoPage(event.args[1])
        elseif event.handler == "onGotoPercent" then raw:gotoPage(math.max(1, math.floor(raw:getPages() * event.args[1] / 100))) end
    end
    return ui, raw
end

local old_ui, old_raw = open("original")
assert(#old_ui.toc.toc == 10, "fixture must have ten chapters")
local ninth, tenth = old_ui.toc.toc[9], old_ui.toc.toc[10]
old_raw:gotoPage(math.floor((ninth.page + tenth.page) / 2))
local original = assert(Native.capture(old_ui, "original", { id = "original-event" }))
assert(original.anchor.chapterTitle == "Chapter 9", original.anchor.chapterTitle)
assert(#original.anchor.quote > 100, "portable passage must be captured")
print("captured", original.anchor.chapterFraction, original.anchor.bookFraction, original.anchor.quote:sub(1, 50))
local exact = assert(Native.restore(old_ui, original, "original"))
assert(exact.quality == "exact")
old_raw:close()

for _, name in ipairs({ "appended", "regenerated", "edited", "empty-chapter" }) do
    local ui, raw = open(name)
    local restored = assert(Native.restore(ui, original, name))
    assert(raw:isXPointerInDocument(restored.nativeLocator.value), "restoration must produce a native position")
    local captured = assert(Native.capture(ui, name))
    print(name, restored.quality, captured.anchor.chapterTitle, captured.anchor.chapterFraction, captured.anchor.bookFraction)
    if name == "appended" or name == "regenerated" then
        assert(restored.quality == "relocated", "unchanged passage must be relocated for " .. name)
        local page = raw:getPageFromXPointer(restored.nativeLocator.value)
        local first = raw:getPageXPointer(page)
        local ending = raw:getPageXPointer(math.min(raw:getPages(), page + 1))
        local visible = require("bookorbit_anchor_text").normalize(raw:getTextFromXPointers(first, ending, false)).text
        assert(visible:find(original.anchor.quote:sub(1, 100), 1, true), "the same passage must be visible for " .. name)
        if name == "appended" then assert(captured.anchor.bookFraction < original.anchor.bookFraction) end
    else
        assert(restored.quality == "approximate", "deleted content must use a valid approximation")
    end
    assert(original.anchor.event.id == "original-event", "restoration must preserve event identity")
    raw:close()
end

local ending_ui, ending_raw = open("original")
ending_raw:gotoPage(ending_raw:getPages())
local old_ending = assert(Native.capture(ending_ui, "original", { id = "old-ending-event" }))
ending_raw:close()
local appended_ui, appended_raw = open("appended")
local ending_restored = assert(Native.restore(appended_ui, old_ending, "appended"))
local ending_position = assert(Native.capture(appended_ui, "appended"))
assert(ending_restored.quality == "relocated", "the old ending must retain its passage after an append")
assert(ending_position.anchor.chapterTitle == "Chapter 10", "new chapters must remain unread at the old ending")
assert(ending_position.anchor.bookFraction < old_ending.anchor.bookFraction)

local legacy = { anchor = { revision = "legacy", chapterFraction = 0, bookFraction = 0.4 } }
assert(Native.restore(appended_ui, legacy, "appended").quality == "approximate", "percentage-only progress must restore automatically")
local strengthened = assert(Native.capture(appended_ui, "appended", { id = "deliberate-reading-event" }))
assert(#strengthened.anchor.quote > 100 and strengthened.anchor.nativeLocator.value,
    "subsequent reading must capture a native position and passage")

appended_raw:gotoPage(appended_raw:getPages() - 2)
local newer = assert(Native.capture(appended_ui, "appended", { id = "newer-chapter-event" }))
assert(newer.anchor.chapterTitle == "Chapter 15")
appended_raw:close()
local newer_quote, newer_locator = newer.anchor.quote, newer.anchor.nativeLocator.value
for _, version in ipairs({ "original", "regenerated", "original" }) do
    local target_ui, target_raw = open(version)
    local mapped = assert(Native.restore(target_ui, newer, version == "original" and "rollback-revision" or version))
    assert(target_raw:isXPointerInDocument(mapped.nativeLocator.value))
    if version == "original" then
        assert(mapped.quality == "approximate", "an older or rolled-back copy cannot claim the missing newer passage")
    else
        assert(mapped.quality == "relocated", "skipping intermediate revisions must retain the newer passage")
    end
    assert(newer.anchor.event.id == "newer-chapter-event" and newer.anchor.chapterTitle == "Chapter 15"
        and newer.anchor.quote == newer_quote and newer.anchor.nativeLocator.value == newer_locator,
        "older projections and repeated updates must not overwrite the newer canonical anchor")
    target_raw:close()
end
print("KOReader rendering-engine continuity acceptance passed")
