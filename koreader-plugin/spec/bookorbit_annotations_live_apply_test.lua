package.loaded["docsettings"] = {
    open = function()
        error("DocSettings should not be used by live apply")
    end,
}

package.loaded["ui/event"] = {
    new = function(_, name, payload)
        return { name = name, payload = payload }
    end,
}

local dirty_scope
local dirty_mode
package.loaded["ui/uimanager"] = {
    setDirty = function(_, scope, mode)
        dirty_scope = scope
        dirty_mode = mode
    end,
}

package.loaded["logger"] = {
    dbg = function() end,
}

package.loaded["ffi/sha2"] = {
    md5 = function(value)
        return value
    end,
}

package.loaded["util"] = {
    trim = function(value)
        return tostring(value or ""):match("^%s*(.-)%s*$")
    end,
}

package.loaded["bookorbit_sidecar"] = {
    normalizeAnnotations = function()
        return {}, ""
    end,
}

package.path = "koreader-plugin/bookorbit.koplugin/?.lua;" .. package.path

local BookOrbitAnnotations = require("bookorbit_annotations")

local function assertEqual(actual, expected, label)
    if actual ~= expected then
        error(string.format("%s: expected %s, got %s", label, tostring(expected), tostring(actual)))
    end
end

local handled_event
local footer_updates = 0
local ui = {
    rolling = true,
    document = {
        isXPointerInDocument = function()
            return true
        end,
        getTextFromXPointers = function()
            return "fresh web highlight"
        end,
        getPageFromXPointer = function()
            return 12
        end,
    },
    annotation = {
        annotations = {},
        addItem = function(self, item)
            item.pageno = 12
            table.insert(self.annotations, item)
            return #self.annotations
        end,
    },
    view = {
        footer = {
            maybeUpdateFooter = function()
                footer_updates = footer_updates + 1
            end,
        },
    },
    handleEvent = function(_, event)
        handled_event = event
    end,
}

local applied, deleted, touched, deleted_touched = BookOrbitAnnotations.applyLive(ui, {
    add = {
        {
            serverId = 42,
            version = 3,
            datetime = "2026-07-08 09:10:11",
            datetimeUpdated = "2026-07-08 09:12:00",
            drawer = "lighten",
            color = "yellow",
            text = "fresh web highlight",
            note = "from web reader",
            chapter = "Chapter 1",
            posFormat = "xpointer",
            pos0 = "/body/DocFragment[1]/p[1]/text().0",
            pos1 = "/body/DocFragment[1]/p[1]/text().19",
        },
    },
})

