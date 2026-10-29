local Identity = dofile("koreader-plugin/bookorbit.koplugin/bookorbit_file_identity.lua")
local path = os.tmpname()
local function write(text)
    local file = assert(io.open(path, "wb"))
    file:write(text)
    file:close()
end
local attributes = { mode = "file", dev = 1, ino = 2, size = 3, modification = 1, change = 1 }
local lfs = { attributes = function()
    if not attributes then return nil end
    local copy = {}
    for key, value in pairs(attributes) do copy[key] = value end
    return copy
end }
local sha = { sha256 = function()
    local chunks = {}
    return function(chunk)
        if chunk then chunks[#chunks + 1] = chunk else return "hashed:" .. table.concat(chunks) end
    end
end }
local function begin(clock)
    return Identity.begin(path, { lfs = lfs, sha = sha, clock = clock })
end
write("abc")
local job = assert(begin())
assert(job:step() == "pending")
local status, result = job:step()
assert(status == "stable" and result.sha256 == "hashed:abc")
assert(job:step() == "closed")

job = assert(begin())
assert(job:step() == "pending")
write("def")
assert(job:step() == "retryable")

write(string.rep("x", 200000))
attributes.size = 200000
job = assert(begin())
assert(job:step() == "pending")
attributes.ino = 3
assert(job:step() == "retryable")
assert(job:step() == "closed")

job = assert(begin())
assert(job:cancel() == "cancelled")
assert(job:step() == "closed")
local now = 1
job = assert(begin(function() return now end))
now = 122
assert(job:step() == "retryable")
attributes.size = 513 * 1024 * 1024
local rejected, reason = begin()
assert(rejected == nil and reason == "size_or_type")
attributes = nil
rejected, reason = begin()
assert(rejected == nil and reason == "missing")
os.remove(path)
print("bookorbit_file_identity_test.lua: ok")
