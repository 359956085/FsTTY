const number = "(?:0|[1-9]\\d*)";
export const RELEASE_VERSION_SOURCE = `${number}\\.${number}\\.${number}(?:-beta\\.[1-9]\\d*)?`;
const pattern = new RegExp(`^${RELEASE_VERSION_SOURCE}$`);

export function releaseChannel(version) {
  if (typeof version !== "string" || !pattern.test(version)) {
    throw new Error("版本必须使用 X.Y.Z 或 X.Y.Z-beta.N 格式，N 为正整数");
  }
  return version.includes("-beta.") ? "beta" : "stable";
}
