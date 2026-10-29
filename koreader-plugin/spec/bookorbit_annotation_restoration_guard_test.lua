package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path
local continuity
local settings = { readSetting = function(_, key)
    if key == "bookorbit_revision_annotations_v1" then return continuity end
end }
package.loaded["docsettings"] = {
    hasSidecarFile = function() return true end,
    open = function() return settings end,
}
package.loaded["ui/widget/booklist"] = {}
package.loaded["libs/libkoreader-lfs"] = {}
package.loaded["ui/event"] = {}
package.loaded["ui/uimanager"] = {}
package.loaded["logger"] = { dbg = function() end }
package.loaded["ffi/sha2"] = { md5 = function(value) return value end }
package.loaded["ffi/util"] = { template = function(value) return value end }
package.loaded["gettext"] = function(value) return value end
package.loaded["util"] = { trim = function(value) return value end }

local Guard = require("bookorbit_annotation_guard")
local Sidecar = require("bookorbit_sidecar")
local Highlights = require("bookorbit_annotations")
local Bookmarks = require("bookorbit_bookmarks")
local calls, pause_during_request = 0, false
local book = {}
local function exchange()
    calls = calls + 1
    if pause_during_request then continuity = { held = { items = {} } } end
    return { results = { { toApply = {}, more = false } } }
end
local client = { exchangeAnnotations = exchange, exchangeBookmarks = exchange }
local options = {
    client = client, state = { getBook = function() return book end }, digest = "copy",
    annotations = {}, bookmarks = {}, apply_mode = "skip", file = "/books/story.epub",
}

for _, pending in ipairs({ { held = { items = {} } }, { pending = { { items = { { text = "Keep me" } } } } } }) do
    continuity = pending
    for _, mode in ipairs({ "live", "sidecar", "skip" }) do
        options.apply_mode = mode
        options.ui = mode == "live" and { doc_settings = settings } or nil
        assert(not Guard.canExchange(options))
        local highlights, highlight_error = Highlights.exchangeBook(options)
        local bookmarks, bookmark_error = Bookmarks.exchangeBook(options)
        assert(not highlights and highlight_error == "annotation_restoration_pending")
        assert(not bookmarks and bookmark_error == "annotation_restoration_pending")
        assert(calls == 0, "held annotations must never be submitted as a complete empty key set")
    end
    local snapshot, err = Sidecar.extract(options.file)
    assert(not snapshot and err == "annotation_restoration_pending", "legacy sweeps must retain held annotations")
    assert(continuity == pending, "sync must not modify pending restoration state")
end

options.ui, options.apply_mode = nil, "skip"
continuity = { pending = {} }
assert(Highlights.exchangeBook(options))
assert(Bookmarks.exchangeBook(options))
assert(calls == 2, "verified copies resume normal exchange")
assert(Sidecar.extract(options.file))

for _, service in ipairs({ Highlights, Bookmarks }) do
    continuity, pause_during_request, book = nil, true, {}
    local result, err = service.exchangeBook(options)
    assert(not result and err == "annotation_restoration_pending")
    assert(next(book) == nil, "an exchange interrupted by replacement must not advance sync watermarks")
end
print("bookorbit_annotation_restoration_guard_test.lua: ok")
