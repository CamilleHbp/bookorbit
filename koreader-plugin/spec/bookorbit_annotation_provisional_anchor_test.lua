package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path
package.loaded["ffi/util"] = { gettime = function() return 0, 0 end }
package.loaded.bookorbit_native_anchor = {
    captureAnnotation = function(_, _, revision)
        return { anchor = { schemaVersion = 1, revision = revision, quote = "Original selected passage" } }
    end,
}
local Capture = require("bookorbit_annotation_continuity")
local values = {}
local annotation = { text = "Original selected passage" }
local ui = {
    annotation = { annotations = { annotation } },
    doc_settings = {
        readSetting = function(_, key) return values[key] end,
        saveSetting = function(_, key, value) values[key] = value end,
    },
}
Capture.capture(ui, ("a"):rep(64))
local source = annotation.bookorbit_source_anchor
assert(source.revision == "sha256:" .. ("a"):rep(64) and source.bookId == nil,
    "offline annotations must retain provisional source identity before book matching")
ui.bookorbit = { reading_continuity = { record = { anchor = { bookId = 2, bookFileId = 9 } } } }
Capture.capture(ui, ("b"):rep(64))
assert(annotation.bookorbit_source_anchor == source and source.bookId == 2 and source.bookFileId == 9)
assert(source.revision == "sha256:" .. ("a"):rep(64) and source.provisionalSha256 == ("a"):rep(64),
    "later identification must preserve the original bytes rather than the installed projection")
assert(values.annotations[1].bookorbit_source_anchor == source, "provisional annotations must survive sidecar persistence")
print("Provisional annotation source identity passed")