assertEqual(#ui.annotation.annotations, 1, "remote highlight is inserted")
assertEqual(applied[1].status, "applied", "remote highlight is acked as applied")
assertEqual(applied[1].verified, true, "remote highlight is verified")
assertEqual(applied[1].pageno, 12, "ack includes inserted pageno")
assertEqual(#deleted, 0, "no deletes are emitted")
assertEqual(touched, 1, "one annotation is touched")
assertEqual(deleted_touched, 0, "no deleted touch is counted")
assertEqual(footer_updates, 1, "footer is refreshed")
assertEqual(dirty_scope, "all", "UI is dirtied")
assertEqual(dirty_mode, "ui", "UI dirty mode is set")
assertEqual(handled_event.name, "AnnotationsModified", "annotations modified event is sent")
assertEqual(handled_event.payload[1], ui.annotation.annotations[1], "event points at inserted item")
assertEqual(handled_event.payload.nb_highlights_added, 1, "event increments highlight count")
assertEqual(handled_event.payload.index_modified, 1, "event carries inserted index")

local entry = {
    serverId = 50, version = 1, datetime = "2026-07-09 09:10:11", text = "fresh web highlight",
    posFormat = "xpointer", pos0 = "/old", pos1 = "/old.end",
}
ui.document.isXPointerInDocument = function(_, xp) return xp ~= "/old" end
ui.document.findAllText = function()
    return { { start = "/first", ["end"] = "/first.end" }, { start = "/second", ["end"] = "/second.end" } }
end
applied = BookOrbitAnnotations.applyLive(ui, { add = { entry } })
assertEqual(applied[1].status, "failed", "ambiguous repair must not choose the nearest repeated passage")
assertEqual(#ui.annotation.annotations, 1, "ambiguous repair does not insert a highlight")

ui.document.isXPointerInDocument = function() return true end
entry.sourceAnchor = { revision = "original", quote = "fresh web highlight", bookFraction = 0.2 }
package.loaded.bookorbit_native_anchor = { resolveAnnotation = function() return nil end }
applied = BookOrbitAnnotations.applyLive(ui, { add = { entry } })
assertEqual(applied[1].status, "failed", "an unresolved source anchor must not fall back to a reused native range")
package.loaded.bookorbit_native_anchor.resolveAnnotation = function(_, record)
    assertEqual(record.anchor, entry.sourceAnchor, "original source anchor reaches the native resolver")
    assertEqual(record.selection, entry.text, "full selection reaches the native resolver")
    return { pos0 = "/mapped", pos1 = "/mapped.end", page = "/mapped" }
end
applied = BookOrbitAnnotations.applyLive(ui, { add = { entry } })
assertEqual(applied[1].status, "applied", "verified source anchor can be installed")
assertEqual(applied[1].corrected, true, "mapped native range is acknowledged as corrected")
assertEqual(ui.annotation.annotations[2].bookorbit_source_anchor, entry.sourceAnchor, "original source anchor remains on the local annotation")

ui.document.getTextFromXPointers = function() return "unrelated installed text" end
applied = BookOrbitAnnotations.applyLive(ui, { add = { entry } })
assertEqual(applied[1].status, "failed", "redelivery must verify the existing native range")
assertEqual(applied[1].verified, false, "redelivery cannot falsely confirm restoration")

ui.document.getTextFromXPointers = function() return "fresh web highlight" end
entry.sourceAnchor, entry.text, entry.datetime, entry.pos0 = nil, "fresh\194\160web highlight", "2099-01-02 00:00:00", "/unicode"
applied = BookOrbitAnnotations.applyLive(ui, { add = { entry } })
assertEqual(applied[1].verified, true, "annotation verification uses shared Unicode whitespace normalization")
entry.text, entry.datetime, entry.pos0 = "", "2099-01-03 00:00:00", "/empty"
applied = BookOrbitAnnotations.applyLive(ui, { add = { entry } })
assertEqual(applied[1].verified, false, "empty text cannot establish a verified annotation range")

ui.bookorbit = { reading_continuity = { ready = true, sha256 = string.rep("a", 64) } }
entry.positionSha256, entry.positionRevisionId = string.rep("a", 64), "current-revision"
applied = BookOrbitAnnotations.applyLive(ui, { add = { entry } })
assertEqual(applied[1].positionSha256, entry.positionSha256, "acknowledgement identifies the installed bytes")
assertEqual(applied[1].positionRevisionId, entry.positionRevisionId, "acknowledgement echoes the matching server revision")
ui.bookorbit.reading_continuity.sha256 = string.rep("b", 64)
applied = BookOrbitAnnotations.applyLive(ui, { add = { entry } })
assertEqual(applied[1].positionSha256, nil, "a different installed copy cannot verify the server projection")
assertEqual(applied[1].positionRevisionId, nil, "a different installed copy cannot claim the server revision")
ui.bookorbit.reading_continuity.sha256, ui.bookorbit.reading_continuity.ready = string.rep("a", 64), false
applied = BookOrbitAnnotations.applyLive(ui, { add = { entry } })
assertEqual(applied[1].positionSha256, nil, "unfinished restoration cannot provide revision evidence")
ui.bookorbit.reading_continuity.ready = true
entry.positionSha256, entry.positionRevisionId = nil, nil
applied = BookOrbitAnnotations.applyLive(ui, { add = { entry } })
assertEqual(applied[1].positionSha256, nil, "legacy servers receive the legacy acknowledgement shape")

print("bookorbit_annotations_live_apply_test.lua: ok")
