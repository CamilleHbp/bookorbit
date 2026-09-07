package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path
local clock, calls, resolved = 0, 0, {}
package.loaded["ffi/util"] = { gettime = function() return clock, 0 end }
package.loaded.bookorbit_native_anchor = {
    captureAnnotation = function(_, annotation, revision)
        calls = calls + 1
        return { anchor = { schemaVersion = 1, revision = revision, quote = annotation.text } }
    end,
    resolveAnnotation = function(_, record)
        resolved[#resolved + 1] = record.anchor.quote
        return { page = record.anchor.quote, pos0 = record.anchor.quote }
    end,
}
local Capture = require("bookorbit_annotation_continuity")
local values, items = {}, {}
for index = 1, 250 do items[index] = { datetime = tostring(index), page = "/" .. index, text = "Passage " .. index } end
local ui = {
    annotation = { annotations = items, sortItems = function() end, updatePageNumbers = function() end },
    doc_settings = {
        readSetting = function(_, key) return values[key] end,
        saveSetting = function(_, key, value) values[key] = value end,
        delSetting = function(_, key) values[key] = nil end,
        flush = function() end,
    },
}
local sha = ("a"):rep(64)
Capture.capture(ui, sha)
assert(calls == 100 and not items[101].bookorbit_source_anchor)
local reopening = Capture.begin(ui, { sha256 = sha })
assert(not Capture.ready(ui, reopening, sha))
assert(values.bookorbit_revision_annotations_v1.captureCursor == 101,
    "ordinary close and reopen must preserve the next capture batch")
Capture.capture(ui, sha)
assert(calls == 200 and items[200].bookorbit_source_anchor and not items[201].bookorbit_source_anchor)
Capture.capture(ui, sha)
assert(calls == 300 and items[250].bookorbit_source_anchor,
    "later annotations must eventually receive anchors without exceeding a capture batch")
local stored = values.bookorbit_revision_annotations_v1
assert(stored.anchors[1] and stored.anchors[150] and stored.anchors[250], "earlier batches must be retained")
-- Sorting between capture and replacement must not pair an index with a different passage.
items[1], items[250] = items[250], items[1]
local pending = Capture.begin(ui, { sha256 = sha })
assert(Capture.ready(ui, pending, ("b"):rep(64)))
assert(#resolved == 248 and #ui.annotation.annotations == 248)
assert(#pending.pending[1].items == 2, "unverified reordered annotations must stay pending")
assert(pending.pending[1].items[1].text == "Passage 250")
assert(pending.pending[1].items[2].text == "Passage 1")
assert(items[250].bookorbit_source_anchor.revision == "sha256:" .. sha,
    "resumable capture must preserve original source identity")
print("Bounded annotation capture batches passed")
