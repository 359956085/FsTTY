#!/usr/bin/env bash
set -uo pipefail

readonly WORK_DIR="/home/ubuntu/codex-quota-ping"
readonly LOG_FILE="${WORK_DIR}/quota-window.log"
readonly CLIENT="${WORK_DIR}/quota-window-client.py"
readonly SERVICE="tibo-quota-anchor.service"
readonly SLOT="${1:-}"

cd "${WORK_DIR}" || exit 1
exec 9>"${WORK_DIR}/quota-window.lock"
if ! /usr/bin/flock -n 9; then
  printf '%s 5h槽%s跳过：已有任务运行\n' "$(date --iso-8601=seconds)" "${SLOT}" >> "${LOG_FILE}"
  exit 0
fi

case "${SLOT}" in
  06:01|11:05|16:10) ;;
  *) printf '%s 5h任务失败：非法槽%s\n' "$(date --iso-8601=seconds)" "${SLOT}" >> "${LOG_FILE}"; exit 2 ;;
esac

if ! /usr/bin/systemctl is-active --quiet "${SERVICE}"; then
  printf '%s 5h槽%s失败：常驻服务异常，不启动第二个App Server\n' "$(date --iso-8601=seconds)" "${SLOT}" >> "${LOG_FILE}"
  exit 1
fi

printf '%s 5h槽%s开始，北京时间=%s\n' "$(date --iso-8601=seconds)" "${SLOT}" "$(TZ=Asia/Shanghai date '+%F %T %Z')" >> "${LOG_FILE}"
if /usr/bin/timeout 380s /usr/bin/python3 "${CLIENT}" "${SLOT}" >> "${LOG_FILE}" 2>&1; then
  printf '%s 5h槽%s完成\n' "$(date --iso-8601=seconds)" "${SLOT}" >> "${LOG_FILE}"
else
  status=$?
  printf '%s 5h槽%s失败：exit=%s\n' "$(date --iso-8601=seconds)" "${SLOT}" "${status}" >> "${LOG_FILE}"
  exit "${status}"
fi
