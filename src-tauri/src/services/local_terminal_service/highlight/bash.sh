# Loaded as the interactive rc file, before Bash initializes its history list.
# Reproduce the login startup-file order without changing any user files or HOME.
{
if [[ -r /etc/profile ]]; then source /etc/profile; fi
for __fstty_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    if [[ -r "$__fstty_profile" ]]; then source "$__fstty_profile"; break; fi
done
unset __fstty_profile

__fstty_history_warned=0
__fstty_command_token='__COMMAND_TOKEN__'
__fstty_global_phase() {
    [[ -n $__fstty_command_token ]] && printf '\033]777;fstty-global:%s:%s\007' "$__fstty_command_token" "$1"
    return 0
}
__fstty_history_failed() {
    if [[ ${__fstty_history_warned:-0} == 0 ]]; then
        printf '\033]777;fstty-history:__HISTORY_TOKEN__:failed\007'
        __fstty_history_warned=1
    fi
}
if [[ $(declare -p HISTFILE 2>/dev/null) =~ ^declare\ -[^[:space:]]*r ]]; then
    # A profile that makes an external HISTFILE readonly cannot be redirected.
    # Start a clean interactive shell with memory-only history rather than
    # reading/writing that file or modifying the user's profile or exit traps.
    __fstty_history_failed
    __fstty_global_phase unavailable
    exec /usr/bin/env HISTFILE= "$BASH" --noprofile --norc -i
fi

if [[ -n __HISTORY_PATH__ ]] && HISTFILE=__HISTORY_PATH__ && [[ -r "$HISTFILE" && -w "$HISTFILE" ]]; then
    # Leave explicit empty/unlimited and readonly capacity settings intact.
    : "${HISTSIZE=10000}" "${HISTFILESIZE=20000}"
    set -o history
    shopt -s histappend
    __fstty_history_prompt() {
        local previous_status=$?
        if [[ ${__fstty_history_warned:-0} == 0 ]]; then
            if builtin history -a "${HISTFILE-}" && [[ -r ${HISTFILE-} ]]; then
                # -n's file-line cursor can skip another tab's append after our
                # own write. Reload the bounded native file to avoid skips and
                # duplicates, including records loaded during Bash startup.
                builtin history -c
                builtin history -r "${HISTFILE-}" || __fstty_history_failed
            else
                __fstty_history_failed
            fi
            if [[ ${__fstty_history_warned:-0} != 0 ]]; then unset HISTFILE; fi
        fi
        return "$previous_status"
    }
    # Preserve string/array prompt hooks and their order; never evaluate command text.
    if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) =~ ^declare\ -[^[:space:]]*r ]]; then
        unset HISTFILE
        __fstty_history_failed
    elif [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
        PROMPT_COMMAND+=(__fstty_history_prompt)
    else
        if [[ -n ${PROMPT_COMMAND-} ]]; then PROMPT_COMMAND+=$'\n'; fi
        PROMPT_COMMAND+=__fstty_history_prompt
    fi
else
    unset HISTFILE 2>/dev/null || HISTFILE=/dev/null
    __fstty_history_failed
fi

if [[ -n $__fstty_command_token ]]; then
    if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) =~ ^declare\ -[^[:space:]]*r ]] ||
       [[ $(declare -p PS2 2>/dev/null) =~ ^declare\ -[^[:space:]]*r ]] ||
       [[ $(declare -p PS0 2>/dev/null) =~ ^declare\ -[^[:space:]]*r ]] ||
       [[ ! -x /usr/bin/base64 ]]; then
        __fstty_global_phase unavailable
    else
        # An explicit continuation notification excludes the entire command,
        # even when cmdhist folds its physical lines into one native entry.
        __fstty_ps2_marker='\[\e]777;fstty-global:__COMMAND_TOKEN__:continuation\a\]'
        PS2="$__fstty_ps2_marker${PS2-}"
        __fstty_command_sequence=0
        __fstty_command_initialized=0
        # Reserve only an unbound sequence, never replace a user's binding.
        if [[ -x /usr/bin/grep ]] && [[ -z $(bind -m emacs-standard -p 2>/dev/null | /usr/bin/grep -F '"\e[24;7~') ]] &&
           [[ -z $(bind -m emacs-standard -s 2>/dev/null | /usr/bin/grep -F '"\e[24;7~') ]]; then
            bind -m emacs-standard '"\e[24;7~":kill-whole-line'
        fi
        __fstty_global_submit() {
            local current=${HISTCMD:-0} line encoded
            __fstty_global_phase execute
            if [[ ${__fstty_command_initialized:-0} == 1 && $current -gt ${__fstty_command_baseline:-0} ]]; then
                # More than one native entry is not split into global entries.
                if (( current == __fstty_command_baseline + 1 )); then
                    line=$(builtin fc -ln -0 2>/dev/null)
                    line=${line#$'\t'}
                    line=${line# }
                    if [[ $PS2 == "$__fstty_ps2_marker"* ]]; then
                        if [[ -n $line && $line != *$'\n'* && $line != *$'\r'* && ${#line} -le 65536 ]]; then
                            encoded=$(printf '%s' "$line" | /usr/bin/base64 -w 0)
                            __fstty_global_phase "command:$__fstty_command_sequence:$encoded"
                        fi
                    else __fstty_global_phase unavailable
                    fi
                fi
            fi
        }
        __fstty_global_capture() {
            local previous=$? capability=copy
            if [[ -o emacs ]] && [[ $(bind -q kill-whole-line 2>/dev/null) == *'"\e[24;7~"'* ]]; then capability=clear; fi
            __fstty_global_phase "input:$capability"
            return "$previous"
        }
        __fstty_global_baseline() {
            local previous=$?
            __fstty_command_baseline=${HISTCMD:-0}
            __fstty_command_initialized=1
            return "$previous"
        }
        # PS0 is expanded after acceptance and before execution, including
        # exit/long-running commands. The zero-length expansion increments the
        # parent-shell sequence without printing it; the observer runs in a
        # subshell and cannot change command status or native history.
        __fstty_empty=''
        # Git Bash's prompt decoder mishandles $() in PS0 on some versions;
        # the constant backtick observer is equivalent and preserves suffixes.
        PS0='${__fstty_empty:0:$((0*(++__fstty_command_sequence)))}`__fstty_global_submit`'"${PS0-}"
        # Capture before user hooks can reload shared history. Update the
        # baseline only after all hooks, including our native history reload.
        if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a '* ]]; then
            PROMPT_COMMAND=(__fstty_global_capture "${PROMPT_COMMAND[@]}" __fstty_global_baseline)
        else
            PROMPT_COMMAND=$'__fstty_global_capture\n'"${PROMPT_COMMAND-}"$'\n__fstty_global_baseline'
        fi
    fi
fi
}
