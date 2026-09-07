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
    return Native.resolveAnnotation(ui, {
        anchor = { revision = "old", chapterTitle = "Chapter", chapterFraction = 0, bookFraction = 0, quote = selected_quote, prefix = prefix },
        chapter = { title = "Chapter", prefix = "" },
        selection = selected_quote,
    }, { clock = function() return 0 end })
end

assert(resolve("ok " .. quote .. " ending", quote, "ok"), "a unique verified passage must resolve")
local repeated = "ok " .. quote .. " " .. ("bad " .. quote .. " "):rep(31) .. "ok " .. quote .. " ending"
assert(not resolve(repeated, quote, "ok"), "hitting the match limit must not hide a later ambiguous passage")
assert(not resolve("中文中文中文中文 ending", "中文中文中文中文", ""), "the minimum quote length must count Unicode scalars")
print("Native anchor search bounds passed")
