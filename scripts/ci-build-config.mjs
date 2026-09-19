export function resolveUpdaterPublicKey(configuredValue, providedValue, requireProvided) {
  const configured = typeof configuredValue === "string" ? configuredValue.trim() : "";
  if (!configured || /[\r\n]/.test(configured)) {
    throw new Error("基础配置缺少有效的更新公钥");
  }

  const provided = typeof providedValue === "string" ? providedValue.trim() : "";
  if (provided && /[\r\n]/.test(provided)) {
    throw new Error("Actions 更新公钥必须是单行内容");
  }
  if (requireProvided && !provided) {
    throw new Error("正式发布缺少更新公钥");
  }
  if (provided && provided !== configured) {
    throw new Error("Actions 更新公钥与仓库配置不一致");
  }
  return configured;
}
