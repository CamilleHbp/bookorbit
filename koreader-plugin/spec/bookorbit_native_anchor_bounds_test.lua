package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path
local Native = require("bookorbit_native_anchor")
local quote = "abcdefghijklmnop"

local function resolve(text, selected_quote, prefix)
    local document = {}
    function document:getToc() return { { title = "Chapter", page = 1, xpointer = "1" } } end
    function document:getPageCount() return 1 end
    function document:getPageXPointer() return "1" end
    function document:getPageFromXPointer() return 1 end
    function document:getPrevVisibleChar(xp)
        local position = tonumber(xp)
        return position > 1 and tostring(position - 1) or nil
    end
    function document:getNextVisibleChar(xp)
        local position = tonumber(xp)
        return position <= #text and tostring(position + 1) or nil
    end
    function document:getTextFromXPointers(first, last) return text:sub(tonumber(first), tonumber(last) - 1) end
    local ui = { document = document }
    local result = Native.resolveAnnotation(ui, {
        anchor = { revision = "old", chapterTitle = "Chapter", chapterFraction = 0, bookFraction = 0, quote = selected_quote, prefix = prefix },
        chapter = { title = "Chapter", prefix = "" },
        selection = selected_quote,
    }, { clock = function() return 0 end })
    return result, document
end

assert(resolve("ok " .. quote .. " ending", quote, "ok"), "a unique verified passage must resolve")
local repeated = "ok " .. quote .. " " .. ("bad " .. quote .. " "):rep(31) .. "ok " .. quote .. " ending"
assert(not resolve(repeated, quote, "ok"), "hitting the match limit must not hide a later ambiguous passage")
assert(not resolve("中文中文中文中文 ending", "中文中文中文中文", ""), "the minimum quote length must count Unicode scalars")
local _, document = resolve(("A visible paragraph with some text. "):rep(3), quote, "")
function document:getToc()
    return { { title = "Old ending", page = 1, xpointer = "1" }, { title = "New chapter", page = 1, xpointer = "40" } }
end
function document:getXPointer() return "20" end
function document:isXPointerInDocument() return true end
function document:compareXPointers(first, last)
    if tonumber(first) == tonumber(last) then return 0 end
    return tonumber(first) < tonumber(last) and 1 or -1
end
local captured = assert(Native.capture({ document = document }, "appended", nil, { clock = function() return 0 end }))
assert(captured.anchor.chapterTitle == "Old ending", "a later chapter on the same page must not claim the old ending")
function document:getXPointer() return "50" end
captured = assert(Native.capture({ document = document }, "appended", nil, { clock = function() return 0 end }))
assert(captured.anchor.chapterTitle == "New chapter", "native positions after the chapter boundary must use the new chapter")
print("Native anchor search bounds passed")
