local token = '__TOKEN__'
local function phase(value)
    -- Standard shell boundaries flush pending ConPTY console rendering before
    -- our nonce notification. Unknown OSC alone can overtake CMD output.
    local boundary = ({prompt='A', input='B', execute='C'})[value]
    if boundary then io.write('\27]133;' .. boundary .. '\7') end
    io.write('\27]777;fstty-highlight:' .. token .. ':' .. value .. '\7')
    io.flush()
end
local initialized = false
clink.onbeginedit(function()
    if not initialized then
        initialized = true
        phase('ready')
    end
    phase('prompt')
end)
local prompt = clink.promptfilter(9999)
function prompt:filter(value)
    return value .. '\27]133;B\7\27]777;fstty-highlight:' .. token .. ':input\7'
end
clink.onendedit(function() phase('execute') end)
local semantic = clink.classifier(9999)
function semantic:classify(commands)
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

