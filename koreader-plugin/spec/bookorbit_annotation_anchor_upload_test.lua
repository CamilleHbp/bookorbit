package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path
package.loaded["docsettings"] = {}
package.loaded["ui/event"] = {}
package.loaded["ui/uimanager"] = {}
package.loaded["logger"] = { dbg = function() end }
package.loaded["ffi/sha2"] = { md5 = function(value) return value end }
package.loaded["util"] = { trim = function(value) return value end }
package.loaded["bookorbit_sidecar"] = {}
local Exchange = require("bookorbit_annotations")
local calls, support, fail, malformed = {}, true, false, false
local book = { annotation_watermark = "2026-07-01 00:00:00" }
local source = { revision = "sha256:" .. ("a"):rep(64), provisionalSha256 = ("a"):rep(64), bookId = 2, bookFileId = 9 }
local annotation = { datetime = "2026-01-01 00:00:00", text = "Original selected text", pos0 = "/original", sourceAnchor = source }
local options = {
    state = { getBook = function() return book end }, digest = "copy", annotations = { annotation },
    ann_signature = "with-anchor", ann_max_datetime = annotation.datetime, apply_mode = "skip",
    client = {
        annotationAnchorSupport = function() return support end,
        exchangeAnnotations = function(_, books)
            calls[#calls + 1] = books
            if fail then return nil, 503 end
            if malformed then return { results = {} } end
            return { results = { { toApply = {}, more = false } } }
        end,
    },
}
assert(Exchange.exchangeBook(options))
assert(calls[1][1].changes[1].sourceAnchor == source, "old notes must backfill their source anchors after an upgrade")
assert(book.annotation_anchor_signature == options.ann_signature)
calls = {}
assert(Exchange.exchangeBook(options))
assert(#calls[1][1].changes == 0, "a completed anchor backfill must not repeat")
options.ann_signature, fail = "more-anchors", true
assert(Exchange.exchangeBook(options).had_errors)
assert(book.annotation_anchor_signature == "with-anchor", "failed uploads must retain the last completed anchor signature")
fail, malformed = false, true
assert(Exchange.exchangeBook(options).had_errors)
assert(book.annotation_anchor_signature == "with-anchor", "missing acknowledgements must not mark an anchor upload complete")
malformed = false
fail, support, calls = false, nil, {}
local result, err = Exchange.exchangeBook(options)
assert(not result and err == "network" and #calls == 0, "unknown capability must not silently discard anchors")
support, book.annotation_watermark = false, nil
annotation.datetime = "2099-01-01 00:00:00"
assert(Exchange.exchangeBook(options))
assert(calls[1][1].changes[1].sourceAnchor == nil, "older servers must receive only legacy fields")
assert(annotation.sourceAnchor == source, "compatibility projection must not mutate the local source anchor")
print("Annotation anchor upload compatibility passed")
