local DocSettings = require("docsettings")
local Guard = {}

function Guard.pending(settings)
    if not settings then return false end
    local state = settings:readSetting("bookorbit_revision_annotations_v1")
    return type(state) == "table" and (state.held ~= nil
        or type(state.pending) == "table" and next(state.pending) ~= nil)
end

function Guard.canExchange(options)
    local settings = options.ui and options.ui.doc_settings
    if not settings and options.file and DocSettings:hasSidecarFile(options.file) then
        settings = DocSettings:open(options.file)
    end
    return not Guard.pending(settings)
end

return Guard
