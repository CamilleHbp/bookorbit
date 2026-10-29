local AnchorText = { VERSION = 1, QUOTE_LIMIT = 256, CONTEXT_LIMIT = 128 }
local spaces = { [32] = true, [133] = true, [160] = true, [5760] = true,
    [8232] = true, [8233] = true, [8239] = true, [8287] = true, [12288] = true }

local function scalarAt(text, position)
    local first = text:byte(position)
    if first < 128 then return first, 1 end
    local width = first >= 240 and first <= 244 and 4
        or first >= 224 and first <= 239 and 3
        or first >= 194 and first <= 223 and 2
    if not width then return nil end
    local code = first % (2 ^ (7 - width))
    for index = position + 1, position + width - 1 do
        local byte = text:byte(index)
        if not byte or byte < 128 or byte > 191 then return nil end
        code = code * 64 + byte - 128
    end
    if code < (width == 2 and 128 or width == 3 and 2048 or 65536)
        or code > 1114111 or code >= 55296 and code <= 57343 then return nil end
    return code, width
end

function AnchorText.normalize(text, max_native_units)
    local budget = max_native_units or 1000000
    if budget ~= budget or budget == math.huge or budget == -math.huge then budget = 0 end
    budget = math.max(0, math.floor(budget))
    local output, offsets = {}, {}
    local position, ending, pending_space = 1, 0, nil
    while position <= #text do
        local code, width = scalarAt(text, position)
        if not code then return nil, "invalid_utf8" end
        if position - 1 + width > budget then break end
        local space = spaces[code] or code >= 9 and code <= 13 or code >= 8192 and code <= 8202
        if space then
            if #output > 0 and pending_space == nil then pending_space = position - 1 end
        else
            if pending_space ~= nil then
                output[#output + 1] = " "
                offsets[#offsets + 1] = pending_space
            end
            output[#output + 1] = text:sub(position, position + width - 1)
            offsets[#offsets + 1] = position - 1
            pending_space = nil
            ending = position - 1 + width
        end
        position = position + width
    end
    offsets[#offsets + 1] = ending
    return { text = table.concat(output), nativeOffsets = offsets, truncated = position <= #text }
end

function AnchorText.bound(text, limit)
    local position, count = 1, 0
    while position <= #text and count < limit do
        local code, width = scalarAt(text, position)
        if not code then return nil, "invalid_utf8" end
        position, count = position + width, count + 1
    end
    return text:sub(1, position - 1)
end

function AnchorText.scalarLength(text)
    local position, count = 1, 0
    while position <= #text do
        local code, width = scalarAt(text, position)
        if not code then return nil, "invalid_utf8" end
        position, count = position + width, count + 1
    end
    return count
end

return AnchorText
