local token = '__TOKEN__'
local history_token = '__HISTORY_TOKEN__'
local history_failed = false
local command_token = '__COMMAND_TOKEN__'
local command_sequence = 0
local clear_key = [["\e[24;7~"]]
local clear_macro = [["luafunc:__fstty_clear_input"]]
function __fstty_clear_input(buffer)
    buffer:beginundogroup()
    buffer:remove(1, buffer:getlength()+1)
    buffer:setcursor(1)
    buffer:endundogroup()
end
local function global_phase(value)
    if command_token == '' then return end
    io.write('\27]777;fstty-global:' .. command_token .. ':' .. value .. '\7'); io.flush()
end
local function base64(value)
    local alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    return ((value:gsub('.', function(c)
        local bits, byte = '', c:byte()
        for i = 8, 1, -1 do bits = bits .. (byte % 2^i - byte % 2^(i-1) > 0 and '1' or '0') end
        return bits
    end) .. '0000'):gsub('%d%d%d?%d?%d?%d?', function(bits)
        if #bits < 6 then return '' end
        local index = 0
        for i = 1, 6 do index = index + (bits:sub(i,i) == '1' and 2^(6-i) or 0) end
        return alphabet:sub(index+1,index+1)
    end) .. ({'', '==', '='})[#value % 3+1])
end
-- CMD requests More? outside Clink's editor after accepting an unfinished
-- physical line. Exclude such lines here; never collect its continuation input.
local function complete_physical_line(line)
    local quoted, depth, i = false, 0, 1
    while i <= #line do
        local c = line:sub(i,i)
        if c == '^' and not quoted then
            if i == #line then return false end
            i = i + 2
        else
            if c == '"' then quoted = not quoted
            elseif not quoted and c == '(' then depth = depth + 1
            elseif not quoted and c == ')' then depth = math.max(0, depth - 1) end
            i = i + 1
        end
    end
    return depth == 0
end
if command_token ~= '' then
    clink.onhistory(function(line)
        -- Observe the native accepted-history path; never change the line or
        -- return a replacement/cancellation to Clink.
        if not line or line:match('^%s*$') or #line > 65536 or line:find('[%z\1-\31\127]') then return end
        if not complete_physical_line(line) then return end
        if settings.get('history.ignore_space') and line:match('^%s') then return end
        command_sequence = command_sequence + 1
        global_phase('command:' .. command_sequence .. ':' .. base64(line))
    end)
end
-- Per-process overrides; the shared profile never stores launch-specific state.
settings.set('clink.colorize_input', token ~= '')
local function phase(value)
    if token == '' then return end
    -- Standard shell boundaries flush pending ConPTY console rendering before
    -- our nonce notification. Unknown OSC alone can overtake CMD output.
    local boundary = ({prompt='A', input='B', execute='C'})[value]
    if boundary then io.write('\27]133;' .. boundary .. '\7') end
    io.write('\27]777;fstty-highlight:' .. token .. ':' .. value .. '\7')
    io.flush()
end
local initialized = false
clink.onbeginedit(function()
    if command_token ~= '' then
        local binding, kind = rl.getbinding(clear_key, 'emacs')
        if not binding and not kind then rl.setbinding(clear_key, clear_macro, 'emacs') end
    end
    -- Clink reloads the shared settings at each edit; this flag belongs to
    -- this process, including when another tab uses a different snapshot.
    settings.set('clink.colorize_input', token ~= '')
    if history_token ~= '' and settings.get('history.save') then
        local file = not history_failed and io.open(path.join(os.getenv('FSTTY_CLINK_PROFILE'), 'clink_history'), 'a')
        if file then file:close()
        else
            settings.set('history.save', false)
            settings.set('history.shared', false)
            if not history_failed then
                history_failed = true
                io.write('\27]777;fstty-history:' .. history_token .. ':failed\7')
                io.flush()
            end
        end
    end
    if not initialized then
        initialized = true
        phase('ready')
    end
    phase('prompt')
end)
local prompt = clink.promptfilter(9999)
function prompt:filter(value)
    if command_token ~= '' then
        local binding = rl.getbinding(clear_key)
        global_phase('input:' .. ((binding == clear_macro or binding == 'luafunc:__fstty_clear_input') and 'clear' or 'copy'))
    end
    if token == '' then return value end
    return value .. '\27]133;B\7\27]777;fstty-highlight:' .. token .. ':input\7'
end
clink.onendedit(function() global_phase('execute'); phase('execute') end)
local semantic = clink.classifier(9999)
function semantic:classify(commands)
    if token == '' then return end
    for _, command in ipairs(commands or {}) do
        local state, colors = command.line_state, command.classifications
        local line = state:getline()
        local cwi = state:getcommandwordindex()
        local first = state:getwordinfo(cwi)
        if first and state:getword(cwi):lower() == 'rem' then
            colors:applycolor(first.offset, #line - first.offset + 1, '90')
        else
            for i = cwi + 1, state:getwordcount() do
                local info, word = state:getwordinfo(i), state:getword(i)
                if info and not info.redir then
                    colors:applycolor(info.offset, info.length, word:match('^[+-]?%d+%.?%d*$') and '33' or '36')
                end
            end
            local start, finish = state:getrangeoffset(), state:getrangeoffset() + state:getrangelength() - 1
            local i = start
            while i <= finish do
                local ch = line:sub(i,i)
                if ch == '^' then i = i + 2
                elseif ch == '"' then
                    local ending = line:find('"', i+1, true)
                    if ending and ending <= finish then
                        colors:applycolor(i, ending-i+1, '32'); i = ending+1
                    else colors:applycolor(i, finish-i+1, '31'); break end
                else i = i+1 end
            end
            -- Variable expansions also retain their semantic color inside strings.
            local from = start
            while from <= finish do
                local a,b = line:find('%%[^%%]+%%', from)
                if not a or b > finish then break end
                colors:applycolor(a, b-a+1, '35'); from = b+1
            end
            for _, pattern in ipairs({'!([^!]+)!', '%%~[%a]*%d', '%%%%%a', '%%%d', '%%%*'}) do
                from = start
                while from <= finish do
                    local a,b = line:find(pattern, from)
                    if not a or b > finish then break end
                    colors:applycolor(a, b-a+1, '35'); from = b+1
                end
            end

        end
    end
end

